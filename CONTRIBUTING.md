# Contributing

Thanks for contributing to pi-dynamic-workflows. This project values small, well-tested changes that keep the workflow runtime predictable. A few conventions keep review fast.

## Before you open a PR

```bash
npm install
npm test     # biome check + tsc build + unit tests — must pass
```

`npm test` runs exactly what CI runs. If it's green locally it should be green in CI. CI runs on every PR to `main`; for fork PRs a maintainer approves the first run.

## What a good PR looks like

- **One concern per PR.** Keep a bug fix, a feature, and a refactor in separate PRs. A mixed PR (e.g. a test-infra fix *and* a new runtime feature) is harder to review and to revert; split it if you can.
- **Conventional Commits.** Use `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, etc. The type drives versioning, so it matters: anything that adds or changes public API (new tool params, new settings, new exported options) is a `feat:`, not a `fix:`, even if it's small. Maintainers squash-merge, so the PR title becomes the commit — make it accurate.
- **Backward compatible by default.** New options should be optional with conservative defaults (off unless configured).

## When you add user-facing config

If you add a `workflow` tool parameter or a `~/.pi/workflows/settings.json` setting, document it in `README.md` in the same place the existing ones live (the agent-options table and the settings paragraph). Undocumented config is treated as incomplete.

## When you change runtime behavior

Fake-agent unit tests are necessary but not sufficient. Any change to how agents actually run — retries, timeouts, model routing, token accounting, concurrency, resume — must also be verified **end-to-end against a real Pi subagent session** (real `createAgentSession` → real model), because the real SDK path behaves differently than a mock. If you don't have a real-provider environment, say so in the PR and a maintainer will run it before merge.

A throwaway harness for this should live in the repo root (not `/tmp`, whose symlink breaks relative imports), import from `./src`, and be deleted before commit — don't commit harnesses, credentials, or provider output. Record the provider/model and observed results in the PR instead.

For workflow runtime reliability changes, exercise every affected item in this real-provider checklist:

1. **Safe typing:** Submit ordinary prompts containing `workflow`, `workflows`, mixed case, punctuation, paths, and slash commands. With fresh/default settings, none may rewrite the prompt or emit a forced-tool message. Explicit `/workflows-trigger on` must restore only word-bounded activation.
2. **Autonomous management:** Let Pi start a background run with `workflow`, then have Pi use `workflow_control` to `list`, inspect `status`, `pause`, `resume`, and `stop` it without asking the user to type `/workflows` commands.
3. **Active fleet:** Start 42 independent agents with Pi selecting `concurrency: 8`. Confirm no more than eight run simultaneously, all active labels appear in `Running now (N/8)`, and remaining work is shown as queued.
4. **Live usage:** Run a multi-turn child. Confirm `~N tok` moves during streaming, exact tokens replace the estimate at assistant-message boundaries, and terminal reconciliation remains exact.
5. **Restart/resume:** Interrupt after at least 27 completed calls, restart Pi, and resume the same run. Confirm completed agents retain status and tokens, aggregate usage remains monotonic, no rows duplicate, and the original concurrency/options remain in effect. Repeat with an older run artifact when changing persistence migration.
6. **Human compatibility:** Confirm `/workflows` commands, navigator pause/stop/restart, `q` close, `x` stop, trigger opt-in, saved workflows, and stale-run recovery still work.

## Style

Formatting and linting are handled by Biome (`npm run format`, `npm run lint`). Match the existing code; don't reformat files you aren't otherwise changing.
