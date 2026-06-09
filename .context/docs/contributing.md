---
type: doc
name: contributing
description: Code standards, review expectations and team conventions
generated: 2026-06-09
status: generated
---

# Contributing

## Standards

- Primary implementation language: TypeScript.
- Prefer small, reviewable changes aligned with existing extension/module boundaries.
- Keep README and generated context docs in sync when public commands, tools, flags or workflows change.

## Review Checklist

- Does the change preserve existing user files and manual edits?
- Are public commands/tools/events documented in .context/docs/api.md and README when behavior changes?
- Were relevant validation commands run and captured with exit status?

## Validation

Before handing off, run relevant checks from [Testing Strategy](./testing-strategy.md) and record the evidence.
