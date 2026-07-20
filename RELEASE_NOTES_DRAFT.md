# Release notes draft (working document for the maintainer — not part of the shipped release)

## Highlights

- **Run the 5 built-in patterns by name, no slash command needed.** `deep-research`, `adversarial-review`, `code-review`, `multi-perspective`, and `codebase-audit` are now reachable directly from a natural-language request ("do a deep-research on...", "run a code-review of this PR") instead of only via `/deep-research` and friends. A saved workflow with the same name always wins, on both the slash-command and natural-language paths, so your own `code-review` cleanly shadows the built-in one everywhere. Generated scripts for `codebase-audit` and `multi-perspective` also escape user-supplied text safely, and `codebase-audit`'s scope is no longer silently truncated in the script that actually runs. (#117)
- **A reliability pass across background runs.** Pausing and resuming now preserves the run's original limits (`maxAgents`, `agentTimeoutMs`, `concurrency`, `agentRetries`) instead of quietly reverting to defaults, and token-budget tracking is cumulative across pause/resume so a run can't reset its spend by pausing. Deleting a run now actually stops it instead of letting it keep executing in the background. Long-lived sessions no longer grow memory or disk usage without bound: finished runs are capped at 300 on disk and 20 in memory, oldest evicted first, with no change to how you list or resume older runs. A run-fatal error now stops its in-flight sibling agents instead of letting them keep spending tokens on a run whose outcome is already decided. (#116, #118, #119)

## Fixes

**Resume and caching**
- Nested `workflow()` calls now resume correctly from cache; previously an inner workflow's cached results could silently fail to reuse and everything inside it re-ran on every resume. (#120)
- A failed retry attempt's writes to shared workflow state no longer leak into the eventual successful attempt or get replayed on resume. (#120)
- Checkpoints (`checkpoint()`) now correctly invalidate their cached answer when their options change between runs, not just when the prompt text changes. (#120)
- Two sequential nested workflow calls at the same nesting depth can no longer collide and corrupt each other's history. (#119)

**Background runs and concurrency**
- Concurrent agents that happen to share a display label no longer have their progress or results attributed to the wrong one. (#119)
- A workflow script that forgets to `await` an `agent()` call can no longer let the run finish while that agent is still executing in the background. (#119)
- Resuming a run no longer reverts its per-run limits to defaults, and no longer resets its recorded token spend. (#116)
- Stopping or deleting a run can no longer be clobbered by a stale, already-superseded execution racing to write its own state afterward. (#116)

**Stability and error handling**
- The `/workflows` navigator no longer crashes on corrupted on-disk run data, disk permission errors, or a stale lock — every action now surfaces a clear message instead. (#115)
- Passing a malformed result schema to `agent()` now fails fast with a clear validation error instead of a confusing provider-side transport error. (#115)
- Hardened model-tier configuration validation so a degenerate configuration (e.g. from "reset to defaults" with no models available) can no longer be silently written and then discarded on the next load. (#115)
- Saved workflows are now written atomically with backup/recovery, matching the run-persistence layer, and a missing or unreadable saved-workflows directory now degrades to an empty list instead of throwing. (#118)

**Memory**
- Subagent sessions are now explicitly aborted on timeout so a retry can no longer stack a second live session in the background, and finished sessions are reliably torn down instead of lingering. (#114)

## New

- **Self-documenting workflow capabilities.** The full set of orchestration primitives (`agent`, `parallel`, `pipeline`, `verify`, `judgePanel`, and more) and their options is now generated directly from the runtime contract and kept in sync across the README, the packaged skill, and the docs site — so the reference you read always matches what's actually callable. Contributed by the community. (#100)

## Upgrade notes

- **Subagents no longer load host extensions by default.** This closes a memory-leak source where every subagent session re-ran every installed extension's startup code. Skills, prompts, and `AGENTS.md` context still load, and the tools you explicitly hand a subagent (coding tools, `web-research`, etc.) are unaffected. What a subagent loses is any tool that comes from another installed extension — MCP bridges, browser tools, and similar. If you configured an `agentType` whose tool allowlist names one of those, that entry will now match nothing; check for that if a subagent behaves as if it's missing a tool it used to have.
- **Checkpoints cached before this release will re-prompt once.** The change that makes `checkpoint()` correctly track its options as part of its cache identity means any checkpoint answer cached under the old logic is treated as stale exactly one time. After that first re-prompt, caching resumes normally.
- No action needed for everything else in this release — run-limit/resume behavior, run retention, and navigator hardening are all backward compatible.
