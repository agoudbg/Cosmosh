# @cosmosh/api-contract

This package is the API contract single source of truth (SSOT) for Cosmosh.

## What lives here

- OpenAPI spec: `openapi/cosmosh.openapi.yaml`
- Generated API types: `src/generated.ts`
- Generated protocol constants: `src/protocol.ts`
- Shared response envelope helpers: `src/envelope.ts`

## Update workflow

1. Modify `openapi/cosmosh.openapi.yaml`
2. Regenerate artifacts:

```bash
pnpm --filter @cosmosh/api-contract generate
```

3. Build package (optional local verification):

```bash
pnpm --filter @cosmosh/api-contract build
```

## Runtime notes

- Electron flow: Renderer -> Main (IPC) -> Backend
- Browser fallback in renderer is prepared but not fully implemented yet.

## API details (current scope)

### Health endpoint

- Path: `/api/health`
- Method: `GET`
- Security: none
- Purpose: backend liveness probe used by main process startup

Example response:

```json
{
	"status": "ok",
	"timestamp": "2026-02-14T10:00:00.000Z"
}
```

### Test ping endpoint

- Path: `/api/v1/test/ping`
- Method: `GET`
- Security: `x-cosmosh-internal-token` header in Electron mode
- Extra header: `x-cosmosh-locale`
- Purpose: smoke test for Renderer -> Main -> Backend pipeline

Success example:

```json
{
	"success": true,
	"code": "TEST_PING_OK",
	"message": "Backend connection is healthy.",
	"requestId": "e5db12d8-b026-4e0b-bf95-4a1fef71dc90",
	"timestamp": "2026-02-14T10:00:00.000Z",
	"data": {
		"service": "cosmosh-backend",
		"mode": "electron-main",
		"authenticated": true,
		"capabilities": ["ssh", "sftp"]
	}
}
```

Failure example:

```json
{
	"success": false,
	"code": "AUTH_INVALID_TOKEN",
	"message": "Invalid internal authentication token.",
	"requestId": "13a7f388-6b66-4c38-8950-60ac5ca51ef4",
	"timestamp": "2026-02-14T10:00:00.000Z"
}
```

## Frontend integration reference

- Transport selection: `packages/renderer/src/lib/api/transport.ts`
- Typed client: `packages/renderer/src/lib/api/client.ts`
- Compatibility wrapper: `packages/renderer/src/lib/backend.ts`

Minimal usage example:

```ts
import { backendClient } from './lib/api/client';

const result = await backendClient.testPing();
console.log(result.code, result.data.capabilities);
```

## Important

- `src/generated.ts` and `src/protocol.ts` are auto-generated.
- Do not edit generated files directly.
