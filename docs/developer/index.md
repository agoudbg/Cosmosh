# Developer Documentation

This section is the engineering source of truth for Cosmosh implementation and governance.

## Recommended Read Order

```mermaid
flowchart TD
  A[Project Map] --> B[Architecture]
  B --> C[IPC Protocol]
  B --> D[SSH Terminal]
  B --> G[Database Security]
  B --> E[SFTP File System]
  B --> F[UI/UX Standards]
```

## Sections

- Core
  - [Project Map](./core/project-map.md)
  - [Architecture](./core/architecture.md)
  - [IPC Protocol](./core/ipc-protocol.md)
- Runtime
  - [SSH Terminal](./runtime/ssh-terminal.md)
  - [Database Security](./runtime/database-security.md)
  - [SFTP File System](./runtime/sftp-file-system.md)
- Design & Governance
  - [UI/UX Standards](./design/ui-ux-standards.md)

## Task-Oriented Entry Points

- Adding a new runtime feature: start from [Project Map](./core/project-map.md), then [Architecture](./core/architecture.md), then [IPC Protocol](./core/ipc-protocol.md).
- Updating SSH behavior: read [SSH Terminal](./runtime/ssh-terminal.md) and align protocol notes in [IPC Protocol](./core/ipc-protocol.md).
- Debugging DB encryption startup: read [Database Security](./runtime/database-security.md), then verify process flow in [Architecture](./core/architecture.md).
- Updating visual behavior: follow [UI/UX Standards](./design/ui-ux-standards.md) before touching page-level styles.

## Governance Reference

- Documentation governance and writing conventions are maintained in `docs/README.md` and repository root `AGENTS.md`.
