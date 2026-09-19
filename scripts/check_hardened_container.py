"""Exercise a disposable image with the production filesystem restrictions."""

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request
from uuid import uuid4


PROBE = r'''
import errno
import os
from pathlib import Path
import tempfile
from app.online_backup import create_online_backup
from app.storage_utils import atomic_write_json

try:
    Path('/app/.hardening-probe').write_text('must not succeed')
except OSError as error:
    assert error.errno == errno.EROFS, error
else:
    raise AssertionError('Application root is writable')
status = Path('/proc/self/status').read_text()
assert 'CapEff:\t0000000000000000' in status
assert 'NoNewPrivs:\t1' in status
with tempfile.TemporaryFile() as handle:
    handle.write(b'temporary upload/export data')
    handle.seek(0)
    assert handle.read() == b'temporary upload/export data'
data = Path('/app/data')
assert len((data / 'secret_key').read_text().strip()) >= 64
atomic_write_json(data / 'hardening-probe.json', {'state': 'before'})
(data / 'tmp').mkdir(exist_ok=True)
atomic_write_json(data / 'tmp' / 'transfer-probe.json', {'temporary': True})
create_online_backup(data, Path('/app/recovery/hardening.zip'))
print('Read-only root, process restrictions, temporary storage and online backup passed')
'''

RESTORE = r'''
import json
from pathlib import Path
import sqlite3
from app.backup_manager import restore_backup
from app.storage_utils import atomic_write_json

data = Path('/app/data')
atomic_write_json(data / 'hardening-probe.json', {'state': 'changed'})
(data / 'extra-after-backup.txt').write_text('remove during restore')
restore_backup('/app/recovery/hardening.zip', data)
assert json.loads((data / 'hardening-probe.json').read_text()) == {'state': 'before'}
assert not (data / 'extra-after-backup.txt').exists()
assert (data / 'tmp' / 'transfer-probe.json').exists()
with sqlite3.connect(data / 'app.db') as database:
    assert database.execute('PRAGMA quick_check').fetchone() == ('ok',)
print('Offline restore and SQLite verification passed')
'''


def docker(*args, capture=True):
    result = subprocess.run(['docker', *args], check=True, text=True,
                            capture_output=capture)
    return result.stdout.strip() if capture else ''


def wait_ready(container):
    binding = docker('port', container, '5000/tcp').splitlines()[0]
    url = f"http://127.0.0.1:{binding.rsplit(':', 1)[1]}/ready"
    for _ in range(90):
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(1)
    raise RuntimeError('Hardened container did not become ready')


def check_image(image, revision, platform):
    owner = uuid4().hex
    label = 'webssh.hardening-test'
    containers = []
    restrictions = [
        '--platform', platform, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '512',
        '--memory', '2g', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777',
        '--tmpfs', '/run/webssh:rw,noexec,nosuid,nodev,size=1m,uid=1000,gid=1000,mode=700',
        '--label', f'{label}={owner}',
    ]
    environment = []
    for key, value in {
        'DEPLOYMENT_PROFILE': 'production', 'CORS_ORIGINS': 'https://localhost',
        'XDG_RUNTIME_DIR': '/run/webssh',
        'ALLOW_CORS_WILDCARD': 'false', 'SESSION_COOKIE_SECURE': 'true',
        'REGISTRATION_ENABLED': 'false', 'BOOTSTRAP_REGISTRATION_ENABLED': 'false',
        'BLOCK_INTERNAL_SSH': 'true', 'TRUSTED_PROXIES': '1',
        'BACKUP_TEMP_DIR': '/app/recovery', 'BACKUP_RECOVERY_DURABLE': 'true',
    }.items():
        environment.extend(['--env', f'{key}={value}'])
    try:
        container = docker('create', *restrictions, *environment,
                           '--volume', '/app/recovery', '--publish', '127.0.0.1::5000', image)
        containers.append(container)
        actual_revision = docker('inspect', '--format',
                                 '{{ index .Config.Labels "org.opencontainers.image.revision" }}', container)
        if actual_revision != revision:
            raise ValueError('Hardened runtime candidate has the wrong revision')
        docker('start', container)
        wait_ready(container)
        docker('exec', container, '/app/entrypoint.sh', 'python', '-c', PROBE, capture=False)
        docker('stop', '--time', '35', container)
        if docker('inspect', '--format', '{{.State.ExitCode}}', container) != '0':
            raise RuntimeError('Hardened container did not shut down cleanly')

        # Restore against the real data volume only after its server stopped.
        restore = docker('create', *restrictions, *environment,
                         '--volumes-from', container, image, 'python', '-c', RESTORE)
        containers.append(restore)
        docker('start', '--attach', restore, capture=False)
        if docker('inspect', '--format', '{{.State.ExitCode}}', restore) != '0':
            raise RuntimeError('Offline restore failed under production restrictions')
        docker('start', container)
        wait_ready(container)
        docker('stop', '--time', '35', container)
        if docker('inspect', '--format', '{{.State.ExitCode}}', container) != '0':
            raise RuntimeError('Restored container did not shut down cleanly')
        print(f'Hardened startup, backup, restore, restart and shutdown passed: {platform}')
    except Exception:
        for container in containers:
            subprocess.run(['docker', 'logs', '--tail', '40', container], check=False)
        raise
    finally:
        for container in reversed(containers):
            actual_owner = docker('inspect', '--format',
                                 '{{ index .Config.Labels "' + label + '" }}', container)
            if actual_owner != owner:
                raise RuntimeError('Refusing cleanup of an unrelated container')
            docker('rm', '--force', '--volumes', container)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--platform', default='linux/amd64', choices=('linux/amd64', 'linux/arm64'))
    args = parser.parse_args()
    check_image(args.image, args.revision, args.platform)


if __name__ == '__main__':
    main()
