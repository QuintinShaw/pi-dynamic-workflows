---
type: agent
name: frontend-specialist
description: Works on UI, components, state, accessibility and frontend ergonomics
role: designer
generated: 2026-06-09
status: generated
---

# Frontend Specialist

## Role

Works on UI, components, state, accessibility and frontend ergonomics.

## Load First

- `.context/docs/architecture.md`
- `.context/docs/data-flow.md`
- `.context/docs/getting-started.md`

## Responsibilities

- Understand the active PREVC phase and task scope before acting.
- Prefer project docs and existing patterns over generic assumptions.
- Keep changes small, reviewable and backed by validation evidence.
- Update docs or handoff notes when behavior, APIs or workflows change.

## Workflow

1. Read the selected feedforward docs and this playbook.
2. Inspect the relevant source files before proposing or editing code.
3. Execute only the current approved scope.
4. Validate with the repository's documented commands.
5. Report evidence, risks and follow-up work.

## Project-Specific Notes

- Project is detected as pi-extension with primary language TypeScript.
- custom session message adversarial-review is part of the public surface in src/builtin-commands.ts.
- custom session message deep-research is part of the public surface in src/builtin-commands.ts.
- custom session message effort is part of the public surface in src/effort-command.ts.
- custom session message workflow-result is part of the public surface in src/task-panel.ts.
- custom session message workflow:${wf.name} is part of the public surface in src/saved-commands.ts.
- custom session message workflows is part of the public surface in src/workflow-commands.ts.

## Relevant Files

- `.context/docs/architecture.md`
- `.context/docs/data-flow.md`
- `.context/docs/getting-started.md`
- `src/adversarial-review.ts`
- `src/agent-history.ts`
- `src/agent-registry.ts`
- `extensions/workflow.ts`
- `tests/agent-history.test.ts`
- `tests/agent-registry.test.ts`
- `tests/agent.test.ts`
- `package.json`
- `README.md`
- `tsconfig.json`
- `docs/2.0-roadmap.md`
- `docs/media/demo.gif`
- `docs/media/workflows-mode.jpg`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
