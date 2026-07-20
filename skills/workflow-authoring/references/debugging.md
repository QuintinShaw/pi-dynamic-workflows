# Workflow debugging map

Start from the symptom, then reproduce through the real workflow runtime with deterministic fake agents.

| Symptom | Likely authoring cause | Check |
| --- | --- | --- |
| Parser says metadata is missing | `export const meta` is not the first statement or is nonliteral | [runtime](runtime.md#script-envelope) |
| `parallel()` rejects input | Promises were passed instead of thunks | [runtime](runtime.md#topology) |
| Synthesis starts early | Fan-out was not awaited as one complete result set | [pattern selection](pattern-selection.md#fan-out-and-synthesize) |
| Coverage silently disappears | `null` results were filtered before IDs were ledgered | [lifecycle](lifecycle.md#retry-and-recoverable-failure) |
| Wrong model is used | A higher-priority selector overrides the expected route | [registry ownership](registry-ownership.md#priority) |
| Unknown `agentType` log | A live registry name was guessed or is unavailable | [registry ownership](registry-ownership.md#agent-types) |
| Budget exceeds the number shown | The budget is a soft pre-call gate and work was in flight | [lifecycle](lifecycle.md#bounds-and-budget) |
| Later calls rerun on resume | An earlier call missed or changed, ending the replayable prefix | [lifecycle](lifecycle.md#resume) |
| Nested workflow fails | Nesting exceeded one level or shared limits were exhausted | [lifecycle](lifecycle.md#nesting-and-shared-state) |
| Checkpoint does not show a form | Input/select/timeout behavior is declared-only | [lifecycle](lifecycle.md#checkpoints) |
| Returned result cannot cross boundary | It contains a function, promise, cycle, `BigInt`, or runtime object | [lifecycle](lifecycle.md#serialization) |
| `Date.now()`/randomness is rejected | Resume requires deterministic call structure | [lifecycle](lifecycle.md#resume) |

## Debugging procedure

1. Reduce to the smallest script that preserves metadata, labels, work IDs, and the failing topology.
2. Replace provider calls with deterministic, schema-aware fake agents.
3. Record call order, labels, phases, prompts, results, and `null` entries.
4. When the failure turns on a disputed signature or default, compare it with the compact [capability index](capabilities.md); follow its exhaustive-facts pointer only when needed.
5. Separate runtime defects from unsupported authoring assumptions and compatibility-only behavior.
6. Fix only the demonstrated authoring issue; do not rely on known out-of-scope gaps in nested persistence, resume accounting, checkpoint forms/timeouts, metadata validation, or budget overshoot.
