# 🛸 Project Cosmosh | Guiding Document

## 1. Project Overview

- **Internal Codename**: Cosmosh (Cosmos + .sh)
- **Official Name**: [Not Decided Yet]
- **Repository**: `agoudbg/cosmosh`
- **Product Type**: A high-performance, professional-grade SSH/Terminal client built with Electron.
- **Core Philosophy**: High information density without sacrificing modern aesthetics. Targeted at "power users" who prefer efficient, compact UIs and useful features over excessive whitespace.

## 2. Technical Stack

- **Runtime**: Electron
- **Frontend**: React (Latest), Vite
- **Backend**: Node.js + Hono for API routing, make it ready for potential future server-client decoupling.
- **Styling**: Tailwind CSS
- **Package Manager**: `pnpm`
- **Key Modules**: `xterm.js` for terminal rendering, Node.js `ssh2` for backend connectivity.

## 3. UI/UX Design Principles (Strict Adherence Required)

- **Information Density**: Maintain a "Pro-Tool" vibe.
- **Negative Space**: Use padding strategically to avoid "visual suffocation" while keeping the overall layout tight.
- **Design Reference**: Inspired by macOS, Arc, and modern dev tools.

## 4. Coding Standards & Implementation

- **Comments**: All code comments **MUST** be in English.
- **Theme Management**:
- Use CSS Variables for all colors, spacing, and radiuses to support custom themes.
- Tailwind should be extended in `tailwind.config.js` to map these CSS variables.

- **Architecture**:
- Maintain strict separation between Electron's Main and Renderer processes.
- Encapsulate SSH logic into a headless service layer for potential future "Server-Client" decoupling.

- **Components**: Prefer custom-built components over heavy UI libraries to ensure maximum control over pixel-perfection.

## 5. Developer Persona (Context for AI)

- The lead developer is a perfectionist with a strong focus on UX details.
- Avoid boilerplate-heavy solutions; prioritize clean, performant, and maintainable React code.
- When suggesting features, think from the perspective of a developer managing hundreds of servers daily.

## 6. AI Governance Source (Mandatory)

- Before starting any implementation task, always read and follow the repository root file `AGENTS.md`.
- Treat `AGENTS.md` as the canonical AI collaboration policy for documentation sync, UI constraints, IPC changes, and architecture approval gates.
- If any instruction in this file conflicts with `AGENTS.md`, follow the stricter rule and update docs accordingly.
