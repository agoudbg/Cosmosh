---
name: cosmosh-mcp
description: Use the SSH servers a user has already configured in Cosmosh through its MCP server — open visible Agent terminal tabs by default, explicitly request isolated background connections, attach user-selected existing SSH panes, run authorized commands, and close or detach connections. Use this whenever the user asks you to inspect, operate on, or run commands against their remote hosts via Cosmosh, or when a `cosmosh` MCP server is connected. Never ask the user for SSH hosts, passwords, keys, or internal terminal identifiers — Cosmosh holds those details and every action is authorized and audited by the user.
---

# Cosmosh MCP

Cosmosh is a desktop SSH/terminal client. Its MCP server lets you use the SSH
servers the user has **already** configured — you never see or handle their
credentials. Every connection you open and (depending on policy) every command
you run is authorized by the user in the Cosmosh window and written to an audit
log. Work with that grain, not against it.

## Tools

| Tool               | Input                                                                                                                                             | Returns                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_servers`     | `query?` (string, ≤200 chars — case-insensitive filter over name/host/username)                                                                   | `{ servers, count }`. Each server: `serverId`, `name`, `host`, `port`, `username`, `commandPolicy`, `folder?`, `tags`, `note?`. Never any credentials.                                                                        |
| `open_connection`  | `serverId` (required), `reason?` (string, ≤500 chars), `mode?` (`terminal` or `background`, default `terminal`)                                   | `{ connection }` with a `connectionId`, `mode`, `status`, `userVisible`, and `agentCreatedTab`, or `{ error, message }`. **Always prompts the user**.                                                                         |
| `attach_terminal`  | `reason?` (string, ≤500 chars)                                                                                                                    | `{ connection }` in `attached` mode, or `{ error, message }`. **Always prompts the user**, who selects an eligible SSH pane. You never receive a terminal list or internal id.                                                |
| `list_connections` | _(none)_                                                                                                                                          | `{ connections, count }` — connections currently open for you.                                                                                                                                                                |
| `run_command`      | `connectionId` (required), `command` (required, ≤8192 bytes), `timeoutMs?` (≤120000, default 15000), `maxOutputBytes?` (≤1048576, default 262144) | `background`: `{ mode, stdout, stderr, exitCode, exitSignal, truncated, timedOut, durationMs }`. `terminal`/`attached`: `{ mode, output, exitCode, truncated, timedOut, durationMs, userIntervened }`. May prompt per policy. |
| `close_connection` | `connectionId` (required)                                                                                                                         | `{ closed: true, connectionId }`. Closes background/Agent-created terminal connections; detaches an existing user pane. No prompt.                                                                                            |

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
  it times out to _denied_ after 120 seconds).

## Working effectively

- **Reuse connections.** Call `list_connections` before `open_connection`; a
  server you already have open needs no second authorization. Connections are
  client-owned resources with a shared maximum of 8.
- **Choose the mode deliberately.** Omit `mode` for the normal visible workflow:
  Cosmosh creates and focuses an Agent-marked SSH tab. Request `background` for
  isolated batch checks that require separate stdout/stderr and no UI tab.
  Request `attach_terminal` only when continuity with a user's existing cwd,
  environment, container, or login state is useful; the user chooses the pane.
- **Visible terminals are collaborative.** The command and output appear in
  xterm, and the user may type, paste, or press `Ctrl+C`. Treat
  `userIntervened=true` as material context. Do not assume exclusive control of
  the PTY or try to discover its internal identifiers.
- **Keep commands non-interactive and bounded.** Visible/shared commands must be
  one line with no control characters. Avoid TUIs, pagers, password prompts, and
  long-lived processes in every mode; use targeted output (`head`, `grep`,
  `tail`) when practical.
- **Always branch on `mode`.** Check `stderr` only for `background`; visible
  results use merged `output`. A non-zero `exitCode` is a remote failure.
  `truncated` means output collection hit its cap. For visible commands,
  `timedOut` means Cosmosh stopped waiting but did **not** kill the remote
  process; the connection stays busy until a trusted prompt returns.
- **Close when done** with `close_connection` if you opened a connection for a
  one-off task, so the user's connection list stays clean.

## Error handling

`open_connection` / `run_command` return `{ error, message }` instead of
throwing. Handle each distinctly:

- `denied` / `timeout` — the user declined (or no window was open). Report it;
  do not retry automatically.
- `audit-unavailable` — Cosmosh could not durably record the authorization.
  No remote action was performed. Report it and do not retry automatically.
- `policy-off` — commands are disabled for this server. Surface it; the user
  changes it in Cosmosh, not you.
- `host-untrusted` — the host key isn't trusted yet. The user must connect to
  this server **once in Cosmosh** to trust the fingerprint; you can't approve
  host trust. Tell them so.
- `limit-reached` — 8 connections already open. Close idle ones first
  (`list_connections` → `close_connection`).
- `terminal-launch-failed` — Cosmosh could not create or bind the approved
  visible tab. Report it; do not silently retry in background mode.
- `terminal-automation-unavailable` — trusted Remote Enhancements command
  automation is unavailable. Ask the user whether a new explicit `background`
  request is acceptable; never downgrade automatically.
- `terminal-not-ready` — the selected pane has no trusted ready prompt or has
  unsubmitted input. Let the user finish or clear the current line before a
  fresh request.
- `terminal-busy` — another command is active or a timed-out command has not
  returned to a trusted prompt. Wait for the user-visible command to finish.
- `no-eligible-terminal` — no existing SSH pane can be attached. Report it; the
  user may open/prepare a pane or approve a new `terminal` connection.
- `server-not-found` / `connection-not-found` — re-run `list_servers` /
  `list_connections`; the id is stale.
- `server-changed` — the server destination changed after the user approved it.
  No connection was attempted. Re-run `list_servers` and request fresh approval.
- `command-too-large` — the command exceeded 8192 bytes; shorten it.
- `invalid-terminal-command` — a visible/shared command contains a newline,
  NUL, or another control character. Use one plain command line.
- `failed` — Cosmosh could not open or maintain the SSH command channel; the
  `message` has detail. This differs from a remote command's non-zero exit code.

If the whole MCP server is unreachable (Cosmosh not running, MCP disabled, or a
stale token), the bridge exits with a clear one-line error. Tell the user to
start Cosmosh and enable **Settings → MCP**; do not fabricate results.

## Ground rules

- Everything is audited. Never try to evade authorization, hide activity, or
  disable auditing.
- Never request or infer Cosmosh tab, pane, terminal-session, launch, WebSocket,
  token, or credential identifiers. They are intentionally outside the MCP
  contract.
- Never ask the user for SSH credentials — Cosmosh has them. If you find
  yourself wanting a password or private key, you're off the intended path.
- Prefer the smallest, most targeted command that answers the question.
