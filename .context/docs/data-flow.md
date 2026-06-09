---
type: doc
name: data-flow
description: How data, state and control move through the system
generated: 2026-06-09
status: generated
---

# Data Flow

## Inputs

- User slash-command arguments handled by registered commands.
- Pi lifecycle and tool events handled by extension hooks.
- package.json scripts, dependencies, keywords and pi manifest.
- README.md and repository documentation used for generated context.
- Source files scanned for registrations, modules and constants.

## Transformations

- Slash commands receive user text, inspect repository files and report through ctx.ui.notify.

## Outputs and Side Effects

- UI notifications for command results and status previews.

## Persistence

- No persistence layer detected.
