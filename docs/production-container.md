# Production container boundaries

Use Docker Compose 2.24.4 or newer and set `WEBSSH_ORIGIN` to the exact public
HTTPS origin before starting the base file with `docker-compose.production.yml`.
The production overlay binds port 5000 to loopback for an HTTPS reverse proxy.

```bash
export WEBSSH_ORIGIN=https://ssh.example.com
docker compose -f docker-compose.yml -f docker-compose.production.yml config
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d
```

The application runs as UID/GID 1000 with a read-only root filesystem, all Linux
capabilities dropped and `no-new-privileges` enabled. Writable locations are:

| Path | Purpose | Lifetime |
| --- | --- | --- |
| `/app/data` | Database, generated secret, user files and application temporary files | Persistent data volume |
| `/app/recovery` | Backup operations, restore staging and rollback copies in a private per-instance directory | Persistent recovery volume |
| `/tmp` | General temporary files | 128 MiB tmpfs, cleared on container recreation |
| `/run/webssh` | Private Gunicorn runtime/control socket directory | 1 MiB tmpfs, UID/GID 1000, mode 0700 |

Both tmpfs mounts disable execution, device nodes and set-user-ID behavior.
`XDG_RUNTIME_DIR=/run/webssh` keeps Gunicorn runtime files off the read-only root.
Keep the data and recovery volumes writable by UID 1000. Recovery storage must
be outside the data directory, static files and logs; a restore also rejects
recovery storage overlapping its actual destination. Provision disk space for
the archive, extracted files and rollback copies. Restore writes use the data
volume's atomic file-copy path, so recovery can reside on a separate filesystem.
Do not move recovery storage onto the small temporary mounts. CLI restore still
requires a stopped application and the explicit offline acknowledgement.

The default container budget is **512 tasks (processes and threads)** and
**2 GiB memory**. Override `WEBSSH_PIDS_LIMIT` and `WEBSSH_MEMORY_LIMIT` in the
Compose environment when measured workloads require it, then inspect the merged
configuration and recreate the service. These are resource ceilings, not a
concurrency guarantee. Keep exactly one Gunicorn worker; the defaults of 64
Gunicorn threads and 48 socket connections leave HTTP capacity available.
SSH transport threads, background work, transfers and tmpfs contents also consume
resources. Monitor memory/OOM events and task counts under expected load before
raising application concurrency. Existing application quotas remain necessary.
The 40-second stop grace period allows bounded application shutdown to finish.

## Optional authentication and networking

For LDAP, merge files in this order:

```bash
docker compose -f docker-compose.yml -f docker-compose.ldap.yml -f docker-compose.production.yml config
docker compose -f docker-compose.yml -f docker-compose.ldap.yml -f docker-compose.production.yml up -d
```

Configure LDAP and initialize secrets using [the LDAP guide](ldap-authentication.md)
first. `/run/webssh-auth` remains a separate read-only secret-volume mount; it is
not covered by `/run/webssh`. Only the explicitly invoked `ldap-tools` helper
writes those secrets. The production resource limits apply to the WebSSH service.

The base/production overlay does not create a Tailscale interface or daemon.
[Tailscale SSH](tailscale-ssh.md) needs its documented kernel interface and shared
network namespace plus explicit user, target and remote-user allowlists. Keep
TUN devices and networking capabilities in the separate Tailscale service;
do not add them to WebSSH. A custom sidecar deployment must move published ports
to the namespace-owning sidecar and retain WebSSH's filesystem and resource
restrictions. Production target policy and interface checks still apply.

## Disposable runtime verification

`scripts/check_hardened_container.py --image IMAGE --revision COMMIT_SHA
--platform linux/amd64` checks the image revision, readiness, filesystem/process
restrictions, temporary writes, online backup, offline restore, SQLite integrity,
restart and graceful shutdown. Use `linux/arm64` for the other release platform.
The helper creates anonymous volumes and uniquely labelled disposable containers,
and checks ownership before removing them. It does not use deployment data.
This is a functional smoke test; it does not establish a load-tested capacity.
