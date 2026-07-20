# gh-pages site changes needed for this release

Reference checkout used: `origin/gh-pages` (single hand-authored page, `index.html`, currently at
`softwareVersion: "3.2.0"` per its JSON-LD block at line 36 — the site has not been bumped for the
3.2.1/3.2.2 patch releases either). The gh-pages branch was **not** modified; this is a punch list for
whoever edits it at release time.

## 1. Version pill

`index.html` line 36:

```json
"softwareVersion": "3.2.0",
```

This is the only version string on the page (there is no visible on-page version badge — just this
JSON-LD field). Bump it to the actual release version once that number is decided; value TBD, not this
task's call.

## 2. New feature: built-in patterns callable by name (#117)

Section `#builtins` ("Ready-made workflows", around lines 470-486) currently reads:

> "The package ships with commands for research, review, multi-perspective analysis, and exhaustive
> codebase checks."

with a `builtin-grid` of only 4 cards: `/deep-research`, `/adversarial-review`, `/code-review`,
`/ultracode`. Two edits:

- **Add one sentence** (either in the section copy or as a new small callout) saying these patterns no
  longer require the slash command — a plain-language request like "run a deep-research on X" now
  reaches the same curated pattern directly, and a user's own saved workflow of the same name always
  wins. This is the single most user-visible change in the release and the site currently has no mention
  of it.
- **Pre-existing gap, not caused by this release but worth fixing while touching this section:** the grid
  is missing `/multi-perspective` and `/codebase-audit` entirely — only 4 of the 5 built-in patterns are
  represented. Since the copy text already says "multi-perspective analysis, and exhaustive codebase
  checks" without corresponding cards, this reads as a stale/incomplete grid. Recommend adding the two
  missing `article.builtin` cards (matching the existing markup pattern, e.g. icon letter + name + one-line
  description) so all 5 are shown.

## 3. Reliability overhaul (#116, #118, #119, #120) — optional light-touch mention

The site does not go into resume/persistence depth the way the README does, so a full rewrite isn't
warranted. The one spot that touches this territory is the "Resume without paying twice" feature card
(`#features`, around line 445):

> "Finished calls replay from the journal. Only the changed call and everything after it run again."

This claim is now more true than before (nested `workflow()` calls previously could silently fail to
resume from cache; fixed in #120) — the existing copy is accurate and doesn't need a rewrite, but if the
maintainer wants to signal the reliability work, a short addition like "including nested workflows" would
be accurate and cheap. Not required.

No other feature card, FAQ entry, or command-cloud text makes a claim this release changes, so nothing
else needs editing for correctness.

## 4. Not touched / out of scope

- `#reference` section's command cloud and FAQ list are unaffected by this release's changes (no new
  slash commands shipped) and were left out of this punch list, though note it's already missing
  `/workflows save`, `/workflows status`, `/workflows pause|resume|stop`, and any mention of the
  `workflow_control` tool — a pre-existing gap versus the README, not something introduced by this
  release.
- `demo.mp4` / `demo-poster.jpg` — no change needed unless the maintainer wants a refreshed recording;
  not part of this release's scope.
