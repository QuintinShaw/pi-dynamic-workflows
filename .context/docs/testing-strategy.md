---
type: doc
name: testing-strategy
description: Test commands, coverage expectations and validation approach
generated: 2026-06-09
status: generated
---

# Testing Strategy

## Test and Check Commands

- `test`: `npm run check && npm run build && npm run test:unit`
- `test:unit`: `tsx --test tests/**/*.test.ts`
- `check`: `biome check .`
- `lint`: `biome lint .`
- `build`: `tsc`
- `prepublishOnly`: `npm run build`

## Detected Test Files

- `tests/agent-history.test.ts`
- `tests/agent-registry.test.ts`
- `tests/agent.test.ts`
- `tests/builtin-commands.test.ts`
- `tests/builtin-workflows.test.ts`
- `tests/checkpoint.test.ts`
- `tests/effort-command.test.ts`
- `tests/helpers/mock-pi.ts`
- `tests/model-routing.test.ts`
- `tests/model-tier-config.test.ts`
- `tests/quality-stdlib.test.ts`
- `tests/run-persistence.test.ts`
- `tests/saved-commands.test.ts`
- `tests/schema-resolution.test.ts`
- `tests/structured-output.test.ts`
- `tests/task-panel.test.ts`
- `tests/utils.test.ts`
- `tests/web-tools.test.ts`
- `tests/workflow-commands.test.ts`
- `tests/workflow-display.test.ts`
- `tests/workflow-editor.test.ts`
- `tests/workflow-manager-abort.test.ts`
- `tests/workflow-manager.test.ts`
- `tests/workflow-parser.test.ts`
- `tests/workflow-runtime.test.ts`
- `tests/workflow-saved.test.ts`
- `tests/workflow-tool.test.ts`
- `tests/workflow-tools-available.test.ts`
- `tests/workflow-ui.test.ts`
- `tests/workflows-models-command.test.ts`

## Recommended Validation

- Run the detected validation scripts that match the changed area.
- Smoke-test extension loading with `pi -e .` in a disposable session.

## Evidence Standard

For every change, capture commands run, exit status, relevant logs and any manual verification steps.
