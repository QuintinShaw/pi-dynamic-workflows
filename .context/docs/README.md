# Documentation Index

Knowledge base for **@quintinshaw/pi-dynamic-workflows** generated from repository analysis by the AICoders Context extension.

## Project Snapshot

- **Project**: @quintinshaw/pi-dynamic-workflows
- **Type**: pi-extension
- **Primary language**: TypeScript
- **Package manager**: npm
- **Detection**: pi package manifest or pi extension/theme keywords detected

## Detected Public Surface

- **custom session message** `adversarial-review` — Custom message type emitted into the pi session. (`src/builtin-commands.ts`)
- **custom session message** `deep-research` — Custom message type emitted into the pi session. (`src/builtin-commands.ts`)
- **custom session message** `effort` — Custom message type emitted into the pi session. (`src/effort-command.ts`)
- **custom session message** `workflow-result` — Custom message type emitted into the pi session. (`src/task-panel.ts`)
- **custom session message** `workflow:${wf.name}` — Custom message type emitted into the pi session. (`src/saved-commands.ts`)
- **custom session message** `workflows` — Custom message type emitted into the pi session. (`src/workflow-commands.ts`)
- **custom session message** `workflows-trigger` — Custom message type emitted into the pi session. (`src/workflow-editor.ts`)
- **package export** `. (import) -> ./dist/index.js` — Declared in package.json exports. (`package.json`)

## Core Guides

- [Project Overview](./project-overview.md) — High-level overview, purpose, stack and entry points
- [Architecture](./architecture.md) — System architecture, boundaries, modules and design decisions
- [Data Flow](./data-flow.md) — How data, state and control move through the system
- [API Reference](./api.md) — Public interfaces, APIs, commands and integration contracts
- [Getting Started](./getting-started.md) — Local setup, installation and onboarding path
- [Development Workflow](./development-workflow.md) — Branching, PREVC, contribution flow and delivery rules
- [Testing Strategy](./testing-strategy.md) — Test commands, coverage expectations and validation approach
- [Tooling](./tooling.md) — Scripts, package manager, automation and productivity tools
- [Security](./security.md) — Security assumptions, secrets, permissions and threat surfaces
- [Deployment](./deployment.md) — Build, release, deployment and rollback process
- [Contributing](./contributing.md) — Code standards, review expectations and team conventions
- [Glossary](./glossary.md) — Domain terms, acronyms and project vocabulary

## Codebase Map

- [codebase-map.json](./codebase-map.json) — machine-readable snapshot generated during initialization.

## Usage

- Use `/dotcontext feed <task>` to preview which files would be injected for a task.
- The extension automatically injects relevant docs/agents/skills before every agent turn.
- Run `/dotcontext init --force` only when you intentionally want to regenerate generated context files, including manually edited files.
