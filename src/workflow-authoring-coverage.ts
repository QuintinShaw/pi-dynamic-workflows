import {
  CapabilityClassification,
  CapabilitySupport,
  DiscoveryPlacement,
  WorkflowAuthoringProtection,
} from "./enums.js";
import { WORKFLOW_CAPABILITY_DEFINITION } from "./workflow-capability-contract.js";
import { COMPREHENSION_SCENARIOS } from "./workflow-comprehension.js";

/** Exact installed guidance location retained for an authoring surface without model evidence. */
export interface ProtectedGuidanceSurface {
  path: string;
  anchor?: string;
  requiredText?: string;
}

/** Evidence and optimization policy for one stable workflow authoring surface. */
export interface WorkflowAuthoringCoverageEntry {
  id: string;
  kind: string;
  reference: { path: string; anchor?: string };
  example?: string;
  behaviorEvidence: readonly string[];
  comprehensionScenarios: readonly string[];
  protection: WorkflowAuthoringProtection;
  protectedGuidance: readonly ProtectedGuidanceSurface[];
}

/** Scenario identifiers that release checks may accept as provider-backed evidence. */
export const WORKFLOW_COMPREHENSION_SCENARIO_IDS = COMPREHENSION_SCENARIOS.map(({ id }) => id);

/** Mixed guidance files that require explicit acceptance while behavioral coverage remains partial. */
export const WORKFLOW_AUTHORING_FROZEN_FILES = [
  {
    path: "skills/workflow-authoring/SKILL.md",
    sha256: "d2843c4d928b6f622271c65bf4cf5d54cb219efca0ce92d8c5f4d8204365bf91",
  },
  {
    path: "skills/workflow-authoring/references/runtime.md",
    sha256: "14f1c4496c523d2e37316a7c96041a22630a65d342d08fdd77aeca2d325e22a3",
  },
  {
    path: "skills/workflow-authoring/references/helpers.md",
    sha256: "1c8d253649f00412511f17ffc08c6156797b99de72ae037e14f2ea92ac33a11e",
  },
  {
    path: "skills/workflow-authoring/references/specialized-helpers.md",
    sha256: "7597c94bbacea885697fb2d05a96ed9ec39403ca6d3a94547bf8ce5e233b2c76",
  },
  {
    path: "skills/workflow-authoring/references/lifecycle.md",
    sha256: "e2f187a7b633beef0ca257e6782f72a140fc06b37a58aac423432d36d1dc19ee",
  },
  {
    path: "skills/workflow-authoring/references/pattern-selection.md",
    sha256: "923988a1b4d506a7b330bf5e4b8ab47cf8456edcfe6674b5d8d8848264633c3d",
  },
  {
    path: "skills/workflow-authoring/references/focused-recipes.md",
    sha256: "30906054232f67029e31f71b3b093f9949f6de9116e4381f433009c401f2c5c7",
  },
  {
    path: "skills/workflow-authoring/references/registry-ownership.md",
    sha256: "daf324448be16732c6796fd6359d1b1b842fa550ed616a6154f556d6ec1ef0b9",
  },
  {
    path: "skills/workflow-authoring/references/review.md",
    sha256: "2bd97acb87a8f6e9514892cdf5c431305b3d8952ba9761c1c203c217b08c9e7d",
  },
  {
    path: "skills/workflow-authoring/references/debugging.md",
    sha256: "2938e635f5856f2934e42c9cc3b7035a66d53176f4ab2beadfeabb9abf42e6cc",
  },
  {
    path: "skills/workflow-authoring/examples/classify-and-act.js",
    sha256: "23d0d9f37ee8648cd29ca526b0b23cf55bd3ac57efd02e1b93e227bcd0c18603",
  },
  {
    path: "skills/workflow-authoring/examples/tournament.js",
    sha256: "3a90bd3055c5e38e13fd8d7447173fc2e6a141fbc33b9bcc8a84723b7ab9d2e6",
  },
  {
    path: "skills/workflow-authoring/examples/validated-gate.js",
    sha256: "1cb4b3941ae61ebd1e12ada899f7d04678fe858a307c7fabc408603a4b9ba889",
  },
] as const;

