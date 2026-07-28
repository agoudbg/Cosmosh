# Cosmosh Project Map

## 1. Monorepo Layout

```mermaid
flowchart TB
  ROOT[Cosmosh Root]
  ROOT --> MAIN[packages/main]
  ROOT --> RENDERER[packages/renderer]
  ROOT --> BACKEND[packages/backend]
  ROOT --> API[packages/api-contract]
  ROOT --> I18N[packages/i18n]
  ROOT --> REMOTE[packages/remote-bootstrap]
  ROOT --> MCPB[packages/mcp-bridge]
  ROOT --> SKILLS[skills]
  ROOT --> DOCS[docs]
  ROOT --> SCRIPTS[scripts]
  ROOT --> CI[".github/workflows"]
```

## 2. Directory Responsibilities

### `.github/workflows`

- **Role**: CI validation, rolling development assets, and versioned release orchestration.
- `build-main.yml` owns ordinary Electron packaging plus intentionally mutable `remote-bootstrap-dev` and branch prerelease channels.
- `release.yml` owns read-only platform builds, Windows signature policy checks, artifact inventory validation, checksums, provenance attestations, and draft release publication through one scoped writer job.
- Every external Action reference is pinned to a full commit SHA. `.github/dependabot.yml` proposes reviewed digest updates.

### `scripts`

- **Role**: Repository-level developer and release workflow helpers.
- **Key files**:
  - `dev-profile.mjs`: development profile manager used by `pnpm dev:profile` and `pnpm dev:main:fresh`. It automatically imports the legacy implicit default identity into the protected `default` profile, then creates, switches, resets, deletes, and runs commands with profile-scoped runtime paths under `.cosmosh/dev-profiles/<name>/`.
  - `build-remote-bootstrap-release.mjs`: CI/release helper that cross-compiles Linux remote bootstrap binaries, computes SHA-256 values, and writes the git-ignored manifest under `packages/remote-bootstrap/dist/`. Tagged releases upload those files to the versioned release; `main` pushes upload them to the fixed `remote-bootstrap-dev` prerelease; pushed branches whose name contains `remote-bootstrap` and manual dispatch runs can upload them to branch-scoped temporary prereleases for end-to-end testing; ordinary PRs use it only for validation.
  - `prepare-release-assets.mjs`: validates the flat cross-platform release inventory and writes deterministic `SHA256SUMS` before attestation and draft upload.
  - `verify-windows-release-signatures.ps1`: audits or enforces Authenticode signatures and timestamp certificates for the NSIS installer and packaged application executable.
  - `update-version.js`: version metadata update helper.
  - `precommit-staged.mjs`: staged-file precommit validation helper.
  - `setup-githooks.mjs`: local Git hook bootstrap.

### `packages/main`

