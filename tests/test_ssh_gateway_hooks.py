import pytest
from app.socket_events import _validate_ssh_params

def test_gateway_validation_is_explicitly_opt_in():
    assert _validate_ssh_params("host",22,"u:t")[3]
    assert _validate_ssh_params("host",22,"u:t",allow_gateway=True) == ("host",22,"u:t",None)

@pytest.mark.parametrize("value", [" u:t", "u:t ", "u: t", "ticket-user:t", "u#x:t"])
def test_gateway_validation_does_not_trim_or_reinterpret(value):
    assert _validate_ssh_params("host",22,value,allow_gateway=True)[3]

def test_ordinary_validation_keeps_trimming():
    assert _validate_ssh_params("host",22," user ") == ("host",22,"user",None)

def test_profile_storage_keeps_legacy_schema_with_gateway(app):
    from app import profile_manager
    from tests.test_command_set_socket_events import create_socket_user
    user_id, _sid = create_socket_user(app, "gateway_profile")
    with app.app_context():
        profile, error = profile_manager.add_profile(user_id, "Gateway", "host", 22, "u:t", "password")
        assert error is None
        assert profile["auth_type"] == "password"
        assert profile_manager._valid_profile(profile)


@pytest.mark.usefixtures("direct_socket_authentication")
def test_socket_gateway_admission_and_cancel(app, monkeypatch):
    import threading
    from flask import request
    from app import socket_events, ssh_manager
    from tests.test_command_set_socket_events import create_socket_user
    user_id, sid = create_socket_user(app, "gateway_cancel")
    entered, finished = threading.Event(), threading.Event()
    received = []
    monkeypatch.setattr(socket_events, "emit", lambda *args, **kwargs: received.append(args))
    def connect(**kwargs):
        attempt = kwargs["gateway_attempt"]
        assert kwargs["password"] is None
        entered.set()
        try:
            attempt.challenge("", "", [("OTP", False)])
        except ValueError:
            pass
        finally: finished.set()
        return None, "cancelled"
    monkeypatch.setattr(ssh_manager, "create_ssh_connection", connect)
    with app.test_request_context("/socket.io"):
        request.sid = sid
        socket_events.handle_ssh_connect({
            "host":"host", "username":"u:t", "auth_type":"password",
            "client_request_id":"gateway-request", "gateway_interaction":1,
        })
    assert entered.wait(2), received
    with app.test_request_context("/socket.io"):
        request.sid = sid
        assert socket_events.handle_ssh_connect_cancel({"client_request_id":"gateway-request"})["success"]
    assert finished.wait(2)


@pytest.mark.usefixtures("direct_socket_authentication")
def test_gateway_requires_client_capability(app, monkeypatch):
    from app import socket_events, ssh_manager
    from tests.test_command_set_socket_events import create_socket_user, call_socket_handler
    _, sid = create_socket_user(app, "gateway_old_client")
    monkeypatch.setattr(ssh_manager, "create_ssh_connection", lambda **kwargs: pytest.fail("connected"))
    _, events = call_socket_handler(app, monkeypatch, socket_events.handle_ssh_connect, sid,
        {"host":"host", "username":"u:t", "client_request_id":"legacy"})
    assert any("updated interactive client" in payload.get("error","") for event,payload in events)
