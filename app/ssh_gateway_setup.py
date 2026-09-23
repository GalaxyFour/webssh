"""Prove target readiness before any terminal startup action is allowed."""
import secrets
import socket
import threading
import time

from . import paramiko_channels
from .ssh_gateway_interaction import GatewayCancelled


class ReadyLine:
    def __init__(self, marker):
        self.marker = marker
        self.pending = b""
        self.ready = False

    def feed(self, data):
        self.pending += data
        while b"\n" in self.pending:
            line, self.pending = self.pending.split(b"\n", 1)
            if line.rstrip(b"\r") == self.marker:
                self.ready = True
        if len(self.pending) > 65536:
            raise ValueError("Gateway readiness output exceeds byte limit")


def _pty(transport, attempt, deadline):
    channel = attempt.own(transport.open_session(timeout=min(10, deadline-time.monotonic())))
    channel.settimeout(.2)
    guard = paramiko_channels._request_guard(channel, max(.01, deadline-time.monotonic()))
    try:
        channel.get_pty(term="xterm", width=80, height=24)
        attempt.check()
        return channel
    except Exception:
        channel.close()
        raise
    finally:
        guard.cancel()


def _pump(channel, attempt, deadline, parser=None):
    attempt.check()
    if time.monotonic() >= deadline:
        raise GatewayCancelled()
    data = attempt.take_input()
    if data is not None:
        channel.sendall(data)
    received = False
    for ready, recv in ((channel.recv_ready, channel.recv),
                        (channel.recv_stderr_ready, channel.recv_stderr)):
        if ready():
            data = recv(4096)
            received = True
            if data:
                attempt.output(data)
                if parser is not None:
                    parser.feed(data)
    return received


def prepare_terminal(transport, attempt):
    attempt.start_setup()
    deadline = min(attempt.deadline, time.monotonic()+180)
    channel = _pty(transport, attempt, deadline)
    marker = ("WEBSSH_READY_"+secrets.token_hex(16)).encode("ascii")
    parser = ReadyLine(marker)
    guard = paramiko_channels._request_guard(channel, max(.01, deadline-time.monotonic()))
    try:
        # Fixed command and generated hex nonce only; never interpolate user input.
        channel.exec_command("printf '\\n%s\\n' "+marker.decode("ascii"))  # nosec B601
        while True:
            received = _pump(channel, attempt, deadline, parser)
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                if channel.recv_exit_status() != 0 or not parser.ready:
                    raise ValueError("Gateway target did not confirm readiness")
                attempt.check()
                return
            if channel.closed and not received:
                raise ValueError("Gateway target closed before readiness")
            if not received:
                time.sleep(.02)
    finally:
        guard.cancel()
        channel.close()


def prepare_sftp(transport, attempt, *, operation_timeout):
    attempt.start_setup()
    deadline = min(attempt.deadline, time.monotonic()+180)
    channel = _pty(transport, attempt, deadline)
    stop = threading.Event()
    errors = []
    def pump():
        try:
            while not stop.is_set():
                if not _pump(channel, attempt, deadline):
                    stop.wait(.02)
        except Exception as error:
            errors.append(error)
            attempt.cancel(reason="failed")
    # At most one pump per admitted BACKGROUND_JOB, joined before returning.
    worker = threading.Thread(target=pump, name="gateway-setup", daemon=True)
    worker.start()
    sftp = None
    try:
        sftp = attempt.own(paramiko_channels.open_sftp_client(
            transport, timeout=max(.01, deadline-time.monotonic()),
            operation_timeout=operation_timeout, deadline=deadline,
        ))
        sftp.normalize(".")
        attempt.check()
        if errors:
            raise errors[0]
        return sftp
    except Exception:
        if sftp is not None:
            sftp.close()
        raise
    finally:
        stop.set()
        channel.close()
        worker.join(1)
        if worker.is_alive():
            attempt.cancel(reason="failed")
            raise GatewayCancelled()