- **Role**: Electron host process.
- **Key files**:
  - `src/index.ts`: app bootstrap, BrowserWindow config, IPC handlers, backend subprocess management.
  - `src/window-close-guard.ts`: serialized window/app close decisions based on backend-owned SSH/SFTP activity, including conservative probe-failure handling.
  - `src/renderer-close-confirmation.ts`: sender-bound, request-ID-validated Main-to-Renderer close confirmation broker with timeout and renderer-destruction handling.
  - `src/ipc/register-app-utility-ipc.ts`: privileged app utility IPC such as native dialogs, file manager integration, SFTP temp-file creation, and validated OS-open/Open With flows.
  - `src/ipc/sftp-open-with-runtime.ts`: kernel-anchored Windows system executable/library resolution, OS-known-folder child environments, and packaged-versus-development macOS helper selection for SFTP Open With.
  - `src/ipc/register-debug-ipc.ts`: development diagnostics IPC, including the backend request mirror list/clear/event channels.
  - `src/ipc/backend-request-trace-store.ts`: development-only sanitized ring buffer for backend proxy request mirrors.
  - `src/ipc/sftp-download-target-authorizations.ts`: renderer-owned exact-path capabilities for local SFTP download destinations, including one owner-bound retry lease keyed by `transferId`.
  - `src/ipc/sftp-task-download-authorizations.ts`: async-task admission and terminal-observation helpers that preserve exact owner/path/`transferId` download authorization across Main task IPC.
  - `src/preload.ts`: secure renderer bridge.
  - `src/security/database-encryption.ts`: DB path/key handling helpers, including development profile database overrides.
  - `src/dev/dev-profile.ts`: development-only profile activation that maps selected profiles to Electron `userData`, SQLite, and backend secret storage paths before startup.
  - `src/dev/backend-runtime.ts`: validation boundary for the system Node executable used by Main's development backend child.
  - `resources/installer.nsh`: Windows NSIS installer extensions, including assisted option pages, shell/terminal registration hooks, uninstall data cleanup, and installer DPI manifest settings.
  - `resources/helpers`: packaged OS helpers, including the macOS NSWorkspace SFTP Open With helper source/binary.
  - `resources/remote-bootstrap/manifest-url.json`: git-ignored CI packaging resource that records the default Remote Enhancements manifest URL for packaged backend startup when a release or `main` build provides one.
  - `scripts/compile-macos-open-with-helper.mjs`: macOS-only build hook that compiles the SFTP Open With helper before packaging.
  - `scripts/dev-main.cjs`: system-Node development launcher that compiles Main and hands the canonical Node executable to Electron.
  - `scripts/dev-preflight.cjs`: incremental development build check for API contract and i18n outputs.
  - `scripts/ensure-sqlcipher-native.cjs`: target-aware SQLCipher native ABI probe and rebuild path for system Node development and Electron packaging.
  - `scripts/write-remote-bootstrap-manifest-url.cjs`: CI packaging helper that writes the packaged Remote Enhancements manifest URL resource when `COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL` is set, and removes any stale ignored resource when it is not set.
  - `devtools/request-trace-panel`: unpacked development-only DevTools extension loaded by Main in development runs; it reads the renderer mirror cache and does not alter backend transport.

### `packages/renderer`

- **Role**: React UI layer.
- **Key folders**:
  - `src/pages`: feature pages (`Home`, `SSH`, `SFTP`, `Settings`, `SettingsEditor`, etc.). Home owns the SSH server, keychain, and port-forwarding management surfaces.
  - `src/pages/ssh`: SSH terminal controllers and pure runtime helpers. `use-ssh-core.ts` coordinates pane routing; primary/secondary hooks own independent session resources; `ssh-pane-state.ts` reduces pane-scoped transport/helper/Agent attachment messages; `ssh-command-markers.ts` owns pending/confirmed xterm marker lifecycles and pane-local command timeline models; `TerminalCommandTimeline.tsx` renders the trusted right-side command rail; `SSHTerminalPaneLayout.tsx` owns the pane-local Agent status bar and Stop/Detach controls.
  - `src/pages/sftp`: SFTP page submodules. `SFTP.tsx` stays the tab-level orchestration entrypoint, while this folder owns browser UI composition, action/drop menus, directory/tree/detail panels, archive dialogs and archive-action polling, fixed-row virtualization helpers and tests, controller hooks for prompts, preferences, selection, keyboard shortcuts, drag/drop, preview actions, concurrent/serial renderer task lanes, failure-attention state, byte-progress presentation, and shared SFTP helpers. `src/lib/api/sftp-task-runtime.ts` owns fixed accepted-session task polling used by typed client wrappers.
  - `src/pages/settings-editor`: CodeMirror-backed settings JSON editor modules, including schema diagnostics, completion, hover details, and editor lifecycle wrappers.
  - `src/components/CloseWindowConfirmationDialog.tsx`: shared Renderer `Dialog` presentation for Main-owned active-session close decisions.
  - `src/components/ui`: Radix-based primitive wrappers, reusable search/replace panel, CodeMirror text context menu, and styling contracts.
  - `src/components/home`: home/SSH shared entity modules (card/icon rendering, TanStack Virtual-backed visual picker, reusable folder-creation dialog).
  - `src/components/terminal`: terminal interaction composites (context menu, selection bar, autocomplete menu).
  - `src/lib`: backend transport, i18n, settings bootstrap (`app-settings.ts`), renderer request-trace mirror bootstrap (`backend-request-trace-mirror.ts`), shared date-time display formatting (`date-time-format.ts`), shared CodeMirror syntax highlighting and search/replace adapter, and utility abstractions (including shared entity visual helpers, Home folder grouping, and the folder-dialog hook). `agent-terminal-registry.ts` is the renderer-only SSH pane registry; `mcp-terminal-lifecycle.ts` holds pure launch/tab lifecycle decisions.
  - `theme`: token source used to generate CSS variable system.

