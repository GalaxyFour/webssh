# Warpgate SSH connections

Connect to an existing Warpgate SSH endpoint using an ordinary WebSSH profile:

1. Enter the gateway hostname and SSH port.
2. Enter the exact Warpgate selector, for example `alice@example.com:production`, as the username.
3. Choose **Password** or an existing **SSH key**. With Password, leave the password empty to start interactive authentication.
4. Respond to additional authentication prompts. Browser approval links open only when clicked. Return to WebSSH and continue after approval.
5. Review any target host-key or access-approval prompt in the temporary gateway terminal.

No additional service, Compose setting, database migration, or dependency is required. Ordinary SSH, existing jump hosts and Tailscale connections keep their existing paths. A normal SSH jump host may precede a gateway terminal connection; Quick SFTP does not add jump-host or Tailscale support.

## Security and compatibility boundaries

- Selectors opt in to a separate authentication path. They do not identify a server as trustworthy; existing per-user gateway host-key checks and network restrictions still apply.
- The gateway controls access to its targets. WebSSH's network policy checks the gateway endpoint, not the destination hidden behind it.
- Passwords, additional factors and approval responses are transient. They are never stored in profiles. Additional factors are explicitly answered; the original password is never reused as an OTP.
- Each interaction belongs to one WebSSH user, socket and request. Challenges are one-shot, deadlines and byte limits are enforced, and pending gateway jobs share the existing background-job quota.
- Warpgate target host-key checks and approval policies remain enabled. There is no automatic target host-key acceptance.
- Terminal setup requires a target supporting a PTY and a bounded `echo` exec probe. Only after the nonce response and successful exit does WebSSH run normal terminal/tmux setup or configured startup commands.
- Quick SFTP uses a temporary PTY for gateway prompts and a separate SFTP channel. Targets must permit those two channels during setup; PTY-disabled or single-channel targets are not supported by this path.
- Existing profile auth types remain unchanged. Older WebSSH versions can read the profile document, but cannot connect using the new selector syntax.
- Ticket secrets, `#` selectors, automatic target discovery, gateway administration and non-SSH protocols are not supported.

The reference implementation is tested against Warpgate 0.29.0 and Paramiko 5.0.0. The gateway-only transport uses Paramiko's `ServiceRequestingTransport` so multi-factor authentication requests the SSH authentication service once. Its initial service wait is explicitly bounded; the small compatibility override must be rechecked when upgrading Paramiko.

Cancel closes an unfinished gateway attempt. Once the existing startup/session commit boundary has been crossed, the ordinary WebSSH cancellation contract applies.
