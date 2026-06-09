---
type: doc
name: development-workflow
description: Branching, PREVC, contribution flow and delivery rules
generated: 2026-06-09
status: generated
---

# Development Workflow

## Workflow

Use PREVC for non-trivial work:

1. **P — Planejar**: investigate in read-only mode and define scope, requirements, artifacts and checks.
2. **R — Revisar**: validate approach, risks, architecture and acceptance criteria before editing.
3. **E — Executar**: implement one approved phase at a time with focused file changes.
4. **V — Validar**: run checks and capture objective evidence.
5. **C — Confirmar**: summarize, hand off and commit only when appropriate.

## Repository Commands

- `test`: `npm run check && npm run build && npm run test:unit`
- `test:unit`: `tsx --test tests/**/*.test.ts`
- `check`: `biome check .`
- `format`: `biome format --write .`
- `lint`: `biome lint .`
- `build`: `tsc`
- `dev`: `tsx src/index.ts`
- `prepublishOnly`: `npm run build`

## Change Rules Inferred From The Codebase

- Use PREVC for non-trivial work and keep implementation phases small.
