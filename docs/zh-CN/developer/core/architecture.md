# Cosmosh 架构设计

## 1. 运行时拓扑

Cosmosh 采用 Electron 双进程模型，并嵌入后端服务：

- **Main 进程** (`packages/main/src/index.ts`)：应用生命周期、BrowserWindow 创建、preload 注入、IPC 注册、后端进程编排。
- **Preload Bridge** (`packages/main/src/preload.ts`)：通过 `contextBridge` 暴露严格受控 API。
- **Renderer 进程** (`packages/renderer/src`)：React UI、xterm UI、状态编排。
- **Backend 进程** (`packages/backend/src/index.ts`)：Hono HTTP API + SSH/本地终端 WebSocket 会话服务。

```mermaid
flowchart LR
  R[Renderer React App] -->|window.electron.*| P[Preload Bridge]
  P -->|ipcRenderer.invoke/send| M[Electron Main]
  M -->|HTTP localhost + internal token| B[Backend Hono API]
  R -->|WebSocket token URL| WS1[SSH WS Service]
  R -->|WebSocket token URL| WS2[Local Terminal WS Service]
  B --> WS1
  B --> WS2
  B --> DB[(SQLite via Prisma)]
```

## 2. Main ↔ Renderer 职责划分

### Main 进程 (`packages/main/src/index.ts`)

- 启动后端进程，并在 `/health` 就绪后再打开 UI。
- 持有应用级能力：语言持久化（内存）、窗口/开发者工具/文件管理器操作。
- 将渲染层请求代理到后端端点，并注入：
  - 作为内部鉴权头的 `COSMOSH_INTERNAL_TOKEN`。
  - 用于后端 i18n 响应的 locale header。

### Renderer 进程 (`packages/renderer/src`)

- 仅通过 `window.electron` bridge 访问能力（不直接使用 Node API）。
- 通过后端 API 创建 SSH/本地终端会话。
- 通过 WebSocket 建立终端数据通道，并由 `xterm.js` 渲染。

## 3. IPC 生命周期（当前）

```mermaid
sequenceDiagram
  participant UI as Renderer UI
  participant PB as Preload Bridge
  participant MP as Main Process
  participant BE as Backend API
  participant WS as WS Session Service

  UI->>PB: window.electron.backendSshCreateSession(payload)
  PB->>MP: ipcRenderer.invoke('backend:ssh-create-session', payload)
  MP->>BE: POST /api/v1/ssh/sessions (+internal token)
  BE-->>MP: sessionId + websocketUrl + websocketToken
  MP-->>PB: API payload
  PB-->>UI: API payload

  UI->>WS: WebSocket connect (url + token)
  WS-->>UI: { type: 'ready' }
  UI->>WS: { type: 'input' | 'resize' | 'ping' }
  WS-->>UI: { type: 'output' | 'telemetry' | 'pong' | 'exit' }

  UI->>PB: close session
  PB->>MP: ipcRenderer.invoke('backend:ssh-close-session', sessionId)
  MP->>BE: DELETE /api/v1/ssh/sessions/{sessionId}
```

## 4. 安全模型

### Electron 表面加固

- `nodeIntegration: false`
- `contextIsolation: true`
- Renderer 仅获得显式 bridge API（`contextBridge.exposeInMainWorld`）。
- 特权操作保留在 Main/Backend 进程。

### Backend 访问边界

- 后端仅监听 localhost，并在 electron-main 模式下由内部运行时 token（`COSMOSH_INTERNAL_TOKEN`）保护。
- Main 进程注入头信息，不向 renderer 暴露内部 token。
- 凭据加密 key 由 `COSMOSH_SECRET_KEY` / 内部 token 哈希在后端启动时推导。

### 会话通道加固

- WebSocket 路径包含 sessionId 与 query token。
- token 不匹配或会话过期会立即关闭（`1008`）。
- 30 秒 attach 超时用于避免资源孤儿化。

## 5. 当前缺口 / 规划工作

- SFTP 运行时通道尚未实现；当前仅有 SSH 终端与本地终端会话通道。
- Renderer 的 Home 右键菜单已有 SFTP 占位入口，实际页面/会话接线仍在规划中。

## 6. 核心数据流视图

### 6.1 会话启动数据流

```mermaid
flowchart TD
  UI[Renderer UI] --> BRIDGE[window.electron bridge]
  BRIDGE --> MAIN[ipcMain handler]
  MAIN --> API[Backend route]
  API --> SERVICE[Session service]
  SERVICE --> DB[(Prisma / SQLite)]
  SERVICE --> REMOTE[SSH host or local PTY]
  SERVICE --> TOKEN[WS token + session registry]
  TOKEN --> UI
```

### 6.2 运行时流式数据流

```mermaid
flowchart LR
  XT[xterm.js] --> IN[input events]
  IN --> WS[WebSocket]
  WS --> SVC[Backend session runtime]
  SVC --> REM[Remote shell / PTY]
  REM --> OUT[stdout + stderr]
  OUT --> WS2[WebSocket output events]
  WS2 --> XT2[xterm.js write]
```

### 6.3 失败边界模型

- **Renderer 边界**：负责视图状态与用户交互；失败应可通过 UI 重试恢复。
- **Main 边界**：负责能力路由与内部鉴权注入；失败不应泄露任何特权 token。
- **Backend 边界**：负责协议校验、会话生命周期与资源清理。
- **Remote 边界**：SSH 主机 / 本地 shell 波动视为外部故障，映射为稳定 UI 错误码。

## 7. 架构决策动机

- 保持 backend 为独立运行时进程，将协议与凭据处理与 renderer 攻击面隔离。
- 保持 preload 为最小桥接面，减少 API 暴露并维持严格进程契约。
- 终端高频 I/O 优先走 WS 数据面，避免 IPC 成为吞吐瓶颈。
- Main 进程作为编排/代理，而非业务承载层，便于未来服务端解耦演进。

## 8. 边界案例处理手册

### 8.1 启动时 Backend 未就绪

```mermaid
sequenceDiagram
  participant MAIN as Main Process
  participant BE as Backend Process
  participant UI as Renderer Window

  MAIN->>BE: start backend runtime
  MAIN->>BE: poll /health
  BE-->>MAIN: not ready
  MAIN->>MAIN: retry with bounded wait
  BE-->>MAIN: healthy
  MAIN->>UI: create BrowserWindow
```

处理原则：

- 仅在 backend 健康检查通过后再打开 UI。
- 启动失败路径应清晰可观测。

### 8.2 WS Attach Token 不匹配

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant WS as Backend WS Gateway

  UI->>WS: connect /ws/ssh/{sessionId}?token=invalid
  WS-->>UI: close code 1008
  UI->>UI: transition to failed state
  UI->>UI: allow explicit retry flow
```

处理原则：

- token/session 不匹配属于安全敏感问题，必须失败即关闭。
- 恢复路径应通过全新 session/token 重新建立。

### 8.3 活跃会话期间 Renderer 重载

```mermaid
sequenceDiagram
  participant UI1 as Renderer Instance A
  participant WS as Backend Session Runtime
  participant UI2 as Renderer Instance B

  UI1->>WS: active attach
  UI1-->>UI1: renderer reload
  UI2->>WS: re-attach with new token/session flow
  WS-->>UI2: ready or reject based on session state
```

处理原则：

- 会话运行时必须防止陈旧 attach 状态污染。
- Renderer 重载应视作新生命周期并显式重建状态。
