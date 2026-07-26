# MCP Access for AI Agents

Cosmosh can act as a bridge between your AI agent (Claude Code, Claude Desktop, Cursor, and other MCP clients) and the SSH servers you have already added. The agent works through Cosmosh, so it never sees your passwords or keys, you approve every connection, and every action is recorded in your audit log.

MCP access is **off by default**. Nothing is exposed until you turn it on.

## What an Agent Can Do

Once connected, an agent can:

- **List your servers** — names, hosts, and usernames only; never credentials.
- **Open a connection** — but only after you approve it in a Cosmosh dialog.
- **Run commands** on a connection it has opened, subject to your command policy.
- **Close connections** it opened.

An agent can never read your stored passwords or private keys, add or edit servers, or trust a new host fingerprint on your behalf.

## Turn On MCP Access

1. Open `Settings > MCP`.
2. Enable `MCP Access`.
3. Open the `MCP` tab (from the header or the sidebar) to see the status panel.

While MCP is enabled, Cosmosh keeps a small local file that lets the bridge find the running app. Turning MCP off removes it.

## Connect Your Agent

1. In the `MCP` tab, find the `Client Configuration` card.
2. Choose the flavor that matches your client:
   - `.mcp.json` — for Claude Code (and Cursor).
   - `claude_desktop_config.json` — for Claude Desktop.
   - `Raw command` — for clients that ask for a command separately.
3. Copy the snippet and paste it into your client's MCP configuration, then restart the client if it needs it.

The snippet points at a small launcher Cosmosh installs for you, so there are no ports or tokens to copy by hand. Client configuration is generated for installed (packaged) builds.

## The Pairing Token

Agents authenticate to Cosmosh with a **pairing token**. You manage it from the `Pairing Token` card in the `MCP` tab:

- **Rotate** — issues a new token and invalidates the old one. The plaintext is shown **once** — copy it if a client needs it directly. (The generated client config uses the launcher and does not require you to paste the token.)
- **Revoke** — invalidates the current token immediately, cutting off connected agents on their next request.

Rotate or revoke any time you suspect a client should no longer have access.

## Approving Connections and Commands

- **Opening a connection always asks you first.** A dialog shows which agent is asking, which server, and the reason it gave. Nothing connects until you approve.
- **Commands follow a policy** you choose in `Settings > MCP`, with an optional per-server override on each server's edit form:
  - `Off` — the agent cannot run commands on that server.
  - `Ask` (default) — you confirm every command.
  - `Allow within connection` — you confirm the first command on a connection, then may allow the rest for that connection.

Authorization dialogs only appear while a Cosmosh window is open. If you are away and a request is not answered within two minutes, it is automatically denied.

## Keep an Eye on Activity

- The `MCP` tab lists connected clients, active connections (each closable), and any pending authorization requests.
- Every MCP action is written to your audit log. Open `Audit Logs` and filter by the `MCP` category to review connections, commands, and authorization decisions.

## Turn It Off

Disable `MCP Access` in `Settings > MCP` at any time. Connected agents are disconnected, active connections are closed, and the discovery file is removed. You can also revoke the pairing token to cut off access without changing the setting.

## Screenshot Placeholders

1. `Settings > MCP` with the `MCP Access` switch and command policy.
2. The `MCP` tab status panel (enabled, connected clients, active connections).
3. The `Client Configuration` card showing a `.mcp.json` snippet.
4. A connection authorization dialog.
5. A command authorization dialog with the full command shown.
6. `Audit Logs` filtered to the `MCP` category.