const RUNTIME_PATH = "skills/workflow-authoring/references/runtime.md";
const SPECIALIZED_HELPERS_PATH = "skills/workflow-authoring/references/specialized-helpers.md";
const LIFECYCLE_PATH = "skills/workflow-authoring/references/lifecycle.md";
const PATTERN_PATH = "skills/workflow-authoring/references/pattern-selection.md";
const RECIPE_PATH = "skills/workflow-authoring/references/focused-recipes.md";
const SKILL_PATH = "skills/workflow-authoring/SKILL.md";
const WRITE_EDIT_ROUTE: ProtectedGuidanceSurface = {
  path: SKILL_PATH,
  requiredText:
    "- **Write or edit:** start with [runtime](references/runtime.md). Add [pattern selection](references/pattern-selection.md) for topology, [lifecycle](references/lifecycle.md) for limits or resume, and [focused recipes](references/focused-recipes.md) for the matching concern.",
};
const HELPER_ROUTE: ProtectedGuidanceSurface = {
  path: SKILL_PATH,
  requiredText:
    "- **Helper task:** read [quality helpers](references/quality-helpers.md) only for `verify` or `judgePanel`, the [retry helper](references/retry-helper.md) only for `retry`, and [specialized helpers](references/specialized-helpers.md) only for `completenessCheck`, `loopUntilDry`, `gate`, or `checkpoint`.",
};
const ROUTING_ROUTE: ProtectedGuidanceSurface = {
  path: SKILL_PATH,
  requiredText:
    "- **Routing:** read [registry ownership](references/registry-ownership.md) before using `model`, `tier`, phase models, or `agentType`; use environment-specific names only when context supplies them.",
};

const CAPABILITY_SCENARIOS: Readonly<Record<string, readonly string[]>> = {
  "workflow.runtime.agent": WORKFLOW_COMPREHENSION_SCENARIO_IDS,
  "workflow.runtime.parallel": [
    "quick-write",
    "full-write",
    "coverage-fan-out-synthesize",
    "coverage-generate-filter",
    "coverage-judge-panel",
  ],
  "workflow.runtime.workflow": ["full-edit"],
  "workflow.runtime.verify": ["full-review"],
  "workflow.runtime.judgePanel": ["coverage-judge-panel"],
  "workflow.runtime.retry": ["full-retry"],
  "workflow.runtime.phase": ["full-edit"],
  "workflow.script.metadata": WORKFLOW_COMPREHENSION_SCENARIO_IDS,
  "workflow.script.return-value": WORKFLOW_COMPREHENSION_SCENARIO_IDS,
};

