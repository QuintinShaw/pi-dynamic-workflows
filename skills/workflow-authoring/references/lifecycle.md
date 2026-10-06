# Lifecycle, limits, and resume

## Bounds and budget

Set finite bounds that match the work for `maxAgents`, `concurrency`, and `agentRetries`; bound loops and semantic retries inside the script. `maxAgents` counts logical `agent()` calls across the shared run tree: include direct calls, nested workflows, `verify` reviewers, every `judgePanel` populated candidate/judge pair (dense input: `attempts.length × judges`), and one `completenessCheck` critic. Agent execution retries do not add slots, but each bounded `retry()`, `gate()`, or `loopUntilDry()` callback call that invokes `agent()` does. Quality helpers preflight only their known expansion before starting it; this does not prove capacity for arbitrary data-dependent callbacks. Treat invocation-level `agentTimeoutMs` and `tokenBudget` as opt-in user constraints, not precautionary defaults. Omit `tokenBudget` unless the user supplies a cap or explicitly asks you to choose one. If asked to choose, allow for every planned agent call, retry, synthesis, and verification pass, with headroom. A tight gate can terminate coverage; it does not reduce work already in flight. An omitted `agentTimeoutMs` uses the configured `defaultAgentTimeoutMs` and is otherwise unbounded. An omitted `tokenBudget` uses the configured `defaultTokenBudget` and is otherwise unlimited.

Enter a phase budget with `phase("Name", { budget: N })`; phase metadata does not carry budgets. `N` is a token allowance, not a call or round count: size it for the intended agent work instead of copying a small iteration limit. Token and phase budgets are soft pre-call gates. Spend lands after agents finish, so concurrent work can overshoot. A phase budget gates later calls in that phase; it neither reserves tokens nor cancels active calls. `budget.spent()` and `budget.remaining()` include nested work.

## Checkpoints

A checkpoint consumes an agent slot but no tokens. For the legacy `checkpoint(prompt, options?)` overload: A workflow invocation is backgrounded by default, and background workflows are headless: they cannot display checkpoint confirmation. Use `background: false` when a checkpoint must reach the foreground host confirmation interface. Without a UI, a checkpoint returns the declared default (or `true` when omitted) unless `headless: "abort"` is selected. Confirm is implemented. Input, select, and timeout fields are declared for compatibility/future behavior but are not authoring promises.

The durable `checkpoint({ kind, checkpointId, payload })` overload instead pauses in either foreground or background until a host controller persists a response and resumes the exact checkpoint ID. It does not choose a headless default or display UI. See [specialized helpers](specialized-helpers.md) for the controller handoff and replay contract.

Checkpoint answers are journaled and can replay during an unchanged resume prefix. Do not describe checkpoints as guaranteed arbitrary forms or as remote steering.

## Retry and recoverable failure

Recoverable execution failures retry according to the per-agent option or invocation-time tool input, then return `null`. Nonrecoverable failures throw without becoming `null`. The logical `retry()` combinator is separate: it performs new agent calls and returns its last result when exhausted unless the script records and handles that outcome.

Always retain `{ id, status, result }` or an equivalent ledger for each intended work unit. Filtering `null` before recording identity turns an execution failure into invisible missing coverage.

`AGENT_EMPTY_OUTPUT` (whitespace-only text from a schema-less call) is recoverable and retries like any other transient failure. Some models occasionally produce it on an otherwise-working first attempt; a fleet built on such a model should set `agentRetries: 1-2` rather than treat one occurrence as a failed run. A `schema` call never trips this check — schema noncompliance is its own, nonrecoverable failure (see [serialization](#serialization)).

## Resume

Resume replays only the longest unchanged prefix of journaled calls. Once one call is new, changed, or unusable, that call and all later calls execute live. Stable lexical call ordering, prompts, labels, routing options, and inputs therefore matter. Retry chains can cascade after an upstream miss. A nested workflow journals under its own runId and replays those entries only while the parent's replay is still open at the workflow() call; a parent edit, or a parent gap shadowing the call, re-executes the child live.

Only a call that finishes with a real result is journaled. A call whose every attempt was recoverable (including one that only ever produced `AGENT_EMPTY_OUTPUT`) contributes no journal entry, so resuming that run reruns exactly that call and everything lexically after it live; the earlier, already-succeeded prefix still replays from cache.

A call interrupted before it could journal (a pause mid-fan-out, a usage-limit stop) is likewise a gap that ends the replayable prefix. A host resume may opt into `resumeMode: "replay-completed"`: a completed call then replays across such a gap only when it was dispatched concurrently with the gap — any synchronous dispatch of a `parallel()`/`pipeline()` thunk (a thunk may dispatch several calls before its first `await`; all of them are in the window). Calls made after an `await` (including inside a fan-out thunk) count as sequential and still re-run; the `workflow()` call opening a nested frame follows the same dispatch-timing rule as any other call (dispatched in the gap's own window it replays with its child journal, dispatched later it re-executes live), a gap inside the child follows the same same-window rule within that frame, and a gap or edit inside a nested frame also re-runs the parent calls dispatched after that frame returns; the first changed call's suffix still executes live. No hash observes shared-store or filesystem reads, so results that flowed through those channels rather than prompts can replay stale across a re-run gap — pass per-item data through prompt/result values when a workflow may be resumed this way.

The runtime blocks common accidental nondeterminism, but this is not a security boundary. Pass timestamps, randomness, and external decisions through `args`.

## Nesting and shared state

`workflow(savedName, childArgs)` runs sequentially inline, allows one nested level, and shares limiter, counters, token accounting, and shared store with the parent. It is not independent capacity. Use only a saved-workflow name provided by context; do not guess registry entries or pass raw scripts as a new authoring pattern even where compatibility behavior accepts them.

## Serialization

The workflow's explicit return value crosses the tool boundary. Keep it JSON-serializable and preserve coverage ledgers in the returned data. Structured agent schemas must be plain JSON Schema. Schema success guarantees the downstream field shape expected by JavaScript; without a schema, treat output as text or `null`. A prompt that asks the model to "return JSON" does not change this — without `schema`, parse and validate that text defensively before reading a field, and ledger an unparseable result instead of reading `undefined` off it (see [defensive text parsing](focused-recipes.md)).
