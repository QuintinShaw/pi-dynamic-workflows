# Contributing

Thanks for contributing to pi-dynamic-workflows. This project values small, well-tested changes that keep the workflow runtime predictable. A few conventions keep review fast.

## Before you open a PR

```bash
npm install
npm test     # Biome, TypeScript, unit tests, and release checks — must pass
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

A throwaway harness for this should live in the repo root (not `/tmp`, whose symlink breaks relative imports), import from `./src`, and be deleted before commit — don't commit harnesses.

## Protected workflow-authoring guidance

The goal is to keep workflow guidance accurate as the runtime changes without bloating the context sent to every model. Stable capability facts come from the executable capability contract and generated documentation. Detailed authoring guidance lives in the on-demand `workflow-authoring` skill instead of the permanent prompt. Context checks keep these surfaces from growing unnoticed.

Some files under `skills/workflow-authoring/` contain mixed or partially behavior-covered guidance. Their full-file SHA-256 hashes in `WORKFLOW_AUTHORING_FROZEN_FILES` (`src/workflow-authoring-coverage.ts`) are explicit review checkpoints, not proof that the wording is correct.

If `PROTECTED_GUIDANCE_DRIFT` reports an accidental change, revert it. For housekeeping such as a typo, link, formatting, or version update, deterministic checks and review are enough. For a semantic guidance change, inspect the affected coverage manifest entry, update relevant behavioral tests, and review provider evidence when needed. Required anchors and required text in the manifest may also need deliberate updates.

After that review, explicitly accept each changed frozen file:

```bash
npm run guidance:accept -- skills/workflow-authoring/path/to/file
```

The command updates only explicitly named frozen files and prints each old and new hash for review. It does not update protected anchors or required text. `npm run guidance:generate` refreshes only the non-contractual prose baseline; it does not update protected hashes. Validate the accepted change with exactly:

```bash
npm run docs:check
npm run context:check
npm run guidance:check
npm run release:verify
```

## Style

Formatting and linting are handled by Biome (`npm run format`, `npm run lint`). Match the existing code; don't reformat files you aren't otherwise changing.