const FROZEN_GUIDANCE_BY_CAPABILITY: Readonly<Record<string, readonly ProtectedGuidanceSurface[]>> = {
  "workflow.runtime.pipeline": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "`pipeline()` runs stages sequentially per item while items proceed concurrently. Each stage receives `(previousValue, originalItem, index)` and forwards `null` to the next stage, so guard missing coverage first.",
    },
  ],
  "workflow.runtime.loopUntilDry": [
    {
      path: SPECIALIZED_HELPERS_PATH,
      requiredText:
        "`loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` | `round(index)` is zero-based. Defaults: `JSON.stringify` key, two dry rounds, 50 rounds. Null, non-array, and duplicate-only rounds are dry. Token-budget or agent-limit exhaustion returns the partial array without a termination reason; keep failed-round identity and stopping state outside the helper.",
    },
  ],
  "workflow.runtime.completenessCheck": [
    {
      path: SPECIALIZED_HELPERS_PATH,
      requiredText:
        "`completenessCheck(args, results)` | Returns `{ complete, missing? }` or recoverable `null`. The critic sees only the first 4,000 serialized characters, so chunk or summarize larger evidence. Treat the verdict as advisory.",
    },
  ],
  "workflow.runtime.gate": [
    {
      path: SPECIALIZED_HELPERS_PATH,
      requiredText:
        "`gate(thunk, validator, { attempts })` | Calls `thunk(feedback, attempt)` with initial `undefined` feedback and a zero-based attempt. `validator(value)` returns `{ ok, feedback? }`, synchronously or asynchronously; a bare boolean is not accepted. Three attempts by default. Returns `{ ok, value, attempts }`, including the last value on exhaustion.",
    },
  ],
  "workflow.runtime.checkpoint": [
    {
      path: SPECIALIZED_HELPERS_PATH,
      requiredText:
        "`checkpoint(prompt, options?)` | Journals a human/default decision. Only foreground confirm and documented headless behavior work; input, select, and timeout are declared-only.",
    },
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "A workflow invocation is backgrounded by default, and background workflows are headless: they cannot display checkpoint confirmation.",
    },
  ],
  "workflow.runtime.log": [
    { path: SKILL_PATH, requiredText: "Use `log()` for new code; `console` is compatibility-only." },
  ],
  "workflow.runtime.args": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "The runtime supplies `agent`, `parallel`, `pipeline`, `workflow`, quality/control helpers, `phase`, `log`, `args`, `cwd`, restricted `process.cwd()`, and `budget`.",
    },
  ],
  "workflow.runtime.cwd": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "The runtime supplies `agent`, `parallel`, `pipeline`, `workflow`, quality/control helpers, `phase`, `log`, `args`, `cwd`, restricted `process.cwd()`, and `budget`.",
    },
  ],
  "workflow.runtime.process": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "The runtime supplies `agent`, `parallel`, `pipeline`, `workflow`, quality/control helpers, `phase`, `log`, `args`, `cwd`, restricted `process.cwd()`, and `budget`.",
    },
  ],
  "workflow.runtime.budget": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "Token and phase budgets are soft pre-call gates. Spend lands after agents finish, so concurrent work can overshoot.",
    },
  ],
  "workflow.runtime.console": [
    { path: SKILL_PATH, requiredText: "Use `log()` for new code; `console` is compatibility-only." },
  ],
  "workflow.tool-input.script": [{ path: RUNTIME_PATH, anchor: "script-envelope" }],
  "workflow.tool-input.args": [
    {
      path: LIFECYCLE_PATH,
      requiredText: "Pass timestamps, randomness, and external decisions through `args`.",
    },
  ],
  "workflow.tool-input.background": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "A workflow invocation is backgrounded by default, and background workflows are headless: they cannot display checkpoint confirmation.",
    },
  ],
  "workflow.tool-input.maxAgents": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "Set finite bounds that match the work: `maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, and `tokenBudget` at invocation time; loop and semantic-retry bounds inside the script.",
    },
  ],
  "workflow.tool-input.concurrency": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "Set finite bounds that match the work: `maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, and `tokenBudget` at invocation time; loop and semantic-retry bounds inside the script.",
    },
  ],
  "workflow.tool-input.agentRetries": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "Set finite bounds that match the work: `maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, and `tokenBudget` at invocation time; loop and semantic-retry bounds inside the script.",
    },
  ],
  "workflow.tool-input.agentTimeoutMs": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "Set finite bounds that match the work: `maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, and `tokenBudget` at invocation time; loop and semantic-retry bounds inside the script.",
    },
  ],
  "workflow.tool-input.tokenBudget": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "Token and phase budgets are soft pre-call gates. Spend lands after agents finish, so concurrent work can overshoot.",
    },
  ],
  "workflow.tool-input.resumeFromRunId": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "Resume replays only the longest unchanged prefix of journaled calls. Once one call is new, changed, or unusable, that call and all later calls execute live.",
    },
  ],
  "workflow.script.determinism": [
    {
      path: SKILL_PATH,
      requiredText:
        "Write plain JavaScript without imports or filesystem modules. Pass nondeterminism through `args`; `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable.",
    },
  ],
  "workflow.compat.markdown-fences": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "Generated entries marked `supported` are authoring API. `console` and whole-script Markdown fences are compatibility-only.",
    },
  ],
  "workflow.dynamic.model-routes": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "Use exact `model`, nonstandard `tier`, or `agentType` only when context supplies its name and purpose.",
    },
  ],
  "workflow.dynamic.agent-types": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "Use exact `model`, nonstandard `tier`, or `agentType` only when context supplies its name and purpose.",
    },
  ],
};

/** Stable orchestration-pattern identifiers covered by the authoring inventory. */
export const WORKFLOW_AUTHORING_PATTERN_IDS = [
  "workflow.pattern.classify-and-act",
  "workflow.pattern.fan-out-and-synthesize",
  "workflow.pattern.adversarial-verification",
  "workflow.pattern.generate-and-filter",
  "workflow.pattern.tournament",
  "workflow.pattern.loop-until-done",
] as const;

/** Stable focused-recipe identifiers covered by the authoring inventory. */
export const WORKFLOW_AUTHORING_RECIPE_IDS = [
  "workflow.recipe.phased-budgets",
  "workflow.recipe.saved-nested-workflows",
  "workflow.recipe.bounded-semantic-retry",
  "workflow.recipe.validator-feedback",
  "workflow.recipe.structured-output",
] as const;

