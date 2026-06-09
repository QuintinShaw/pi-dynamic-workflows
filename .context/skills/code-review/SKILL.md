---
name: code-review
description: Use when auditing code quality, correctness and maintainability.
phases: [R, V]
---

# Code Review

## Procedure

1. Confirm the task scope and active PREVC phase.
2. Load the relevant project docs from `.context/docs/`.
3. Apply the checklist below to the specific files in scope.
4. Capture validation evidence and unresolved risks.

## Checklist

- Use repository-specific conventions, not generic defaults.
- Reference concrete files, commands and outputs.
- Keep recommendations actionable and prioritized.
- If information is missing, inspect the codebase first, then ask a focused question only when needed.

## Project Notes

- Use this skill against a pi-extension codebase with TypeScript as the primary language.
- Does the change preserve existing user files and manual edits?
- Are public commands/tools/events documented in .context/docs/api.md and README when behavior changes?
- Were relevant validation commands run and captured with exit status?

## Useful Context

- `.context/docs/project-overview.md`
- `.context/docs/development-workflow.md`
- `.context/docs/architecture.md`
- `.context/docs/security.md`
- `.context/docs/data-flow.md`
- `.context/docs/contributing.md`
- `.context/docs/testing-strategy.md`
- `.context/docs/api.md`
