"""Exercise the real directory probe against a disposable local tmux server."""

import shlex
import shutil
import subprocess
import sys
import time

import pytest

from app import session_directory


@pytest.mark.skipif(
    sys.platform != 'linux' or not shutil.which('tmux') or not shutil.which('bash'),
    reason='Requires local Linux tmux and bash',
)
def test_tmux_probe_follows_folders_and_rejects_copy_and_application_modes(tmp_path):
    tmux = ['tmux', '-S', str(tmp_path / 'sync.sock'), '-f', '/dev/null']

    def run(*args):
        return subprocess.run([*tmux, *args], capture_output=True, check=True, timeout=5)

    def send(command):
        run('send-keys', '-t', '=sync:', '-l', command)
        run('send-keys', '-t', '=sync:', 'Enter')

    def until(predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        pytest.fail('Disposable tmux pane did not reach the expected state')

    command = session_directory.probe_command({'use_tmux': True, 'tmux_session_name': 'sync'})
    script = shlex.split(command)[3].replace('tmux display-message', shlex.join(tmux) + ' display-message')

    def probe():
        result = subprocess.run(['sh', '-c', script], capture_output=True, timeout=5)
        return session_directory.parse_directory(result.stdout) if result.returncode == 0 else None

    def ready_at(path):
        result = probe()
        return result and result['shell_ready'] and result['path'] == str(path)

    run('new-session', '-d', '-s', 'sync', '-c', str(tmp_path), 'bash --noprofile --norc')
    try:
        until(lambda: ready_at(tmp_path))
        for name in ['first', "second with ' quote"]:
            folder = tmp_path / name
            folder.mkdir()
            send('cd -- ' + shlex.quote(str(folder)))
            until(lambda: ready_at(folder))

        run('copy-mode', '-t', '=sync:')
        assert probe() is None
        run('send-keys', '-t', '=sync:', '-X', 'cancel')
        until(lambda: ready_at(folder))

        send('sleep 30')
        until(lambda: (result := probe()) is not None and not result['shell_ready'])
        run('send-keys', '-t', '=sync:', 'C-c')
        until(lambda: ready_at(folder))

        send("printf '\\033[?1049h'")
        until(lambda: run('display-message', '-p', '-t', '=sync:', '#{alternate_on}').stdout.strip() == b'1')
        assert probe() is None
    finally:
        subprocess.run([*tmux, 'kill-server'], capture_output=True, timeout=5)
