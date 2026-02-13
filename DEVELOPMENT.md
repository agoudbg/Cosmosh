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
# Start Electron main process (will try to load renderer from localhost:5173)
pnpm dev

# Start renderer dev server
pnpm dev:renderer

# Start backend API
pnpm dev:backend
```

## Important Notes

1. **For Electron development**: You MUST start the renderer dev server first (port 5173), then start the main process.

2. **Hot Reload**:
   - Renderer changes will hot-reload automatically via Vite
   - Main process changes require restarting the Electron app
   - Backend changes will auto-reload via tsx watch

3. **Ports**:
   - Renderer: `http://localhost:5173`
   - Backend API: `http://localhost:3000`

## Building for Production

```bash
# Build all packages
pnpm build

# Or build individually
pnpm --filter @cosmosh/renderer build
pnpm --filter @cosmosh/backend build
pnpm --filter @cosmosh/main build
```

## Code Quality

```bash
# Run ESLint
pnpm lint

# Format code with Prettier
pnpm format
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

Make sure the renderer dev server is running first on port 5173.
