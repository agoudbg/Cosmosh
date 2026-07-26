# Cosmosh MCP 服务器

> 状态：开发中。本页跟踪 Cosmosh MCP 功能的分阶段落地进展。

Cosmosh MCP 暴露一个本地 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器，让外部 AI Agent（Claude Code、Claude Desktop、Cursor 及其他 MCP 客户端）可以直接使用用户已在 Cosmosh 中配置好的服务器——无需在其他地方重新录入主机或凭据。

## 产品规则

- 功能**默认关闭**（`mcpEnabled` 设置项）。
- **建立 SSH 连接始终需要用户在 Cosmosh 窗口中通过对话框显式授权**。
- 命令执行由可配置策略约束（全局 `mcpCommandPolicy`，默认 `ask`），每台服务器可覆盖（`SshServer.mcpCommandPolicy`，默认 `default` 即继承全局）：
  - `off` — 拒绝 Agent 命令。
  - `ask` — 每条命令都需要确认对话框。
  - `allowWithinConnection` — 连接内首条命令确认一次，用户可选择放行该连接内的后续命令。
- 所有 MCP 操作——客户端会话、授权决定、连接生命周期、每条已执行的命令——都会以 `mcp` 类别写入审计日志。

## 契约地基（Phase 1）

- 共享类型：`packages/api-contract/src/mcp.ts`（`McpCommandPolicy`、`McpServerCommandPolicy`、授权/事件载荷）。
- 设置项：设置注册表新增 `mcp` 分类下的 `mcpEnabled`（默认 `false`）与 `mcpCommandPolicy`（默认 `ask`）。
- 持久化：`SshServer.mcpCommandPolicy` 列与 `McpPairingToken` 模型（迁移 `20260726000100_mcp_pairing_and_policy`）。
- OpenAPI 契约新增 `/api/v1/mcp/*` 管理端点（状态、配对令牌、客户端、连接、授权、事件通道）。`/mcp` 协议端点本身是 Streamable HTTP 上的 JSON-RPC，有意不纳入 OpenAPI schema。

## 后续阶段

1. 后端 MCP 运行时（`packages/backend/src/mcp/`）：协议会话、SSH 连接注册表、授权 broker、审计链路。
2. 渲染器授权对话框与 MCP 管理面板。
3. `cosmosh-mcp` stdio 桥接程序，含发现文件（`<userData>/mcp/bridge.json`）与客户端配置生成。
4. Agent Skill（`skills/cosmosh-mcp/`）与完整文档。
