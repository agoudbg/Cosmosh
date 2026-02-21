# Getting Started

This page walks you through the fastest practical path from first launch to a stable SSH session in Cosmosh.

## Before You Start

- A host you can access by SSH (`host`, `port`, `username`).
- Authentication material (password or private key).
- Network route from your machine to the target host.

## 5-Minute First Session

1. Download and install Cosmosh from GitHub Releases.
2. Open Cosmosh and go to the server creation flow.
3. Create one server entry with host, port, username, and auth method.
4. Save the server and start an SSH session.
5. If fingerprint verification appears, verify then trust the host.
6. Run a safe command such as `pwd` or `uname -a` to confirm connectivity.

## Recommended Setup After First Login

- Add a naming convention for server entries (for example `env-region-role`).
- Group hosts by environment to reduce mistakes in daily operations.
- Close the session explicitly when done.

## Screenshot Placeholders

1. App home with server list visible.
2. Server create form with required fields.
3. First successful SSH session prompt.

## Next Reads

- [Install & Setup](./install-and-setup.md)
- [Troubleshooting](./troubleshooting.md)
- [FAQ](./faq.md)