### `packages/backend`

- **Role**: Internal API + session orchestration runtime.
- **Key folders**:
  - `src/http/routes`: REST endpoints for settings, SSH entities, SFTP session/task operations, port-forwarding rules, and local terminal actions.
  - `src/audit`: local-first audit domain (sanitization, retention policy, query model, write service).
  - `src/ssh`: SSH auth/session logic (`ssh2`, known-host trust, telemetry, keychain-backed credential resolution), the streaming OSC 777 parser/trust gate, structured command lifecycle consumption, shared Agent PTY attachment/command state machine (`agent-terminal.ts`), and authenticated connection helpers for shell and non-shell transports. The helper creates fresh proxy sockets per transport and supports attempt-scoped compression and cancellation.
  - `src/remote-bootstrap`: pre-shell Remote Enhancements orchestration. It shares concurrent manifest fetches through a five-minute success-only cache, probes the remote platform through a temporary SSH transport isolated from the interactive client, validates installed status, conditionally injects the download wrapper, returns a trusted helper contract, forwards `bootstrap-status`, and logs terminal bootstrap outcomes.
  - `src/port-forward`: SSH port-forwarding rule validation, SOCKS5 parsing, and active runtime session service.
  - `src/sftp`: SFTP browser, download, file-operation, task-scheduling, and remote-archive session logic. `session-service.ts` owns session authorization/lifecycle and ordinary `ssh2.sftp` operations; `task-scheduler.ts` owns per-session total/heavy/mutation admission, POSIX path claims, absolute deadlines, cancellation signals, and memory-only task snapshots; `archive-service.ts` owns fixed POSIX command construction, capability probing, async archive state, staging/commit, conflict merge, cancellation, audit, and cleanup under an exclusive scheduler claim. Single-file transfers retain their existing short-lived byte-progress records.
  - `src/mcp`: externally-exposed MCP server runtime. `service.ts` is the lifecycle/settings-gated façade; `pairing.ts` owns encrypted pairing tokens and discovery; `sessions.ts` owns per-client transport state; `connection-capacity.ts` enforces the shared 8-connection cap; `connection-registry.ts` owns background and visible connection summaries/lifecycle; `approval-broker.ts` owns 120-second authorization requests; `terminal-launch-broker.ts` owns replayable 60-second visible-tab launches; `events-service.ts` streams approval/connection/launch/session events; `exec.ts` retains bounded background `ssh2.exec`; `tools.ts` registers six MCP tools. Default off via `mcpEnabled`.
  - `src/settings`: settings payload defaults, validation parsers, and shared AppSettings readers used by HTTP routes and runtime services.
  - `src/validation-utils.ts`: shared backend HTTP-boundary validation primitives used by route and domain payload parsers.
  - `src/local-terminal`: local PTY session logic (`node-pty`).
  - `src/terminal`: shared terminal session primitives (WebSocket message normalization, history parsing, size clamping, history sync timing helpers).
  - `src/terminal/completion`: shared terminal auto-complete domain (spec dataset, ranking engine, completion payload shaping) used by both SSH and local-terminal session services.
  - `src/db/prisma.ts`: Prisma lifecycle, runtime migration execution, schema validation, and structured database errors.
  - `src/db/sqlcipher.ts`: production SQLCipher adapter factory, keyed connection verification, legacy plaintext migration, and interrupted-migration recovery.

