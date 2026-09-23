"""Cancellation contracts for interactive SSH setup and its base primitive."""
import threading

import pytest


@pytest.fixture(autouse=True)
def gateway_enabled(monkeypatch):
    from app import app_settings
    monkeypatch.setattr(app_settings, 'is_ssh_gateway_enabled', lambda: True)


def make_attempt(gateway=False, **kwargs):
    if gateway:
        from app.ssh_gateway_interaction import GatewayAttempt
        return GatewayAttempt(1, 'sid', 'req', lambda *args: None, **kwargs)
    from app.ssh_connection_attempt import SSHConnectionAttempt
    return SSHConnectionAttempt(1, 'sid', 'req', **kwargs)


@pytest.mark.parametrize('gateway', [False, True])
@pytest.mark.parametrize('winner', ['cancel', 'commit'])
def test_cancel_and_commit_have_one_winner(gateway, winner):
    attempt = make_attempt(gateway)
    try:
        if winner == 'cancel':
            assert attempt.cancel()
            assert attempt.wait(.01)
            assert not attempt.commit_if_active()
        else:
            assert attempt.commit_if_active()
            assert not attempt.cancel()
            assert not attempt.is_set()
            assert attempt.commit_if_active()
    finally:
        attempt.finish()


@pytest.mark.parametrize('gateway', [False, True])
@pytest.mark.parametrize('reason', ['disconnected', 'shutdown'])
def test_runtime_cleanup_can_cancel_committed_attempt(gateway, reason):
    attempt = make_attempt(gateway)
    try:
        assert attempt.commit_if_active()
        assert attempt.cancel(reason=reason)
        assert attempt.is_set()
        assert not attempt.commit_if_active()
    finally:
        attempt.finish()


@pytest.mark.parametrize('gateway', [False, True])
def test_runtime_cancellation_prevents_commit(gateway):
    attempt = make_attempt(gateway)
    runtime = threading.Event()
    try:
        attempt.bind_runtime(runtime)
        runtime.set()
        assert attempt.wait(.01)
        assert not attempt.commit_if_active()
    finally:
        attempt.finish()


@pytest.mark.parametrize('gateway', [False, True])
def test_cancel_before_worker_binds_is_retained(gateway):
    attempt = make_attempt(gateway)
    try:
        attempt.cancel()
        attempt.bind_runtime(threading.Event())
        assert attempt.is_set()
        assert not attempt.commit_if_active()
    finally:
        attempt.finish()


def test_registry_is_scoped_and_rejects_duplicate_live_request():
    from app.ssh_connection_attempt import SSHAttemptRegistry
    registry = SSHAttemptRegistry()
    attempt = registry.create(1, 'sid', 'req')
    try:
        assert registry.get(1, 'sid', 'req') is attempt
        assert registry.get(2, 'sid', 'req') is None
        assert registry.get(1, 'other', 'req') is None
        assert registry.get(1, 'sid', 'other') is None
        with pytest.raises(ValueError):
            registry.create(1, 'sid', 'req')
        assert SSHAttemptRegistry().get(1, 'sid', 'req') is None
    finally:
        registry.finish(attempt)
    replacement = registry.create(1, 'sid', 'req')
    registry.finish(attempt)
    assert registry.get(1, 'sid', 'req') is replacement
    registry.finish(replacement)


def test_shutdown_cancels_all_and_prevents_new_attempts():
    from app.ssh_connection_attempt import SSHAttemptRegistry
    registry = SSHAttemptRegistry()
    a = registry.create(1, 'sid', None)
    b = registry.create(2, 'other', 'req')
    try:
        registry.cancel_socket('sid')
        assert a.is_set()
        assert not b.is_set()
        assert b.commit_if_active()
        registry.shutdown()
        assert b.is_set()
        with pytest.raises(ValueError):
            registry.create(3, 'new', 'req')
    finally:
        registry.finish(a)
        registry.finish(b)


@pytest.mark.parametrize('gateway', [False, True])
def test_cancel_retains_quota_and_handoff_preserves_session(gateway):
    released, closed = [], []
    class Reservation:
        def release(self): released.append(True)
    class Resource:
        def close(self): closed.append(self)
    attempt = make_attempt(gateway, reservation=Reservation())
    session, pending = Resource(), Resource()
    attempt.own(session)
    attempt.own(pending)
    attempt.handoff(session)
    attempt.cancel()
    assert released == []
    assert closed == [pending]
    attempt.finish()
    attempt.finish()
    assert released == [True]
    assert closed == [pending]

def test_base_attempt_has_no_implicit_timeout(monkeypatch):
    from app import ssh_connection_attempt
    attempt = make_attempt()
    started = ssh_connection_attempt.time.monotonic()
    try:
        monkeypatch.setattr(ssh_connection_attempt.time, 'monotonic', lambda: started + 600)
        assert not attempt.is_set()
        assert attempt.commit_if_active()
    finally:
        attempt.finish()


def test_interactive_admission_reserves_only_when_requested(monkeypatch):
    from app import ssh_connection_attempt
    from app.quota_manager import QuotaExceeded, QuotaKind, QuotaManager
    from app.ssh_gateway_interaction import GatewayAttempt
    quotas = QuotaManager({kind: {'global': 2, 'per_user': 1} for kind in QuotaKind})
    monkeypatch.setattr(ssh_connection_attempt, 'quota_manager', quotas)
    registry = ssh_connection_attempt.SSHAttemptRegistry()
    busy = quotas.reserve(QuotaKind.BACKGROUND_JOB, 1)
    ordinary = registry.create(1, 'sid', 'ordinary')
    try:
        with pytest.raises(QuotaExceeded):
            registry.create(1, 'sid', 'gateway', factory=GatewayAttempt,
                            emit=lambda *args: None, reserve=True)
        assert not ordinary.is_set()
        assert registry.get(1, 'sid', 'gateway') is None
    finally:
        registry.finish(ordinary)
        busy.release()
    gateway = registry.create(1, 'sid', 'gateway', factory=GatewayAttempt,
                              emit=lambda *args: None, reserve=True)
    gateway.cancel()
    with pytest.raises(QuotaExceeded):
        quotas.reserve(QuotaKind.BACKGROUND_JOB, 1)
    registry.finish(gateway)
    quotas.reserve(QuotaKind.BACKGROUND_JOB, 1).release()
