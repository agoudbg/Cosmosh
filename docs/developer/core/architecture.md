# Cosmosh Architecture

## 1. Runtime Topology

Cosmosh uses an Electron dual-process model with an embedded backend service:

- **Main Process** (`packages/main/src/index.ts`): app lifecycle, BrowserWindow creation, preload wiring, IPC registration, backend process orchestration.
- **Preload Bridge** (`packages/main/src/preload.ts`): strict API surface exposed via `contextBridge`.
- **Renderer Process** (`packages/renderer/src`): React UI, xterm UI, state orchestration.
- **Backend Process** (`packages/backend/src/index.ts`): Hono HTTP API + WebSocket session services for SSH/local terminal, plus SFTP browser, download, file-operation sessions, and SSH port-forwarding runtimes.

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

- Starts BrowserWindow and backend warmup in parallel during app bootstrap.
- Keeps a single in-flight backend startup promise to deduplicate concurrent startup triggers.
- Main-process backend proxy requests now ensure backend readiness before forwarding HTTP calls.
- Startup diagnostics are appended to `startup.log` under Electron `userData/logs`; main records app/window/backend readiness timing, mirrors backend stdout/stderr into the same file, and rotates the log at 1 MiB.
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
- Local terminal profile discovery now uses short-lived in-memory caching and parallel probing, reducing repeated profile scan latency on Home/Settings first-load paths.
- Generated terminal completion command specs and inshellisense description catalogs are lazy-loaded on the first completion request instead of during backend bootstrap, keeping large generated resources out of the Home/server-list startup path.
- Startup includes idempotent Prisma migration-file execution in `initializeDatabase(...)`, so first install launch and every subsequent launch both converge local DB structure to the current backend schema contract before serving HTTP routes.
- Backend startup emits coarse bootstrap timing plus database initialization phase timing for secure directory/file preparation, SQLCipher bootstrap, Prisma connect, PRAGMA application, and schema synchronization.
- Simple Prisma `ALTER TABLE ... ADD COLUMN` migrations are reconciled against live SQLite table metadata before execution. If a column already exists but `_prisma_migrations` lacks the row, startup records the migration as applied instead of re-running duplicate DDL; non-simple migration drift still fails fast.
- Schema sync is fail-fast: backend startup stops when required tables still cannot be reconciled after runtime migration execution, preventing partial/undefined API behavior.
- Migration ledger metadata is stored in Prisma-compatible `_prisma_migrations` format to keep a future path open for native `prisma migrate deploy/resolve` workflows.

### Renderer Process (`packages/renderer/src`)

- Uses `window.electron` bridge only (no direct Node API usage).
- Creates SSH/local terminal sessions and SFTP browser/download/file-operation sessions through backend APIs.
- Connects terminal data channels through WebSocket and renders with `xterm.js`.
- Non-home renderer pages (including SSH and settings editor/Monaco) are lazy-loaded to keep heavyweight assets out of the default startup path.
- Home loads first-screen datasets independently: SSH folders, SSH servers, keychains, local terminal profiles, and port-forwarding rules each update their owning surface as soon as its request completes, so slow secondary resources do not block the first visible server list.
- Renderer bootstrap hydrates settings from local cache first, then refreshes canonical values from backend in background.
- Development StrictMode is opt-in via `VITE_ENABLE_STRICT_MODE=true` to reduce duplicate effect execution during local performance profiling.
- SSH page uses tab-scoped connection intent snapshots (no global mutable target singleton), so retry/split flows are isolated per tab.
- Hidden tabs are rendered but cannot start new SSH connect side effects; connect flow is active-tab gated.

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
- The sandboxed preload script must not import workspace packages at runtime. It may use shared API contract types at compile time, but runtime validators used inside preload must stay local or be bundled so Electron does not need to resolve project modules before the bridge loads.
- Internal privileged operations stay in Main/Backend process.
- Renderer-requested app windows are denied by default. The current allow-list only permits same-renderer SFTP Properties popups, and those child windows reuse the secure preload with `nodeIntegration` disabled and `contextIsolation` enabled.

### Backend Access Boundary

