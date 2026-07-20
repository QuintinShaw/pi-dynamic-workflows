# Workflow review checklist

Review author-visible behavior, not formatting preferences. When behavior depends on a quality or control combinator, consult only its exact [quality](quality-helpers.md) or [specialized](specialized-helpers.md) helper contract before correcting the script.

## Envelope and contract

- Is literal `export const meta` the first statement, with a short unique name and useful description?
- Are only used phases declared, and does each named phase begin at the intended boundary?
- Does the script call at least one agent and explicitly return JSON-serializable data?
- Are imports and nondeterministic APIs absent?

## Topology and identity

- Does topology match dependencies: thunks for independent parallel work, stages for per-item pipelines, barriers before whole-set synthesis?
- Is cardinality bounded before fan-out?
- Is every agent label short and unique?
- Are stable work-unit IDs retained beside ordered results?
- Are failed/null identities recorded before any filtering?

## Data and routing

- Does JavaScript consume structured fields only after a small plain JSON Schema guarantees them?
- Does synthesis receive complete coverage and failure ledgers?
- Are `model`, `tier`, and `agentType` used according to selector priority?
- Did every nonstandard route or agent type come from context with a name and purpose?

## Lifecycle

- Are runtime retries and semantic retries separately bounded?
- Are loops, agents, concurrency, timeout, and token spend bounded appropriately?
- Are budget claims honest about soft gates and in-flight overshoot?
- Are checkpoints limited to implemented confirmation/headless behavior?
- Does nesting stay one level and account for shared limits/store?
- Would lexical call order remain stable under resume?

## Compatibility and publication

- Does new code use `log()` rather than compatibility-only `console`?
- Is compatibility behavior clearly distinguished from supported authoring behavior and VM substrate?
- Do package, skill, and generated contract versions match?
- Do all relative links resolve within the publishable package?

Use [lifecycle](lifecycle.md) for lifecycle reasoning. Open the compact [capability index](capabilities.md) only when the review turns on a disputed signature, default, support boundary, or installed version; follow its exhaustive-facts pointer only when the index is insufficient.
