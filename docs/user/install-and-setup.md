# Install & Setup

## Install

Download packages from GitHub Releases:

- https://github.com/agoudbg/cosmosh/releases

### Windows

1. Download the `.exe` installer from the latest release.
2. Run the installer and complete setup.
3. Start Cosmosh from desktop or start menu.

### macOS

1. Download the macOS build from the latest release (for your chip architecture).
2. Move the app to `Applications`.
3. Start Cosmosh from Launchpad or Applications.

### Linux

1. Download the Linux package from the latest release (format depends on release artifact).
2. Install using your distro package workflow.
3. Start Cosmosh from application launcher or terminal.

## First Configuration

- Set your preferred language.
- Prepare at least one SSH target and credential method.
- Verify your private key file path if using key authentication.

## Connection Readiness Checklist

- Confirm host and port are reachable from your current network.
- Confirm server-side SSH service is running.
- Confirm account permissions are sufficient for intended commands.

## Security Setup

- Keep private keys protected and avoid sharing key files.
- Verify host fingerprints before trusting unknown hosts.
- Use principle-of-least-privilege accounts for remote connections.

## If Setup Fails

- Use [Troubleshooting](./troubleshooting.md) for targeted recovery paths.

## Recommended Verification After Install

1. Launch Cosmosh successfully.
2. Create one test server profile.
3. Open one SSH session and run `echo COSMOSH_OK`.
4. Close session explicitly to confirm lifecycle behavior.

## Screenshot Placeholders

1. Release page showing downloadable artifacts.
2. Installer completion screen.
3. First launch and language/setup entry view.
