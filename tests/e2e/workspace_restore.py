"""Remote-operation fixtures; authentication, restoration and transport stay real."""
import time
import uuid
from flask import request
from flask_login import current_user


def register_workspace_restore(socketio):
    from app import ssh_manager, sftp_handler, session_insights, runtime_inventory
    from app.models import SSHSession, db

    fixture_owners = {}
    fixture_transports = {}

    def override(module, name, replacement):
        original = getattr(module, name)

        def dispatch(session_id, *args, **kwargs):
            if session_id in fixture_owners:
                return replacement(session_id, *args, **kwargs)
            return original(session_id, *args, **kwargs)

        setattr(module, name, dispatch)

    class Listing:
        def read_page(self, _page_size):
            return [{'name': 'reload-proof.txt', 'size': 12, 'mode': 0o100644,
                     'is_dir': False, 'is_symlink': False, 'modified': 1}], None, False

        def close(self):
            pass

    override(sftp_handler, 'probe_sftp_capability', lambda _id: True)
    override(sftp_handler, 'get_home_directory', lambda _id: ('/home/fixture', None))
    override(sftp_handler, 'open_directory_listing', lambda _id, _path: (Listing(), None))
    override(session_insights, 'collect_linux_stats', lambda _id, **_kwargs: ({
        'cpu': [200, 0, 150, 950], 'os_name': 'Reload fixture Linux',
        'uptime_seconds': 3600,
        'memory': {'total_kib': 1024, 'used_kib': 512, 'available_kib': 512},
        'disk': {'total_kib': 1024, 'used_kib': 512, 'available_kib': 512, 'percent': 50},
    }, None))
    override(runtime_inventory, 'collect_runtime_inventory', lambda _id: ({
        'systemd': {'state': 'running', 'total': 0, 'services': []},
    }, None))

    class Channel:
        def resize_pty(self, **_kwargs):
            pass

        def close(self):
            pass

    @socketio.on('e2e_workspace_restore')
    def seed(data):
        if not current_user.is_authenticated:
            return {'ok': False}
        count = data.get('count', 1)
        if type(count) is not int or not 0 <= count <= 12:
            return {'ok': False}
        # Replace only this test user's fixture sessions, never other test state.
        for session_id, owner in list(fixture_owners.items()):
            if owner == current_user.id:
                with ssh_manager.sessions_lock:
                    ssh_manager.sessions.pop(session_id, None)
                SSHSession.query.filter_by(session_id=session_id, user_id=owner).delete()
                del fixture_owners[session_id]
        # Polling transports from an unloaded document can linger until heartbeat
        # expiry. Retire only the exact transport captured by this fixture.
        from app.socket_events import disconnect_engineio_transport
        current_transport = socketio.server.manager.eio_sid_from_sid(request.sid, '/')
        previous_transport = fixture_transports.pop(current_user.id, None)
        if previous_transport and previous_transport != current_transport:
            disconnect_engineio_transport(socketio.server, previous_transport)
        if count:
            fixture_transports[current_user.id] = current_transport
        ids = []
        for _ in range(count):
            session_id = str(uuid.uuid4())
            fixture_owners[session_id] = current_user.id
            with ssh_manager.sessions_lock:
                ssh_manager.sessions[session_id] = {
                    'host': 'reload-fixture.local', 'port': 22, 'username': 'fixture',
                    'connected': True, 'user_id': current_user.id, 'client': None,
                    'channel': Channel(), 'last_activity': time.time(),
                    'output_buffer': ['restore fixture ready\r\n$ '], 'output_sequence': 1,
                }
            db.session.add(SSHSession(session_id=session_id, user_id=current_user.id,
                                      host='reload-fixture.local', port=22, username='fixture'))
            ids.append(session_id)
        db.session.commit()
        return {'ok': True, 'session_ids': ids}
