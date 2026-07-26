# Cosmosh MCP Server

> Status: in development. This page tracks the Cosmosh MCP feature as it lands phase by phase.

Cosmosh MCP exposes a local [Model Context Protocol](https://modelcontextprotocol.io/) server so external AI agents (Claude Code, Claude Desktop, Cursor, and other MCP clients) can use the servers a user has already configured in Cosmosh — without re-entering hosts or credentials anywhere else.

## Product rules

- The feature is **off by default** (`mcpEnabled` setting).
- **Opening an SSH connection always requires explicit user authorization** through a dialog in the Cosmosh window.
- Command execution is governed by a configurable policy (`mcpCommandPolicy`, global default `ask`) with a per-server override (`SshServer.mcpCommandPolicy`, default `default` = inherit):
  - `off` — agent commands are rejected.
  - `ask` — every command needs a confirmation dialog.
  - `allowWithinConnection` — the first command on a connection asks once; the user may allow the rest of that connection.
- Every MCP operation — client sessions, authorization decisions, connection lifecycle, every executed command — is written to the audit log under the `mcp` category.

## Contract groundwork (Phase 1)

- Shared types: `packages/api-contract/src/mcp.ts` (`McpCommandPolicy`, `McpServerCommandPolicy`, approval/event payloads).
- Settings: `mcpEnabled` (default `false`) and `mcpCommandPolicy` (default `ask`) in the settings registry, under the new `mcp` category.
- Persistence: `SshServer.mcpCommandPolicy` column and the `McpPairingToken` model (migration `20260726000100_mcp_pairing_and_policy`).
- Management REST endpoints under `/api/v1/mcp/*` in the OpenAPI contract (status, pairing token, clients, connections, approvals, events channel). The `/mcp` protocol endpoint itself is JSON-RPC over Streamable HTTP and is deliberately not part of the OpenAPI schema.

## Upcoming phases

1. Backend MCP runtime (`packages/backend/src/mcp/`): protocol sessions, SSH connection registry, approval broker, audit trail.
2. Renderer authorization dialogs and the MCP management panel.
3. `cosmosh-mcp` stdio bridge with a discovery file (`<userData>/mcp/bridge.json`) and client config generation.
4. Agent skill (`skills/cosmosh-mcp/`) and full documentation.
