# Cosmosh Development Guide

## Project Structure

The project is organized as a pnpm workspace with three main packages:

- **packages/main**: Electron main process (Node.js backend for Electron)
- **packages/renderer**: Frontend UI (Vite + React + TypeScript)
- **packages/backend**: API server (Hono + Node.js)
- **packages/i18n**: Shared i18n core and translation resources

## Initial Setup

After cloning the repository:

```bash
# Install all dependencies
pnpm install
```

## Development Workflow

### Option 1: Run All Services Separately

Open three terminal windows:

```bash
# Terminal 1: Start the Electron app
pnpm --filter @cosmosh/main dev

# Terminal 2: Start the renderer dev server (Required for Electron)
pnpm --filter @cosmosh/renderer dev

# Terminal 3: Start the backend API
pnpm --filter @cosmosh/backend dev
```

### Option 2: Using the Root Scripts

```bash
# Start Electron main process (will try to load renderer from localhost:2767)
pnpm dev

# Start renderer dev server
pnpm dev:renderer

# Start backend API
pnpm dev:backend
```

## Backend Database (Prisma + SQLite)

Current status: framework only, no tables/models yet.

### Files

- Prisma schema: `packages/backend/prisma/schema.prisma`
- DB bootstrap service: `packages/backend/src/db/prisma.ts`
- Manual init command: `packages/backend/src/scripts/init-db.ts`

### Initialization Modes

- **Automatic**: backend startup calls `initializeDatabase(...)` before opening the HTTP port.
- **Manual**: run `pnpm --filter @cosmosh/backend db:init` to initialize and validate DB setup only.

### Command Examples

```bash
# Generate Prisma client only
pnpm --filter @cosmosh/backend db:generate

# Run one-shot DB initialization check (without starting API server)
pnpm --filter @cosmosh/backend db:init

# Start backend in standalone mode (DB path: packages/backend/.cosmosh/...)
pnpm --filter @cosmosh/backend dev

# Start backend in electron-main mode (PowerShell)
$env:COSMOSH_RUNTIME_MODE='electron-main'; pnpm --filter @cosmosh/backend dev
```

### Runtime Flow (Text Diagram)

```text
Backend Start
   └─ bootstrap()
         ├─ initializeDatabase(runtimeMode)
         │   ├─ resolveDatabaseFilePath(runtimeMode)
         │   ├─ ensureSecureDirectory(...)
         │   ├─ ensureSecureFile(...)
         │   ├─ PrismaClient.$connect()
         │   └─ applyPragmas(...)
         ├─ registerShutdownHooks()
         └─ serve(Hono app)

Process Exit (SIGINT/SIGTERM)
   └─ shutdownDatabase()
```

### Security Strategy (Current)

- Use app-local/private storage path by runtime mode:
   - `electron-main`: user local app data directory
   - `standalone`: `packages/backend/.cosmosh/`
- Create DB directory with restricted permission intent (`0700` where supported).
- Create DB file with restricted permission intent (`0600` where supported).
- On Windows, enforce ACL hardening via `icacls`:
   - remove inherited permissions (`/inheritance:r`)
   - re-grant only current user + `SYSTEM`
- Apply SQLite pragmas at connect time:
   - `foreign_keys = ON`
   - `journal_mode = WAL`
   - `synchronous = NORMAL`
   - `busy_timeout = 5000`
   - `locking_mode = EXCLUSIVE` (electron-main only)

`locking_mode = EXCLUSIVE` improves single-owner safety semantics, but it can reduce
concurrency with external DB tools or secondary processes. If you see "database is locked"
symptoms during debugging, verify no extra process is trying to attach to the same DB file.

### Error Handling and Observability

- Structured DB errors are wrapped as `DatabaseInitError` with:
   - error code (for quick triage)
   - context object (runtime mode, file path, etc.)
   - original cause
- Startup/shutdown logs print DB error code and context for easier debugging.

## Important Notes

1. **For Electron development**: You MUST start the renderer dev server first (port 2767), then start the main process.

2. **Hot Reload**:
   - Renderer changes will hot-reload automatically via Vite
   - i18n locale changes also hot-reload in renderer dev mode
   - i18n locale changes auto-refresh in backend/main development runtime
   - Main process changes require restarting the Electron app
   - Backend changes will auto-reload via tsx watch

3. **i18n Watch Mode (Optional but Recommended while editing locales)**:

```bash
# Keep @cosmosh/i18n rebuilding in watch mode for non-renderer consumers
pnpm --filter @cosmosh/i18n dev
```

4. **Ports**:
   - Renderer: `http://localhost:2767`
   - Backend API: `http://localhost:3000`
   - Optional override: set `COSMOSH_RENDERER_DEV_PORT` before running dev commands.

## API Contract and Usage

### Single Source of Truth (SSOT)

- OpenAPI source: `packages/api-contract/openapi/cosmosh.openapi.yaml`
- Generated types: `packages/api-contract/src/generated.ts`
- Generated protocol constants: `packages/api-contract/src/protocol.ts`
- Shared response templates: `packages/api-contract/src/envelope.ts`

