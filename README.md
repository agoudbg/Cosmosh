# 🛸 Cosmosh

A high-performance, professional-grade SSH/Terminal client built with Electron.

## Tech Stack

- **Desktop Framework**: Electron
- **Frontend**: Vite + React + TypeScript
- **Backend**: Hono + Node.js
- **Package Manager**: pnpm (workspace)
- **Code Quality**: ESLint 9 + Prettier

## Project Structure

```
cosmosh/
├── packages/
│   ├── main/           # Electron main process
│   ├── renderer/       # Vite + React frontend
│   ├── backend/        # Hono API server
│   ├── api-contract/   # OpenAPI spec + generated shared API types
│   └── i18n/           # Shared i18n core and locale resources
├── pnpm-workspace.yaml
└── package.json
```

## API Mechanism

- **SSOT**: API contract lives in `packages/api-contract/openapi/cosmosh.openapi.yaml`.
- **Type generation**: `openapi-typescript` generates `packages/api-contract/src/generated.ts`.
- **Protocol constants**: `packages/api-contract/src/protocol.ts` is generated from OpenAPI.
- **Envelope helpers**: `packages/api-contract/src/envelope.ts` exposes shared success/error templates.

### Runtime Communication

- **Electron runtime**: Renderer -> Main (IPC) -> Backend (HTTP with internal token)
- **Browser runtime (prepared fallback)**: Renderer uses browser transport placeholder with future token + base URL strategy.
- Renderer API calls are now isolated behind `packages/renderer/src/lib/api/client.ts` and `packages/renderer/src/lib/api/transport.ts`.

### Contract Commands

```bash
# Regenerate contract outputs from OpenAPI
pnpm --filter @cosmosh/api-contract generate

# Build contract package
pnpm --filter @cosmosh/api-contract build
```

For package-local details, see `packages/api-contract/README.md`.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0

### Installation

```bash
# Install dependencies for all packages
pnpm install
```

### Development

```bash
# Start all services in development mode
pnpm dev              # Start Electron app
pnpm dev:renderer     # Start Vite dev server (port 5173)
pnpm dev:backend      # Start Hono backend (port 3000)
```

### Build

```bash
# Build all packages
pnpm build
```

### Linting & Formatting

```bash
# Run ESLint on all packages
pnpm lint

# Run Prettier on all packages
pnpm format
```

### i18n Locale Check

```bash
# Validate locale key consistency in the shared i18n package
pnpm --filter @cosmosh/i18n check
```
