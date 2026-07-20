---
name: workflow-authoring
description: Guidance for writing, editing, reviewing, and debugging JavaScript workflow code for pi-dynamic-workflows. Use when authoring or changing workflow scripts; not for merely running an existing workflow.
metadata:
  version: "3.3.0"
---

# Workflow authoring

Load this skill when workflow JavaScript changes. Running an existing workflow needs no authoring reference.

## Choose a branch

Read only what the task needs:

- **Write or edit:** start with [runtime](references/runtime.md). Add [pattern selection](references/pattern-selection.md) for topology, [lifecycle](references/lifecycle.md) for limits or resume, and [focused recipes](references/focused-recipes.md) for the matching concern.
- **Helper task:** read [quality helpers](references/quality-helpers.md) only for `verify` or `judgePanel`, the [retry helper](references/retry-helper.md) only for `retry`, and [specialized helpers](references/specialized-helpers.md) only for `completenessCheck`, `loopUntilDry`, `gate`, or `checkpoint`.
- **Review:** use the [review checklist](references/review.md), plus only the matching [quality](references/quality-helpers.md) or [specialized](references/specialized-helpers.md) helper contracts.
- **Debug:** use the [debugging map](references/debugging.md).
- **Routing:** read [registry ownership](references/registry-ownership.md) before using `model`, `tier`, phase models, or `agentType`; use environment-specific names only when context supplies them.
- **Exact lookup or portability:** start with the generated [capability index](references/capabilities.md). Follow its exhaustive-facts pointer only for constraints or support boundaries. Use [versions](references/versions.md) when moving scripts between installations.

## Invariants

- Start with literal `export const meta = { name, description }`; declare phases as an array of used `{ title }` objects and enter each named phase.
- Call `agent()` at least once, give every call a short unique `label`, and return plain JSON data explicitly.
- Pair ordered results with stable work IDs before filtering. When one agent consumes another's selected result, include both its stable ID and actual data in the downstream prompt. Treat recoverable `null` as missing coverage and report it.
- Bound fan-out, loops, retries, agents, concurrency, time, and token spend to the task.
- Use `log()` for new code; `console` is compatibility-only.
- Write plain JavaScript without imports or filesystem modules. Pass nondeterminism through `args`; `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable.
