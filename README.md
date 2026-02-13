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
│   └── i18n/           # Shared i18n core and locale resources
├── pnpm-workspace.yaml
└── package.json
```

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