### `packages/api-contract`

Shared protocol constants, request/response types, OpenAPI source, generated contracts.

- `src/http.ts`: API path-token and query-string resolution helpers shared by main IPC proxying and renderer browser transport.
- `src/ipc.ts`: shared IPC-only payload enums and structs that are not generated from OpenAPI, such as app menu actions, SFTP Open With application descriptors, and development backend request traces.
- `src/settings-registry.ts`: **single source of truth** for all settings definitions — types, defaults, constraints, enum sets, UI control metadata, categories, and helper functions. Adding/removing a setting only requires editing this file.
- `src/settings.ts`: generic, registry-driven validation and normalization helpers (`normalizeSettingsValuesStrict`, `normalizeSettingsValuesWithDefaults`) shared by backend and renderer.
- `src/sftp.ts`: shared SFTP entry/name ordering helpers consumed by backend session listings and renderer browser/tree views.
- `src/terminal-protocol.ts`: protocol-v2 terminal WebSocket unions, remote shell event/capability constants, bootstrap/runtime status types, and renderer-safe Agent attachment status shared by backend and renderer.

### `packages/i18n`

Locale JSON source files and i18n runtime package for main/backend/renderer scopes.

- Runtime core is payload-agnostic. Consumers import only required locale JSON files and register them through `createMessages(...)` + `createI18n(...)`.
- Backend scope can merge generated completion locale data (for example `backend-inshellisense.json`) via `mergeTranslationTrees(...)` before registration.

### `packages/remote-bootstrap`

Go source for the user-scoped remote installer used by Remote Enhancements. This package does not open SSH connections; backend `RemoteBootstrapService` decides when to run it and how to forward statuses.

- `README.md`: module guide covering purpose, runtime ownership, manifest contract, installed paths, status codes, security boundaries, and test/build commands.
- `cmd/cosmosh-wrappergen`: generates shell-specific bootstrap wrappers for `bash`, `zsh`, `fish`, `ash`, and `sh`.
- `cmd/cosmosh-bootstrap`: installs the downloaded bootstrap binary and Go-generated shell helper into user-scoped remote directories, or reports the validated installed runtime contract.
- `internal/wrapper`: validates manifest-derived wrapper inputs and renders POSIX/fish shell source with shell-safe quoting.
- `internal/install`: owns versioned helper generation, shell-accurate OSC capability declarations, exact helper/binary validation, atomic user-level installation, Bash interactive/login profile coverage, mode/symlink-preserving profile repair, installed status reporting, version marker writes, and line-delimited `bootstrap-status` output.

### `packages/mcp-bridge`

Standalone `cosmosh-mcp` stdio bridge that connects an external MCP client (Claude Code/Desktop, Cursor) to the running app. It performs transport-level JSON-RPC passthrough only and holds no product logic.

- `src/discovery.ts`: resolves `<userData>/mcp/bridge.json` (via `--discovery`, `COSMOSH_MCP_DISCOVERY`, or the platform default) to obtain the loopback port and pairing token.
- `src/proxy.ts`: bridges `StdioServerTransport` ↔ `StreamableHTTPClientTransport('http://127.0.0.1:<port>/mcp', { Authorization: Bearer })`, re-reading discovery to retry once on disconnect.
- `src/index.ts`: CLI entry that emits a single actionable stderr line and exits non-zero when the app is not running or MCP is disabled.
- Built by esbuild into a single-file `dist/cosmosh-mcp.cjs` (CJS, `platform=node`). Main `prebuild` copies it into `packages/main/resources/helpers/mcp-bridge/` (git-ignored) for packaging; the packaged app writes a launcher under `<userData>/bin/` that runs the bundle under Electron as Node.

