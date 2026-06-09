---
type: doc
name: api
description: Public interfaces, APIs, commands and integration contracts
generated: 2026-06-09
status: generated
---

# API Reference

## Slash Commands

- **slash command** `/adversarial-review` — Investigate a task, then cross-check each finding with skeptical reviewers (`src/builtin-commands.ts`)
- **slash command** `/deep-research` — Research a question across the web with cross-checked sources (`src/builtin-commands.ts`)
- **slash command** `/effort` — Standing workflow effort: off | high | ultra — auto-arms a workflow for substantive messages (`src/effort-command.ts`)
- **slash command** `/ultracode` — Ultracode: standing maximal-effort mode — auto-arms an exhaustive workflow for substantive messages. /ultracode off to stop. (`src/effort-command.ts`)
- **slash command** `/workflows` — Manage workflow runs — no args (opens navigator) | status/stop/pause/resume <id> | rm <id> | save <name> [runId] (`src/workflow-commands.ts`)
- **slash command** `/workflows-models` — View and edit model tiers used by workflows (small/medium/big) (`src/workflows-models-command.ts`)

## LLM Tools and Flags

- No custom LLM tools or CLI flags detected.

## Events and Session Messages

- **custom session message** `adversarial-review` — Custom message type emitted into the pi session. (`src/builtin-commands.ts`)
- **custom session message** `deep-research` — Custom message type emitted into the pi session. (`src/builtin-commands.ts`)
- **custom session message** `effort` — Custom message type emitted into the pi session. (`src/effort-command.ts`)
- **custom session message** `workflow-result` — Custom message type emitted into the pi session. (`src/task-panel.ts`)
- **custom session message** `workflow:${wf.name}` — Custom message type emitted into the pi session. (`src/saved-commands.ts`)
- **custom session message** `workflows` — Custom message type emitted into the pi session. (`src/workflow-commands.ts`)
- **custom session message** `workflows-trigger` — Custom message type emitted into the pi session. (`src/workflow-editor.ts`)
- **pi event hook** `agentEnd` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `agentStart` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `complete` — Extension subscribes to this pi lifecycle/event hook. (`src/task-panel.ts`)
- **pi event hook** `complete` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `error` — Extension subscribes to this pi lifecycle/event hook. (`src/task-panel.ts`)
- **pi event hook** `error` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `error` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `input` — Extension subscribes to this pi lifecycle/event hook. (`src/workflow-editor.ts`)
- **pi event hook** `paused` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `paused` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `resumed` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `resumed` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `session_start` — Extension subscribes to this pi lifecycle/event hook. (`extensions/workflow.ts`)
- **pi event hook** `stopped` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `stopped` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `turn_end` — Extension subscribes to this pi lifecycle/event hook. (`src/workflow-editor.ts`)
- **pi event hook** `uncaughtException` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `uncaughtException` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)

## Package Integration

- **package export** `. (import) -> ./dist/index.js` — Declared in package.json exports. (`package.json`)
- **package export** `. (types) -> ./dist/index.d.ts` — Declared in package.json exports. (`package.json`)
- **pi event hook** `agentEnd` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `agentStart` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `complete` — Extension subscribes to this pi lifecycle/event hook. (`src/task-panel.ts`)
- **pi event hook** `complete` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `error` — Extension subscribes to this pi lifecycle/event hook. (`src/task-panel.ts`)
- **pi event hook** `error` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `error` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `input` — Extension subscribes to this pi lifecycle/event hook. (`src/workflow-editor.ts`)
- **pi event hook** `paused` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `paused` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `resumed` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `resumed` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `session_start` — Extension subscribes to this pi lifecycle/event hook. (`extensions/workflow.ts`)
- **pi event hook** `stopped` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `stopped` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)
- **pi event hook** `turn_end` — Extension subscribes to this pi lifecycle/event hook. (`src/workflow-editor.ts`)
- **pi event hook** `uncaughtException` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager-abort.test.ts`)
- **pi event hook** `uncaughtException` — Extension subscribes to this pi lifecycle/event hook. (`tests/workflow-manager.test.ts`)

## Examples

- No command examples inferred from detected public contracts.
