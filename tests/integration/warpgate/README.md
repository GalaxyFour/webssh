# Disposable Warpgate reference tests

Run `tests/integration/test_warpgate.py` serially against a dedicated local
Warpgate 0.29.0 instance and an OpenSSH target. The fixture must listen only on
loopback and contain synthetic accounts. Never point these tests at an existing
gateway: they change the fixture user's SSH credential policy and the target's
approval requirement, restoring both afterwards. The host-key test temporarily
removes and restores only the disposable target's trusted keys.

No application Compose changes are needed. Test prerequisites:

- Warpgate 0.29.0, with its published binary checksum verified.
- A local OpenSSH daemon on an unprivileged loopback port, with a disposable host
  key, the gateway's public client key in a temporary authorized-keys file,
  PTY/exec and SFTP enabled, and two session channels allowed.
- A Warpgate user with a synthetic password and a known TOTP secret; a role
  granting that user access to the SSH target; the target's host key reviewed and
  trusted in the disposable gateway.
- A test-only Warpgate admin token, its exact TLS certificate, and a pinned public
  gateway SSH host key. No trust-all host-key policy is used by the suite.

Create an ignored JSON fixture description (for example under `.test-tmp/`):

```json
{
  "disposable": true,
  "host": "127.0.0.1",
  "port": 12222,
  "sftp_only_port": 12224,
  "selector": "probe:probe",
  "password": "<synthetic password>",
  "api_url": "https://127.0.0.1:18443/@warpgate/admin/api",
  "certificate": "<absolute path to the disposable TLS certificate>",
  "admin_token": "<disposable admin token>",
  "user_id": "<fixture user UUID>",
  "target_id": "<fixture target UUID>",
  "otp_secret_hex": "<hexadecimal bytes of the fixture TOTP secret>",
  "host_key_type": "ssh-ed25519",
  "host_key": "<base64 public gateway host key>"
}
```

For the optional SFTP-only case, run a second loopback OpenSSH daemon on
`sftp_only_port` with the same generated host key and `ForceCommand internal-sftp`.
PTY requests and two channels must remain allowed. Omit that field to skip it.

Set `WEBSSH_WARPGATE_FIXTURE` to that file and run:

```sh
python -m pytest tests/integration/test_warpgate.py -q
```

Without this variable, these integration tests skip. They cover password, OTP,
key and combined factor policies; terminal and SFTP readiness; pending admin and
browser approval cancellation; successful administrator approval; explicit target
host-key confirmation; SFTP-only targets; and changed gateway host-key rejection. Browser
approval completion through a real identity provider requires a separate
deployment-specific acceptance test.