### `skills`

Repository-hosted agent skills. `skills/cosmosh-mcp/SKILL.md` teaches an external agent how to use the Cosmosh MCP tools, the connection/command authorization model, and the audit/credential ground rules.

## 3. Feature Placement Rules

```mermaid
flowchart TD
  A[New Feature Request] --> B{UI only?}
  B -- Yes --> C[packages/renderer/src/pages + components]
  B -- No --> D{Needs privileged access?}
  D -- Yes --> E[Add preload bridge API + main IPC]
  E --> F[Main proxies to backend or executes OS action]
  D -- No --> G[Add backend route/service]
  G --> H[Expose through transport in renderer]
  F --> I[Update docs + ipc-protocol]
  H --> I
```

## 4. Naming & Structure Guidelines

- Keep cross-process contracts in `api-contract` first, then consume in backend/main/renderer.
- Keep renderer side effects in `src/lib` (transport/services), not directly in presentational components.
- Add new IPC channels only via preload and mirror declaration in `renderer/src/vite-env.d.ts`.
- For backend features:
  - route in `http/routes/*`
  - business/session logic in dedicated service module
  - input validation in `ssh/validation.ts`-style parser modules.

## 5. Not Implemented Yet (Planned)

- Directory upload/download, generalized public task cancellation/resume, scheduler retry policies, and persisted task history remain planned. The core backend scheduler, task start/list/detail API, single-file progress records, and exclusive archive coordination are implemented as bounded in-memory flows.
- Dedicated shared `common` package is not present yet; current sharing is done through `api-contract` + `i18n`.

## 6. Common Change Scenarios

### Add New IPC Action

1. Define or reuse contract types in `packages/api-contract` when needed.
2. Expose the bridge API in `packages/main/src/preload.ts`.
3. Add `ipcMain` handler in `packages/main/src/ipc/*` and, when needed, backend proxy wiring.
4. Wire renderer transport wrapper in `packages/renderer/src/lib`.
5. Update `docs/developer/core/ipc-protocol.md` in the same change set.

### Add New Backend Capability

1. Add route under `packages/backend/src/http/routes`.
2. Add service logic in domain module (`ssh`, `local-terminal`, or new module).
3. Add validation/parser layer for input boundaries.
4. For security-core operations, emit `AuditEventService` events with redacted metadata.
5. Expose consumption path to renderer via main bridge.
6. Sync architecture/runtime docs.

### Add New Port Forwarding Behavior

1. Update `packages/api-contract/openapi/cosmosh.openapi.yaml` first when route or payload shape changes.
2. Keep persistence fields in `packages/backend/prisma/schema.prisma` and matching migrations.
3. Keep runtime ownership in `packages/backend/src/port-forward`, using `packages/backend/src/ssh/connect.ts` for SSH authentication and host trust.
4. Mirror bridge changes through `packages/main/src/preload.ts`, `packages/main/src/ipc/register-backend-ipc.ts`, `packages/renderer/src/vite-env.d.ts`, and renderer API wrappers.
5. Update `docs/developer/runtime/port-forwarding.md` and `docs/zh-CN/developer/runtime/port-forwarding.md`.

### Add New Application Setting

1. In `packages/api-contract/src/settings-registry.ts`:
   - Add the key and its type to the `SettingsValues` interface.
   - Add a `SettingDefinition` entry to the `SETTINGS_REGISTRY` array (default value, constraints, UI control, category, i18n keys, etc.).

2. Add i18n keys in `packages/i18n/locales/en/*.json` and `zh-CN/*.json`.
3. No other files need changes — validation, defaults, and UI rendering are derived from the registry automatically.

## 7. Local-First Audit Ownership Map (2026-03)

- Data model owner:
  - `packages/backend/prisma/schema.prisma` (`AuditEvent`, `AuditSyncCursor`).
  - `packages/backend/prisma/migrations/*` for runtime schema convergence.
