# IPC 协议字典

## 1. Channel 拓扑

```mermaid
flowchart TB
  R[Renderer] --> P[preload.ts]
  P -->|ipcRenderer.send/invoke| M[main/index.ts ipcMain]
  M -->|HTTP + internal token| B[backend routes]
```

## 2. Channel 字典

| Channel | IPC Type | Params | Return Schema | Main Handler Behavior |
|---|---|---|---|---|
| `app:close-window` | `send` | none | none | Closes focused window or main window |
| `i18n:get-locale` | `invoke` | none | `Promise<string>` | Returns current resolved locale |
| `i18n:set-locale` | `invoke` | `locale: string` | `Promise<string>` | Resolves/persists in-memory locale and updates title |
| `app:get-runtime-user-name` | `invoke` | none | `Promise<string>` | Returns OS username fallback chain |
| `app:get-version-info` | `invoke` | none | `Promise<{ appName: string; version: string; buildVersion: string; buildTime: string }>` | 为关于页返回应用名称、版本号、内部版本号和构建时间 |
| `app:get-pending-launch-working-directory` | `invoke` | none | `Promise<string \| null>` | 返回当前待消费的上下文启动工作目录（来自 CLI 参数） |
| `app:launch-working-directory` | `event (main -> renderer)` | `cwd: string` | none | 当第二实例触发时，向渲染层推送上下文启动工作目录 |
| `app:open-devtools` | `invoke` | none | `Promise<boolean>` | Opens devtools when unpackaged |
| `app:show-in-file-manager` | `invoke` | `targetPath?: string` | `Promise<boolean>` | Opens file/folder in OS file manager |
| `app:open-external-url` | `invoke` | `targetUrl: string` | `Promise<boolean>` | 使用系统默认浏览器打开受信任的 HTTP(S) 链接 |
| `backend:test-ping` | `invoke` | none | `Promise<ApiTestPingResponse \| ApiErrorResponse>` | Calls backend health test endpoint |
| `backend:settings-get` | `invoke` | none | `Promise<ApiSettingsGetResponse \| ApiErrorResponse>` | GET 已持久化设置 |
| `backend:settings-update` | `invoke` | `payload: ApiSettingsUpdateRequest` | `Promise<ApiSettingsUpdateResponse \| ApiErrorResponse>` | PUT 设置快照 |
| `backend:ssh-list-servers` | `invoke` | none | `Promise<ApiSshListServersResponse \| ApiErrorResponse>` | GET SSH server list |
| `backend:ssh-create-server` | `invoke` | `payload: ApiSshCreateServerRequest` | `Promise<ApiSshCreateServerResponse \| ApiErrorResponse>` | POST create SSH server |
| `backend:ssh-update-server` | `invoke` | `serverId: string, payload: ApiSshUpdateServerRequest` | `Promise<ApiSshUpdateServerResponse \| ApiErrorResponse>` | PUT update SSH server |
| `backend:ssh-get-server-credentials` | `invoke` | `serverId: string` | `Promise<ApiSshGetServerCredentialsResponse \| ApiErrorResponse>` | GET decrypted credentials |
| `backend:ssh-list-folders` | `invoke` | none | `Promise<ApiSshListFoldersResponse \| ApiErrorResponse>` | GET folder list |
| `backend:ssh-create-folder` | `invoke` | `payload: ApiSshCreateFolderRequest` | `Promise<ApiSshCreateFolderResponse \| ApiErrorResponse>` | POST create folder |
| `backend:ssh-update-folder` | `invoke` | `folderId: string, payload: ApiSshUpdateFolderRequest` | `Promise<ApiSshUpdateFolderResponse \| ApiErrorResponse>` | PUT update folder |
| `backend:ssh-list-tags` | `invoke` | none | `Promise<ApiSshListTagsResponse \| ApiErrorResponse>` | GET tag list |
| `backend:ssh-create-tag` | `invoke` | `payload: ApiSshCreateTagRequest` | `Promise<ApiSshCreateTagResponse \| ApiErrorResponse>` | POST create tag |
| `backend:ssh-create-session` | `invoke` | `payload: ApiSshCreateSessionRequest` | `Promise<ApiSshCreateSessionResponse \| ApiSshCreateSessionHostVerificationRequiredResponse \| ApiErrorResponse>` | POST create SSH shell session |
| `backend:ssh-trust-fingerprint` | `invoke` | `payload: ApiSshTrustFingerprintRequest` | `Promise<ApiSshTrustFingerprintResponse \| ApiErrorResponse>` | POST trust host fingerprint |
| `backend:ssh-close-session` | `invoke` | `sessionId: string` | `Promise<{ success: boolean }>` | DELETE SSH session |
| `backend:ssh-delete-server` | `invoke` | `serverId: string` | `Promise<{ success: boolean }>` | DELETE SSH server |
| `backend:ssh-delete-folder` | `invoke` | `folderId: string` | `Promise<{ success: boolean }>` | DELETE SSH folder |
| `backend:local-terminal-list-profiles` | `invoke` | none | `Promise<LocalTerminalListResponse \| ApiErrorResponse>` | GET local terminal profile list |
| `backend:local-terminal-create-session` | `invoke` | `payload: LocalTerminalCreateSessionRequest` | `Promise<LocalTerminalCreateSessionResponse \| ApiErrorResponse>` | POST 本地终端会话（Main 可能注入一次性 `cwd` 上下文） |
| `backend:local-terminal-close-session` | `invoke` | `sessionId: string` | `Promise<{ success: boolean }>` | DELETE local terminal session |

## 3. Schema 来源

- API payload 类型来自 `@cosmosh/api-contract` 包。
- 本地终端 request/response schema 当前定义在：
  - `packages/main/src/preload.ts`
  - `packages/renderer/src/vite-env.d.ts`
  - `packages/renderer/src/lib/api/transport.ts`

## 4. 变更规则

当新增/修改 channel 时，必须在一个变更中同步更新：

1. `packages/main/src/preload.ts`
2. `packages/main/src/index.ts`
3. `packages/renderer/src/vite-env.d.ts`
4. 相关 renderer transport/service 封装
5. 本文件（`docs/zh-CN/developer/core/ipc-protocol.md`）

## 5. Channel 新增模板

新增 channel 时建议按以下清单执行：

1. Channel 命名：`domain:action-name`
2. IPC 类型：`invoke` 或 `send`
3. 参数 schema：在 bridge 与 renderer 声明中显式类型化
4. 返回 schema：成功与错误结构
5. Main 行为：后端代理或本地特权动作
6. 安全说明：token/header 处理、权限边界、暴露范围
7. 文档同步：同一变更集更新中英文协议文档
