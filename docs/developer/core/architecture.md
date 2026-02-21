# Cosmosh Architecture

## 1. Runtime Topology

Cosmosh uses an Electron dual-process model with an embedded backend service:

- **Main Process** (`packages/main/src/index.ts`): app lifecycle, BrowserWindow creation, preload wiring, IPC registration, backend process orchestration.
- **Preload Bridge** (`packages/main/src/preload.ts`): strict API surface exposed via `contextBridge`.
- **Renderer Process** (`packages/renderer/src`): React UI, xterm UI, state orchestration.
- **Backend Process** (`packages/backend/src/index.ts`): Hono HTTP API + WebSocket session services for SSH and local terminal.

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

## 2. Main ↔ Renderer Responsibilities

### Main Process (`packages/main/src/index.ts`)

- Starts backend process and waits for `/health` before opening UI.
- Owns app-level capabilities: locale persistence (in-memory), window/devtools/file-manager actions.
- Proxies renderer requests to backend endpoints with:
  - `COSMOSH_INTERNAL_TOKEN` as internal auth header.
  - locale header for i18n-compatible backend responses.

### Renderer Process (`packages/renderer/src`)

- Uses `window.electron` bridge only (no direct Node API usage).
- Creates SSH/local terminal sessions through backend APIs.
- Connects terminal data channels through WebSocket and renders with `xterm.js`.

## 3. IPC Lifecycle (Current)

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

## 4. Security Model

### Electron Surface Hardening

- `nodeIntegration: false`
- `contextIsolation: true`
- Renderer gets only explicit bridge APIs via `contextBridge.exposeInMainWorld`.
- Internal privileged operations stay in Main/Backend process.

### Backend Access Boundary

- Backend is localhost-only and guarded by an internal runtime token (`COSMOSH_INTERNAL_TOKEN`) in electron-main mode.
- Main process injects headers and never exposes internal token to renderer.
- Credential encryption key is derived from `COSMOSH_SECRET_KEY`/internal token hash in backend bootstrap.

### Session Channel Hardening

- WebSocket path includes sessionId and query token.
- Token mismatch or stale session causes immediate close (`1008`).
- Session attach timeout is enforced (30 seconds) to avoid orphaned resources.

## 5. Current Gaps / Planned Work

- SFTP runtime channel is not implemented yet; only SSH terminal and local terminal session channels are active.
- Renderer has SFTP entry placeholders in Home context menu; actual SFTP page/session wiring remains planned.

## 6. Core Data-Flow Views

### 6.1 Session Bootstrap Data Flow

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

### 6.2 Runtime Stream Data Flow

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

### 6.3 Failure Boundary Model

- **Renderer boundary**: visual state and user interaction; failures should stay recoverable via UI retry.
- **Main boundary**: capability routing and internal auth injection; failures should never leak privileged tokens.
- **Backend boundary**: protocol validation, session lifecycle, and resource cleanup ownership.
- **Remote boundary**: SSH host / local shell instability is treated as external and mapped to stable UI error codes.

## 7. Architecture Decision Rationale

- Keep the backend as a separate runtime process to isolate protocol and credential handling from renderer attack surface.
- Use preload as a minimal bridge to reduce API exposure and preserve strict process contracts.
- Prefer WS data plane for terminal streams to avoid IPC bottlenecks on high-frequency I/O.
- Keep main as orchestrator/proxy instead of business-logic host for easier future server-client decoupling.

## 8. Boundary Case Playbook

### 8.1 Backend Not Ready at Startup

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

Handling principle:

- UI should open only after backend health is confirmed.
- Startup failure paths should be explicit and observable.

### 8.2 WS Attach Token Mismatch

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant WS as Backend WS Gateway

  UI->>WS: connect /ws/ssh/{sessionId}?token=invalid
  WS-->>UI: close code 1008
  UI->>UI: transition to failed state
  UI->>UI: allow explicit retry flow
```

Handling principle:

- Token/session mismatch is security-sensitive and must fail closed.
- Recovery should create a fresh session/token path.

### 8.3 Renderer Reload During Active Session

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

Handling principle:

- Session runtime must guard against stale attach state.
- Renderer should treat reload as a new lifecycle and re-establish state explicitly.