- Runtime owner:
  - `packages/backend/src/audit/service.ts` for write/query/retention flow.
  - `packages/backend/src/audit/sanitizer.ts` for metadata redaction and size caps.
  - `packages/backend/src/http/routes/audit.ts` for list/detail API surface.
- Bridge owner:
  - `packages/main/src/ipc/register-backend-ipc.ts` and `packages/main/src/preload.ts` for audit IPC channels.
- Renderer owner:
  - `packages/renderer/src/pages/AuditLogs.tsx` for operator-facing list/detail experience.
  - `packages/renderer/src/lib/api/*` for typed transport/client mapping.
- Documentation owner:
  - `docs/developer/runtime/audit-events.md` and `docs/zh-CN/developer/runtime/audit-events.md` as runtime source pages.

## 8. SSH Keychain Ownership Map (2026-03)

- Data model owner:
  - `packages/backend/prisma/schema.prisma` for `SshKeychain` and `SshServer.keychainId` relation.
  - Keychain folder/tag metadata reuses `SshFolder` and `SshTag` (plus `SshKeychainTagLink`) instead of dedicated keychain-only folder/tag tables.
- Runtime owner:
  - `packages/backend/src/http/routes/ssh.ts` for keychain CRUD + credential fetch routes.
  - `packages/backend/src/ssh/session-service.ts` for server→keychain credential hydration during connect.
- Bridge owner:
  - `packages/main/src/ipc/register-backend-ipc.ts` and `packages/main/src/preload.ts` for keychain IPC proxy channels.
- Renderer owner:
  - `packages/renderer/src/pages/Home.tsx` for the shared Home sidebar and SSH server / keychain / port-forwarding mode bodies. Home is the canonical management surface for servers and keychains.
  - `packages/renderer/src/components/ssh/SSHServerEditorDialog.tsx` for per-server create/edit, including keychain selection and inline fallback editing. When it embeds keychain creation, locally saved keychains must be merged with any in-flight reference-list reload so the server form can select the newly saved keychain immediately.
  - `packages/renderer/src/components/ssh/SSHKeychainEditorDialog.tsx` for shared keychain create/edit. Each Home mode owns an independent sort/group view preference so mode switches do not rewrite another surface's organization state.

## 9. SSH Port Forwarding Ownership Map (2026-05)

- Data model owner:
  - `packages/backend/prisma/schema.prisma` (`PortForwardRule`, `PortForwardRuleType`).
  - `packages/backend/prisma/migrations/*port_forward_rules*` for runtime schema convergence.
- Contract owner:
  - `packages/api-contract/openapi/cosmosh.openapi.yaml` for routes, payloads, API codes, and generated `API_PATHS`.
  - `packages/api-contract/src/index.ts` for exported request/response aliases consumed by main/renderer.
- Runtime owner:
  - `packages/backend/src/http/routes/port-forward.ts` for CRUD/start/stop routes.
  - `packages/backend/src/port-forward/session-service.ts` for active local/remote/dynamic runtime state.
  - `packages/backend/src/port-forward/validation.ts` and `socks5.ts` for input and SOCKS protocol boundaries.
  - `packages/backend/src/ssh/connect.ts` for shared SSH authentication and host trust.
- Bridge owner:
  - `packages/main/src/ipc/register-backend-ipc.ts`, `packages/main/src/preload.ts`, and `packages/renderer/src/vite-env.d.ts`.
- Renderer owner:
  - `packages/renderer/src/pages/Home.tsx` for Home -> Port Forwarding table, mode-local sort/group controls, dialog, actions, and host trust retry.
  - `packages/renderer/src/lib/api/*` and `packages/renderer/src/lib/backend.ts` for typed transport wrappers.
- Documentation owner:
  - `docs/developer/runtime/port-forwarding.md` and `docs/zh-CN/developer/runtime/port-forwarding.md`.

