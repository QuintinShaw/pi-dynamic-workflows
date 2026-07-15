# pi-dynamic-workflows

[![npm](https://img.shields.io/npm/v/@quintinshaw/pi-dynamic-workflows?color=cb3837&logo=npm)](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev)
[![tests](https://img.shields.io/badge/tests-679%20passing-success)](#development)

> **Claude Code–style dynamic workflows for [Pi](https://pi.dev).**
> Turn one prompt into a fleet of subagents that fan out in parallel, cross-check each other, and hand back a single synthesized answer.

**[Website](https://quintinshaw.github.io/pi-dynamic-workflows/) · [npm](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows) · [Pi package](https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows) · [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows)**

![pi-dynamic-workflows demo](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/demo.gif)

Instead of one model grinding a task step by step, Pi writes a small JavaScript **orchestration script** that spawns many subagents at once, keeps the intermediate work in script variables (not your chat context), and returns only the result. It's the "code mode for subagents" from Claude Code — on any model Pi can reach.

Built for **codebase-wide audits, multi-perspective review, large refactors, and cross-checked research** — anything one context window can't hold.

## Install

```bash
pi install npm:@quintinshaw/pi-dynamic-workflows
```

Then `/reload` in Pi. You get the `workflow` start tool, the `workflow_control` management tool, plus the `/workflows`, `/deep-research`, and `/adversarial-review` commands.

## Try it

Ask in plain language:

```text
Run a workflow to audit every route under src/routes/ for missing auth checks.
```

Pi writes the script and runs it in the background — your turn ends immediately and a live panel tracks progress while you keep working. Keyword activation is **off by default**, so ordinary mentions of `workflow` or `workflows` are never rewritten. To enable it, run `/workflows-trigger on`; enabled triggers are case-insensitive, word-bounded literal terms and do not match paths, slash commands, or identifier-like text. You can choose a custom term with `/workflows-trigger set pi-workflow`, restore `workflow`/`workflows` with `/workflows-trigger reset`, inspect it with `/workflows-trigger status`, or disable it again with `/workflows-trigger off`. Preferences are saved for new sessions.

To force a workflow without enabling keyword activation, run `/workflows run <prompt>`. This explicit command always works.

![Workflows mode in the input box](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/workflows-mode.jpg)

If another Pi extension has already installed a custom editor component, pi-dynamic-workflows leaves it in place. The default-off submit hook leaves input and active tools untouched. When keyword activation is explicitly enabled, submit-time detection still works in compatibility mode, but the animated highlight and Backspace one-shot disarm affordance are unavailable because the existing editor owns rendering and input handling. Editor composition is load-order dependent: whichever extension installs a visual editor last owns the editor surface.

## What a workflow looks like

Plain JavaScript. The first statement exports literal metadata; then you orchestrate:

```js
export const meta = {
  name: 'auth_audit',
  description: 'Find routes missing auth checks and verify the findings',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }],
}

phase('Scan')
const files = await agent('List every route file under src/routes/.', { tier: 'small' })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`Audit ${file} for missing auth checks.`, { tier: 'medium', isolation: 'worktree' }),
  ),
)

phase('Verify')
return await agent('Synthesize and double-check these findings:\n' + findings.join('\n\n'), { tier: 'big' })
```

`agent()` spawns an isolated subagent, `parallel()` runs many at once, `phase()` groups them in the live view, and `tier` routes each one to the right model. That's the whole idea.

## Highlights

- **Fan-out orchestration** — `agent()`, `parallel()`, `pipeline()`, `phase()` in a sandboxed script. Pi can select 1–16 concurrent agents for each run independently of the 1000-agent whole-run cap; intermediate results stay in variables, not the chat.
- **Real model routing** — `small` / `medium` / `big` tiers (or an exact `model`) per agent. It actually switches the subagent's model — cheap work on a light one, hard synthesis on a big one.
- **Durable journaled resume** — an interrupted run preserves completed agent identities and exact usage, replays finished agents without charging them twice, and resumes unfinished work with the original run controls.
- **Git worktree isolation** — `isolation: "worktree"` gives an agent its own branch, so parallel agents can edit the same files without clobbering each other.
- **Live token & cost accounting** — `~N tok` marks a streaming, display-only estimate; exact cumulative usage replaces it at each assistant-message boundary and is reconciled from the subagent session at completion. Runs have no default token cap; `tokenBudget`, phase budgets, and `budget` use exact usage for explicit gates.
- **Background by default** — the turn ends right away, a live "Workflows running" panel tracks runs, and each result is delivered back so the conversation auto-continues when it finishes. Queued and running counts are separate, and `Running now (N/M)` names every active agent against the run's concurrency cap. The panel is compact by default; `/workflows-progress detailed` expands it inline to per-phase/per-agent rows with live usage — no need to open `/workflows`.
- **Interactive `/workflows` TUI** — drill runs → phases → agents → detail; inspect queued/running/done/error/skipped state, per-agent usage, failures, and compact history; pause, stop, restart, and save runs from the keyboard.
- **Quality patterns built in** — `verify()`, `judgePanel()`, `loopUntilDry()`, and `completenessCheck()` for adversarial review, best-of-N, and exhaustive discovery.
- **Ultracode** — `/ultracode` is a standing opt-in that auto-arms an exhaustive multi-agent workflow for every substantive message, the way Claude Code's ultracode does. `/effort high` is the lighter tier.
- **Bundled `/deep-research` + `/adversarial-review` + `/code-review`** — real web search, source cross-checking, cited reports, and a 7-angle parallel code review with a verify pass.
- **Saved & nested workflows** — turn any run into a `/<name>` command, and compose saved workflows from inside other scripts.

## How it maps to Claude Code dynamic workflows

The same model — on Pi, plus the production pieces a real run needs:

| Claude Code dynamic workflows | pi-dynamic-workflows (on Pi) |
| --- | --- |
| Code-mode orchestration — the model writes a script that drives subagents | A JS `workflow` tool running `agent()` / `parallel()` / `pipeline()` / `phase()` in a vm sandbox |
| Subagents with isolated context | Private Pi sessions outside `/resume`; results held in script variables, not the chat |
| Structured outputs | JSON-Schema `schema` → a validated object, with bounded repair if the model misses |
| Background runs | Non-blocking by default, a live task panel, autonomous `workflow_control`, and auto-continue delivery |
| Resume | **Durable, journaled, and replayable** — survives restarts with completed status/usage and run controls intact |
| Model selection | **Per-agent / per-phase routing** across any provider Pi is authenticated for |
| Ultracode (standing maximal-effort opt-in) | **`/ultracode`** (or `/effort ultra`) — auto-arms an exhaustive workflow for every substantive message |
| — | **Git worktree isolation**, **real cost accounting**, **`/deep-research`**, and a **quality-pattern stdlib** |

## Pi tools

Pi starts work with `workflow`, then manages background runs directly with `workflow_control`; it does not need to ask you to type a slash command. `workflow_control` supports `list`, `status`, `set_concurrency`, `pause`, `resume`, `stop`, `restart`, and `remove`. Every action except `list` requires the canonical `runId` returned by `workflow` or `workflow_control list`.

For example, you can ask Pi:

```text
Start a background workflow with concurrency 8, then list its status.
Pause that run, resume it when I say continue, and stop it if I say quit.
```

Pi can make the corresponding calls itself:

```json
{ "action": "list" }
{ "action": "status", "runId": "<canonical-run-id>" }
{ "action": "pause", "runId": "<canonical-run-id>" }
{ "action": "resume", "runId": "<canonical-run-id>" }
{ "action": "stop", "runId": "<canonical-run-id>" }
{ "action": "restart", "runId": "<canonical-run-id>" }
{ "action": "remove", "runId": "<canonical-run-id>" }
```

`stop` means terminate/quit the run. In the navigator, `x` also stops the selected run, while `q` only closes the navigator.

## Commands

```text
/workflows                  open the interactive navigator (plain list in print mode)
/workflows status <id>      watch a run live; print its result when it finishes
/workflows save <name>      save the latest run's script as a reusable /<name> command
/workflows pause|resume|stop|rm <id>
/workflows-trigger off|on|status
                            persistently disable, enable, or inspect keyword triggering (off by default)
/workflows-trigger set <word>|reset
                            customize or reset the word-bounded trigger (default "workflow",
                            also matches "workflows"; all trigger words are literal and case-insensitive)
/workflows run <prompt>     force a dynamic workflow from <prompt> on demand — the explicit
                            twin of the keyword trigger. Works even when the keyword trigger
                            is off (/workflows-trigger off); the run shows in the panel + /workflows.
/workflows-progress compact|detailed|status
                            switch the live panel between the compact one-liner and the detailed
                            per-phase/per-agent view (with tokens, cost, and a live tok/s rate)
/workflows-progress-max <N> cap agents shown per phase in detailed mode (1-1000, default 8)
/workflows-models           map the small / medium / big tiers to real models, optionally with thinking levels
/ultracode [off]            ultracode: auto-arm an exhaustive workflow for every substantive message
/effort off|high|ultra      finer control over the standing opt-in (high = thorough, ultra = ultracode)

/deep-research <question>   web-researched, source-cross-checked report
/adversarial-review <task>  findings vetted by skeptical reviewers
/multi-perspective "<topic>" [angle …]
                            analyze a topic from several independent angles, then synthesize
/code-review [target]       7 parallel finder angles (correctness, reuse, simplification, efficiency,
                            altitude) + a verify pass → ranked findings
/codebase-audit <scope> "<check>" …
                            run parallel checks over a scope, then cross-validate and report
```

`/multi-perspective` and `/codebase-audit` take quoted arguments so a topic or check can be multiple words:

```
/multi-perspective "should we use Redis or Postgres for session storage"
/multi-perspective "JWT vs session cookies" security scalability developer-experience
/codebase-audit src/ "missing error handling" "unused exports" "inconsistent naming"
```

`/multi-perspective` needs a topic; with fewer than two angles it defaults to `technical, product, security, user experience, maintainability`. `/codebase-audit` needs a scope and at least one check.

`/code-review` reads its target from `[target]`, defaulting to your working diff when omitted:

```
/code-review                  review git diff HEAD (your working changes)
/code-review HEAD~3..HEAD     review a git range
/code-review src/foo.ts       review a git diff scoped to one path
/code-review 42               review gh pr diff 42 (needs the gh CLI + auth)
```

It fans out 7 finder agents in parallel — 3 on correctness (line-by-line scan, removed-behavior audit, cross-file call-site tracing), 3 on cleanup (reuse, simplification, efficiency), and 1 on abstraction-level fit — dedupes their candidates, verifies each one, and returns a ranked markdown report (correctness first, cleanup next, abstraction last, capped at the top 10). A diff over ~200k characters is truncated with a clear notice rather than silently cut or blowing up the prompt.

In the navigator: `↑/↓` select · `enter`/`→` open · `esc`/`←` back · `p` pause · `x` stop run · `r` restart · `s` save · `q` close. `q` never terminates a run. Each agent shows its explicit state and model; the detail view shows its prompt, live or exact token usage, result, error diagnostics, and compact message/tool history.

## Storage

Workflow state is stored under `~/.pi/workflows` so projects do not accumulate extension-owned `.pi/workflows` directories. Global settings and model tiers live at `~/.pi/workflows/settings.json` and `~/.pi/workflows/model-tiers.json`; project-scoped run history, resume journals, locks, and saved workflow overrides live under `~/.pi/workflows/projects/<project>/`. Older project-local `.pi/workflows/runs` and `.pi/workflows/saved` data is still read as a fallback, but new writes go to the user-level workflow store.

`model-tiers.json` uses Pi CLI-style model parsing. A tier can be a plain model spec or include an optional thinking suffix:

```json
{
  "tiers": {
    "small": "openai-codex/gpt-5.4-mini:low",
    "medium": "openai-codex/gpt-5.4:medium",
    "big": "openai-codex/gpt-5.5:xhigh"
  }
}
```

Use `/workflows-models` to edit these in the TUI: choose the base model first, then choose `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or the session default.

Keyword triggering is disabled when `keywordTriggerEnabled` is missing or `false`. To opt in with a custom term, configure `~/.pi/workflows/settings.json`:

```json
{
  "keywordTriggerEnabled": true,
  "keywordTriggerWord": "pi-workflow"
}
```

The built-in `"workflow"` trigger also matches `"workflows"`. All trigger words are literal, case-insensitive, and word-bounded, with no spaces or leading slash; they do not activate inside paths, slash commands, or identifiers. For example, `"pi-workflow"` does not match `"workflow"`, `"workflows"`, or `"pi-workflows"`.

## Reference

The full guide — every global, agent option, `agentType` definitions, structured output, and determinism — lives on the **[website](https://quintinshaw.github.io/pi-dynamic-workflows/)**. The essentials:

| Global | What it does |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text, or a validated object with `opts.schema`; recoverable failures return `null` with diagnostics in `/workflows`. |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently; results in input order. |
| `pipeline(items, ...stages)` | Fan items through sequential stages `(prev, original, index)`. |
| `phase(title, { budget? })` | Group agents in the live view; optional per-phase token sub-budget. |
| `verify` / `judgePanel` / `loopUntilDry` / `completenessCheck` | Built-in quality patterns. |
| `workflow(name, args)` | Run a saved workflow inline (shares the global caps). |
| `checkpoint(prompt, opts)` | A journaled, replayable human approval gate. |
| `budget` | `{ total, spent(), remaining() }` real-token tracker. |

| Agent option | Description |
| --- | --- |
| `tier` | `"small"` \| `"medium"` \| `"big"` — coarse model routing (configure via `/workflows-models`; tiers may store `provider/modelId:thinking`). |
| `model` | Exact `provider/modelId` or `provider/modelId:thinking` (always wins over `tier`). |
| `agentType` | A named definition (`.pi/agents/<name>.md` project-level, or `~/.pi/agent/agents/<name>.md` user-level — `~/.pi/agents/<name>.md` still works as a deprecated fallback) binding tools + model + role prompt. |
| `isolation: "worktree"` | Run in a throwaway git worktree for conflict-free parallel edits. |
| `schema` | JSON Schema → the subagent returns a validated object. |
| `label` / `phase` / `timeoutMs` | Display label / phase override / optional per-agent hard timeout. Omit `timeoutMs` for no hard timeout. |
| `retries` | Retry attempts after a recoverable failure (timeout, connection failure, empty output) for this agent. Overrides the run-level `agentRetries`. Default `0`. |

By default, workflows do not set a run-wide token budget or per-agent hard timeout. Use the `workflow` tool's `tokenBudget` / `agentTimeoutMs`, per-phase budgets, or per-agent `timeoutMs` only when you want an explicit cap. A global fallback timeout can also be set in `~/.pi/workflows/settings.json` as `{ "defaultAgentTimeoutMs": 600000 }`; set it to `null` or omit it for no default hard timeout.

For larger or flakier fan-outs, Pi may set the `workflow` tool's per-run positive-integer `concurrency` based on independent task count and provider stability. The plugin imposes no hard concurrency cap. If omitted, `defaultConcurrency` from `~/.pi/workflows/settings.json` is used; the runtime fallback is `16`. The selected requested/effective concurrency is persisted and reused on resume. Resize a running or paused run with `workflow_control set_concurrency` or `/workflows concurrency <runId> <n>`. Increasing the limit releases queued agents immediately; decreasing it lets already-running agents finish and starts no replacements until activity falls below the new limit. `concurrency` only limits simultaneous agents; `maxAgents` separately limits the whole-run total (default `1000`), so provider capacity and `maxAgents` remain the practical ceilings.

The tool also accepts `agentRetries` for recoverable failures such as a timeout, connection failure, or empty assistant output. Defaults can be set as `{ "defaultConcurrency": 4, "defaultAgentRetries": 2 }`; a per-run tool value overrides the configured default, and a per-agent `retries` overrides `agentRetries`. Retries default to `0` (off) unless configured or passed, and nonrecoverable errors still abort the run.

By default, each workflow subagent uses a file-backed Pi session under the workflow project's private state directory (`~/.pi/workflows/projects/<project>/agent-sessions/`), named `workflow:<runId> <agent label>`. These child sessions are intentionally outside Pi's standard session directory, so they do not clutter the normal `/resume` picker; the run artifact links each agent to its transcript for workflow-specific analysis and turn-boundary resume. A paused or crash-interrupted agent can reopen its transcript and continue from the last durable assistant-message/tool-result boundary instead of restarting the whole agent. Sessions are keyed by the project cwd, and an isolated agent's worktree is preserved while paused so its coding tools reopen in the same cwd. Set `{ "persistAgentSessions": false }` in `~/.pi/workflows/settings.json` (or a project override) to opt out; interrupted agents then fall back to a fresh session. Large fan-outs create one session file per agent and full transcripts can contain sensitive context. If a saved session is missing, corrupt, or unwritable, only that agent restarts fresh and the fallback is shown in workflow logs/UI.

The live "Workflows running" panel is configured in the same `~/.pi/workflows/settings.json`: `"progressPanelMode"` is `"compact"` (default, one summary per run) or `"detailed"`, and `"progressPanelMaxAgents"` (default `8`, range `1`–`1000`) caps rows per phase. Both views separately show finished agents, `paused mid-run` agents, and queued agents that have `not started`; paused rows say whether a child session was saved or a fresh restart is required. Active labels remain listed as `Running now (N/M)`. Token text prefixed with `~` is an in-progress estimate; exact cumulative usage replaces it at message boundaries and terminal reconciliation. Estimates are display-only and are not persisted or charged to budgets.

When a background run finishes, its result is delivered back into the conversation with a `↳ Full result: <path>` pointer to the persisted `~/.pi/workflows/projects/<project>/runs/<id>.json`, so nothing is lost even when the summary is shortened. Only the JSON-dump fallback (a result object without a `verdict`/`report`/`summary` string field) is truncated — at `"deliveredResultMaxChars"` characters (default `400`) in the same `~/.pi/workflows/settings.json` — and the dropped size is shown inline, e.g. `…(truncated 3.2 KB)`.

Run artifacts are versioned. On Pi restart, completed agents keep their stable identities, status, history, usage, and results; agents that had started are recovered as `paused` with their child-session/worktree checkpoint, while agents that never entered the runner remain `queued`. Runs do not auto-resume. `/workflows resume <id>` or `workflow_control resume` replays completed journal entries, reopens paused child sessions, and starts never-started work fresh with the persisted concurrency, limits, retries, timeout, and token budget. A provider stream cannot resume mid-token, and a tool interrupted before its result was durably recorded is inherently uncertain; the continuation prompt tells the agent to inspect existing state and avoid repeating completed side effects. Older artifacts are migrated defensively, and missing/corrupt child sessions fall back per-agent to a fresh restart.

Workflows run in a Node `vm` sandbox; `Date.now()`, `Math.random()`, `new Date()`, and `require`/`import`/`fs`/network are unavailable, so runs stay reproducible — which is what makes durable replay reliable.

## Default tier assignment

When no `~/.pi/workflows/model-tiers.json` exists, pi-dynamic-workflows builds a default config from the models you have authenticated. The registry returns models grouped by provider, not ranked by capability, so a naive positional spread (`first → small`, `last → big`) can put a mini or flash model in the big slot — or even collapse two tiers onto the same model. To avoid this, `buildDefaultTierConfig` first ranks every available model with a capability score based on well-known substrings: names containing `mini`, `flash`, `haiku`, `nano`, or `small` rank lowest, names containing `opus`, `pro`, `ultra`, `large`, or `plus` rank highest, and everything else ranks neutral (checks are case-insensitive; a name matching both hint sets ranks as small, so it can never outrank a bigger model). Models keep their registry order within the same rank. Tiers are then assigned from this single ranked pool — the least-capable model becomes `small`, the most-capable becomes `big`, and the middle-ranked one becomes `medium` — so distinct tiers never collapse onto the same model and a smaller model can never land in a higher tier than a bigger one. With fewer than 3 distinct models the assignment degrades gracefully: with 2 models the weaker one becomes `small` and the stronger one covers both `medium` and `big`; with 1 (or 0) models every tier resolves to that model (or the current Pi model / empty string as a last resort). You can review or override the assignment at any time with `/workflows-models`.

## Development

```bash
npm install
npm test     # biome + tsc + unit tests
```

Every feature is also verified end-to-end against a real Pi subagent session before release.

## Credits

The "code mode for subagents" idea comes from Michael Livs' original [pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) and Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code). This project builds on it with real model routing, journaled resume, git-worktree isolation, cost accounting, an interactive TUI, and deep research.

## License

MIT — see [LICENSE](LICENSE).
