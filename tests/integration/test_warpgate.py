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
