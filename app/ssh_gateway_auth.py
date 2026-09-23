"""Explicit multi-factor authentication using Paramiko's public transport API."""
import time

from paramiko import AuthenticationException, BadAuthenticationType, ServiceRequestingTransport
from paramiko.auth_strategy import AuthStrategy

from .ssh_gateway import parse_selector


class GatewayAuthStrategy(AuthStrategy):
    def __init__(self, username, *, password=None, pkey=None, interact, check=None):
        super().__init__(ssh_config=None)
        parse_selector(username)
        self.username = username
        self.password = password or None
        self.pkey = pkey
        self.interact = interact
        self.check = check or (lambda: None)

    def authenticate(self, transport):
        deadline = time.monotonic() + 180
        transport.auth_timeout = 180
        method = "publickey" if self.pkey is not None else (
            "password" if self.password else "keyboard-interactive"
        )
        attempted = set()
        try:
            for _round in range(8):
                self.check()
                if time.monotonic() >= deadline:
                    raise AuthenticationException("Gateway authentication timed out")
                if method in attempted:
                    raise AuthenticationException("Gateway authentication did not complete")
                attempted.add(method)
                try:
                    if method == "publickey":
                        methods = transport.auth_publickey(self.username, self.pkey)
                    elif method == "password":
                        password = self.password
                        if password is None:
                            answers = self.interact("", "", [("Password", False)])
                            if len(answers) != 1:
                                raise AuthenticationException("Invalid authentication response")
                            password = answers[0]
                        try:
                            methods = transport.auth_password(self.username, password, fallback=False)
                        finally:
                            password = None
                    else:
                        rounds = 0
                        def handler(title, instructions, prompts):
                            nonlocal rounds
                            rounds += 1
                            self.check()
                            if rounds > 8 or time.monotonic() >= deadline:
                                raise AuthenticationException("Gateway authentication limit exceeded")
                            return self.interact(title, instructions, prompts)
                        methods = transport.auth_interactive(self.username, handler)
                except BadAuthenticationType as error:
                    methods = error.allowed_types
                self.check()
                if transport.is_authenticated():
                    return
                if not isinstance(methods, (list, tuple)):
                    raise AuthenticationException("Gateway authentication failed")
                method = next((candidate for candidate in (
                    "password", "keyboard-interactive"
                ) if candidate in methods and candidate not in attempted), None)
                if method is None:
                    raise AuthenticationException("Gateway authentication failed")
            raise AuthenticationException("Gateway authentication limit exceeded")
        finally:
            self.password = None
            self.pkey = None

class GatewayTransport(ServiceRequestingTransport):
    """Request ssh-userauth once, with a bounded Paramiko 5 service handshake.

    Paramiko's public ServiceRequestingTransport supports multiple factors, but
    its ensure_session loop does not stop on close or timeout. This isolated
    override retains its protocol behavior and bounds that initial wait.
    """

    def ensure_session(self):
        from paramiko import Message, SSHException
        from paramiko.common import cMSG_SERVICE_REQUEST
        if not self.active or not self.initial_kex_done:
            raise SSHException("No existing gateway session")
        if self._service_userauth_accepted:
            return
        message = Message()
        message.add_byte(cMSG_SERVICE_REQUEST)
        message.add_string("ssh-userauth")
        self._send_message(message)
        deadline = time.monotonic() + min(self.auth_timeout or 10, 10)
        while not self._service_userauth_accepted:
            if not self.active or time.monotonic() >= deadline:
                self.close()
                raise AuthenticationException("Gateway authentication service unavailable")
            time.sleep(.02)
        self.auth_handler = self.get_auth_handler()
