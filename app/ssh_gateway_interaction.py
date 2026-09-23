"""Bounded, socket-owned gateway interactions. No credentials are persisted."""
from collections import deque
import secrets
import threading
import time

from .quota_manager import QuotaKind, quota_manager


class GatewayCancelled(ValueError):
    def __init__(self):
        super().__init__("Gateway connection cancelled or timed out")


class GatewayAttempt:
    def __init__(self, user_id, sid, request_id, emit, *, reservation=None):
        self.user_id = str(user_id)
        self.sid = sid
        self.request_id = request_id
        self.emit = emit
        self.reservation = reservation
        self.deadline = time.monotonic() + 300
        self.auth_deadline = time.monotonic() + 180
        self.condition = threading.Condition(threading.RLock())
        self.cancelled = False
        self.finished = False
        self.resources = []
        self.prompt = None
        self.responses = None
        self.phase = "auth"
        self.inputs = deque()
        self.input_bytes = 0
        self.output_bytes = 0
        self.sequence = 0
        self.unacked = {}
        self.guard = threading.Timer(300, self.cancel)
        self.guard.daemon = True
        self.guard.start()

    def check(self):
        with self.condition:
            if (self.cancelled or self.finished or time.monotonic() >= self.deadline
                    or (self.phase == 'auth' and time.monotonic() >= self.auth_deadline)):
                raise GatewayCancelled()

    def own(self, resource):
        with self.condition:
            if not self.cancelled and not self.finished and time.monotonic() < self.deadline:
                if resource not in self.resources:
                    self.resources.append(resource)
                return resource
        resource.close()
        raise GatewayCancelled()

    def handoff(self, *resources):
        with self.condition:
            self.check()
            for resource in resources:
                if resource in self.resources:
                    self.resources.remove(resource)

    def send(self, event, **data):
        self.emit(event, {"client_request_id": self.request_id, **data})

    def challenge(self, title, instructions, prompts):
        if not isinstance(title, str) or not isinstance(instructions, str):
            raise ValueError("Invalid gateway challenge")
        if len(prompts) > 8 or any(
            not isinstance(p, (tuple, list)) or len(p) != 2 or not isinstance(p[0], str)
            for p in prompts
        ):
            raise ValueError("Invalid gateway challenge")
        if sum(len(s.encode("utf-8")) for s in [title, instructions, *[p[0] for p in prompts]]) > 16384:
            raise ValueError("Gateway challenge exceeds byte limit")
        with self.condition:
            self.check()
            if self.prompt is not None:
                raise ValueError("Gateway challenge already pending")
            challenge_id = secrets.token_urlsafe(24)
            self.prompt = (challenge_id, len(prompts))
            self.responses = None
            self.send("ssh_gateway_challenge", challenge_id=challenge_id,
                      title=title, instructions=instructions,
                      prompts=[{"label": p[0]} for p in prompts])
            deadline = min(self.deadline, self.auth_deadline, time.monotonic() + 120)
            try:
                while self.responses is None:
                    self.check()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise GatewayCancelled()
                    self.condition.wait(min(remaining, .25))
                return self.responses
            finally:
                self.prompt = None
                self.responses = None

    def answer(self, user_id, sid, challenge_id, answers):
        with self.condition:
            if self.cancelled or self.finished or self.user_id != str(user_id) or self.sid != sid:
                return False
            if self.prompt is None or self.prompt[0] != challenge_id or self.responses is not None:
                return False
            if not isinstance(answers, list) or len(answers) != self.prompt[1]:
                return False
            if any(not isinstance(a, str) for a in answers):
                return False
            try:
                if sum(len(a.encode("utf-8")) for a in answers) > 16384:
                    return False
            except UnicodeError:
                return False
            self.responses = list(answers)
            self.condition.notify_all()
            return True

    def start_setup(self):
        with self.condition:
            self.check()
            self.phase = "setup"
            self.send("ssh_gateway_progress", phase="setup")

    def input(self, value):
        if not isinstance(value, str):
            return False
        try:
            data = value.encode("utf-8")
        except UnicodeError:
            return False
        with self.condition:
            if self.phase != "setup" or self.cancelled or self.finished:
                return False
            if not data or len(data) > 1024 or self.input_bytes + len(data) > 8192:
                return False
            self.input_bytes += len(data)
            self.inputs.append(data)
            return True

    def take_input(self):
        with self.condition:
            return self.inputs.popleft() if self.inputs else None

    def output(self, data):
        if not isinstance(data, bytes) or len(data) > 4096:
            raise ValueError("Invalid gateway output frame")
        with self.condition:
            self.check()
            self.output_bytes += len(data)
            if self.output_bytes > 8 * 1024 * 1024:
                raise ValueError("Gateway output limit exceeded")
            deadline = time.monotonic() + 5
            while len(self.unacked) >= 4:
                self.check()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise GatewayCancelled()
                self.condition.wait(min(remaining, .25))
            self.sequence += 1
            self.unacked[self.sequence] = True
            self.send("ssh_gateway_output", sequence=self.sequence,
                      data=data.decode("utf-8", errors="replace"))

    def ack(self, sequence):
        with self.condition:
            if type(sequence) is not int or sequence not in self.unacked:
                return False
            del self.unacked[sequence]
            self.condition.notify_all()
            return True

    def cancel(self):
        with self.condition:
            self.cancelled = True
            self.responses = None
            resources, self.resources = self.resources, []
            self.inputs.clear()
            self.condition.notify_all()
        # Paramiko close may take locks: never close under the registry lock.
        for resource in reversed(resources):
            try:
                resource.close()
            except Exception:
                pass

    def finish(self):
        self.guard.cancel()
        self.cancel()
        with self.condition:
            if self.finished:
                return
            self.finished = True
        if self.reservation is not None:
            self.reservation.release()


class GatewayRegistry:
    def __init__(self):
        self.lock = threading.Lock()
        self.attempts = {}
        self.stopping = False

    def create(self, user_id, sid, request_id, emit):
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            raise ValueError("Gateway request ID is required")
        key = (str(user_id), sid, request_id)
        with self.lock:
            if self.stopping or key in self.attempts:
                raise ValueError("Gateway request is unavailable")
            reservation = quota_manager.reserve(QuotaKind.BACKGROUND_JOB, user_id)
            try:
                attempt = GatewayAttempt(user_id, sid, request_id, emit, reservation=reservation)
                self.attempts[key] = attempt
                return attempt
            except Exception:
                reservation.release()
                raise

    def get(self, user_id, sid, request_id):
        if not isinstance(request_id, str):
            return None
        with self.lock:
            return self.attempts.get((str(user_id), sid, request_id))

    def finish(self, attempt):
        attempt.finish()
        key = (attempt.user_id, attempt.sid, attempt.request_id)
        with self.lock:
            if self.attempts.get(key) is attempt:
                del self.attempts[key]

    def cancel_socket(self, sid):
        with self.lock:
            attempts = [a for a in self.attempts.values() if a.sid == sid]
        for attempt in attempts:
            attempt.cancel()

    def shutdown(self):
        with self.lock:
            self.stopping = True
            attempts = list(self.attempts.values())
        for attempt in attempts:
            attempt.cancel()
