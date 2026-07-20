<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->
# Exhaustive workflow capability facts

Contract format: `1.0.0`<br>
Contract content / skill / extension: `3.2.2`

Every exact fact below is projected from the installed extension's capability contract. Explanatory judgment belongs in the hand-written references next to this file.

<a id="agent"></a>
## agent

- Classification: `runtime-global`
- Support: `supported`
- Signature: `agent(prompt, options?) => Promise<string \| structured value \| null>`
- Option shape: `agent-options`
- `label`: string (optional; default: derived from phase and call count)
- `phase`: string (optional; default: current phase)
- `schema`: plain JSON Schema (optional)
- `model`: string (optional; highest-priority exact model selector)
- `tier`: string (optional; configured route name; dynamic reference: model-routes)
- `isolation`: "worktree" (optional)
- `agentType`: string (optional; must come from provided context; dynamic reference: agent-types)
- `timeoutMs`: number | null (optional; default: run timeout; null disables)
- `retries`: number (optional; default: run retry count; finite values are floored and clamped to 0..3)
- Constraint: recoverable failures return null after retries; nonrecoverable failures throw
- Constraint: schema noncompliance after bounded structured-output repair is nonrecoverable and bypasses agent retries
- Constraint: per-agent retries override invocation retries; retries are floored and clamped to 0..3
- Constraint: resume replays only the longest unchanged prefix; the first miss and every later call execute live
- Constraint: selector priority is explicit model > agentType model > tier > phase model > metadata model > implicit medium > session default
- Constraint: if the selected model or route is unavailable, execution falls directly to the session default rather than trying lower-priority selectors
- Constraint: worktree isolation is best-effort; failure logs that isolation was ignored and continues without an isolated working directory

<a id="parallel"></a>
## parallel

- Classification: `runtime-global`
- Support: `supported`
- Signature: `parallel(thunks) => Promise<Array<unknown \| null>>`
- Constraint: requires functions rather than promises
- Constraint: result order matches input order
- Constraint: recoverable thunk failures become null; nonrecoverable failures throw

<a id="pipeline"></a>
## pipeline

- Classification: `runtime-global`
- Support: `supported`
- Signature: `pipeline(items, ...stages) => Promise<Array<unknown \| null>>`
- Constraint: items run concurrently while stages per item run sequentially
- Constraint: each stage receives previousValue, originalItem, and zero-based index
- Constraint: a null stage result is passed to the next stage; authors must guard missing coverage explicitly
- Constraint: recoverable stage failures become null; nonrecoverable failures throw

<a id="workflow"></a>
## workflow

- Classification: `runtime-global`
- Support: `supported`
- Signature: `workflow(savedName, childArgs?) => Promise<unknown>`
- Constraint: one nested level
- Constraint: shares limiter, counters, token accounting, and store
- Constraint: nested workflows do not reuse the parent resume journal

<a id="verify"></a>
## verify

- Classification: `runtime-global`
- Support: `supported`
- Signature: `verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string \| string[] }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>`
- Option shape: `verify-options`
- `reviewers`: number (optional; default: 2; authors should provide a finite integer; runtime clamps below 1)
- `threshold`: number (optional; default: 0.5)
- `lens`: string | string[] (optional)
- Constraint: reviewer failures are omitted; successful votes form the denominator in realCount / total
- Constraint: threshold comparison is inclusive and real is false when no reviewer succeeds
- Constraint: multiple lenses cycle across reviewers

<a id="judgepanel"></a>
## judgePanel

- Classification: `runtime-global`
- Support: `supported`
- Signature: `judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } \| undefined>`
- Option shape: `judge-panel-options`
- `judges`: number (optional; default: 3; authors should provide a finite integer; runtime clamps below 1)
- `rubric`: string (optional; default: "overall quality and correctness")
- Constraint: failed judgments are omitted and each candidate score averages successful judgments only
- Constraint: a candidate with no successful judgments scores 0
- Constraint: highest mean score wins with stable input index as the tie-break; empty input returns undefined

<a id="loopuntildry"></a>
## loopUntilDry