Detailed package-level guidance: `packages/api-contract/README.md`

Generate contract artifacts after API spec changes:

```bash
pnpm --filter @cosmosh/api-contract generate
```

### Frontend API Layer

Renderer no longer directly depends on `window.electron` for business calls:

- API client: `packages/renderer/src/lib/api/client.ts`
- Transport selection: `packages/renderer/src/lib/api/transport.ts`
- Compatibility wrapper: `packages/renderer/src/lib/backend.ts`

Current transport behavior:

- **Electron mode**: uses preload bridge (`backend:test-ping` IPC)
- **Browser mode**: uses a fallback placeholder prepared for future account-auth flow
   - reads future token key: `localStorage['cosmosh.accessToken']`
   - reads future API base URL: `VITE_COSMOSH_API_BASE_URL`
   - returns explicit error when auth flow is not yet implemented

### End-to-end call chain (detailed)

1. `Home.tsx` calls `testBackendPing()`
2. `lib/backend.ts` forwards to typed `backendClient`
3. `lib/api/client.ts` delegates to selected transport
4. `lib/api/transport.ts` chooses runtime path:
   - Electron: `window.electron.backendTestPing()` via preload IPC
   - Browser: prepared HTTP fallback with future bearer token contract
5. Main process receives `backend:test-ping`, adds internal token header, calls backend endpoint
6. Backend validates internal token and returns OpenAPI-conformant envelope

### Why this structure

- UI pages stay independent from IPC and runtime checks
- Runtime swap (Electron/Browser) is isolated in one transport layer
- Future account-auth implementation can be added in browser transport without touching page code

## Building for Production

```bash
# Build all packages
pnpm build

# Or build individually
pnpm --filter @cosmosh/renderer build
pnpm --filter @cosmosh/backend build
pnpm --filter @cosmosh/main build
```

`@cosmosh/main` on Windows now produces only the NSIS installer:

- Output: `packages/main/release/Cosmosh Setup <version>.exe`
- Prebuild behavior: `packages/main/release` is recreated each run to avoid stale artifacts.

## Code Quality

```bash
# Run ESLint
pnpm lint

# Auto-fix lint issues where supported
pnpm lint:fix

# Format code with Prettier
pnpm format
```

After `pnpm install`, Git pre-commit hook is configured automatically and runs:

```bash
pnpm precommit:lint
```

## TypeScript

Each package has its own `tsconfig.json`:

- **main**: Uses CommonJS module system for Electron compatibility
- **renderer**: Uses ES modules with React JSX support
- **backend**: Uses ES modules with Node.js support

## Troubleshooting

### ESLint Parser Errors

If you see ESLint parsing errors about `tsconfigRootDir`, try:

1. Reload VS Code window (Ctrl+Shift+P → "Developer: Reload Window")
2. Restart the ESLint server (Ctrl+Shift+P → "ESLint: Restart ESLint Server")

### TypeScript Errors

If TypeScript can't find modules after installation:

1. Reload VS Code window
2. Ensure the TypeScript server is using the workspace version (check bottom-right of VS Code)

### i18n Consistency Check

Run the locale consistency checker before commit when translation keys are changed:

```bash
pnpm --filter @cosmosh/i18n check
pnpm --filter @cosmosh/i18n check:sort
```

Auto-sort locale files when needed:

```bash
pnpm --filter @cosmosh/i18n sort
```

If pre-commit hooks do not run on macOS (for example after clone or permission changes), run:

```bash
pnpm prepare
```

Current default locale strategy:

- Main keeps the active locale state (`COSMOSH_LOCALE` as initial fallback)
- Renderer syncs locale with main via preload bridge (`getLocale`/`setLocale`)
- Backend resolves locale per request from `x-cosmosh-locale` (fallback: `Accept-Language`)

i18n formatting examples:

- Named placeholders: `Hello {name}, profile: {profile}` with `{ name: 'agou', profile: 'prod' }`
- Printf-style placeholders: `CPU %d%%, status: %s` with `[58, 'ok']`
- Indexed placeholders: `Node %1s has %2d sessions` with `['node-a', 3]`
- Single-key pluralization:
   `{count, plural, =0 {No sessions} one {# session} other {# sessions}}`

Pluralization quick guide:

- Base structure: `{count, plural, RULE_A {textA} RULE_B {textB} other {textN}}`
- `count` is the numeric variable passed to `t(...)`
- `#` is replaced with the actual number value of `count`
- `one` usually means singular form; `other` is the default fallback form
- `=0`, `=1` are exact-match rules and have higher priority than category rules

Examples:

```ts
t('home.pluralSessions', { count: 0 });
// => "No sessions"

t('home.pluralSessions', { count: 1 });
// => "1 session"

t('home.pluralSessions', { count: 3 });
// => "3 sessions"
```

Chinese example pattern:

```text
{count, plural, =0 {暂无会话} one {# 个会话} other {# 个会话}}
```

### Electron Won't Start

Make sure the renderer dev server is running first on port 2767.