## 10. Server Proxy Ownership Map (2026-06)

- Contract and validation:
  - `packages/api-contract/src/proxy.ts` owns proxy modes, URL validation, protocols, and limits.
  - `packages/api-contract/openapi/cosmosh.openapi.yaml` owns server proxy fields and transient system proxy request fields.
- Persistent model:
  - `packages/backend/prisma/schema.prisma` owns `SshServer.proxyMode` and `SshServer.proxyUrl`.
- Privileged system resolution:
  - `packages/main/src/ipc/register-app-utility-ipc.ts` owns `app:resolve-system-proxy` through Electron `Session.resolveProxy`.
- Renderer orchestration:
  - `packages/renderer/src/lib/server-proxy.ts` decides whether system resolution is needed before SSH, SFTP, or port-forward startup.
- Backend runtime:
  - `packages/backend/src/ssh/proxy.ts` owns precedence, PAC result parsing, tunnel construction, timeout sharing, and credential-safe errors.

## 11. MCP Server Ownership Map (2026-07)

- Contract and settings:
  - `packages/api-contract/src/mcp.ts` owns `McpCommandPolicy` / `McpServerCommandPolicy`, event types, and defaults.
  - `packages/api-contract/openapi/cosmosh.openapi.yaml` owns the `/api/v1/mcp/*` management endpoints; the `/mcp` JSON-RPC endpoint is intentionally not in OpenAPI.
  - `packages/api-contract/src/settings-registry.ts` owns `mcpEnabled` (default false) and `mcpCommandPolicy` (default `ask`) under the `mcp` category.
- Persistent model:
  - `packages/backend/prisma/schema.prisma` owns `SshServer.mcpCommandPolicy` and the `McpPairingToken` model, with migration `20260726000100_mcp_pairing_and_policy`.
- Backend runtime:
  - `packages/backend/src/mcp/*` owns the MCP server, pairing/discovery, shared connection capacity, background/visible connection registry, approval broker, terminal launch broker, event channel, bounded background exec, and tool registration.
  - `packages/backend/src/ssh/agent-terminal.ts` and `session-service.ts` own trusted shared-PTY attachment, one-command serialization, command-id output capture, intervention tracking, and terminal-close invalidation.
  - `packages/backend/src/http/routes/mcp.ts` owns the management REST surface; `src/mcp/http.ts` owns the `/mcp` endpoint mount and Bearer auth.
- Stdio bridge and packaging:
  - `packages/mcp-bridge/*` owns the `cosmosh-mcp` bridge bundle.
  - `packages/main/scripts/sync-mcp-bridge.cjs` and `packages/main/src/mcp-bridge-launcher.ts` own bundle sync and the per-user launcher script; the launcher path is advertised through `COSMOSH_MCP_BRIDGE_LAUNCHER`.
- Bridge owner:
  - `packages/main/src/ipc/register-backend-ipc.ts`, `packages/main/src/preload.ts`, and `packages/renderer/src/vite-env.d.ts` for the `backend:mcp-*` and `app:focus-main-window` channels.
- Renderer owner:
  - `packages/renderer/src/components/settings/SettingsMcpSection.tsx` owns status, pairing, client configuration, connections, and approvals inside `Settings > MCP`; there is no standalone MCP page or tab.
  - `McpApprovalHost.tsx` owns pane selection; `McpTerminalHost.tsx` owns replay-safe visible-tab launch/bind/close behavior; `agent-terminal-registry.ts` owns renderer-private pane/session identity; and `use-mcp-events.ts` owns event backfill.
  - `packages/renderer/src/components/ssh/SSHServerEditorDialog.tsx` for the per-server command-policy override.
- Documentation owner:
  - `docs/developer/runtime/mcp-server.md` and `docs/zh-CN/developer/runtime/mcp-server.md` as the runtime source pages; `skills/cosmosh-mcp/SKILL.md` as the external-agent guide.
