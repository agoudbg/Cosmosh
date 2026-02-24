# AGENTS.md

## Cosmosh AI Collaboration Rules (Copilot / Cursor / Cline)

This file defines mandatory collaboration rules for AI agents working in Cosmosh.

## 0. Pre-Task Initialization (Strictly Enforced)

Before writing any code, modifying files, or generating a plan, you must adhere to the following:
1. **Strict Resource Compliance:** You must comprehensively review and strictly follow all existing project documentation, this `AGENTS.md` file, established architecture rules, and any provided Agent Skills or custom instructions.
2. **Contextual Awareness:** Keep the Cosmosh core identity in mind: A high-performance, high-information-density SSH/SFTP client built for Power Users.
3. **Tech Stack Alignment:** Always assume the core stack (Electron, React, Tailwind CSS, pnpm, xterm.js, ssh2) and use the correct package manager (`pnpm`) for any dependency operations.
4. **Analyze First:** Do not rush into code generation. Analyze the current codebase context, evaluate the impact of your changes, and align with the existing architecture before modifying files.

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

## 2. Code Standards & Quality

### 2.1 Code Quality and DRY Principle
- **Reject Duplicate Code!** Never copy-paste blocks of code. Actively look for repeated patterns across the codebase.
- **Abstract and Extract:** Extract duplicate UI elements into reusable components. Abstract repeated logic into pure functions, custom React hooks, or shared utility modules.
- Ensure all functions and modules adhere to the Single Responsibility Principle.

### 2.2 Comprehensive Commenting (Mandatory)
- **Language:** All comments in the codebase MUST be in English.
- **JSDoc Everywhere:** All exported functions, classes, interfaces, and complex types must have complete JSDoc blocks explaining the purpose, parameters, return types, and any edge cases.
- **Explain the "Why":** Comments should explain the intent, business logic, and constraints (`Why`), not narrate the syntax (`What`).
- **Block-level Summaries:** For complex algorithms, multi-step processes, or specific logical chunks, provide a clear, high-level summary comment at the start of that code block detailing what the block achieves.

### 2.3 Framework & Process Constraints
- Keep strict process boundaries:
  - Main process for privileged orchestration.
  - Preload for minimal secure bridge.
  - Renderer for UI logic only.
- Avoid heavy UI frameworks; use Radix primitives wrapped by Cosmosh internal Tailwind components to guarantee pixel-perfect precision.

## 3. Aesthetic Constraints

- Visual language must follow `docs/ui-ux-standards.md` exactly.
- Keep high-density professional layout (Linear/Arc-inspired precision).
- Strict adherence to typographic scales (standard font size 14px) and rigorous border-radius calculations.
- Do not introduce ad-hoc colors/radius/shadows/blur values outside token and wrapper rules. Stick to the defined dark mode and moderate glassmorphism specs.

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

1. Implementation is complete, abstract, well-commented, and builds successfully.
2. Affected docs under `docs/` are synchronized.
   2.1 English and Chinese developer docs are both updated and semantically aligned.
3. IPC dictionary is updated if channels changed.
4. UI changes match visual standards exactly (Tailwind/Radix only, no ad-hoc styling).
5. Any major architectural change has recorded developer approval.
