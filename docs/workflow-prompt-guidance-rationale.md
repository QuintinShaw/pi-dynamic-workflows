# Workflow prompt guidance rationale

This document preserves the decision-by-decision record behind the workflow tool's compact model guidance. It records each reviewed insertion, removal, and compaction with its reasoning, evidence, and confidence.

## Current placement in 3.0.0

The record originated in [Whamp/pi-dynamic-workflows#23](https://github.com/Whamp/pi-dynamic-workflows/pull/23). The 3.0.0 target later merged [QuintinShaw/pi-dynamic-workflows#93](https://github.com/QuintinShaw/pi-dynamic-workflows/pull/93), which changed workflow triggering from forced execution to authorization and established one always-on workflow gate. The current implementation preserves that gate and its background-delivery behavior while applying the concision decisions recorded below.

| Decision area | Current authority |
| --- | --- |
| Capability summary | `description` and `promptSnippet` in [`src/workflow-tool.ts`](../src/workflow-tool.ts) |
| First-attempt script syntax and composition | `script.description` in [`src/workflow-tool.ts`](../src/workflow-tool.ts) |
| Background and outer resource controls | Their parameter descriptions plus runtime behavior |
| Workflow authorization | The single `WORKFLOW_GATE_GUIDELINE`; #93 supersedes the older exact selection wording below |
| Detailed authoring policy | The on-demand [`workflow-authoring` skill](../skills/workflow-authoring/SKILL.md), not permanent prompt guidelines |
| Exact capability facts | The executable contract and generated [workflow-authoring reference](workflow-authoring.md) |
| Dynamic model routes and agent types | Active user and project configuration, not static prompt catalogues |
| Context and comprehension evidence | [Workflow authoring evidence](workflow-authoring-evidence.md) and generated context measurements |

The original reviewed record follows. Its quoted before-and-after text documents the decisions made at that point; it is not a second source of current model-facing wording. Current source, generated references, and release checks are authoritative.

## Prompt surfaces

Pi renders `promptSnippet` as the workflow tool's one-line entry in the system prompt's `Available tools` section. Pi appends each `promptGuidelines` entry as a flat bullet in the system prompt's `Guidelines` section. The provider-visible tool definition separately carries the tool `description` and parameter schema.

## Original approved changes

### Describe the workflow capability in `promptSnippet`

Replace:

```text
Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }.
```

with:

```text
Delegate substantive independent or staged work to subagents with a JavaScript workflow, optionally composing agent calls with parallel(), pipeline(), or both
```

#### Reasoning

The Available-tools entry should tell the parent model what the workflow tool does when the model selects a tool. The replacement names the tool's purpose, suitable task scale, and supported composition shapes.

The old entry duplicated the required `meta` declaration from the `script` parameter description. Keeping that syntax in the parameter schema gives it one authoritative home and keeps the Available-tools entry focused on capability.

The phrase `parallel(), pipeline(), or both` covers simple workflows that use neither helper and composed workflows that use either helper or both. It names the real functions instead of implying that “parallel agents” and “pipeline agents” are distinct agent types.

The replacement also removes the claim that the workflow is deterministic. The runtime restricts nondeterministic script APIs, but real subagent output remains nondeterministic.

#### Evidence

Pi documents `promptSnippet` as a short one-line Available-tools entry and uses capability-oriented text in its example custom tool. See [Pi extension tool guidance](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md#L1321-L1358).

The project's prompt-budget research classifies the old snippet as duplicated and recommends leaving the metadata header in `script.description`. See [Minimal workflow prompt and budgets](https://github.com/Whamp/pi-dynamic-workflows/blob/7fa8a5944c5ad4182aee0c43d757350c61e3a5da/docs/research/minimal-workflow-prompt-and-budgets.md).

The schema-comprehension experiment showed that the tool definition and schema supported parser-valid workflow scripts across four tested parent models after removing `promptGuidelines`. The experiment retained the old `promptSnippet`, so it does not isolate whether the schema alone teaches the metadata header. See [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

#### Confidence

Confidence is high that `promptSnippet` should describe capability while `script.description` owns the metadata syntax. Confidence is moderate that removing the duplicated header causes no authoring regression because the existing experiment did not isolate that variable.

### Focus the tool description on delegation

Replace:

```text
Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline(). script is required raw JavaScript. It must start with export const meta = { name, description, phases? } and must call agent() at least once.
```

with:

```text
Run a JavaScript workflow that delegates work to subagents with agent(), optionally composing calls with parallel() and pipeline().
```

#### Reasoning

The provider-visible tool description should state the capability, while the `script` parameter description owns exact input syntax. Removing the metadata declaration and raw-script requirements from the description leaves one authoritative home for those facts.

“JavaScript workflow” distinguishes this constrained orchestration environment from a general JavaScript runner. “Delegates work” follows the approved domain language used for workflow selection and agent work units.

The runtime requires at least one `agent()` invocation but not multiple subagents. `parallel()` and `pipeline()` are optional composition helpers, so the new description identifies `agent()` as the delegation primitive and marks composition as optional.

The old “deterministic” claim described only the restricted orchestration shell. Subagent model output remains nondeterministic, making the claim misleading for the tool as a whole.

#### Evidence

The `script` parameter description already specifies raw JavaScript, the required metadata declaration, available globals, the `parallel()` thunk shape, and the requirement to call `agent()` at least once. The runtime rejects a workflow that launches no agents.

Pi exposes the description in the provider-visible tool definition and renders `promptSnippet` separately in the system prompt's Available-tools list. Both surfaces need capability language, but only the parameter schema needs the complete input contract.

#### Confidence

Confidence is very high that the description should omit duplicated syntax, avoid “deterministic” and “multiple subagents,” and distinguish required delegation through `agent()` from optional composition through `parallel()` and `pipeline()`.

### Put enforced script syntax in `script.description`

Remove these permanent guidelines:

```text
For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.
```

```text
For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.
```

```text
For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().
```

```text
For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.
```

```text
For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.
```

Replace them with no permanent guideline. Keep the complete first-attempt contract in the `script` parameter description:

```text
Required raw JavaScript workflow script, with no Markdown fences. First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] } Use plain JavaScript only; imports, require(), filesystem modules, Date.now(), Math.random(), and new Date() are unavailable. Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, cwd, process.cwd(), and budget. The workflow must call agent() at least once. parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).
```

The three dots in the quoted examples are literal JavaScript spread or placeholder syntax from the model-facing text; they do not omit wording from this record.

#### Reasoning

These are input-shape facts rather than selection or judgment policy. `script.description` is visible where the model constructs the tool argument and gives the facts one authoritative authoring home. The parser and runtime remain authoritative for enforcement and return corrective errors after violations.

The shortened schema had retained raw JavaScript, metadata, common globals, the minimum agent count, and the `parallel()` thunk requirement. This change restores two useful facts lost during shortening: the restricted JavaScript environment and the available `cwd` and `process.cwd()` path globals.

#### Evidence

The schema-comprehension experiment produced parser-valid scripts and correct `parallel()` thunk shapes across four tested parent models without `promptGuidelines`. Because that experiment retained the old metadata-bearing `promptSnippet`, it does not isolate metadata comprehension; keeping the declaration in `script.description` addresses that limitation. See [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

Runtime and parser tests cover metadata placement, nondeterministic APIs, VM escapes, and invalid `parallel()` arguments. The implementation lives in [`src/workflow.ts`](../src/workflow.ts).

#### Confidence

Confidence is very high that enforced syntax belongs in the parameter schema and runtime instead of duplicated permanent guidelines. Confidence is high that the concise environment restriction and path globals are necessary for a valid first attempt.

### Preserve composition mechanics in `script.description`

Keep these first-attempt mechanics in the `script` parameter description rather than permanent guidance:

```text
parallel() requires functions, not promises, and returns results in input order: await parallel(items.map(item => () => agent(...))).
```

```text
pipeline(items, ...stages) runs stages sequentially for each item while items proceed concurrently; each stage receives (previousValue, originalItem, index).
```

#### Reasoning

The approved permanent topology rule tells the parent when to use `parallel()` and `pipeline()`. These schema sentences separately state how to call them correctly. Result ordering preserves the association between parallel results and input work-unit identities despite completion timing. The pipeline sentence provides the callback contract needed to use prior stage output, recover the original item, and identify its input position.

These facts were present in the old permanent guidance or README but were accidentally absent from the shortened schema. Restoring them to `script.description` preserves first-attempt authoring capability without growing permanent system-prompt text.

#### Evidence

`src/workflow.ts` implements `parallel()` with `Promise.all`, which preserves input order, and implements `pipeline()` by running each item through its stages sequentially while item pipelines proceed through `Promise.all`. Each stage is invoked with `(previousValue, originalItem, index)`.

#### Confidence

Confidence is very high that both mechanics are stable runtime contracts, useful for valid first attempts, and correctly placed in the parameter schema rather than permanent guidance.

### Keep background behavior in the parameter schema and tool result

Remove this permanent guideline without replacement:

```text
For workflow, runs are background by default: the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when the run finishes. Pass background: false only when you must use the result inline in this same turn (it will block).
```

Retain the pre-call contract in `background.description`:

```text
Run the workflow in the background. Default: true — the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when it finishes. Set to false only when you need the result inline in this same turn (the call will block until the workflow completes).
```

#### Reasoning

Background execution is a parameter choice rather than permanent selection policy. The parameter description presents the default and tradeoff when the parent constructs the call. After a background run starts, the tool result confirms that execution continues independently, automatic result delivery is enabled, and the run can be inspected or stopped.

Keeping the same behavior in a permanent guideline would duplicate the parameter contract and create another surface that could drift when execution behavior changes.

#### Evidence

`src/workflow-tool.ts` defaults omitted `background` to `true`. `backgroundStartedText()` supplies the post-call explanation and run-management commands. The prompt-placement research recommends placing background behavior and parameter defaults in schema and runtime rather than permanent guidance.

#### Confidence

Confidence is very high that `background.description` and the actual tool result are sufficient authorities and that no permanent replacement is needed.

### Keep conditional phase guidance in `script.description`

Remove this permanent guideline:

```text
For workflow, when meta.phases declares more than one phase, call phase('Exact Title') at the start of each phase's work (or set opts.phase on each agent) so every agent groups under the correct phase; never declare a phase you don't switch into — a declared phase with no agents shows as 0/0 and any agent you forgot to move stays in the previous phase.
```

Replace the required metadata example:

```text
First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }
```

with this conditional contract in `script.description`:

```text
First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Add phases: [{ title: 'Phase' }] only when the workflow has named phases, and declare only phases it will use. With multiple phases, call phase('Exact Title') before each phase's work or set `phase` in the agent options.
```

#### Reasoning

`meta.phases` is optional, so the minimal executable example should not make a phase declaration look mandatory. Simple workflows avoid meaningless one-phase metadata, while models choosing multiple phases receive the switching rule where they author the script.

The rule affects execution as well as display. Agents default to the first declared phase; `phase(title)` changes the current assignment; an agent's `phase` option overrides it. Assigned phases select grouping, phase-specific model routing, and phase budgets. A multi-phase script that never switches can therefore silently apply the first phase's configuration to every agent.

The runtime currently permits undeclared titles and does not diagnose declared phases without agents. Runtime diagnostics are tracked separately so the model-facing schema does not remain the only guard.

#### Evidence

`src/workflow.ts` initializes the current phase to the first declared title and resolves each agent's assigned phase from its explicit option or that current phase. Runtime regression tests confirm the first-phase default and the absence of a synthetic phase when none is declared.

#### Confidence

Confidence is high that the long conditional rule does not belong in permanent guidance, that the minimal metadata example should omit optional phases, and that `script.description` should retain concise multi-phase instructions.

### Make saved-workflow nesting discoverable in `script.description`

Remove this permanent guideline:

```text
For workflow, you may call `await workflow('saved-name', argsObject)` to run a saved workflow inline and use its result; nesting is one level deep only, and the global 16-concurrent / 1000-total caps hold across the nesting.
```

Add this sentence to `script.description`:

```text
Use `await workflow(savedName, childArgs)` to run a saved workflow inline; nesting is limited to one level and shares the parent run's concurrency, agent, and token limits.
```

#### Reasoning

Saved-workflow composition is an optional script capability rather than permanent workflow-selection policy. Removing its guideline without another model-facing home made the `workflow()` global undiscoverable from the tool definition. The parameter description restores concise capability discovery where scripts are authored.

The replacement avoids fixed `16-concurrent / 1000-total` wording. Those are global maxima rather than every run's effective settings; nested workflows inherit the parent run's configured limiter, total agent count, and token budget.

Arguments, returned results, shared-store behavior, nested run IDs, resume-journal isolation, and log persistence remain runtime and documentation details rather than first-attempt syntax.

#### Evidence

The README documents `workflow(name, args)` as the inline saved-workflow global. Runtime tests cover child arguments and results, shared agent counting, one-level nesting, and shared-store identity. The implementation is in [`src/workflow.ts`](../src/workflow.ts).

#### Confidence

Confidence is high that saved-workflow composition should stay out of permanent guidance but remain discoverable through this concise parameter-schema sentence. Confidence is very high that inherited-limit language is more accurate than fixed maxima.

### Keep quality-helper names discoverable without a permanent catalogue

Remove this detailed permanent guideline:

```text
For workflow, prefer the built-in quality helpers when they fit (each is built on agent()/parallel() and returns plain data): verify(item, {reviewers, threshold, lens}) for adversarial fact-checking; judgePanel(attempts, {judges, rubric}) to score N candidates and return the best; loopUntilDry({round, key, consecutiveEmpty}) to keep finding until rounds stop yielding new items; completenessCheck(args, results) as a final 'what's missing' critic.
```

Add this concise capability sentence to `script.description`:

```text
Optional quality helpers include verify(), judgePanel(), loopUntilDry(), and completenessCheck().
```

Retain the separately approved permanent policy:

```text
Add verification when results would materially benefit from cross-checking, or a final synthesis agent when the deliverable needs comparison or prose.
```

#### Reasoning

The old catalogue combined capability discovery, full signatures, and a default preference for extra quality stages. Its “prefer” instruction conflicted with selecting verification according to material benefit, and the detailed signatures were irrelevant to most workflows.

Complete removal would make novel extension capabilities effectively invisible. The concise schema sentence preserves their names without turning permanent guidance into an advanced API reference. The permanent sentence separately governs when additional quality calls justify their cost.

Detailed option and return semantics remain in the README, website, tests, and source. Workflows can also construct equivalent topologies directly from `agent()` and `parallel()`.

#### Evidence

The prompt research classifies the quality-helper catalogue as detailed-only or on-demand and recommends presenting helpers as optional patterns rather than default stages. The runtime and `tests/quality-stdlib.test.ts` cover each helper's behavior.

#### Confidence

Confidence is very high that the detailed permanent catalogue and default preference should be removed. Confidence is high that a concise name catalogue in `script.description` provides an appropriate minimum level of discovery for an unfamiliar model.

### Keep outer resource controls in parameter descriptions

Remove these permanent guidelines:

```text
For workflow, do not set tokenBudget or agentTimeoutMs unless the user explicitly asks to cap spend or time; the defaults are unbounded.
```

```text
For workflow, use low concurrency and agentRetries for unstable provider/transport fan-out runs; retries apply only to recoverable agent failures and still require explicit null handling after exhaustion.
```

Add no replacement to `promptGuidelines`. Retain the existing `tokenBudget`, `agentTimeoutMs`, `concurrency`, and `agentRetries` parameter descriptions, and replace `maxAgents.description`:

```text
Maximum number of agents allowed in this run. Default: 1000.
```

with:

```text
Maximum number of agents allowed in this run. Default: 1000; this is a safety ceiling, not a target. Set a lower limit for dynamic or exploratory fan-out, and reserve large fan-outs for explicit user intent.
```

#### Reasoning

Outer resource controls matter while constructing the tool call, so their parameter descriptions are the direct authority. Permanent copies duplicate defaults and conditional advice.

Workflow selection and workflow scale are separate authorization decisions. Explicit workflow intent permits delegation, but it does not make the runtime's 1,000-agent maximum an appropriate target. The amended field trusts normal model judgment while requiring clearer authority for unusually large fan-outs and recommending a lower safety limit for dynamic expansion.

The detailed in-script budget, retry, gate, and graceful-degradation recipe remains a separate decision.

#### Evidence

The runtime enforces total-agent, concurrency, token-budget, timeout, and recoverable-retry behavior. The parameter schema describes each outer control where the model chooses its value. The public-workflow research assigns these facts to parameter schema and runtime while treating operational recipes as detailed guidance.

#### Confidence

Confidence is very high that outer control facts belong in their field descriptions and that 1,000 should be described as a ceiling rather than a target. Confidence is high that large fan-outs should require explicit user intent.

### Compress advanced control recipes into capability discovery

Remove this detailed permanent guideline:

```text
For workflow, to bound spend: pass tokenBudget for a hard run-wide cap; carve a per-phase ceiling with phase('Name', {budget: N}) (that phase throws at its sub-budget without touching the run total — wrap its work in try/catch so later phases proceed); use retry(thunk, {attempts, until}) for bounded retry, and gate(thunk, validator, {attempts}) when a validator's feedback should steer the next attempt. To degrade gracefully, branch on budget.remaining() to skip optional rounds or choose a lighter tier.
```

Add this concise sentence to `script.description`:

```text
Optional control helpers include retry() and gate(); budget exposes total, spent(), and remaining(), and phase('Name', { budget: N }) sets a phase token limit.
```

#### Reasoning

The old guideline combined hard run caps, phase limits, authored retry loops, validator-feedback loops, exception structure, and graceful degradation. Most workflows do not need that operational recipe, and its strategy should not be a permanent default.

Complete removal would make `retry()`, `gate()`, `budget` methods, and phase token limits undiscoverable to models unfamiliar with the extension. The concise schema sentence exposes their existence and essential shape without prescribing them.

Outer `tokenBudget`, `agentRetries`, and `agentTimeoutMs` remain documented by their tool parameters. `agentRetries` repeats recoverable failed executions; the script-level `retry()` repeats an authored thunk according to its `until` condition; `gate()` feeds validator feedback into another authored attempt. Full signatures and return semantics remain in detailed documentation.

#### Evidence

The prompt research classifies budgets, retry, gate, and graceful-degradation recipes as detailed-only or on-demand while keeping parameter facts in schema. Runtime tests in `tests/quality-stdlib.test.ts` cover `retry()` and `gate()`, and workflow runtime tests cover run and phase budgets. Broader static capability discovery and documentation drift are tracked in [issue #22](https://github.com/Whamp/pi-dynamic-workflows/issues/22).

#### Confidence

Confidence is very high that the detailed operational recipe should leave permanent guidance. Confidence is high that concise capability discovery in `script.description` is appropriate until a broader self-documenting capability architecture exists.

### Keep `agentType` static while moving exact names to deliberate discovery

Remove the dynamic `agentTypeGuideline()` call and its machine- and project-specific catalogue from permanent guidance. Keep `promptGuidelines` as a static array, and add this sentence to `script.description`:

```text
The optional `agentType` option selects a named user or project definition that can bind tools, a model, and role instructions; use it only when its name and purpose are provided in context. Its bound model overrides `tier`; an explicit `model` overrides both.
```

#### Reasoning

`agentType` is a stable extension capability, but available definitions are live filesystem data from the current project and user configuration. Injecting those names and descriptions into the permanent system prompt makes its size and contents environment-dependent and risks cache invalidation as definitions change.

Complete removal would make the option undiscoverable. The static schema sentence explains the capability, authority boundary, and model precedence. Exact names and purposes must come from the user's context or a deliberate cache-safe discovery mechanism after workflow selection.

The runtime currently warns and falls back to default tools and model for an unknown `agentType`; failing closed or returning a structured diagnostic remains a runtime hardening opportunity.

#### Evidence

Issue #12 researched cache-safe discovery for exact model and `agentType` catalogues. Issue #22 tracks a broader self-documenting capability architecture. Runtime model precedence is explicit `model`, then the `agentType`-bound model, then `tier`, then phase routing.

#### Confidence

Confidence is very high that the live catalogue should leave permanent context and that `promptGuidelines` should remain static. Confidence is high that the concise schema sentence preserves appropriate discovery without authorizing guessed names.

### Delete obsolete prompt-helper exports

Delete `modelRoutingGuideline()` and `agentTypeGuideline()` from `src/workflow-tool.ts`, along with their registry imports and direct string tests. Add no replacement helper functions.

#### Reasoning

Neither helper is exported from the package root defined by `package.json` and `src/index.ts`, so removal does not change the supported package API. Their only production use was constructing the old permanent guidance.

`modelRoutingGuideline()` encoded superseded policy: mandatory tier tags, a closed three-tier vocabulary, and embedded exact-model examples. The approved static routing language supports standard and user-configured routes and reserves exact `model` overrides for user-named models.

`agentTypeGuideline()` read live filesystem definitions and flattened them into permanent system-prompt text. That conflicts with the approved static capability sentence and deliberate, cache-safe exact-name discovery.

Removing both helpers lets `promptGuidelines` remain a plain static array. `WorkflowManager` still receives the model registry for runtime model resolution, so execution behavior does not depend on either text helper.

#### Evidence

`package.json` exports only the package root. `src/index.ts` exports `WorkflowToolInput`, `WorkflowToolOptions`, `backgroundStartedText`, and `createWorkflowTool` from `workflow-tool.ts`, but not either helper. Repository search found no remaining production caller after the prompt rewrite.

#### Confidence

Confidence is very high that the helpers are unsupported internal exports with obsolete responsibilities and should be deleted rather than preserved or deprecated.

### Test intent and placement instead of guideline count

Delete this provisional assertion:

```text
assert.ok(tool.promptGuidelines.length <= 5, "permanent guidance should stay scannable");
```

Retain intent-level assertions for the approved authoring contracts, static guidance, omission of live catalogues and advanced recipes, and relocation of syntax and parameter facts to their authoritative schema fields.

#### Reasoning

Guideline count does not measure prompt size or clarity. Five arbitrarily long bullets pass, six concise bullets fail, and the limit encourages unrelated contracts to be combined. The approved guidance should group related ideas naturally rather than target an arbitrary array length.

Rendered system-prompt bytes and provider-visible tool-definition bytes remain useful audit measurements, but they should not become byte-level test ratchets. Prompt quality depends on what each surface teaches and where the contract belongs, not on freezing an incidental serialized size.

Exact-copy tests also remain inappropriate for prose that may receive harmless editorial improvements. Intent, placement, absence, and runtime behavior provide the regression signals; surface sizes may be reported during review as evidence without becoming pass/fail thresholds.

#### Confidence

Confidence is very high that guideline-count and byte-level ratchet tests should be omitted while behavioral, static-guidance, and placement assertions remain.

### Require explicit workflow intent

Replace:

```text
Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.
```

and:

```text
For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.
```

with:

```text
Use workflow only for explicit workflow intent: a request for a workflow, subagent delegation, fan-out, or multi-agent orchestration, or an enabled mode that requires workflow. Use ordinary tools for work you can perform directly.
```

#### Reasoning

Workflow selection is an authorization decision rather than a test of whether a parent model can recognize decomposable work. One run permits up to 1,000 agents, up to 16 concurrently, and no token budget by default. A capable model can choose an appropriate topology after authorization, but it cannot infer the user's tolerance for that potential expense from task complexity alone.

The boundary does not require a magic trigger word. Explicit intent includes a direct workflow request, delegation to even one subagent, fan-out, multi-agent orchestration, or standing intent established by an enabled workflow or effort mode. The runtime requires at least one agent rather than multiple agents, so singular subagent delegation is valid.

Enabled modes must count because the extension deliberately transforms matching messages into a workflow requirement. Recognizing that standing opt-in prevents the permanent guidance from conflicting with the extension's own trigger behavior.

“Work you can perform directly” replaces arbitrary one-read, one-edit, and one-command tests. Decomposability shapes the workflow after selection; it does not independently authorize delegation.

Permission to use workflow is distinct from permission for a large fan-out. Scale policy remains a separate operational decision so this selection rule stays focused.

#### Evidence

The workflow runtime enforces a 1,000-agent total cap and a 16-agent concurrency cap, while `tokenBudget` is unbounded by default. The workflow editor's forced-mode prompt requires at least one `agent()` call even for a small task. See [`src/config.ts`](../src/config.ts), [`src/workflow-tool.ts`](../src/workflow-tool.ts), and [`src/workflow-editor.ts`](../src/workflow-editor.ts).

The schema-comprehension experiment showed that all four tested parent models selected the workflow tool for an explicit orchestration request. It did not test autonomous workflow selection, so it supports comprehension of explicit intent rather than broad autonomous permission. See [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

#### Confidence

Confidence is high that potentially high-scale delegation requires explicit current or standing user intent, that one-subagent delegation is valid intent, and that ordinary tools should handle work the parent can perform directly. Large-fan-out authorization should be decided separately from workflow selection.

### Scope each agent at a natural, context-sized boundary

Replace:

```text
For workflow, give each subagent a substantive, self-contained task: do not spawn an agent just to read one file or run one command, and do not use one agent only to check on another. Prefer fewer, higher-level agents over many trivial micro-tasks.
```

and:

```text
For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.
```

with:

```text
For workflow, assign each agent a substantive work unit at a natural task boundary that it can complete comfortably within one context window. Split larger work at additional natural boundaries. Make each agent prompt self-contained with relevant context, paths, constraints, and expected output.
```

#### Reasoning

A file or command count is a poor proxy for task quality. One file can be the right work unit when each file needs substantive independent analysis or a complete implementation-and-verification pipeline. A task spanning many files can still be too small, coupled, or vague to delegate. Agent count should follow the task's natural boundaries rather than an unconditional preference for fewer agents.

A natural boundary is not sufficient when the resulting unit is too large for one subagent to complete coherently. Requiring the unit to fit comfortably within one context window leaves room for instructions, investigation, tool results, reasoning, and final output. Larger work should split at additional domain boundaries rather than arbitrary token intervals.

The guidance does not name a token limit because workflow agents may use configured models with different context windows. A model-relative rule remains accurate as model configurations change and avoids treating the whole advertised window as available task capacity.

Each workflow agent starts a fresh Pi session. It receives its working directory, normal Pi resources, runner instructions, per-agent instructions, label, and authored prompt, but not the parent conversation or the parent's tool results. Its prompt must therefore carry the task-specific context and completion contract.

#### Evidence

The public-workflow corpus found concrete work units to be the strongest recurring structure across 95 scripts from 92 repositories. Observed boundaries included directory and review dimension, document group, finding, module, test, and issue. See [Dynamic workflow authoring patterns](https://github.com/Whamp/pi-dynamic-workflows/blob/8bfe12fc020159748e5c0519951896086c493ce2/docs/research/claude-code-dynamic-workflow-patterns.md#recurring-structures).

The Bun `phase-a-port` workflow pipelines one source file through implementation, verification, and conditional repair, directly contradicting a blanket prohibition on one-file agents. See [Bun `phase-a-port.workflow.js`](https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/phase-a-port.workflow.js#L148-L224).

The source-author guidance recommends self-contained worker prompts and bounded scale. See [Agent script authoring skill](https://github.com/YuanpingSong/ultracodex/blob/5519ed1da818b4b43e23b7547063fac4759f6809/skills/agent-script-authoring/SKILL.md#L145-L164).

Pi model configuration exposes model-specific `contextWindow` and `maxTokens` values rather than one universal limit. See [Pi model configuration](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/models.md#L194-L207).

The fresh-session prompt assembly is implemented in [`src/agent.ts`](../src/agent.ts).

#### Confidence

Confidence is high that work should follow natural task boundaries rather than file or command counts, that oversized work should split further, and that agent prompts must be self-contained. The corpus supports bounded concrete work units, but it did not directly compare a one-context-window rule against another sizing heuristic.

### Select verification and synthesis by need

Replace:

```text
For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.
```

and the permanent default recipe:

```text
For workflow, the default quality shape for fan-out work is finder -> verify -> merge: run one agent per angle or work-unit (in parallel), pass each candidate finding through verify() and drop the unconfirmed, then a single synthesis agent that de-duplicates, ranks by confidence/severity, and caps the output. If nothing survives verification, return an empty result and say so rather than padding.
```

with:

```text
Add verification when results would materially benefit from cross-checking, or a final synthesis agent when the deliverable needs comparison or prose.
```

#### Reasoning

Verification and synthesis solve different problems. Verification cross-checks results whose errors matter enough to justify another model call. The word `materially` prevents verification from becoming an automatic stage merely because any result could benefit slightly from review.

A final synthesis agent is useful when the deliverable requires comparison, judgment across results, or coherent prose. It is unnecessary when JavaScript already has exact paths, counts, keyed records, pass/fail rows, deduplicated findings, or threshold decisions. Another model call can damage those results by changing identifiers or counts.

The old `finder -> verify -> merge` recipe remains available as an authoring pattern, but it is not the universal topology. The approved wording selects quality stages from the deliverable instead of requiring them by default. It also removes mandatory `ok` and `verdict` fields; each workflow should return the structure its contract requires.

#### Evidence

The public corpus found synthesis or merge language in 57 of 95 scripts and identified four recurring endings: direct structured return, plain-JavaScript reduction, final narrative synthesis, and judge-and-graft synthesis. See [Dynamic workflow authoring patterns: synthesis strategies](https://github.com/Whamp/pi-dynamic-workflows/blob/8bfe12fc020159748e5c0519951896086c493ce2/docs/research/claude-code-dynamic-workflow-patterns.md#synthesis-strategies).

The same corpus observed verification at the cost boundary: expensive or actionable findings received independent refutation, while cheap discovery often did not. See [Dynamic workflow authoring patterns: recurring structures](https://github.com/Whamp/pi-dynamic-workflows/blob/8bfe12fc020159748e5c0519951896086c493ce2/docs/research/claude-code-dynamic-workflow-patterns.md#recurring-structures).

#### Confidence

Confidence is high that verification and final synthesis should be conditional rather than universal. The corpus directly contains workflows that return structured results, reduce them in JavaScript, or synthesize them with a final agent according to the deliverable.

### Choose and compose topology by dependency shape

Replace:

```text
For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.
```

and:

```text
For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).
```

with:

```text
For workflow, compose parallel() and pipeline() when the work has both shapes: use parallel() for independent work and between stages when the next stage needs all prior results; use pipeline() when each item can pass through its stages independently.
```

#### Reasoning

Permanent guidance should teach the topology decision rather than repeat call syntax. Use `pipeline()` while each item can advance through dependent stages without seeing other items. Use separate `parallel()` calls when work is independent or when the next stage requires the complete preceding result set for a whole-set operation such as deduplication, merging, a count-based decision, or cross-item comparison.

A workflow may contain either helper or both. Explicitly naming composition prevents readers from treating `parallel()` and `pipeline()` as mutually exclusive workflow types. The work's dependency shape determines whether to use per-item pipelines, whole-set barriers, or both.

The `script` parameter description remains the authoritative prompt-level home for the `parallel()` thunk requirement. Runtime validation supplies a concrete corrective error when a script passes promises instead of functions. Detailed callback signatures and nesting examples do not need permanent system-prompt space.

#### Evidence

The runtime implements `parallel()` with `Promise.all()` over supplied thunks. It implements `pipeline()` with concurrent items and sequential stages for each item. See [`src/workflow.ts`](../src/workflow.ts).

All four parent models in the schema-only experiment produced runtime-valid parallel fan-out without `promptGuidelines`, showing that the schema communicated the thunk shape for the tested task. The experiment did not test the `pipeline()` versus whole-set-barrier decision. See [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

The public authoring research recommends `pipeline()` for per-item staged work and separate `parallel()` barriers when a later stage needs whole-set deduplication, merging, a count-based exit, or cross-item comparison. See [Dynamic workflow authoring patterns: profile recommendation](https://github.com/Whamp/pi-dynamic-workflows/blob/8bfe12fc020159748e5c0519951896086c493ce2/docs/research/claude-code-dynamic-workflow-patterns.md#profile-recommendation).

#### Confidence

Confidence is high in the runtime semantics, the per-item versus whole-set deciding rule, and keeping detailed thunk syntax out of permanent guidance. Confidence is moderately high that the concise topology rule earns permanent space because the composition model is novel and cannot be inferred reliably from the function names alone.

### Require an explicit JSON-serializable result

Replace the return clause in:

```text
For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.
```

with an independent contract:

```text
For workflow, explicitly `return` a JSON-serializable result.
```

#### Reasoning

Every workflow needs a final result regardless of whether it returns records directly, reduces them in JavaScript, verifies findings, or calls a final synthesis agent. The old wording incorrectly associated the return contract with synthesis and prescribed `ok` and `verdict` fields that many workflows do not need.

`JSON-serializable` establishes the provider-facing boundary without prescribing a domain-specific shape. The explicit JavaScript keyword distinguishes `return result` from a bare final expression such as `result;`, which does not return from the generated async function.

The runtime currently accepts `undefined`, so the model-facing instruction remains necessary. Runtime validation should become authoritative and produce an actionable error instead of allowing a successful run with no usable result. Follow-up: [#19 Reject workflows that return undefined](https://github.com/Whamp/pi-dynamic-workflows/issues/19).

#### Evidence

In the schema-only experiment, two of four parent models produced runtime-valid scripts without an explicit return. Terra logged its synthesis result without returning it. GLM ended with `result;` rather than `return result`. Both workflows completed without a result and caused empty parent responses. See [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

When rerun with the current guidance, all four tested models explicitly returned the requested result. Those reruns used the complete guidance rather than isolating this sentence, but the observed failures and corrective instruction both concern the missing JavaScript `return` directly.

#### Confidence

Confidence is very high that workflows must explicitly return a result and that this contract should remain permanently visible until runtime rejects `undefined`. Confidence is high that the result should be JSON-serializable without mandatory field names.

### Treat recoverable failures as missing coverage

Replace:

```text
For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.
```

with:

```text
For workflow, treat `null` from recoverable agent(), parallel(), or pipeline() failures as missing coverage, not a negative finding. Record failed work-unit identities before filtering, and report any coverage that remains incomplete.
```

#### Reasoning

Checking for `null` is not enough unless the author understands its meaning. A recoverable failure means the intended work produced no result. It does not mean the work ran and found nothing. Treating a failed scanner, verifier, or auditor as a negative finding can turn missing work into a false clean result.

Recording failed work-unit identities before filtering preserves the distinction between checked and clean, checked with findings, and not checked because execution failed. Reporting only coverage that remains incomplete allows a retry or fallback path to restore coverage without forcing an inaccurate incomplete status.

The wording names recoverable failures because non-recoverable failures and aborts propagate instead of becoming `null`. This is more accurate than saying that every failed branch returns `null`.

#### Evidence

In the schema-only experiment, two of four parent models expected failed agents to throw. The runtime resolved recoverable failures to `null`, so those scripts treated missing checker results as successful evidence. With current guidance, all four models detected the simulated `null`, preserved the failed checker, and returned the requested incomplete-coverage information. See [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

In the 95-script public corpus, 79 scripts contained an explicit null or failure guard and 69 used `.filter(Boolean)`. The strongest examples recorded failed work-unit identities before filtering and marked results incomplete rather than clean. See [Dynamic workflow authoring patterns: failure handling](https://github.com/Whamp/pi-dynamic-workflows/blob/8bfe12fc020159748e5c0519951896086c493ce2/docs/research/claude-code-dynamic-workflow-patterns.md#failure-handling).

The runtime returns `null` for recoverable direct-agent failures, recoverable `parallel()` branches, and items whose `pipeline()` stage fails recoverably. Non-recoverable failures halt the run. See [`src/workflow.ts`](../src/workflow.ts).

#### Confidence

Confidence is very high that the `null` contract, the distinction between missing coverage and negative evidence, and failed-work identity must remain permanently visible while the runtime represents recoverable failures with `null`.

### Label each agent invocation by work unit

Replace:

```text
For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.
```

with:

```text
For workflow, give each agent() invocation a short, unique `label` that identifies its work unit.
```

#### Reasoning

Meaningful labels make live status, task-panel rows, failure messages, persisted runs, and missing-coverage reports understandable. The requirement applies to each invocation rather than only each authored call site because one `agent()` expression inside a loop may create many work units.

The old 2–5-word requirement was an arbitrary proxy. A useful label need only remain short, distinguish the invocation, and identify its work. Stating that purpose is more durable than permanent examples.

The runtime can generate fallback labels, so omission does not invalidate execution. This is an observability and failure-accounting contract rather than parser syntax. It supports the approved requirement to record failed work-unit identities before filtering.

#### Evidence

In the public corpus, 94 of 95 scripts supplied a label to an agent call, making labels the most consistently observed inner-agent option after explicit top-level returns. See [Dynamic workflow authoring patterns: corpus results](https://github.com/Whamp/pi-dynamic-workflows/blob/8bfe12fc020159748e5c0519951896086c493ce2/docs/research/claude-code-dynamic-workflow-patterns.md#public-workflow-corpus).

The schema-only research concluded that the outer workflow schema cannot describe options nested inside the JavaScript `agent()` call. During reruns with current guidance, all four tested parent models supplied short labels. See [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

#### Confidence

Confidence is high that each invocation should have a short, meaningful label tied to its work unit and that the arbitrary word-count rule and permanent examples should be removed.

### Treat tiers as an open set of configured model routes

Replace:

```text
For workflow, the user configures per-tier models (/workflows-models), so TAG EVERY agent with opts.tier by role so those models are actually used. opts.tier accepts 'small', 'medium', or 'big' and is enforced at runtime. Small tier: lightweight exploration/search/inventory agents. Medium tier: balanced analysis agents. Big tier: synthesis/judgment/decision agents spanning the full context. An agent with no opts.tier and no opts.model falls back to the user's medium tier; do not rely on that — tag agents explicitly so small/big are used where they fit.
```

with:

```text
For workflow, `tier` selects a configured model route. Standard routes are `small` for lightweight or high-volume work, `medium` for routine work, and `big` for the hardest or highest-stakes work; use another user-configured route only when its name and purpose are provided in context.
```

#### Reasoning

The permanent language must not make `small`, `medium`, and `big` a closed enumeration. They are stable standard routes with useful default meanings, while the model-routing interface can grow to include user-configured routes such as an alternative high-capability model for independent judgment or routes tuned for cheaper and more expensive implementation.

A **model route** answers which model configuration should execute the work. An `agentType` answers which role, instructions, and tools an agent should have. A review-specialized model can therefore be a custom route, while a reviewer with specialized instructions or tools remains an `agentType`.

The parent must not invent route names. A custom route is usable only when cache-safe, post-selection discovery has supplied both its name and purpose. The permanent prompt therefore exposes the open interface without injecting a live user-specific catalogue or changing the system prompt between turns.

The role descriptions are deliberately broad. `small` covers lightweight or high-volume work, `medium` covers routine work rather than analysis alone, and `big` describes difficulty or stakes rather than the ambiguous phrase “cross-context judgment.”

#### Evidence

The current configuration and runtime already preserve an extensible seam: `ModelTierConfig.tiers` is a `Record<string, string>`, `resolveTierModel()` accepts any string, `WorkflowAgentOptions.tier` is a string, and `sortedTierNames()` orders additional names after the three standard routes. The existing command can display additional keys present in the configuration, although it cannot yet create or remove them and the configuration cannot describe their purposes.

The dynamic-workflow prompting research recommends keeping the stable `small`/`medium`/`big` vocabulary always-on, moving live catalogues to deliberate discovery, and avoiding a concrete model list in permanent context. See [Dynamic workflow authoring patterns: placement matrix](https://github.com/Whamp/pi-dynamic-workflows/blob/8bfe12fc020159748e5c0519951896086c493ce2/docs/research/claude-code-dynamic-workflow-patterns.md#placement-matrix-for-the-current-guidance).

#### Confidence

Confidence is high that the permanent interface should present `small`, `medium`, and `big` as standard routes rather than the only valid values. Confidence is also high that custom routes require purpose metadata and cache-safe discovery before a parent model can select them reliably.

Implementation of user-configured routes and post-selection discovery is tracked in [#20](https://github.com/Whamp/pi-dynamic-workflows/issues/20).

### Reserve explicit model selection for user-named overrides

Replace:

```text
Use opts.model only when the user names a specific model; pass that exact provider/id. opts.model always takes precedence over opts.tier. Exact model specs may include Pi CLI-style thinking suffixes such as openai-codex/gpt-5.5:xhigh or anthropic/claude-fable-5:max when the user requests a specific effort level.
```

with:

```text
Use `model` instead of `tier` only to honor an exact model named by the user.
```

#### Reasoning

Normal routing should use a configured model route through `tier`. An explicit `model` bypasses that abstraction and should therefore represent a direct user choice rather than an autonomous concrete-model decision by the workflow author.

“Instead of” encodes the runtime precedence as an authoring decision: do not provide both options and leave a misleading, unused route in the invocation. The runtime accepts an unambiguous `provider/modelId` or a resolvable bare `modelId`, so requiring a provider-qualified ID is unnecessarily strict.

Concrete provider examples and thinking-suffix syntax do not belong in permanent guidance. They become stale, privilege particular providers, and are unnecessary when the user supplies the exact model specification to honor.

#### Evidence

The schema-only experiment recorded a parent inventing the concrete model name `sonnet` even though neither the user nor the tool schema supplied it. The resulting recommendation was to route normal work through semantic tiers and use an exact model only when the user names one. See [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

The runtime resolves explicit `model` before an `agentType`-bound model, `tier`, phase routing, and the default route. Encoding the choice with “instead of” removes the need to teach that precedence separately.

#### Confidence

Confidence is very high that explicit `model` selection should only honor an exact user-named model, that authors should choose it instead of `tier`, and that concrete model-spec examples should be omitted from permanent guidance.

### Describe the structured-output return contract

Replace:

```text
For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.
```

with:

```text
When an agent must return structured data, pass a plain JSON Schema in its `schema` option; on success, `agent()` returns the validated object.
```

#### Reasoning

The concise replacement retains the deciding condition, the required schema format, the nested option name, and the changed return contract. “On success” keeps it consistent with the separately documented recoverable-failure path, where an invocation may yield `null` instead.

The return contract matters because an agent without `schema` returns text, while a successful schema-constrained agent returns the validated object. Stating that result prevents workflow authors from treating it as prose or parsing it again.

TypeScript and TypeBox prohibitions are unnecessary permanent guidance. The workflow script contract already permits plain JavaScript without imports, and “plain JSON Schema” states the usable representation positively.

#### Evidence

When `schema` is present, the runtime creates a terminating `structured_output` tool with that schema. Pi validates its arguments before capture. If the subagent omits the tool call, the runtime re-prompts and accepts prose recovery only after conversion and schema validation; unresolved noncompliance fails rather than returning unvalidated data.

JSON Schema appeared in 86 of 95 scripts in the public workflow corpus. In the schema-comprehension experiment, all four reruns with current guidance used JSON schemas for structured subagent output. The research concluded that concise `schema` guidance belongs in the always-on inner-agent contract because the outer workflow schema cannot describe options nested inside JavaScript. See [Dynamic workflow authoring patterns: corpus results](https://github.com/Whamp/pi-dynamic-workflows/blob/8bfe12fc020159748e5c0519951896086c493ce2/docs/research/claude-code-dynamic-workflow-patterns.md#public-workflow-corpus) and [What the workflow schema teaches parent models](https://github.com/Whamp/pi-dynamic-workflows/blob/f8b6f5c34e9476e014d2906a257344e410a00364/docs/research/workflow-schema-comprehension.md).

#### Confidence

Confidence is very high that concise `schema` guidance and the successful validated-object return contract should remain permanently visible, while TypeScript and TypeBox warnings should move out of permanent guidance.
