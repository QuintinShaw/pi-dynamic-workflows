---
type: doc
name: deployment
description: Build, release, deployment and rollback process
generated: 2026-06-09
status: generated
---

# Deployment

## Build and Release Commands

- `test`: `npm run check && npm run build && npm run test:unit`
- `build`: `tsc`
- `prepublishOnly`: `npm run build`

## Distribution Model

- Distributed as a pi package declared through package.json pi.extensions and pi.themes.
- Package keywords: `pi-package`, `pi`, `pi-coding-agent`, `workflow`, `workflows`, `dynamic-workflows`, `orchestration`, `subagents`, `multi-agent`, `agents`, `ai-agents`, `parallel`, `fan-out`, `claude-code`, `deep-research`, `code-review`, `llm`.
- README includes installation guidance for local and git-based pi package loading.

## Release Notes

- Use release/publish scripts listed above and capture their output.
- Before publishing, smoke-test extension discovery, command registration and resource discovery from a clean clone.
