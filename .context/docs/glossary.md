---
type: doc
name: glossary
description: Domain terms, acronyms and project vocabulary
generated: 2026-06-09
status: generated
---

# Glossary

## Terms

- **PREVC** — Planejar, Revisar, Executar, Validar, Confirmar workflow used for non-trivial changes.
- **Feedforward** — repository context injected before work starts so the agent acts with local knowledge.
- **dotcontext** — AICoders Context command family that generates and loads the .context knowledge base.
- **Guardrails** — extension rules that block or ask permission for sensitive paths and commands.
- **Pi package** — package.json manifest with pi.extensions and/or pi.themes loaded by the pi coding agent.
- **/adversarial-review** — slash command in `src/builtin-commands.ts`. Investigate a task, then cross-check each finding with skeptical reviewers
- **/deep-research** — slash command in `src/builtin-commands.ts`. Research a question across the web with cross-checked sources
- **/effort** — slash command in `src/effort-command.ts`. Standing workflow effort: off | high | ultra — auto-arms a workflow for substantive messages
- **/ultracode** — slash command in `src/effort-command.ts`. Ultracode: standing maximal-effort mode — auto-arms an exhaustive workflow for substantive messages. /ultracode off to stop.
- **/workflows** — slash command in `src/workflow-commands.ts`. Manage workflow runs — no args (opens navigator) | status/stop/pause/resume <id> | rm <id> | save <name> [runId]
- **/workflows-models** — slash command in `src/workflows-models-command.ts`. View and edit model tiers used by workflows (small/medium/big)