- Classification: `runtime-global`
- Support: `supported`
- Signature: `loopUntilDry(options: { round: (roundIndex: number) => unknown[] \| Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => Promise<unknown[]>`
- Option shape: `loop-until-dry-options`
- `round`: (roundIndex: number) => unknown[] | Promise<unknown[]> (required)
- `key`: (item: unknown) => string (optional; default: JSON.stringify)
- `consecutiveEmpty`: number (optional; default: 2; authors should provide a finite integer; runtime clamps below 1)
- `maxRounds`: number (optional; default: 50; authors should provide a finite positive integer)
- Constraint: roundIndex is zero-based; null, non-array, or duplicate-only round results count as empty
- Constraint: token-budget or agent-limit capacity exhaustion returns the accumulated partial array instead of throwing
- Constraint: the returned array does not report whether termination came from dryness, maxRounds, or capacity exhaustion
- Constraint: authors must retain failed-round identity and truthful termination state outside the helper

<a id="completenesscheck"></a>
## completenessCheck

- Classification: `runtime-global`
- Support: `supported`
- Signature: `completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } \| null>`
- Constraint: only the first 4,000 characters of serialized result evidence are sent to the critic
- Constraint: missing is optional and recoverable critic failure returns null
- Constraint: large evidence sets must be chunked or summarized before relying on the advisory verdict

<a id="retry"></a>
## retry

- Classification: `runtime-global`
- Support: `supported`
- Signature: `retry(thunk: (attempt: number) => unknown \| Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>`
- Option shape: `retry-options`
- `attempts`: number (optional; default: 3; authors must provide a finite integer; runtime clamps values below 1 to 1)
- `until`: (result: unknown) => boolean (optional; default: accept first result when omitted; must be synchronous; use gate for asynchronous validation)
- Constraint: attempt is zero-based and attempts counts total thunk calls
- Constraint: until is synchronous; returning a Promise is truthy and accepts the first result
- Constraint: omitting until accepts the first result regardless of attempts
- Constraint: stops when until(result) is true; exhaustion returns only the last result without attempt metadata
- Constraint: authors must supply a finite attempts bound when overriding the default

<a id="gate"></a>
## gate

- Classification: `runtime-global`
- Support: `supported`
- Signature: `gate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } \| Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>`
- Option shape: `gate-options`
- `attempts`: number (optional; default: 3; authors must provide a finite integer; runtime clamps values below 1 to 1)
- Constraint: feedback is undefined on the first thunk call and then receives the previous validator feedback string
- Constraint: attempt is zero-based for the thunk while the returned attempts count is one-based
- Constraint: a value is accepted when the validator returns an object with a truthy ok property; a bare boolean is not accepted
- Constraint: exhaustion returns ok false with the last value and the bounded attempts count
- Constraint: authors must supply a finite attempts bound when overriding the default

<a id="checkpoint"></a>
## checkpoint

- Classification: `runtime-global`
- Support: `supported`
- Signature: `checkpoint(prompt, options?) => Promise<unknown>`
- Option shape: `checkpoint-options`
- `default`: unknown (optional; default: true when no UI and omitted)
- `headless`: "default" | "abort" (optional; default: "default")
- `kind`: "confirm" | "input" | "select" (optional; default: "confirm")
- `choices`: string[] (optional)
- `timeoutMs`: number (optional)
- Constraint: foreground confirm and headless behavior are implemented; input/select/timeout are declared-only
- Constraint: consumes one agent slot and no tokens
- Constraint: journaled answers replay only within an unchanged resume prefix

<a id="log"></a>
## log

- Classification: `runtime-global`
- Support: `supported`
- Signature: `log(message) => void`

<a id="phase"></a>
## phase

- Classification: `runtime-global`
- Support: `supported`
- Signature: `phase(title, options?) => void`
- Option shape: `phase-options`
- `budget`: number (optional; positive soft pre-call token gate)
- Constraint: phase budgets are soft pre-call gates

<a id="args"></a>
## args

- Classification: `runtime-global`
- Support: `supported`
- Signature: `args: unknown`

<a id="cwd"></a>
## cwd

- Classification: `runtime-global`
- Support: `supported`
- Signature: `cwd: string`

<a id="process"></a>
## process

