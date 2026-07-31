# MCP Access for AI Agents

Cosmosh can act as a bridge between your AI agent (Claude Code, Claude Desktop, Cursor, and other MCP clients) and the SSH servers you have already added. The agent works through Cosmosh, so it never sees your passwords or keys, you approve every connection, and every action is recorded in your audit log.

MCP access is **off by default**. Nothing is exposed until you turn it on.

## What an Agent Can Do

Once connected, an agent can:

- **List your servers** — names, hosts, and usernames only; never credentials.
- **Open a visible SSH tab** — the default mode creates and focuses a normal Cosmosh terminal after you approve it.
- **Run an isolated background command connection** — only when the agent explicitly asks for background mode.
- **Attach an existing SSH pane** — you select the pane; the Agent never receives your terminal list or Cosmosh's internal tab, pane, or session ids.
- **Run commands** on a connection it has opened, subject to your command policy.
- **Close connections** it opened.

An agent can never read your stored passwords or private keys, add or edit servers, or trust a new host fingerprint on your behalf.

## Turn On MCP Access

1. Open `Settings > MCP`.
2. Enable `MCP Access`.
3. Optionally enable `Require Approval to List Servers` if agents should ask before viewing configured server metadata.
4. Use the pairing, client-configuration, connected-client, connection, and approval sections on the same page.

While MCP is enabled, Cosmosh keeps a small local file that lets the bridge find the running app. Turning MCP off removes it.

## Connect Your Agent

1. In `Settings > MCP`, find the `Client Configuration` section.
2. Choose the flavor that matches your client:
   - `.mcp.json` — for Claude Code (and Cursor).
   - `claude_desktop_config.json` — for Claude Desktop.
   - `Raw command` — for clients that ask for a command separately.
3. Copy the snippet and paste it into your client's MCP configuration, then restart the client if it needs it.

The snippet points at a small launcher Cosmosh installs for you, so there are no ports or tokens to copy by hand. Client configuration is generated for installed (packaged) builds.

## The Pairing Token

Agents authenticate to Cosmosh with a **pairing token**. You manage it from the `Pairing Token` section in `Settings > MCP`:

- **Rotate** — issues a new token and invalidates the old one. The plaintext is shown **once** — copy it if a client needs it directly. (The generated client config uses the launcher and does not require you to paste the token.)
- **Revoke** — invalidates the current token immediately, cutting off connected agents on their next request.

Rotate or revoke any time you suspect a client should no longer have access.

## Approving Server Lists, Connections, and Commands

- **Listing servers can ask you first.** Enable `Require Approval to List Servers` in `Settings > MCP` to require a dialog before an agent can view server names, hosts, usernames, folders, tags, or notes. The setting is off by default.
- **Opening a connection always asks you first.** A dialog shows which agent is asking, which server, and the reason it gave. Nothing connects until you approve.
- A normal open defaults to a visible Agent-marked SSH tab and focuses it immediately after approval. A request marked `Background` stays out of the tab strip and uses isolated command execution.
- **Attaching a terminal also asks you first.** The selector starts on the current eligible SSH pane and lists other SSH panes. A disabled pane shows why it cannot be shared, such as not being ready, missing trusted Remote Enhancements, or already belonging to another Agent.
- Cosmosh verifies that the server name, host, port, and username still match the dialog immediately before connecting. If the server changed, the request is stopped and the agent must ask again.
- **Commands follow a policy** you choose in `Settings > MCP`, with an optional per-server override on each server's edit form:
  - `Off` — the agent cannot run commands on that server.
  - `Ask` (default) — you confirm every command.
  - `Allow within connection` — you confirm the first command on a connection, then may allow the rest for that connection.

Policy changes apply to the next command. Editing a server also clears any existing `Allow within connection` approval for that connection.

Authorization dialogs only appear while a Cosmosh window is open. If you are away and a request is not answered within two minutes, it is automatically denied.

Cosmosh records each authorization request and decision before acting on it. If the local audit log is unavailable, the request is rejected and no remote action is performed.

## Working in a Shared Terminal

- An attached pane remains your terminal. You can type, paste, or press `Ctrl+C` while an Agent command is running; Cosmosh reports that intervention to the Agent.
- The compact status bar above the pane shows the Agent name, whether it is idle or running, and that visible output is being shared. **Stop** sends ordinary `Ctrl+C`; **Detach** removes Agent access without closing the terminal.
- Agent cancellation or timeout does not automatically interrupt the remote process. The process remains visible and the connection stays busy until the trusted shell prompt returns.
- Raw keyboard input is not returned to the Agent or written to MCP audit metadata. Text echoed by the remote program is normal terminal output and may be included in the Agent's command result.
- Shared-terminal automation requires trusted Remote Enhancements. If that capability is unavailable, Cosmosh rejects the operation instead of silently switching it to background mode. Local terminals cannot be attached in this version.

## Keep an Eye on Activity

- `Settings > MCP` lists connected clients, active connections with their mode/status, and pending authorization requests. Closing an attached connection detaches it; explicitly closing an Agent-created terminal connection closes its tab.
- Every MCP action is written to your audit log. Open `Audit Logs` and filter by the `MCP` category to review connections, commands, and authorization decisions.

## Turn It Off

Disable `MCP Access` in `Settings > MCP` at any time. Connected agents are disconnected, background connections are closed, visible attachments are removed, and their SSH tabs remain as ordinary user tabs. The discovery file is removed. Revoking the pairing token has the same visible-terminal preservation rule.

## Screenshot Placeholders

1. `Settings > MCP` with access controls, pairing, connected clients, and active connections.
2. The `Client Configuration` section showing a `.mcp.json` snippet.
3. A connection authorization dialog.
4. An attach-terminal selector showing eligible and disabled SSH panes.
5. An attached pane status bar and Agent-marked tab.
6. A command authorization dialog with the full command shown.
7. `Audit Logs` filtered to the `MCP` category.
