---
type: doc
name: project-overview
description: High-level overview, purpose, stack and entry points
generated: 2026-06-09
status: generated
---

# Project Overview

- **Project**: @quintinshaw/pi-dynamic-workflows
- **Type**: pi-extension
- **Primary language**: TypeScript
- **Package manager**: npm
- **Detection**: pi package manifest or pi extension/theme keywords detected

## Purpose

Claude-Code-style dynamic workflows for Pi — fan a task out across 100s of subagents with real model routing, token/cost accounting, resume, git-worktree isolation, an interactive /workflows TUI, and a real /deep-research.

[](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows) [](license) [](https://pi.dev) [](development)

Claude Code–style dynamic workflows for Pi. Turn one prompt into a fleet of subagents that fan out in parallel, cross-check each other, and hand back a single synthesized answer.

Website · npm · Pi package · GitHub

Instead of one model grinding a task step by step, Pi writes a small JavaScript orchestration script that spawns many subagents at once, keeps the intermediate work in script variables (not your chat context), and returns only the result. It's the "code mode for subagents" from Claude Code — on any model Pi can reach.

## What This Codebase Provides

- **src** — Source module inferred from repository layout. Highlights: 28 source file(s); entry point(s): src/index.ts; contracts: custom session message adversarial-review, custom session message deep-research, custom session message effort, custom session message workflow-result, custom session message workflow:${wf.name}.
- **extensions/workflow.ts** — Source module inferred from repository layout. Highlights: 1 source file(s); entry point(s): extensions/workflow.ts; contracts: pi event hook session_start.
- **tests** — Source module inferred from repository layout. Highlights: 31 source file(s); contracts: pi event hook agentEnd, pi event hook agentStart, pi event hook complete, pi event hook error, pi event hook error.
- **project-root** — Package metadata, README and top-level documentation for installing and loading the pi package. Highlights: 1 documentation file(s); entry point(s): README.md, package.json.
- **docs** — Documentation module inferred from markdown/doc files. Highlights: 1 documentation file(s).
- **.github** — Repository automation and CI/CD configuration.
- **biome.json** — Repository module inferred from file layout.
- **LICENSE** — Documentation module inferred from markdown/doc files. Highlights: 1 documentation file(s).

## Key Entry Points

- `. (import) -> ./dist/index.js`
- `. (types) -> ./dist/index.d.ts`
- `./dist/index.d.ts`
- `./dist/index.js`
- `README.md`
- `extensions/workflow.ts`
- `package.json`
- `src/index.ts`

## Public Surface

- **custom session message** `adversarial-review` — Custom message type emitted into the pi session. (`src/builtin-commands.ts`)
- **custom session message** `deep-research` — Custom message type emitted into the pi session. (`src/builtin-commands.ts`)
- **custom session message** `effort` — Custom message type emitted into the pi session. (`src/effort-command.ts`)
- **custom session message** `workflow-result` — Custom message type emitted into the pi session. (`src/task-panel.ts`)
- **custom session message** `workflow:${wf.name}` — Custom message type emitted into the pi session. (`src/saved-commands.ts`)
- **custom session message** `workflows` — Custom message type emitted into the pi session. (`src/workflow-commands.ts`)
- **custom session message** `workflows-trigger` — Custom message type emitted into the pi session. (`src/workflow-editor.ts`)
- **package export** `. (import) -> ./dist/index.js` — Declared in package.json exports. (`package.json`)
- **package export** `. (types) -> ./dist/index.d.ts` — Declared in package.json exports. (`package.json`)
- **pi event hook** `agentEnd` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `agentStart` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `complete` — Extension subscribes to this pi lifecycle/event hook. (`src/task-panel.ts`)

## Next Reading

- [Architecture](./architecture.md)
- [API Reference](./api.md)
- [Testing Strategy](./testing-strategy.md)
