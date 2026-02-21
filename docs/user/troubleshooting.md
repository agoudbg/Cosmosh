# Troubleshooting

## Cannot Create SSH Session

- Re-check server host, port, and username fields.
- Confirm the host is reachable from your machine.
- Confirm server SSH daemon is running.

## Host Fingerprint Prompt Blocks Progress

- Compare fingerprint value with a trusted source.
- Trust only after verification.
- If fingerprint changed unexpectedly, stop and verify with your infra owner.

## Authentication Failed

- Re-check password or private key path in your server entry.
- Verify key format and permissions.
- Confirm the account is allowed by server SSH policy.

## Terminal Display Issues

- Resize the terminal window.
- Reconnect the session.
- Restart the app if rendering remains inconsistent.

## Session Drops Frequently

- Check VPN, proxy, or unstable network routes.
- Test with another host to isolate host-specific issues.
- Reconnect and verify whether drops are time-based or command-triggered.

## Quick Triage Order

1. Verify host reachability and SSH service state.
2. Verify authentication material and host trust state.
3. Reproduce once with a minimal command path.

## Screenshot Placeholders

1. Fingerprint verification dialog state.
2. Authentication failure response state.
3. Session closed/error state in terminal view.
