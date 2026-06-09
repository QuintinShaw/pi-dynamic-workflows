---
name: api-design
description: Use when designing APIs, tool schemas, commands or integration contracts.
phases: [P, R]
---

# API Design

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
- custom session message adversarial-review: Custom message type emitted into the pi session.
- custom session message deep-research: Custom message type emitted into the pi session.
- custom session message effort: Custom message type emitted into the pi session.
- custom session message workflow-result: Custom message type emitted into the pi session.
- custom session message workflow:${wf.name}: Custom message type emitted into the pi session.
- custom session message workflows: Custom message type emitted into the pi session.
- custom session message workflows-trigger: Custom message type emitted into the pi session.
- package export . (import) -> ./dist/index.js: Declared in package.json exports.

## Useful Context

- `.context/docs/project-overview.md`
- `.context/docs/development-workflow.md`
- `.context/docs/architecture.md`
- `.context/docs/glossary.md`
- `.context/docs/security.md`
- `.context/docs/data-flow.md`
- `.context/docs/contributing.md`
- `.context/docs/api.md`
