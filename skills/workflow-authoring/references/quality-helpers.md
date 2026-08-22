# Verify and judge

Keep work IDs outside helper results that may omit failed agents.

## Capacity

`maxAgents` counts logical `agent()` calls across the whole shared run tree, not visible helper calls. Include the exact expansion for each quality helper in the plan:

| Helper | Logical slots | Runtime behavior |
| --- | --- | --- |
| `verify(item, { reviewers })` | `reviewers` logical slots (default `2`) | `reviewers` must be a finite integer at least `1`; only omitted/`undefined` selects the default, and every supplied value (including `null`) throws `TypeError` when invalid. Preflights the entire reviewer fan-out before it starts any reviewer. |
| `judgePanel(attempts, { judges })` | populated `attempts` entries × `judges` (dense input: `attempts.length × judges`; default `3` judges) | `judges` must be a finite integer at least `1`; only omitted/`undefined` selects the default, and every supplied value (including `null`) throws `TypeError`. Sparse holes are absent candidates, consume no slots, and populated candidates retain their original indexes. Preflights every candidate/judge pair before it starts any judge. |

Agent execution retries stay within their original logical slot. In contrast, each planned `agent()` call made by `retry()`, `gate()`, or a `loopUntilDry()` callback needs its own slot. The helper preflight only covers its known expansion; it does not infer arbitrary callback or data-dependent work. An external pause/stop abort takes precedence over capacity preflight and fan-out validation, so no helper agent starts after an abort.

| Call | Contract |
| --- | --- |
| `verify(item, { reviewers: number, threshold: number, lens: string | string[] })` | Defaults: 2 reviewers, inclusive `0.5`, one lens or a cycled array. Returns `{ real, realCount, total, votes }`. Failed reviewers are omitted; successful votes are the denominator; zero survivors means `real: false`. |
| `judgePanel(attempts, { judges: number, rubric: string })` | Defaults: 3 judges and `"overall quality and correctness"`. Failed judgments are omitted. Returns the highest mean `{ index, attempt, score, judgments }`; input order wins ties; empty input returns `undefined`. |