- Classification: `runtime-global`
- Support: `supported`
- Signature: `process: { cwd(): string }`

<a id="budget"></a>
## budget

- Classification: `runtime-global`
- Support: `supported`
- Signature: `budget: { total, spent(), remaining() }`
- Constraint: frozen view over shared soft token accounting
- Constraint: spend accrues after agents finish, so in-flight work can overshoot
- Constraint: nested workflows share the same accounting

<a id="console"></a>
## console

- Classification: `runtime-global`
- Support: `compatibility`
- Signature: `console: { log, info, warn, error }`
- Constraint: new workflows should use log()

<a id="tool-input-script"></a>
## script

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `script?: string`
- Constraint: required raw JavaScript workflow source unless `name` is given

<a id="tool-input-name"></a>
## name

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `name?: string`
- Constraint: resolves a project/user saved workflow first, then one of the 5 built-in patterns
- Constraint: mutually exclusive with resumeFromRunId

<a id="tool-input-args"></a>
## args

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `args?: unknown`

<a id="tool-input-background"></a>
## background

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `background?: boolean = true`
- Constraint: background workflows are headless; use background false when checkpoint must show foreground confirmation

<a id="tool-input-maxagents"></a>
## maxAgents

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `maxAgents?: number = 1000`
- Constraint: default, not a hard product maximum

<a id="tool-input-concurrency"></a>
## concurrency

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `concurrency?: number`
- Constraint: runtime clamps to 1..16

<a id="tool-input-agentretries"></a>
## agentRetries

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `agentRetries?: number = configured value or 0`
- Constraint: floored and clamped to 0..3

<a id="tool-input-agenttimeoutms"></a>
## agentTimeoutMs

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `agentTimeoutMs?: number = configured default or unbounded`

<a id="tool-input-tokenbudget"></a>
## tokenBudget

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `tokenBudget?: number = configured default or unlimited`
- Constraint: soft pre-call gate; in-flight work can overshoot

<a id="tool-input-resumefromrunid"></a>
## resumeFromRunId

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `resumeFromRunId?: string`
- Constraint: resumes a prior incomplete run with an edited script
- Constraint: unchanged positional agent calls replay from cache until the first changed or inserted call
- Constraint: always runs in the background

<a id="metadata"></a>
## export const meta

- Classification: `script-contract`
- Support: `supported`
- Signature: `export const meta = { name: string, description: string, phases?: Array<{ title: string; detail?: string; model?: string }>, model?: string }`
- Constraint: must be the first statement
- Constraint: name and description must be nonblank strings
- Constraint: metadata must use literal values; expressions such as string concatenation and template interpolation are rejected
- Constraint: the meta declaration is the only legal export because the remaining body executes inside an async function

<a id="return-value"></a>
## workflow return value

- Classification: `script-contract`
- Support: `supported`
- Signature: `return JSON-serializable data`
- Constraint: do not return functions, promises, cyclic objects, BigInt, or runtime handles

<a id="determinism"></a>
## deterministic script execution

- Classification: `script-contract`
- Support: `supported`
- Signature: —
- Constraint: Date.now(), Math.random(), and no-argument new Date() are unavailable
- Constraint: pass timestamps and randomness through args

<a id="compatibility"></a>
## whole-script Markdown fence stripping

- Classification: `compatibility-behavior`
- Support: `compatibility`
- Signature: —
- Constraint: accepted for compatibility but not recommended

<a id="model-routes"></a>
## model routes

- Classification: `dynamic-reference`
- Support: `supported`
- Signature: —
- Constraint: live values must not be copied into static contract data
- Dynamic reference owner: `model-tier-config`
- Item shape: `{ name: string; description?: string }`
- Future lookup connection: `loadModelTierConfig`
- Live values are intentionally absent from this static reference.

<a id="agent-types"></a>
## agent types

- Classification: `dynamic-reference`
- Support: `supported`
- Signature: —
- Constraint: live values must not be copied into static contract data
- Dynamic reference owner: `agent-registry`
- Item shape: `{ name: string; description?: string }`
- Future lookup connection: `loadAgentRegistry`
- Live values are intentionally absent from this static reference.
