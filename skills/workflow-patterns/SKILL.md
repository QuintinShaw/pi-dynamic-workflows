---
name: workflow-patterns
description: Names and argument shapes for the 5 curated built-in workflow patterns (deep-research, adversarial-review, code-review, multi-perspective, codebase-audit), reachable via the `workflow` tool's `name` input. Use when a request matches one of these shapes even without slash-command syntax — e.g. "research X", "deep-dive this question", "adversarially review/fact-check this", "review this diff/PR", "analyze from multiple perspectives/angles", or "audit the codebase for Y". Not for authoring a new workflow script — see workflow-authoring for that.
metadata:
  version: "3.2.2"
---

# Built-in workflow patterns

pi-dynamic-workflows ships 5 curated, tested workflow patterns. Each is also a
slash command (`/deep-research`, `/adversarial-review`, `/code-review`,
`/multi-perspective`, `/codebase-audit`), but they are equally reachable from
the `workflow` tool directly: call it with `name` set to the pattern name
below and `args` matching its shape, instead of writing an equivalent script
from scratch. Prefer this over authoring a new script whenever the request
fits one of these shapes — the curated version is already reviewed and tested.

A project or user saved workflow of the same name always takes precedence
over a built-in of that name.

## Patterns

| `name` | When to reach for it | `args` |
| --- | --- | --- |
| `deep-research` | Research a question across the web with cross-checked sources | `{ question: string }` |
| `adversarial-review` | Investigate a task/claim, then cross-check each finding with skeptical reviewers | `{ task: string, reviewers?: number, threshold?: number }` |
| `code-review` | Multi-angle review of a diff (correctness, reuse, simplification, efficiency, altitude) | `{ diff: string, diffSource?: string }` — get `diff` yourself first (e.g. `git diff`, `gh pr diff <n>`); this path does not fetch it for you |
| `multi-perspective` | Analyze a topic from several independent perspectives in parallel, then synthesize | `{ topic: string, perspectives?: string[] }` — omit or give fewer than 2 to use the default set (technical, product, security, user experience, maintainability) |
| `codebase-audit` | Run parallel checks against a codebase scope, then cross-validate and report | `{ scope: string, checks: string[] }` |

## Example

```json
{ "name": "deep-research", "args": { "question": "What are the tradeoffs of X vs Y?" } }
```

This is a `workflow` tool call, not a script — omit `script` entirely. The run
starts in the background exactly like the slash-command form; `background`,
`maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, and `tokenBudget`
all still apply.

## Writing a new workflow instead

If the request doesn't fit one of these 5 shapes, author a script with
`script` as usual — see the workflow-authoring skill.