- Backend HTTP explicitly binds to the IPv4 loopback interface (`127.0.0.1`) in every runtime mode. The listener must never rely on the Node server default, which can expose standalone development APIs on non-loopback interfaces.
- Electron-main mode additionally guards `/api/v1/*` with an internal runtime token (`COSMOSH_INTERNAL_TOKEN`). Standalone mode remains loopback-only even though it does not require that token.
- Main process injects headers and never exposes internal token to renderer.
- Main also capability-gates local SFTP download destinations. App utility IPC authorizes an exact normalized path for the requesting renderer webContents, and the backend proxy rejects any download path without that owner-bound authorization. Temporary preview/open paths are reusable; Downloads and save-dialog paths are consumed after one request.
- Credential encryption key is derived from `COSMOSH_SECRET_KEY`/internal token hash in backend bootstrap.
- HTTP i18n is request-scoped: backend middleware resolves locale from `x-cosmosh-locale` (fallback `accept-language`), then injects a per-request translator used by all route response messages.
- WS runtime i18n is session-scoped: session creation carries resolved locale into SSH/local terminal runtime so WS `error`/`exit` messages and close reasons are localized consistently.
- i18n runtime is resource-injected: consumers register locale JSON payloads during `createI18n(...)` setup, so each process bundles only its required scope data.

### Session Channel Hardening

- WebSocket path includes sessionId and query token.
- Token mismatch or stale session causes immediate close (`1008`).
- Session attach timeout is enforced (30 seconds) to avoid orphaned resources.

## 5. Runtime Capabilities

- SSH and local terminal sessions use WebSocket data channels for terminal I/O.
- SFTP uses request/response IPC + backend HTTP routes for directory browsing, local-file upload, download, create, rename, copy, delete, and batch file operations.
- Port Forwarding uses request/response IPC + backend HTTP routes for persisted rule CRUD and manual start/stop. Runtime state stays in backend memory, so app/backend restart resets all rules to stopped.
- SFTP local OS-open flows download regular files into a Cosmosh-controlled temp root through the existing backend download endpoint, then ask main-process app utility IPC to open only validated temp files. Windows uses the shell `openas` verb for Open With; macOS uses the packaged NSWorkspace helper; Linux omits Open With.
- SFTP directory upload/download, chmod, byte-level transfer progress/cancellation, richer transfer queues, and SSH terminal session reuse remain planned follow-up work.

## 5.1 SSH Port Forwarding Runtime (Implemented)

- Port forwarding rules are persisted in SQLite through `PortForwardRule`, with type-specific fields for local, remote, and dynamic SOCKS forwarding.
- `PortForwardSessionService` owns active SSH clients, `net.Server` listeners, sockets, channels, remote-forward listeners, and shutdown cleanup.
- Start opens SSH clients through the shared `packages/backend/src/ssh/connect.ts` helper, so keychain credential decryption and strict host-key behavior stay aligned with SSH/SFTP.
- Local forwarding listens on the backend host and opens `ssh2.Client.forwardOut(...)` per inbound local socket.
- Remote forwarding calls `client.forwardIn(...)` and connects accepted SSH channels from backend to the configured target host/port.
- Dynamic forwarding implements SOCKS5 no-auth TCP CONNECT for IPv4, IPv6, and domain targets; UDP ASSOCIATE, BIND, and SOCKS authentication are not supported.
- Default local bind host is `127.0.0.1`; non-localhost bind hosts are allowed only with renderer risk messaging.
- Each rule is capped at 64 concurrent connections with a 15-second connection setup timeout.

## 5.2 Settings Runtime (Implemented)

- Settings are now persisted by backend route `GET/PUT /api/v1/settings`.
- Storage model is a single-row JSON payload per scope (`scopeAccountId` + `scopeDeviceId`) in `AppSettings`.
- Scope defaults to local device (`deviceId=local-device`) while keeping account scope field for future sync.
- Renderer bootstrap (`packages/renderer/src/main.tsx`) applies persisted language/theme using cached settings at startup, then synchronizes with backend.
- Renderer date-time display uses persisted time-zone/date/time format settings through `packages/renderer/src/lib/date-time-format.ts`; `system` preserves the OS time zone, and the Settings UI lists runtime-supported IANA time zones with their current UTC offsets.
- Renderer terminal character width compatibility is stored as `terminalCharacterWidthCompatibilityModeEnabled`; SSH server records can opt out per server with `disableCharacterWidthCompatibilityMode`, while local terminal sessions only follow the global setting.
- Non-visual settings (for example SSH runtime limits) are persisted and discoverable, but some are intentionally not bound to runtime behavior yet.
- All setting definitions (types, defaults, constraints, enum sets, JSON schemas, UI metadata, categories) live in a single registry: `packages/api-contract/src/settings-registry.ts`. Adding or removing a setting only requires editing this file (plus i18n locale files).
- Validation logic in `packages/api-contract/src/settings.ts` is now generic and registry-driven for common scalar rules (type check, enum, range, maxLength), with narrow custom validators for settings that need runtime checks or structured JSON normalization such as IANA time-zone support and the SFTP directory-list view.
- Settings UI surfaces structured JSON settings as explicit rows, but they do not render inline editors or per-item Settings Editor actions. They provide a single Settings Editor link so full-object editing remains schema-backed and centralized, while default reset remains available through the regular item menu.
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

