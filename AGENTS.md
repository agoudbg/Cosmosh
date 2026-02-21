# AGENTS.md

## Cosmosh AI Collaboration Rules (Copilot / Cursor / Cline)

This file defines mandatory collaboration rules for AI agents working in Cosmosh.

## 1. Sync Principle (Documentation Is Part of the Change)

For any change that touches feature behavior, architecture, IPC, transport contracts, or UX standards, update matching docs in the same change set.

Documentation synchronization is not optional or post-fix work. It is part of the implementation done-definition.

Mandatory mapping:

- Architecture/runtime changes → `docs/developer/core/architecture.md` (+ `docs/zh-CN/developer/core/architecture.md`)
- Folder/module ownership or placement changes → `docs/developer/core/project-map.md` (+ `docs/zh-CN/developer/core/project-map.md`)
- SSH terminal/session protocol changes → `docs/developer/runtime/ssh-terminal.md` (+ `docs/zh-CN/developer/runtime/ssh-terminal.md`)
- SFTP capability changes → `docs/developer/runtime/sftp-file-system.md` (+ `docs/zh-CN/developer/runtime/sftp-file-system.md`)
- IPC channel changes → `docs/developer/core/ipc-protocol.md` (+ `docs/zh-CN/developer/core/ipc-protocol.md`)
- Visual system/tokens/interaction standards changes → `docs/developer/design/ui-ux-standards.md` (+ `docs/zh-CN/developer/design/ui-ux-standards.md`)

No implementation PR is considered complete if required docs are stale.

### 1.1 Timeliness Rules (Mandatory)

- Update docs in the same task, not in a later “docs follow-up”.
- Keep doc edits in the same branch and ideally the same commit set as code changes.
- If implementation scope changes during development, adjust docs immediately before finalizing.
- If a task introduces TODO limitations, document current behavior and planned follow-up explicitly.

### 1.2 Development Documentation Expansion Rules

- Do not only patch changed lines; improve surrounding context when needed for future maintainers.
- Prefer adding “decision rationale” and “boundary constraints” sections when behavior is non-obvious.
- When introducing new modules/channels/features, add or update:
	- ownership/location notes,
	- lifecycle/data-flow diagrams,
	- error model/retry semantics,
	- security constraints and assumptions.
- Keep examples and flow diagrams aligned with current runtime behavior.

### 1.3 Bilingual Documentation Policy

- English documentation is the source of truth.
- Chinese documentation is synchronized translation.
- Any update to English developer docs must include same-cycle Chinese sync.
- If temporary mismatch is unavoidable, clearly mark affected pages with a sync TODO and resolve before merge.

### 1.4 Documentation Authoring Conventions

- Keep documentation process/writing rules centralized in `AGENTS.md` and `docs/README.md`.
- Do not scatter generic documentation-writing guidance across feature-specific pages.
- In Chinese Markdown content, do not insert spaces before/after link syntax.
	- Correct: `请阅读[开发文档总览](/zh-CN/developer/)`

## 2. Code Standards

- All comments must be in English.
- Comments should explain intent/constraints (`Why`), not syntax narration (`What`).
- Keep strict process boundaries:
	- Main process for privileged orchestration.
	- Preload for minimal secure bridge.
	- Renderer for UI logic only.
- Avoid heavy UI frameworks; use Radix primitives wrapped by Cosmosh internal components.

## 3. Aesthetic Constraints

- Visual language must follow `docs/ui-ux-standards.md` exactly.
- Keep high-density professional layout (Linear/Arc-inspired precision).
- Do not introduce ad-hoc colors/radius/shadows/blur values outside token and wrapper rules.

## 4. Architecture Change Confirmation Gate

For major changes (cross-process boundary, IPC contract redesign, backend runtime model changes, persistent data model migrations, or security model changes):

1. Provide a short implementation brief to the developer first.
2. Explicitly ask for approval before editing implementation files.
3. Proceed only after approval.

## 5. Tool Compatibility Notes

- **Copilot**: repository instruction entry should reference this file.
- **Cursor/Cline**: keep this file at repository root as canonical governance source.
- If tool-specific rule files exist, they must mirror this file and must not conflict.

## 6. PR / Task Completion Checklist

Before finishing any AI-assisted task:

1. Implementation is complete and builds.
2. Affected docs under `docs/` are synchronized.
2.1 English and Chinese developer docs are both updated and semantically aligned.
3. IPC dictionary is updated if channels changed.
4. UI changes match visual standards.
5. Any major architectural change has recorded developer approval.
