# Pattern selection

Choose from data dependencies, then read only the matching example. JavaScript owns enumeration, identity, ordering, deduplication, bounds, stopping, brackets, and failure ledgers. Agents own semantic work.

<a id="fan-out-and-synthesize"></a>
| Dependency shape | Pattern | Preserve when adapting | Example |
| --- | --- | --- | --- |
| Heterogeneous items need different handling | Classify and act | Finish all classification before routed action; ledger classification and action failures by item ID | [Adapt](../examples/classify-and-act.js) |
| Independent work needs whole-set judgment | Fan out and synthesize | Pass thunks; await the full set; give synthesis every intended ID, including `null` | [Adapt](../examples/fan-out-and-synthesize.js) |
| Claims need skeptical checks | Adversarial verification | Use separate producer and skeptic calls; start skepticism after production; ledger both failures | [Adapt](../examples/adversarial-verification.js) |
| Exploration should diverge before one rubric | Generate and filter | Finish generation; deterministically deduplicate and bound candidates before filter calls | [Adapt](../examples/generate-and-filter.js) |
| Pairwise comparison beats absolute scoring | Tournament | Let JavaScript run the bounded bracket and byes; agents compare one pair; ledger match failures | [Adapt](../examples/tournament.js) |
| Work cardinality is unknown | Loop until done | Deduplicate by stable key; count only successful empty rounds as dry; cap rounds; retain failed rounds | [Adapt](../examples/loop-until-done.js) |

For every pattern, validate and bound input before fan-out, use stable IDs and unique labels, preserve missing coverage, and return plain JSON data. Combine patterns only when the task has both dependency shapes. Direct work needs no orchestration.
