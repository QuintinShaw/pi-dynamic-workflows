# Focused recipes

Read only the recipe matching the concern. Change task prompts, schemas, bounds, and context-supplied inputs; preserve the listed contract.

| Concern | Preserve when adapting | Tested recipe |
| --- | --- | --- |
| Phased budgets | Phase and run budgets are soft pre-call gates; active work can overshoot. Report shared spend and bound calls independently. | [Phased budgets](../examples/phased-budgets.js) |
| Saved workflows | Use a context-supplied name, await jobs sequentially, nest one level, and treat shared limits, counters, tokens, limiter, and store as parent capacity. | [Saved nested workflows](../examples/saved-nested-workflows.js) |
| Semantic retry | Separate it from recoverable runtime retries. Use a new unique label per bounded attempt and return the attempt ledger plus exhausted outcome. | [Bounded semantic retry](../examples/bounded-semantic-retry.js) |
| Validator feedback | Follow the exact `gate()` callbacks in [specialized helpers](specialized-helpers.md). Return the gate outcome and attempt ledger so feedback and exhaustion remain visible. | [Validated gate](../examples/validated-gate.js) |
| Structured fields | Pass a small plain JSON Schema before reading fields. Ledger recoverable `null`; treat exhausted schema repair as a nonrecoverable failure. | [Structured output](../examples/structured-output.js) |