const PATTERN_COVERAGE: readonly WorkflowAuthoringCoverageEntry[] = [
  {
    id: "workflow.pattern.classify-and-act",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/classify-and-act.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts"],
    comprehensionScenarios: [],
    protection: WorkflowAuthoringProtection.GUIDANCE_FROZEN,
    protectedGuidance: [
      WRITE_EDIT_ROUTE,
      {
        path: PATTERN_PATH,
        requiredText:
          "| Heterogeneous items need different handling | Classify and act | Finish all classification before routed action; ledger classification and action failures by item ID | [Adapt](../examples/classify-and-act.js) |",
      },
    ],
  },
  {
    id: "workflow.pattern.fan-out-and-synthesize",
    kind: "pattern",
    reference: { path: PATTERN_PATH, anchor: "fan-out-and-synthesize" },
    example: "skills/workflow-authoring/examples/fan-out-and-synthesize.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["coverage-fan-out-synthesize"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.pattern.adversarial-verification",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/adversarial-verification.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-review"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.pattern.generate-and-filter",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/generate-and-filter.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["coverage-generate-filter"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.pattern.tournament",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/tournament.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts"],
    comprehensionScenarios: [],
    protection: WorkflowAuthoringProtection.GUIDANCE_FROZEN,
    protectedGuidance: [
      WRITE_EDIT_ROUTE,
      {
        path: PATTERN_PATH,
        requiredText:
          "| Pairwise comparison beats absolute scoring | Tournament | Let JavaScript run the bounded bracket and byes; agents compare one pair; ledger match failures | [Adapt](../examples/tournament.js) |",
      },
    ],
  },
  {
    id: "workflow.pattern.loop-until-done",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/loop-until-done.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-loop"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
];

const RECIPE_COVERAGE: readonly WorkflowAuthoringCoverageEntry[] = [
  {
    id: "workflow.recipe.phased-budgets",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/phased-budgets.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-edit"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.recipe.saved-nested-workflows",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/saved-nested-workflows.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-edit"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.recipe.bounded-semantic-retry",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/bounded-semantic-retry.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-retry"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.recipe.validator-feedback",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/validated-gate.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts"],
    comprehensionScenarios: [],
    protection: WorkflowAuthoringProtection.GUIDANCE_FROZEN,
    protectedGuidance: [
      WRITE_EDIT_ROUTE,
      {
        path: RECIPE_PATH,
        requiredText:
          "| Validator feedback | Follow the exact `gate()` callbacks in [specialized helpers](specialized-helpers.md). Return the gate outcome and attempt ledger so feedback and exhaustion remain visible. | [Validated gate](../examples/validated-gate.js) |",
      },
    ],
  },
  {
    id: "workflow.recipe.structured-output",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/structured-output.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-write", "full-debug", "full-loop", "full-retry"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
];

const HELPER_CAPABILITY_IDS = new Set([
  "workflow.runtime.verify",
  "workflow.runtime.judgePanel",
  "workflow.runtime.completenessCheck",
  "workflow.runtime.loopUntilDry",
  "workflow.runtime.retry",
  "workflow.runtime.gate",
  "workflow.runtime.checkpoint",
]);

const CONTRACT_COVERAGE: readonly WorkflowAuthoringCoverageEntry[] = WORKFLOW_CAPABILITY_DEFINITION.capabilities
  .filter(({ discovery, support }) => discovery !== DiscoveryPlacement.NONE && support !== CapabilitySupport.INTERNAL)
  .map((capability) => {
    const comprehensionScenarios = CAPABILITY_SCENARIOS[capability.id] ?? [];
    const frozenGuidance = FROZEN_GUIDANCE_BY_CAPABILITY[capability.id] ?? [];
    const route =
      capability.classification === CapabilityClassification.DYNAMIC_REFERENCE
        ? ROUTING_ROUTE
        : HELPER_CAPABILITY_IDS.has(capability.id)
          ? HELPER_ROUTE
          : WRITE_EDIT_ROUTE;
    const protectedGuidance = comprehensionScenarios.length > 0 ? [] : [...frozenGuidance, route];
    return {
      id: capability.id,
      kind: capability.classification,
      reference: capability.staticReference ?? { path: "skills/workflow-authoring/references/capabilities.md" },
      behaviorEvidence: capability.behaviorEvidence,
      comprehensionScenarios,
      protection:
        comprehensionScenarios.length > 0
          ? WorkflowAuthoringProtection.BEHAVIORALLY_COVERED
          : WorkflowAuthoringProtection.GUIDANCE_FROZEN,
      protectedGuidance,
    };
  });

/** Complete release-gated inventory of behavioral coverage and frozen authoring guidance. */
export const WORKFLOW_AUTHORING_COVERAGE: readonly WorkflowAuthoringCoverageEntry[] = [
  ...CONTRACT_COVERAGE,
  ...PATTERN_COVERAGE,
  ...RECIPE_COVERAGE,
];
