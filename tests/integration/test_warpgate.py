"""Opt-in tests for a disposable, loopback-only Warpgate 0.29.0 fixture.

See tests/integration/warpgate/README.md. No external gateway is accepted.
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import ssl
import struct
import threading
import time
import urllib.request
from urllib.parse import urlsplit

import paramiko
import pytest

from app.ssh_gateway_auth import GatewayAuthStrategy, GatewayTransport
from app.ssh_gateway_interaction import GatewayAttempt, GatewayCancelled
from app.ssh_gateway_setup import prepare_terminal, prepare_sftp


@pytest.fixture
def gateway():
    filename = os.environ.get("WEBSSH_WARPGATE_FIXTURE")
    if not filename:
        pytest.skip("Disposable Warpgate fixture not configured")
    assert "PYTEST_XDIST_WORKER" not in os.environ, "Run the disposable policy tests serially"
    config = json.loads(Path(filename).read_text(encoding="utf-8"))
    assert config["disposable"] is True
    assert ipaddress.ip_address(config["host"]).is_loopback
    api_url = urlsplit(config["api_url"])
    assert api_url.scheme == "https" and ipaddress.ip_address(api_url.hostname).is_loopback
    # Trust the disposable instance's exact certificate. Its generated name need
    # not match the loopback literal; this context is never used by the product.
    context = ssl.create_default_context(cafile=config["certificate"])
    context.check_hostname = False

    def api(path, data=None, method=None):
        request = urllib.request.Request(
            config["api_url"] + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"X-Warpgate-Token": config["admin_token"], "Content-Type": "application/json"},
            method=method,
        )
        with urllib.request.urlopen(request, context=context, timeout=5) as response:
            content = response.read()
            return json.loads(content) if content else None
    user_path = "/users/" + config["user_id"]
    user = api(user_path)
    target_path = "/targets/" + config["target_id"]
    target = api(target_path)

    def policy(kinds):
        api(user_path, {**user, "credential_policy": {"ssh": kinds}}, "PUT")

    try:
        yield config, api, policy
    finally:
        api(user_path, user, "PUT")
        api(target_path, target, "PUT")


def client_for(config):
    client = paramiko.SSHClient()
    key = paramiko.PKey.from_type_string(
        config["host_key_type"], base64.b64decode(config["host_key"]),
    )
    client.get_host_keys().add(f"[{config['host']}]:{config['port']}", key.get_name(), key)
    return client


def connect(client, config, **auth):
    client.connect(config["host"], port=config["port"], username=config["selector"],
                   timeout=5, transport_factory=GatewayTransport,
                   auth_strategy=GatewayAuthStrategy(config["selector"], **auth))


def current_otp(config):
    secret = bytes.fromhex(config["otp_secret_hex"])
    digest = hmac.new(secret, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack(">I", digest[offset:offset+4])[0] & 0x7fffffff) % 1000000).zfill(6)


@pytest.mark.parametrize("kinds", [
    ["Password"], ["Password", "Totp"], ["Totp"],
    ["PublicKey"], ["PublicKey", "Password"], ["PublicKey", "Password", "Totp"],
])
def test_reference_authentication_policies(gateway, kinds):
    config, api, policy = gateway
    policy(kinds)
    key = None
    credential = None
    client = client_for(config)
    prompts_seen = []
    def answer(_title, _instructions, prompts):
        prompts_seen.extend(label for label, _echo in prompts)
        return [current_otp(config) if "One-time" in label else config["password"]
                for label, _echo in prompts]
    try:
        if "PublicKey" in kinds:
            key = paramiko.RSAKey.generate(2048)
            credential = api("/users/" + config["user_id"] + "/credentials/public-keys",
                             {"label": "disposable-integration", "openssh_public_key": key.get_name()+" "+key.get_base64()})
        connect(client, config, pkey=key, password=(
            config["password"] if "Password" in kinds and key is None else None
        ), interact=answer)
        assert client.get_transport().is_authenticated()
        if "Totp" in kinds:
            assert any("One-time" in prompt for prompt in prompts_seen)
        if key and "Password" in kinds:
            assert "Password" in prompts_seen
    finally:
        client.close()
        if credential:
            api("/users/"+config["user_id"]+"/credentials/public-keys/"+credential["id"], method="DELETE")


def test_terminal_and_sftp_target_readiness(gateway):
    config, _api, policy = gateway
    policy(["Password"])
    def emit(event, data):
        if event == "ssh_gateway_output":
            attempt.ack(data["sequence"])
    attempt = GatewayAttempt(1, "reference", "ready", emit)
    client = attempt.own(client_for(config))
    try:
        connect(client, config, password=config["password"],
                interact=attempt.challenge, check=attempt.check)
        prepare_terminal(client.get_transport(), attempt)
        sftp = prepare_sftp(client.get_transport(), attempt, operation_timeout=5)
        assert sftp.normalize(".")
    finally:
        attempt.finish()


def test_browser_approval_can_be_cancelled_without_authenticating(gateway):
    config, _api, policy = gateway
    policy(["WebUserApproval"])
    client = client_for(config)
    seen = []
    def abort(_title, instructions, prompts):
        assert instructions and prompts
        seen.append(True)
        raise GatewayCancelled()
    try:
        with pytest.raises((GatewayCancelled, paramiko.AuthenticationException)):
            connect(client, config, interact=abort)
        assert seen and not client.get_transport().is_authenticated()
    finally:
        client.close()


def test_pending_administrator_approval_blocks_target_readiness(gateway):
    config, api, policy = gateway
    policy(["Password"])
    path = "/targets/"+config["target_id"]
    target = api(path)
    api(path, {**target, "require_approval": True}, "PUT")
    def emit(event, data):
        if event == "ssh_gateway_output":
            attempt.ack(data["sequence"])
    attempt = GatewayAttempt(1, "reference", "approval", emit)
    client = attempt.own(client_for(config))
    timer = threading.Timer(.5, attempt.cancel)
    try:
        connect(client, config, password=config["password"], interact=attempt.challenge)
        timer.start()
        with pytest.raises((GatewayCancelled, paramiko.SSHException, OSError)):
            prepare_terminal(client.get_transport(), attempt)
        assert not client.get_transport() or not client.get_transport().is_active()
    finally:
        timer.cancel()
        attempt.finish()


def test_changed_gateway_host_key_fails_before_authentication(gateway):
    config, _api, _policy = gateway
    client = client_for(config)
    wrong = paramiko.RSAKey.generate(2048)
    client.get_host_keys().clear()
    client.get_host_keys().add(f"[{config['host']}]:{config['port']}", wrong.get_name(), wrong)
    try:
        with pytest.raises(paramiko.BadHostKeyException):
            connect(client, config, password=config["password"],
                    interact=lambda *_args: pytest.fail("prompt before host trust"))
    finally:
        client.close()


def test_administrator_approval_allows_readiness_only_after_approval(gateway):
    config, api, policy = gateway
    policy(["Password"])
    path = "/targets/" + config["target_id"]
    target = api(path)
    api(path, {**target, "require_approval": True}, "PUT")
    existing = {item["id"] for item in api("/session-approvals")}
    attempt = GatewayAttempt(1, "reference", "approved", lambda event, data:
        attempt.ack(data["sequence"]) if event == "ssh_gateway_output" else None)
    client = attempt.own(client_for(config))
    done = threading.Event()
    failures = []
    def setup():
        try:
            prepare_terminal(client.get_transport(), attempt)
        except Exception as error:
            failures.append(error)
        finally:
            done.set()
    worker = threading.Thread(target=setup)
    try:
        connect(client, config, password=config["password"], interact=attempt.challenge)
        worker.start()
        deadline = time.monotonic() + 10
        pending = []
        while time.monotonic() < deadline:
            pending = [item for item in api("/session-approvals")
                       if item["id"] not in existing and item["target"] == target["name"]]
            if pending: break
            assert not done.wait(.05), failures
        assert len(pending) == 1 and not done.is_set()
        api("/session-approvals/" + pending[0]["id"] + "/approve",
            {"scope": "Once", "target": target["name"]})
        assert done.wait(10), "Approved target did not become ready"
        assert not failures
    finally:
        attempt.finish()
        if worker.ident is not None: worker.join(2)


def test_target_host_key_requires_explicit_verified_response(gateway):
    config, api, policy = gateway
    policy(["Password"])
    keys = api("/targets/" + config["target_id"] + "/known-ssh-host-keys")
    assert keys, "Fixture target must initially be trusted"
    expected_keys = [key["key_base64"] for key in keys]
    output = []
    answered = []
    def emit(event, data):
        if event != "ssh_gateway_output": return
        attempt.ack(data["sequence"])
        output.append(data["data"])
        text = "".join(output)
        if "(y/n)" in text and not answered:
            assert any(key in text for key in expected_keys)
            assert attempt.input("y")
            answered.append(True)
    attempt = GatewayAttempt(1, "reference", "host-key", emit)
    client = attempt.own(client_for(config))
    timer = threading.Timer(15, attempt.cancel)
    try:
        for key in keys: api("/ssh/known-hosts/" + key["id"], method="DELETE")
        connect(client, config, password=config["password"], interact=attempt.challenge)
        timer.start()
        prepare_terminal(client.get_transport(), attempt)
        assert answered == [True]
    finally:
        timer.cancel()
        attempt.finish()
        known = api("/ssh/known-hosts")
        for key in keys:
            if not any(all(item[field] == key[field] for field in
                       ("host", "port", "key_type", "key_base64")) for item in known):
                api("/ssh/known-hosts", {field: key[field] for field in
                    ("host", "port", "key_type", "key_base64")})


def test_sftp_only_target_does_not_require_exec(gateway):
    config, api, policy = gateway
    port = config.get("sftp_only_port")
    if port is None:
        pytest.skip("Disposable ForceCommand internal-sftp target not configured")
    assert type(port) is int and 1024 <= port <= 65535
    policy(["Password"])
    path = "/targets/" + config["target_id"]
    target = api(path)
    assert ipaddress.ip_address(target["options"]["host"]).is_loopback
    keys = api(path + "/known-ssh-host-keys")
    assert keys
    created = []
    try:
        # The second disposable daemon must use the same generated host key.
        for key in keys:
            created.append(api("/ssh/known-hosts", {
                "host": key["host"], "port": port, "key_type": key["key_type"],
                "key_base64": key["key_base64"],
            }))
        api(path, {**target, "options": {**target["options"], "port": port}}, "PUT")
        for terminal in (False, True):
            attempt = GatewayAttempt(1, "reference", "sftp-only", lambda event, data:
                attempt.ack(data["sequence"]) if event == "ssh_gateway_output" else None)
            client = attempt.own(client_for(config))
            timer = threading.Timer(10, attempt.cancel)
            try:
                connect(client, config, password=config["password"], interact=attempt.challenge)
                timer.start()
                if terminal:
                    with pytest.raises(ValueError, match="did not confirm readiness"):
                        prepare_terminal(client.get_transport(), attempt)
                else:
                    sftp = prepare_sftp(client.get_transport(), attempt, operation_timeout=5)
                    assert sftp.normalize(".")
            finally:
                timer.cancel()
                attempt.finish()
    finally:
        for key in created:
            api("/ssh/known-hosts/" + key["id"], method="DELETE")