## 5.3 Local-First Audit Runtime (Implemented)

- Security-core operations are persisted to `AuditEvent` with stable correlation fields (`requestId`, `sessionId`, `entityId`, `relatedRecordId`) for forensic traceability.
- Existing `SshLoginAudit` remains active for backward-compatible SSH last-used sorting, while `AuditEvent` is used as the cross-domain audit stream.
- Audit writes are best-effort and non-blocking by contract: failures are logged in backend runtime and do not fail parent request/session flows.
- Metadata persistence is sanitized before storage (secret-like keys are redacted) and capped by serialized size limits to prevent payload inflation.
- Retention is local policy-driven (default 180 days) with periodic sweeps in audit service runtime.
- Future sync checkpoint state is pre-modeled by `AuditSyncCursor` without introducing current mandatory remote dependency.

Current event categories in runtime wiring include:

- `ssh-session`
- `ssh-host-trust`
- `ssh-server`
- `ssh-keychain`
- `port-forward`
- `settings`

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

## 7. SSH Keychain Credential Model (2026-03)

- SSH credentials are now persisted in `SshKeychain` and linked from `SshServer.keychainId`.
- `SshServer` keeps connection identity, host/transport policy (`host`, `port`, `username`, `strictHostKey`, `enableSshCompression`), and renderer terminal compatibility flags (`disableCharacterWidthCompatibilityMode`) but no longer stores encrypted password/private-key fields directly.
- SSH transport compression is disabled by default. When enabled on a server record, the backend applies the same compression negotiation policy to SSH shell sessions, SFTP sessions, and port-forwarding clients.
- Keychain organization metadata reuses the same `SshFolder` and `SshTag` domains used by servers (no separate keychain-only folder/tag tables).
- Existing per-server edit UX is preserved by allowing inline credential input in the SSH editor; backend transparently materializes/updates hidden keychains.
- Server updates that keep inline credential mode may omit password/private-key fields; the backend retains the existing encrypted values and only rejects the update when the stored credential material cannot satisfy the selected auth type.
- Shared keychains can be reused by multiple servers; hidden keychains are intended for single-server private use.
- SSH session creation resolves credentials through server → keychain relation before opening `ssh2` connections.

## 8. Architecture Decision Rationale

- Keep the backend as a separate runtime process to isolate protocol and credential handling from renderer attack surface.
- Use preload as a minimal bridge to reduce API exposure and preserve strict process contracts.
- Prefer WS data plane for terminal streams to avoid IPC bottlenecks on high-frequency I/O.
- Keep main as orchestrator/proxy instead of business-logic host for easier future server-client decoupling.

## 9. Boundary Case Playbook

### 9.1 Backend Not Ready at Startup

```mermaid
sequenceDiagram
  participant MAIN as Main Process
  participant BE as Backend Process
  participant UI as Renderer Window

  MAIN->>BE: start backend runtime
  MAIN->>UI: create BrowserWindow in parallel
  MAIN->>BE: poll /health
  BE-->>MAIN: not ready
  MAIN->>MAIN: retry with bounded wait
  BE-->>MAIN: healthy
  UI->>MAIN: first backend IPC request
  MAIN->>BE: await startup promise if needed
```

Handling principle:
- UI should become visible as early as possible while backend continues warming in parallel.
- First backend-bound IPC request must still observe backend ready-state before forwarding.
- Startup failure paths should be explicit and observable.

### 9.2 WS Attach Token Mismatch

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

### 9.3 Renderer Reload During Active Session

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
