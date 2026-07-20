# Verify and judge

Keep work IDs outside helper results that may omit failed agents.

| Call | Contract |
| --- | --- |
| `verify(item, { reviewers: number, threshold: number, lens: string | string[] })` | Defaults: 2 reviewers, inclusive `0.5`, one lens or a cycled array. Returns `{ real, realCount, total, votes }`. Failed reviewers are omitted; successful votes are the denominator; zero survivors means `real: false`. |
| `judgePanel(attempts, { judges: number, rubric: string })` | Defaults: 3 judges and `"overall quality and correctness"`. Failed judgments are omitted. Returns the highest mean `{ index, attempt, score, judgments }`; input order wins ties; empty input returns `undefined`. |
