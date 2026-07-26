---
name: cosmosh-mcp
description: Use the SSH servers a user has already configured in Cosmosh (a desktop SSH/terminal client) through its MCP server — list servers, open authorized SSH connections, run non-interactive commands, and close connections. Use this whenever the user asks you to inspect, operate on, or run commands against their remote hosts via Cosmosh, or when a `cosmosh` MCP server is connected. Never ask the user for SSH hosts, passwords, or keys — Cosmosh holds the credentials and every action is authorized and audited by the user.
---

# Cosmosh MCP

Cosmosh is a desktop SSH/terminal client. Its MCP server lets you use the SSH
servers the user has **already** configured — you never see or handle their
credentials. Every connection you open and (depending on policy) every command
you run is authorized by the user in the Cosmosh window and written to an audit
log. Work with that grain, not against it.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `list_servers` | `query?` (string, ≤200 chars — case-insensitive filter over name/host/username) | `{ servers, count }`. Each server: `serverId`, `name`, `host`, `port`, `username`, `commandPolicy`, `folder?`, `tags`, `note?`. Never any credentials. |
| `open_connection` | `serverId` (required), `reason?` (string, ≤500 chars) | `{ connection }` with a `connectionId`, or `{ error, message }`. **Always prompts the user** for authorization. |
| `list_connections` | *(none)* | `{ connections, count }` — connections currently open for you. |
| `run_command` | `connectionId` (required), `command` (required, ≤8192 bytes), `timeoutMs?` (≤120000, default 15000), `maxOutputBytes?` (≤1048576, default 262144) | `{ stdout, stderr, exitCode, exitSignal, truncated, timedOut, durationMs }`, or `{ error, message }`. May prompt per policy. |
| `close_connection` | `connectionId` (required) | `{ closed: true, connectionId }`. No prompt. |

## Authorization model — work with it

- **Opening a connection always requires a human click** in the Cosmosh window.
  There is no way to bypass it, and you should not try. Put a short, honest
  `reason` on every `open_connection` (e.g. `"check disk usage on web-01"`) — it
  is shown in the prompt and recorded in the audit log.
- **Command execution follows a policy** the user sets (globally, or per server;
  the effective value is each server's `commandPolicy` from `list_servers`):
  - `off` — commands are rejected. Don't retry; tell the user this server is
    read-only to agents and they can change it in Cosmosh's settings.
  - `ask` — every command needs a confirmation click.
  - `allowWithinConnection` — the first command on a connection prompts once; the
    user may pre-approve the rest of that connection.
- **A denied or timed-out request is a human "no", not a transient error.** Do
  **not** immediately retry or spam new prompts — that just buries the user in
  dialogs. Stop, report what was denied, and ask the user to check the Cosmosh
  window (a prompt only resolves while a Cosmosh window is open; with no window
  it times out to *denied* after 120 seconds).

## Working effectively

- **Reuse connections.** Call `list_connections` before `open_connection`; a
  server you already have open needs no second authorization. Connections are
  user-visible, application-level resources — they persist until closed and are
  auto-closed after 10 minutes idle (max 8 open at once).
- **Non-interactive commands only.** `run_command` runs one command and captures
  its output; it is not a shell session. No TUIs, pagers, prompts, `sudo`
  password entry, or long-lived processes. Redirect or pipe instead of paging
  (`... | cat`, not `less`).
- **Always check `exitCode` and `stderr`**, not just `stdout`. A non-zero
  `exitCode` means the command failed. If `truncated` is true the output hit
  `maxOutputBytes` — narrow the command (`head`, `grep`, `tail`) rather than
  blindly raising the cap. If `timedOut` is true, the command exceeded
  `timeoutMs` and was killed.
- **Close when done** with `close_connection` if you opened a connection for a
  one-off task, so the user's connection list stays clean.

## Error handling

`open_connection` / `run_command` return `{ error, message }` instead of
throwing. Handle each distinctly:

- `denied` / `timeout` — the user declined (or no window was open). Report it;
  do not retry automatically.
- `policy-off` — commands are disabled for this server. Surface it; the user
  changes it in Cosmosh, not you.
- `host-untrusted` — the host key isn't trusted yet. The user must connect to
  this server **once in Cosmosh** to trust the fingerprint; you can't approve
  host trust. Tell them so.
- `limit-reached` — 8 connections already open. Close idle ones first
  (`list_connections` → `close_connection`).
- `server-not-found` / `connection-not-found` — re-run `list_servers` /
  `list_connections`; the id is stale.
- `command-too-large` — the command exceeded 8192 bytes; shorten it.
- `failed` — an unexpected error; the `message` has detail.

If the whole MCP server is unreachable (Cosmosh not running, MCP disabled, or a
stale token), the bridge exits with a clear one-line error. Tell the user to
start Cosmosh and enable **Settings → MCP**; do not fabricate results.

## Ground rules

- Everything is audited. Never try to evade authorization, hide activity, or
  disable auditing.
- Never ask the user for SSH credentials — Cosmosh has them. If you find
  yourself wanting a password or private key, you're off the intended path.
- Prefer the smallest, most targeted command that answers the question.
