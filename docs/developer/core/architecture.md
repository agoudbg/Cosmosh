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
- In development startup, main uses an incremental preflight (`packages/main/scripts/dev-preflight.cjs`) and skips `@cosmosh/api-contract` / `@cosmosh/i18n` rebuilds when outputs are fresh.
- Main launches backend with a runtime-only non-watch command (`dev:runtime`) to avoid duplicate `predev` rebuilds and reduce sustained CPU noise on laptops.
- Owns app-level capabilities: locale persistence (in-memory), window/devtools/file-manager actions.
- Proxies renderer requests to backend endpoints with:
  - `COSMOSH_INTERNAL_TOKEN` as internal auth header.
  - locale header for i18n-compatible backend responses.

### Backend Process (`packages/backend/src/index.ts`)

- Registers idempotent graceful-shutdown flow for runtime signals and fatal process events.
- Shutdown order is explicit: stop WS session services, close HTTP listener, then disconnect Prisma/SQLite handles.
- Windows-specific termination (`SIGBREAK`) is handled in the same path as POSIX signals to reduce stale DB lock cases.
- Startup includes idempotent Prisma migration-file execution in `initializeDatabase(...)`, so first install launch and every subsequent launch both converge local DB structure to the current backend schema contract before serving HTTP routes.
- Schema sync is fail-fast: backend startup stops when required tables still cannot be reconciled after runtime migration execution, preventing partial/undefined API behavior.
- Migration ledger metadata is stored in Prisma-compatible `_prisma_migrations` format to keep a future path open for native `prisma migrate deploy/resolve` workflows.

### Renderer Process (`packages/renderer/src`)

- Uses `window.electron` bridge only (no direct Node API usage).
- Creates SSH/local terminal sessions through backend APIs.
- Connects terminal data channels through WebSocket and renders with `xterm.js`.
- Non-home renderer pages (including SSH and settings editor/Monaco) are lazy-loaded to keep heavyweight assets out of the default startup path.
- Development StrictMode is opt-in via `VITE_ENABLE_STRICT_MODE=true` to reduce duplicate effect execution during local performance profiling.

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
- HTTP i18n is request-scoped: backend middleware resolves locale from `x-cosmosh-locale` (fallback `accept-language`), then injects a per-request translator used by all route response messages.
- WS runtime i18n is session-scoped: session creation carries resolved locale into SSH/local terminal runtime so WS `error`/`exit` messages and close reasons are localized consistently.

### Session Channel Hardening

- WebSocket path includes sessionId and query token.
- Token mismatch or stale session causes immediate close (`1008`).
- Session attach timeout is enforced (30 seconds) to avoid orphaned resources.

## 5. Current Gaps / Planned Work

- SFTP runtime channel is not implemented yet; only SSH terminal and local terminal session channels are active.
- Renderer has SFTP entry placeholders in Home context menu; actual SFTP page/session wiring remains planned.

## 5.1 Settings Runtime (Implemented)

- Settings are now persisted by backend route `GET/PUT /api/v1/settings`.
- Storage model is a single-row JSON payload per scope (`scopeAccountId` + `scopeDeviceId`) in `AppSettings`.
- Scope defaults to local device (`deviceId=local-device`) while keeping account scope field for future sync.
- Renderer bootstrap (`packages/renderer/src/main.tsx`) applies persisted language/theme at startup.
- Non-visual settings (for example SSH runtime limits) are persisted and discoverable, but some are intentionally not bound to runtime behavior yet.
- All setting definitions (types, defaults, constraints, enum sets, UI metadata, categories) live in a single registry: `packages/api-contract/src/settings-registry.ts`. Adding or removing a setting only requires editing this file (plus i18n locale files).
- Validation logic in `packages/api-contract/src/settings.ts` is now generic and registry-driven: per-key rules (type check, enum, range, maxLength) are derived from the registry at runtime — no manual switch/case per key.
- The OpenAPI `SettingsValues` schema is intentionally loose (`type: object`); strict TypeScript types and constraints live exclusively in the code registry.
- Settings API response types (`ApiSettingsGetResponse`, `ApiSettingsUpdateResponse`) are hand-crafted in `packages/api-contract/src/index.ts` using the strict `SettingsValues` from the registry rather than generated from OpenAPI.
- Stored settings payload parsing is forward-compatible: missing/new fields are backfilled per-field from defaults instead of resetting the entire settings object.
- Strict full-schema validation is still enforced for update requests (`PUT /api/v1/settings`) to keep persisted payload shape deterministic.

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant PB as Preload
  participant MP as Main IPC
  participant BE as Backend Settings Route
  participant DB as SQLite(AppSettings)

  UI->>PB: window.electron.backendSettingsGet()
  PB->>MP: ipcRenderer.invoke('backend:settings-get')
  MP->>BE: GET /api/v1/settings
  BE->>DB: load AppSettings row by scope
  DB-->>BE: payloadJson + revision
  BE-->>MP: SettingsGetSuccess
  MP-->>UI: settings payload
  UI->>UI: apply language + theme
```

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

### 8.4 Unreadable SQLite File During Startup

```mermaid
sequenceDiagram
  participant BE as Backend Bootstrap
  participant DB as SQLite File
  participant MAIN as Electron Main

  BE->>DB: Try SQLCipher bootstrap
  DB-->>BE: file is not a database / unreadable
  BE-->>MAIN: fail startup with DB_PRAGMA_FAILED
```

Handling principle:

- Production uses strict mode: SQLCipher/Prisma incompatibility fails fast and must be fixed operationally.

### 8.5 Startup Schema Upgrade Path

```mermaid
sequenceDiagram
  participant BE as Backend Bootstrap
  participant DB as SQLite

  BE->>DB: initializeDatabase(...)
  BE->>DB: apply PRAGMA + pending Prisma migration.sql files
  DB-->>BE: schema aligned (or error)
  BE->>BE: validate required table set
  BE-->>BE: continue startup only when validation passes
```

Handling principle:

- Runtime migration sync is idempotent and executes on every startup.
- Existing user data must remain intact while structural drift is repaired incrementally.
