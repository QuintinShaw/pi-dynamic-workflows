---
name: test-generation
description: Use when creating tests, regression checks or validation cases.
phases: [E, V]
---

# Test Generation

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
- Run the detected validation scripts that match the changed area.
- Smoke-test extension loading with `pi -e .` in a disposable session.

## Useful Context

- `.context/docs/project-overview.md`
- `.context/docs/development-workflow.md`
- `.context/docs/architecture.md`
- `.context/docs/api.md`
- `.context/docs/data-flow.md`
- `.context/docs/getting-started.md`
- `.context/docs/testing-strategy.md`
- `.context/docs/security.md`
