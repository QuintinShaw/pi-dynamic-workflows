import { setImmediate as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { AgentRunOptions } from "./agent.js";
import { ComprehensionSuite, ComprehensionTaskKind } from "./enums.js";
import { ModelGenerationError, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRuntimeEvent } from "./workflow.js";

/** Re-exported scenario groups and authoring operations used by the optional comprehension CLI. */
export { ComprehensionSuite, ComprehensionTaskKind } from "./enums.js";

/** Prompt and expected authoring branch for one optional model scenario. */
export interface ComprehensionScenario {
  id: string;
  suite: ComprehensionSuite;
  kind: ComprehensionTaskKind;
  prompt: string;
}

const ENVELOPE =
  "Return one complete plain-JavaScript workflow. It must start with export const meta, call agent() at least once, use unique labels, and explicitly return JSON-serializable data. Do not use imports.";

/** Stable quick, core, and coverage scenarios available to provider and replay runs. */
export const COMPREHENSION_SCENARIOS: readonly ComprehensionScenario[] = [
  {
    id: "quick-write",
    suite: ComprehensionSuite.QUICK,
    kind: ComprehensionTaskKind.WRITE,
    prompt: `${ENVELOPE}\nWrite a small workflow that asks two independent agents to summarize alpha and beta concurrently, then returns both labeled results. Consult any installed skill that applies before authoring.`,
  },
  {
    id: "full-write",
    suite: ComprehensionSuite.FULL,
    kind: ComprehensionTaskKind.WRITE,
    prompt: `${ENVELOPE}\nWrite a fan-out workflow for work units alpha and beta. Use common authoring with parallel calls and require structured output from each agent before JavaScript reads fields. The deterministic beta agent may fail, so return completed data and a missing-work ledger that preserves beta by identity. Consult any installed skill that applies.`,
  },
  {
    id: "full-edit",
    suite: ComprehensionSuite.FULL,
    kind: ComprehensionTaskKind.EDIT,
    prompt: `${ENVELOPE}\nEdit the workflow below. It must declare and enter a phase with a positive phase budget, ask one preparation agent, then invoke the saved workflow named child-workflow sequentially for alpha and beta with workflow( and return both child results. Consult any installed skill that applies.\n\nCurrent workflow:\nexport const meta = { name: "nested", description: "broken" }\nreturn await workflow("child-workflow", { id: "alpha" })`,
  },
  {
    id: "full-review",
    suite: ComprehensionSuite.FULL,
    kind: ComprehensionTaskKind.REVIEW,
    prompt: `${ENVELOPE}\nReview and correct the workflow below. The corrected workflow must adversarially verify an agent-produced claim with exactly three reviewers, an inclusive threshold of 0.6, and source/logic lenses cycled across reviewers. One deterministic reviewer may fail. Return the claim plus the helper's complete verdict unchanged so successful-vote counts and missing review coverage remain visible. Consult any installed skill that applies.\n\nCurrent workflow:\nexport const meta = { name: "review", description: "broken" }\nconst claim = await agent("claim")\nreturn claim`,
  },
  {
    id: "full-debug",
    suite: ComprehensionSuite.FULL,
    kind: ComprehensionTaskKind.DEBUG,
    prompt: `${ENVELOPE}\nDebug and correct the workflow below. Use a bounded control helper (retry or gate), with at most three attempts. Require structured agent output with the fields acceptable (boolean) and answer (string), retry when acceptable is false, and return the accepted agent result plus attempt outcome. The deterministic first result is unacceptable and the next is acceptable. Consult any installed skill that applies.\n\nCurrent workflow:\nexport const meta = { name: "debug", description: "broken" }\nwhile (true) await agent("try")`,
  },
  {
    id: "full-loop",
    suite: ComprehensionSuite.FULL,
    kind: ComprehensionTaskKind.WRITE,
    prompt: `${ENVELOPE}\nWrite a bounded discovery workflow that stops after two consecutive successful dry rounds, with at most five rounds. Each round must call one uniquely labeled agent with structured output containing a findings array of { id, evidence }. The deterministic agent responses provide one alpha finding, then a recoverable failure, then two empty successes. Derive findings, failures, and stopping state from the actual agent return values; do not hard-code the announced sequence. A failed round must not count as dry. Return deduplicated findings, failed-round identity, a truthful termination reason, and complete: false whenever any round failed. Consult any installed skill that applies.`,
  },
  {
    id: "full-retry",
    suite: ComprehensionSuite.FULL,
    kind: ComprehensionTaskKind.DEBUG,
    prompt: `${ENVELOPE}\nWrite a workflow using retry() with at most three total attempts. The thunk receives a zero-based attempt index and must call one uniquely labeled structured agent per attempt for { acceptable: boolean, answer: string }. Use a synchronous null-safe acceptance predicate. The deterministic first result is unacceptable and the second is acceptable. Return the accepted agent result, an explicit exhausted boolean, and a ledger containing every attempt result. Consult any installed skill that applies.`,
  },
  {
    id: "coverage-fan-out-synthesize",
    suite: ComprehensionSuite.COVERAGE,
    kind: ComprehensionTaskKind.WRITE,
    prompt: `${ENVELOPE}\nWrite a fan-out-and-synthesize workflow for two independent research briefs identified as climate and transport. Run both structured research agents concurrently and wait for the complete result set before synthesis. The deterministic transport agent may fail recoverably. Then call exactly one structured synthesis agent with both intended brief identities, the actual climate result, and transport represented as missing rather than omitted. Return the contributor coverage ledger and the actual synthesis result. Consult any installed skill that applies.`,
  },
  {
    id: "coverage-generate-filter",
    suite: ComprehensionSuite.COVERAGE,
    kind: ComprehensionTaskKind.WRITE,
    prompt: `${ENVELOPE}\nWrite a generate-and-filter workflow. Run exactly two structured generator agents concurrently; each returns candidate objects with id and proposal fields, and the deterministic outputs contain one duplicate id. After all generation finishes, use JavaScript to deduplicate by id and cap the retained set at three before calling one uniquely labeled structured filter agent per retained candidate. Return the actual generator outputs, retained candidate identities, accepted filter results, and any filter failures. Consult any installed skill that applies.`,
  },
  {
    id: "coverage-judge-panel",
    suite: ComprehensionSuite.COVERAGE,
    kind: ComprehensionTaskKind.REVIEW,
    prompt: `${ENVELOPE}\nWrite a workflow that produces exactly two structured candidate attempts concurrently, then passes the actual attempts to judgePanel() with exactly three judges and a concrete correctness rubric. One deterministic judgment may fail recoverably. Return both produced attempts and the helper's winning result unchanged, including its index, attempt, mean score, and surviving judgments. Consult any installed skill that applies.`,
  },
];

/** Skill discovery and read calls observed while the parent model authored a workflow. */
export interface SkillLoadingEvidence {
  discovered: boolean;
  loaded: boolean;
  toolCalls: Array<{ tool: string; path?: string }>;
}

/** Provider-reported usage attached to one generated workflow. */
export interface ComprehensionTokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Workflow source and generation evidence supplied to the deterministic replay seam. */
export interface ModelGeneration {
  workflow: string;
  skillLoadingEvidence: SkillLoadingEvidence;
  tokenUsage: ComprehensionTokenUsage;
}

/** Re-exported generation failure that retains loading and usage evidence. */
export { ModelGenerationError } from "./errors.js";

interface RuntimeCall {
  index: number;
  completedIndex: number | null;
  label: string;
  prompt: string;
  phase: string | null;
  structured: boolean;
  scenarioRole: "generator" | "filter" | null;
  status: "returned" | "null";
  result: unknown;
}

type RuntimeEvent = WorkflowRuntimeEvent & { index: number };

interface ScenarioFixtureState {
  attempt: number;
}

interface GeneratorFixtureValue {
  value: unknown;
  consumed: number;
}

interface ScenarioAgentRequest {
  prompt: string;
  label: string;
  schema: unknown;
}

type ScenarioAgentResponse = { status: "returned"; result: unknown } | { status: "null"; message: string };

type ScenarioAgentFixture = (request: ScenarioAgentRequest, state: ScenarioFixtureState) => ScenarioAgentResponse;

const ordinaryAgentFixture: ScenarioAgentFixture = ({ prompt, label, schema }) => ({
  status: "returned",
  result: schema ? sampleSchema(schema, label || "agent") : `result:${label || prompt}`,
});

function resolveWriteTaskIdentity(label: string, prompt: string): string | undefined {
  return resolveIdentity(label, prompt, ["alpha", "beta"]);
}

function resolveIdentity(label: string, prompt: string, identities: readonly string[]): string | undefined {
  const labelIdentities = identities.filter((identity) => new RegExp(`\\b${identity}\\b`, "i").test(label));
  if (labelIdentities.length === 1) {
    return labelIdentities[0];
  }
  return identities
    .map((identity) => ({ identity, position: prompt.search(new RegExp(`\\b${identity}\\b`, "i")) }))
    .filter(({ position }) => position >= 0)
    .sort((left, right) => left.position - right.position)[0]?.identity;
}

function resolveExclusiveIdentity(label: string, prompt: string, identities: readonly string[]): string | undefined {
  const labelIdentities = identities.filter((identity) => new RegExp(`\\b${identity}\\b`, "i").test(label));
  if (labelIdentities.length === 1) return labelIdentities[0];
  const promptIdentities = identities.filter((identity) => new RegExp(`\\b${identity}\\b`, "i").test(prompt));
  return promptIdentities.length === 1 ? promptIdentities[0] : undefined;
}

function resolveGenerateFilterIdentity(
  label: string,
  prompt: string,
  identities: readonly string[],
): string | undefined {
  const labelIdentity = resolveExclusiveIdentity(label, "", identities);
  if (labelIdentity) {
    return labelIdentity;
  }
  const candidateIdentities = jsonValuesInText(prompt)
    .flatMap((value) => generatedCandidatesFromResult(value) ?? [])
    .flatMap(({ id }) => (typeof id === "string" && identities.includes(id) ? [id] : []));
  if (new Set(candidateIdentities).size === 1) {
    return candidateIdentities[0];
  }
  return resolveIdentity(label, prompt, identities);
}

const fullWriteAgentFixture: ScenarioAgentFixture = (request) => {
  const taskIdentity = resolveWriteTaskIdentity(request.label, request.prompt);
  if (taskIdentity === "beta") {
    return { status: "null", message: "deterministic beta failure" };
  }
  return {
    status: "returned",
    result: request.schema
      ? sampleSchema(request.schema, request.label || "agent", taskIdentity)
      : `result:${request.label || request.prompt}`,
  };
};

const SCENARIO_AGENT_FIXTURES: Readonly<Record<string, ScenarioAgentFixture>> = {
  "quick-write": ordinaryAgentFixture,
  "full-write": fullWriteAgentFixture,
  "full-edit": ordinaryAgentFixture,
  "full-review": (request) => {
    const reviewerMatch = /^verify (\d+)$/.exec(request.label);
    if (!reviewerMatch) {
      return ordinaryAgentFixture(request, { attempt: 0 });
    }
    const reviewer = Number(reviewerMatch[1]);
    if (reviewer === 3) {
      return { status: "null", message: "deterministic reviewer failure" };
    }
    return {
      status: "returned",
      result: { real: reviewer === 1, reason: `reviewer-${reviewer}` },
    };
  },
  "full-debug": (request, state) => {
    state.attempt++;
    const attemptIdentity = request.label || `attempt-${state.attempt}`;
    return {
      status: "returned",
      result: {
        acceptable: state.attempt > 1,
        answer: state.attempt > 1 ? `accepted:${attemptIdentity}` : `invalid:${attemptIdentity}`,
        feedback: state.attempt > 1 ? "" : "add concrete detail",
      },
    };
  },
  "full-loop": (request, state) => {
    state.attempt++;
    if (state.attempt === 2) {
      return { status: "null", message: "deterministic discovery round failure" };
    }
    return {
      status: "returned",
      result: {
        findings: state.attempt === 1 ? [{ id: "alpha", evidence: `evidence:${request.label}` }] : [],
      },
    };
  },
  "full-retry": (request, state) => {
    state.attempt++;
    return {
      status: "returned",
      result: {
        acceptable: state.attempt > 1,
        answer: state.attempt > 1 ? `accepted:${request.label}` : `invalid:${request.label}`,
      },
    };
  },
  "coverage-fan-out-synthesize": (request) => {
    const identity = resolveExclusiveIdentity(request.label, request.prompt, ["climate", "transport"]);
    if (identity === undefined) {
      return {
        status: "returned",
        result: {
          summary: "synthesis:climate-with-transport-missing",
          coveredIds: ["climate"],
          missingIds: ["transport"],
        },
      };
    }
    if (identity === "transport") {
      return { status: "null", message: "deterministic transport failure" };
    }
    return {
      status: "returned",
      result: request.schema
        ? sampleSchema(request.schema, request.label || "research", identity)
        : { id: identity ?? "climate", finding: `finding:${request.label}` },
    };
  },
  "coverage-generate-filter": (request, state) => {
    if (isGenerateFilterGeneratorSchema(request.schema)) {
      state.attempt++;
      const candidates =
        state.attempt === 1
          ? [
              { id: "signal-a", proposal: "proposal:signal-a" },
              { id: "shared", proposal: "proposal:shared:first" },
            ]
          : [
              { id: "shared", proposal: "proposal:shared:duplicate" },
              { id: "signal-b", proposal: "proposal:signal-b" },
              { id: "signal-c", proposal: "proposal:signal-c" },
            ];
      return {
        status: "returned",
        result: createGeneratorResult(request.schema, candidates, request.label),
      };
    }
    const identity = resolveGenerateFilterIdentity(request.label, request.prompt, [
      "signal-a",
      "shared",
      "signal-b",
      "signal-c",
    ]);
    if (identity === "signal-b") {
      return { status: "null", message: "deterministic filter failure for signal-b" };
    }
    return {
      status: "returned",
      result: createFilterDecisionResult(request.schema, identity ?? "unknown", identity === "signal-a"),
    };
  },
  "coverage-judge-panel": (request, state) => {
    const judgeMatch = /^judge (\d+)\.(\d+)$/.exec(request.label);
    if (judgeMatch) {
      const attempt = Number(judgeMatch[1]);
      const judge = Number(judgeMatch[2]);
      if (attempt === 2 && judge === 3) {
        return { status: "null", message: "deterministic judge 2.3 failure" };
      }
      const scores = attempt === 1 ? [0.4, 0.5, 0.3] : [0.9, 0.8, 0.7];
      return {
        status: "returned",
        result: { score: scores[judge - 1], reason: `judge:${attempt}.${judge}` },
      };
    }
    state.attempt++;
    const identity = state.attempt === 1 ? "draft-a" : "draft-b";
    return {
      status: "returned",
      result: { id: identity, answer: `answer:${identity}` },
    };
  },
};

/** Exact requested and resolved model settings recorded for reproducible comparison. */
export interface ComprehensionModelSelection {
  requested: string;
  resolved: string;
  thinkingLevel: ModelThinkingLevel | null;
}

type ComprehensionFailureStage = "generation" | "parse" | "runtime" | "assertion";

/** Versioned evidence from one generated workflow executed against its scenario contract. */
export interface ComprehensionEvidence {
  formatVersion: 2;
  provider: string;
  modelSelection: ComprehensionModelSelection;
  extensionVersion: string;
  contractVersions: { format: string; content: string };
  skillVersion: string;
  task: { id: string; suite: ComprehensionSuite; kind: ComprehensionTaskKind; prompt: string };
  generatedWorkflow: string | null;
  skillLoadingEvidence: SkillLoadingEvidence;
  tokenUsage: ComprehensionTokenUsage | null;
  runtime: {
    calls: RuntimeCall[];
    events: RuntimeEvent[];
    topology: { maxConcurrent: number; phases: string[] };
    failures: Array<{
      callIndex: number;
      label: string;
      message: string;
      errorCode: string | null;
      recoverable: boolean | null;
    }>;
    result: unknown;
    assertions: Array<{ name: string; passed: boolean; details: string }>;
  };
  passed: boolean;
  failure: { stage: ComprehensionFailureStage; message: string; stack?: string } | null;
}

interface RunComprehensionScenarioBaseOptions {
  scenario: ComprehensionScenario;
  provider: string;
  extensionVersion: string;
  contractVersions: { format: string; content: string };
  skillVersion: string;
  generate: (scenario: ComprehensionScenario) => Promise<ModelGeneration>;
}

/** Dependencies and version facts needed to generate and execute one comprehension scenario. */
export type RunComprehensionScenarioOptions = RunComprehensionScenarioBaseOptions &
  (
    | { modelSelection: ComprehensionModelSelection; model?: never }
    | {
        /** @deprecated Use modelSelection. Retained for provider-free callers created before evidence format 2. */
        model: string;
        modelSelection?: never;
      }
  );

/** Select scenarios in stable declaration order for one suite. */
export function selectComprehensionScenarios(
  suite: ComprehensionSuite | `${ComprehensionSuite}`,
): readonly ComprehensionScenario[] {
  return COMPREHENSION_SCENARIOS.filter((scenario) => scenario.suite === suite);
}

/** Generate, parse, execute, and behaviorally score one scenario without making scoring-stage provider calls. */
export async function runComprehensionScenario(
  options: RunComprehensionScenarioOptions,
): Promise<ComprehensionEvidence> {
  const evidence = emptyEvidence(options);
  let generation: ModelGeneration;
  try {
    generation = await options.generate(options.scenario);
    evidence.generatedWorkflow = generation.workflow;
    evidence.skillLoadingEvidence = generation.skillLoadingEvidence;
    evidence.tokenUsage = generation.tokenUsage;
  } catch (error) {
    if (error instanceof ModelGenerationError) {
      evidence.skillLoadingEvidence = error.skillLoadingEvidence;
      evidence.tokenUsage = error.tokenUsage;
    }
    evidence.failure = failure("generation", error);
    return evidence;
  }

  try {
    parseWorkflowScript(generation.workflow);
  } catch (error) {
    evidence.failure = failure("parse", error);
    return evidence;
  }

  const calls: RuntimeCall[] = [];
  const events: RuntimeEvent[] = [];
  const runtimeFailures: ComprehensionEvidence["runtime"]["failures"] = [];
  let timelineIndex = 0;
  let active = 0;
  let maxConcurrent = 0;
  const fixtureState: ScenarioFixtureState = { attempt: 0 };
  try {
    const result = await runWorkflow(generation.workflow, {
      persistLogs: false,
      args: { work: [{ id: "alpha" }, { id: "beta" }], phaseBudget: 100 },
      loadSavedWorkflow: () =>
        `export const meta = { name: "comprehension_child", description: "deterministic child" }\nconst value = await agent("child:" + args.id, { label: "child:" + args.id })\nreturn { id: args.id, value }`,
      onRuntimeEvent: (event) => events.push({ ...event, index: timelineIndex++ }),
      onAgentStart: ({ label, phase, prompt }) => {
        calls.push({
          index: timelineIndex++,
          completedIndex: null,
          label,
          prompt,
          phase: phase ?? null,
          structured: false,
          scenarioRole: null,
          status: "returned",
          result: null,
        });
      },
      onAgentEnd: ({ label, error, errorCode, recoverable }) => {
        const call = [...calls].reverse().find((candidate) => candidate.label === label);
        const completedIndex = timelineIndex++;
        if (call) {
          call.completedIndex = completedIndex;
        }
        if (!error) {
          return;
        }
        runtimeFailures.push({
          callIndex: call?.index ?? -1,
          label,
          message: error,
          errorCode: errorCode ?? null,
          recoverable: recoverable ?? null,
        });
      },
      agent: {
        async run(prompt: string, agentOptions: AgentRunOptions<TSchema> = {}): Promise<unknown> {
          const call = [...calls].reverse().find(({ label }) => label === agentOptions.label && label !== "");
          if (call) {
            call.structured = agentOptions.schema !== undefined;
            if (options.scenario.id === "coverage-generate-filter") {
              call.scenarioRole = isGenerateFilterGeneratorSchema(agentOptions.schema) ? "generator" : "filter";
            }
          }
          active++;
          maxConcurrent = Math.max(maxConcurrent, active);
          await pause();
          active--;
          const fixture = SCENARIO_AGENT_FIXTURES[options.scenario.id];
          if (!fixture) {
            throw new Error(`No deterministic fixture for scenario ${options.scenario.id}`);
          }
          const response = fixture(
            {
              prompt,
              label: agentOptions.label ?? "",
              schema: agentOptions.schema,
            },
            fixtureState,
          );
          if (response.status === "null") {
            if (call) {
              call.status = "null";
            }
            throw new WorkflowError(response.message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
              recoverable: true,
              agentLabel: agentOptions.label,
            });
          }
          if (call) {
            call.result = serializable(response.result);
          }
          return response.result;
        },
      },
    });
    evidence.runtime.calls = calls;
    evidence.runtime.events = events;
    evidence.runtime.topology = { maxConcurrent, phases: [...result.phases] };
    evidence.runtime.failures = runtimeFailures;
    evidence.runtime.result = serializable(result.result);
  } catch (error) {
    evidence.runtime.calls = calls;
    evidence.runtime.events = events;
    evidence.runtime.topology.maxConcurrent = maxConcurrent;
    evidence.failure = failure("runtime", error);
    return evidence;
  }

  const assertions = assertScenario(options.scenario, generation.skillLoadingEvidence, evidence.runtime);
  evidence.runtime.assertions = assertions;
  evidence.passed = assertions.every(({ passed }) => passed);
  if (!evidence.passed) {
    evidence.failure = {
      stage: "assertion",
      message: assertions
        .filter(({ passed }) => !passed)
        .map(({ details }) => details)
        .join("; "),
    };
  }
  return evidence;
}

function emptyEvidence(options: RunComprehensionScenarioOptions): ComprehensionEvidence {
  return {
    formatVersion: 2,
    provider: options.provider,
    modelSelection: normalizeModelSelection(options),
    extensionVersion: options.extensionVersion,
    contractVersions: options.contractVersions,
    skillVersion: options.skillVersion,
    task: {
      id: options.scenario.id,
      suite: options.scenario.suite,
      kind: options.scenario.kind,
      prompt: options.scenario.prompt,
    },
    generatedWorkflow: null,
    skillLoadingEvidence: { discovered: false, loaded: false, toolCalls: [] },
    tokenUsage: null,
    runtime: {
      calls: [],
      events: [],
      topology: { maxConcurrent: 0, phases: [] },
      failures: [],
      result: null,
      assertions: [],
    },
    passed: false,
    failure: null,
  };
}

function normalizeModelSelection(options: RunComprehensionScenarioOptions): ComprehensionModelSelection {
  if (options.modelSelection) {
    return options.modelSelection;
  }
  if (options.model) {
    return { requested: options.model, resolved: options.model, thinkingLevel: null };
  }
  throw new Error("modelSelection is required");
}

function assertScenario(
  scenario: ComprehensionScenario,
  skillLoadingEvidence: SkillLoadingEvidence,
  runtime: ComprehensionEvidence["runtime"],
): Array<{ name: string; passed: boolean; details: string }> {
  const assertions: Array<{ name: string; passed: boolean; details: string }> = [];
  assertions.push({
    name: "skill:loaded",
    passed: skillLoadingEvidence.discovered && skillLoadingEvidence.loaded,
    details: "model must discover and load the applicable installed skill",
  });
  assertions.push({
    name: "runtime:calls",
    passed: runtime.calls.length > 0,
    details: "real runtime must observe at least one deterministic agent call",
  });
  const labels = runtime.calls.map(({ label }) => label);
  assertions.push({
    name: "labels:unique",
    passed: labels.every((label) => label.trim().length > 0) && new Set(labels).size === labels.length,
    details: "every agent call must use a unique nonblank label",
  });
  if (scenario.id === "quick-write" || scenario.id === "full-write") {
    assertions.push({
      name: "topology:parallel",
      passed: runtime.topology.maxConcurrent > 1,
      details: "write scenario must execute independent calls concurrently",
    });
  }
  if (scenario.id === "quick-write") {
    const taskCalls = ["alpha", "beta"].map((workId) => findTaskCall(runtime.calls, workId));
    assertions.push({
      name: "labels:unique-task-calls",
      passed:
        taskCalls.every((call) => call !== undefined && call.label.trim() !== "") &&
        new Set(taskCalls.map((call) => call?.label)).size === taskCalls.length,
      details: "quick-write task calls must use distinct nonblank labels",
    });
    for (const [index, workId] of ["alpha", "beta"].entries()) {
      const call = taskCalls[index];
      assertions.push({
        name: `result:${workId}-returned`,
        passed: call !== undefined && containsTaskResult(runtime.result, workId, call.result),
        details: `quick-write must return the ${workId} agent result associated with ${workId}`,
      });
    }
  }
  if (scenario.id === "full-write") {
    const alphaCall = findTaskCall(runtime.calls, "alpha");
    const betaCall = findTaskCall(runtime.calls, "beta");
    assertions.push({
      name: "structured-output:task-calls",
      passed: alphaCall?.structured === true && betaCall?.structured === true,
      details: "full-write must execute both alpha and beta with schema-validated output",
    });
    assertions.push({
      name: "coverage:completed-alpha",
      passed:
        alphaCall !== undefined &&
        containsInNamedField(runtime.result, /complet|success|done/i, (value) =>
          containsTaskResultEvidence(value, "alpha", alphaCall.result),
        ),
      details: "full-write must preserve the successful alpha result in completed data",
    });
    assertions.push({
      name: "coverage:missing-beta",
      passed:
        betaCall !== undefined &&
        betaCall.status === "null" &&
        runtime.failures.some(({ callIndex }) => callIndex === betaCall.index) &&
        containsInNamedField(runtime.result, /miss|fail|error|unavailable/i, (value) =>
          containsIdentity(value, "beta"),
        ),
      details: "full-write must preserve failed beta by identity in a missing-work collection",
    });
  }
  if (scenario.id === "coverage-fan-out-synthesize") {
    const contributorCalls = runtime.calls.filter(
      ({ label, prompt }) => resolveExclusiveIdentity(label, prompt, ["climate", "transport"]) !== undefined,
    );
    const synthesisCalls = runtime.calls.filter((call) => !contributorCalls.includes(call));
    const synthesisCall = synthesisCalls[0];
    const climateCall = contributorCalls.find(
      ({ label, prompt }) => resolveExclusiveIdentity(label, prompt, ["climate", "transport"]) === "climate",
    );
    const transportCall = contributorCalls.find(
      ({ label, prompt }) => resolveExclusiveIdentity(label, prompt, ["climate", "transport"]) === "transport",
    );
    assertions.push({
      name: "synthesis:complete-fan-out",
      passed:
        contributorCalls.length === 2 &&
        runtime.topology.maxConcurrent > 1 &&
        climateCall?.structured === true &&
        transportCall?.structured === true &&
        transportCall.status === "null" &&
        runtime.failures.some(({ callIndex }) => callIndex === transportCall.index),
      details:
        "fan-out-and-synthesize must run both structured contributors concurrently and preserve failure evidence",
    });
    assertions.push({
      name: "synthesis:complete-input",
      passed:
        synthesisCalls.length === 1 &&
        synthesisCall?.structured === true &&
        climateCall !== undefined &&
        promptContainsResultOrSingleFieldProjection(synthesisCall.prompt, climateCall.result) &&
        /\btransport\b/i.test(synthesisCall.prompt) &&
        /miss|null|fail|unavailable/i.test(synthesisCall.prompt),
      details:
        "synthesis must start from the complete intended coverage, including the climate result and missing transport identity",
    });
    assertions.push({
      name: "synthesis:returned-provenance",
      passed:
        synthesisCall !== undefined &&
        climateCall !== undefined &&
        containsValue(runtime.result, synthesisCall.result) &&
        containsInNamedField(
          runtime.result,
          /contribut|coverage|ledger/i,
          (value) =>
            containsIdentity(value, "climate") &&
            containsIdentity(value, "transport") &&
            containsMissingCoverage(value, "transport"),
        ),
      details:
        "fan-out-and-synthesize must return the actual synthesis and a contributor ledger with missing transport coverage",
    });
  }
  if (scenario.id === "coverage-generate-filter") {
    const generatorCalls = runtime.calls.filter(({ scenarioRole }) => scenarioRole === "generator");
    const filterCalls = runtime.calls.filter(({ scenarioRole }) => scenarioRole === "filter");
    const generatedCandidates = generatorCalls.flatMap(({ result }) => generatedCandidatesFromResult(result) ?? []);
    const retainedCandidates: Array<Record<string, unknown>> = [];
    const seenCandidateIds = new Set<string>();
    for (const candidate of generatedCandidates) {
      if (typeof candidate.id !== "string" || seenCandidateIds.has(candidate.id)) continue;
      seenCandidateIds.add(candidate.id);
      if (retainedCandidates.length < 3) retainedCandidates.push(candidate);
    }
    const filterCallsById = new Map(
      retainedCandidates.map((candidate) => [
        candidate.id,
        filterCalls.filter(({ prompt }) => promptContainsCandidate(prompt, candidate)),
      ]),
    );
    assertions.push({
      name: "filter:generation-barrier",
      passed:
        generatorCalls.length === 2 &&
        generatorCalls.every(({ structured }) => structured) &&
        runtime.topology.maxConcurrent > 1 &&
        generatorCalls.every(({ completedIndex }) => completedIndex !== null) &&
        filterCalls.every(
          ({ index }) =>
            index > Math.max(...generatorCalls.map(({ completedIndex }) => completedIndex ?? Number.POSITIVE_INFINITY)),
        ),
      details: "generate-and-filter must finish exactly two concurrent structured generators before filtering",
    });
    assertions.push({
      name: "filter:deduplicated-bounded-input",
      passed:
        retainedCandidates.length > 0 &&
        retainedCandidates.length <= 3 &&
        generatedCandidates.length > seenCandidateIds.size &&
        filterCalls.length === retainedCandidates.length &&
        filterCalls.every(({ structured }) => structured) &&
        retainedCandidates.every((candidate) => {
          const calls = filterCallsById.get(candidate.id) ?? [];
          return calls.length === 1 && promptContainsCandidate(calls[0]?.prompt ?? "", candidate);
        }),
      details:
        "generate-and-filter must deduplicate by candidate id, cap at three, and filter each retained candidate once",
    });
    const acceptedCalls = filterCalls.filter(({ result }) => filterDecisionIsAccepted(result));
    const failedFilters = filterCalls.filter(({ status }) => status === "null");
    const generatorOutputsReturned = containsInNamedField(runtime.result, /generat|output|batch/i, (value) =>
      generatedCandidates.every((candidate) => containsCandidateProjection(value, candidate)),
    );
    assertions.push({
      name: "filter:returned-provenance",
      passed:
        generatorOutputsReturned &&
        retainedCandidates.every(
          ({ id }) =>
            typeof id === "string" &&
            containsInNamedField(runtime.result, /retain|candidate.?id/i, (value) => containsIdentity(value, id)),
        ) &&
        acceptedCalls.every((call) => {
          const identity = resolveGenerateFilterIdentity(
            call.label,
            call.prompt,
            retainedCandidates.flatMap(({ id }) => (typeof id === "string" ? [id] : [])),
          );
          return (
            identity !== undefined &&
            containsInNamedField(runtime.result, /accept|pass|selected/i, (value) =>
              containsIdentity(value, identity),
            ) &&
            containsFilterDecisionEvidence(runtime.result, call.result, identity)
          );
        }) &&
        failedFilters.every((call) => {
          const identity = resolveGenerateFilterIdentity(
            call.label,
            call.prompt,
            retainedCandidates.flatMap(({ id }) => (typeof id === "string" ? [id] : [])),
          );
          return (
            identity !== undefined &&
            runtime.failures.some(({ callIndex }) => callIndex === call.index) &&
            containsInNamedField(runtime.result, /fail|miss|error/i, (value) => containsIdentity(value, identity))
          );
        }) &&
        (failedFilters.length > 0 ||
          containsInNamedField(runtime.result, /fail|miss|error/i, (value) => Array.isArray(value) || isRecord(value))),
      details:
        "generate-and-filter must return actual generation, retained identities, accepted decisions, and failed filter identity",
    });
  }
  if (scenario.id === "coverage-judge-panel") {
    const qualityStart = runtime.events.find(
      (event) => event.type === "quality" && event.stage === "start" && event.helper === "judgePanel",
    );
    const qualityEnd = runtime.events.find(
      (event) => event.type === "quality" && event.stage === "end" && event.helper === "judgePanel",
    );
    const judgmentCalls =
      qualityStart && qualityEnd
        ? runtime.calls.filter(({ index }) => qualityStart.index < index && index < qualityEnd.index)
        : [];
    const candidateCalls = runtime.calls.filter((call) => !judgmentCalls.includes(call));
    const judgedAttempts = candidateCalls.map((candidate, index) =>
      judgedAttemptFromPrompt(
        judgmentCalls.find(({ label }) => label.startsWith(`judge ${index + 1}.`))?.prompt ?? "",
        candidate.result,
      ),
    );
    const judgmentsByCandidate = candidateCalls.map((_candidate, index) =>
      judgmentCalls.filter(({ label }) => label.startsWith(`judge ${index + 1}.`)),
    );
    assertions.push({
      name: "judge-panel:executed",
      passed:
        qualityStart !== undefined &&
        qualityEnd !== undefined &&
        candidateCalls.length === 2 &&
        candidateCalls.every(({ structured }) => structured) &&
        runtime.topology.maxConcurrent > 1,
      details:
        "judge-panel scenario must produce exactly two structured candidates concurrently and execute judgePanel",
    });
    assertions.push({
      name: "judge-panel:numeric-judges",
      passed:
        judgmentCalls.length === 6 &&
        judgmentCalls.every(({ structured, prompt }) => structured && /correct|valid|accur/i.test(prompt)) &&
        judgmentsByCandidate.every(
          (calls, index) =>
            calls.length === 3 &&
            judgedAttempts[index] !== undefined &&
            containsResultProjection(judgedAttempts[index], candidateCalls[index]?.result),
        ) &&
        judgmentCalls.filter(({ status }) => status === "null").length === 1,
      details:
        "judgePanel must run exactly three structured correctness judges per produced candidate and retain one recoverable failure",
    });
    const scoredCandidates = judgmentsByCandidate.map((calls, index) => {
      const surviving = calls.filter(({ status }) => status === "returned");
      const scores = surviving.map(({ result }) =>
        isRecord(result) && typeof result.score === "number" ? result.score : 0,
      );
      return {
        index,
        attempt: judgedAttempts[index],
        score: scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
        judgments: surviving.map(({ result }) => result),
      };
    });
    const expectedWinner = scoredCandidates.reduce<(typeof scoredCandidates)[number] | undefined>(
      (best, candidate) =>
        !best || candidate.score > best.score || (candidate.score === best.score && candidate.index < best.index)
          ? candidate
          : best,
      undefined,
    );
    assertions.push({
      name: "judge-panel:returned-winner",
      passed:
        expectedWinner !== undefined &&
        candidateCalls.every(({ result }) => containsResultProjection(runtime.result, result)) &&
        containsValue(runtime.result, expectedWinner),
      details: "judge-panel scenario must return both produced candidates and the helper's unchanged winning result",
    });
  }
  if (scenario.id === "full-edit") {
    const childStarts = runtime.events.filter(
      (event): event is RuntimeEvent & { type: "workflow"; stage: "start" } =>
        event.type === "workflow" && event.stage === "start",
    );
    const childEnds = runtime.events.filter(
      (event): event is RuntimeEvent & { type: "workflow"; stage: "end" } =>
        event.type === "workflow" && event.stage === "end",
    );
    const alphaStart = childStarts.find((event) => isRecord(event.args) && event.args.id === "alpha");
    const alphaEnd = childEnds.find((event) => isRecord(event.args) && event.args.id === "alpha");
    const betaStart = childStarts.find((event) => isRecord(event.args) && event.args.id === "beta");
    const betaEnd = childEnds.find((event) => isRecord(event.args) && event.args.id === "beta");
    const preparationCalls = alphaStart ? runtime.calls.filter(({ index }) => index < alphaStart.index) : [];
    const preparation = preparationCalls[0];
    const alphaCall = callWithin(runtime.calls, alphaStart, alphaEnd);
    const betaCall = callWithin(runtime.calls, betaStart, betaEnd);
    assertions.push({
      name: "preparation:executed",
      passed: preparationCalls.length === 1,
      details: "edit scenario must execute exactly one preparation agent before saved children",
    });
    assertions.push({
      name: "nesting:executed",
      passed: alphaStart !== undefined && betaStart !== undefined,
      details: "saved child workflow must execute for alpha and beta",
    });
    assertions.push({
      name: "nesting:sequential",
      passed: alphaEnd !== undefined && betaStart !== undefined && alphaEnd.index < betaStart.index,
      details: "saved child workflows must execute sequentially in alpha then beta order",
    });
    assertions.push({
      name: "nesting:returned-results",
      passed:
        alphaCall !== undefined &&
        betaCall !== undefined &&
        containsValue(runtime.result, alphaCall.result) &&
        containsValue(runtime.result, betaCall.result),
      details: "edit scenario must return data from both saved child workflows",
    });
    assertions.push({
      name: "phase:entered",
      passed:
        preparation !== undefined &&
        runtime.events.some(
          (event) =>
            event.type === "phase" && event.budget !== null && event.budget > 0 && event.index < preparation.index,
        ),
      details: "edit scenario must enter a positive-budget phase before preparation",
    });
  }
  if (scenario.id === "full-review") {
    const qualityStart = runtime.events.find((event) => event.type === "quality" && event.stage === "start");
    const qualityEnd = runtime.events.find((event) => event.type === "quality" && event.stage === "end");
    const claimCall = qualityStart ? runtime.calls.filter(({ index }) => index < qualityStart.index).at(-1) : undefined;
    const qualityCalls =
      qualityStart && qualityEnd
        ? runtime.calls.filter(({ index }) => qualityStart.index < index && index < qualityEnd.index)
        : [];
    const successfulQualityCalls = qualityCalls.filter(({ status }) => status === "returned");
    const expectedVerdict = {
      real: false,
      realCount: 1,
      total: 2,
      votes: successfulQualityCalls.map(({ result }) => result),
    };
    assertions.push({
      name: "quality:executed",
      passed:
        claimCall !== undefined &&
        qualityCalls.length === 3 &&
        qualityCalls.every(({ prompt }) => promptContainsResultOrSingleFieldProjection(prompt, claimCall.result)),
      details: "quality helper must run exactly three adversarial reviewers over the produced claim",
    });
    assertions.push({
      name: "quality:verify-contract",
      passed:
        qualityCalls.length === 3 &&
        /\bFocus lens:[^\n]*\bsource\b/i.test(qualityCalls[0]?.prompt ?? "") &&
        /\bFocus lens:[^\n]*\blogic(?:al)?\b/i.test(qualityCalls[1]?.prompt ?? "") &&
        /\bFocus lens:[^\n]*\bsource\b/i.test(qualityCalls[2]?.prompt ?? "") &&
        qualityCalls[2]?.status === "null" &&
        containsValue(runtime.result, expectedVerdict),
      details: "review scenario must use the documented verify options and return its survivor-based verdict unchanged",
    });
    assertions.push({
      name: "review:returned-outcome",
      passed:
        claimCall !== undefined &&
        containsResultOrSingleFieldProjection(runtime.result, claimCall.result) &&
        successfulQualityCalls.length === 2 &&
        successfulQualityCalls.every(({ result }) => containsValue(runtime.result, result)),
      details: "review scenario must return the produced claim and successful quality-helper votes",
    });
  }
  if (scenario.id === "full-debug") {
    const attempts = runtime.events.filter((event) => event.type === "control-attempt");
    const firstAttemptCall = attempts[0]
      ? runtime.calls.filter(({ index }) => index < attempts[0].index).at(-1)
      : undefined;
    const acceptedEvent = attempts.at(-1);
    const acceptedCall = acceptedEvent
      ? runtime.calls.filter(({ index }) => index < acceptedEvent.index).at(-1)
      : undefined;
    assertions.push({
      name: "control:retried",
      passed:
        attempts.length >= 2 &&
        attempts.length <= 3 &&
        attempts[0]?.accepted === false &&
        acceptedEvent?.accepted === true,
      details: "bounded control helper must reject the first result and accept within two or three attempts",
    });
    assertions.push({
      name: "control:structured-validity",
      passed:
        firstAttemptCall?.structured === true &&
        acceptedCall?.structured === true &&
        isRecord(firstAttemptCall.result) &&
        firstAttemptCall.result.acceptable === false &&
        isRecord(acceptedCall.result) &&
        acceptedCall.result.acceptable === true,
      details: "debug scenario must gate the scenario-owned structured validity signal",
    });
    assertions.push({
      name: "debug:returned-outcome",
      passed:
        acceptedCall !== undefined &&
        containsNamedResultProjection(runtime.result, acceptedCall.result, ["acceptable", "answer"]),
      details: "debug scenario must return the accepted agent result rather than fabricate success",
    });
  }
  if (scenario.id === "full-loop") {
    const firstCall = runtime.calls[0];
    const failedCall = runtime.calls.find(({ status }) => status === "null");
    const firstFinding =
      isRecord(firstCall?.result) && Array.isArray(firstCall.result.findings)
        ? firstCall.result.findings[0]
        : undefined;
    assertions.push({
      name: "loop:successful-dry-stopping",
      passed:
        runtime.calls.length === 4 &&
        runtime.calls.every(({ structured }) => structured) &&
        failedCall === runtime.calls[1],
      details: "loop scenario must ignore the failed round for dryness and stop after two later successful dry rounds",
    });
    assertions.push({
      name: "loop:coverage-ledger",
      passed:
        firstFinding !== undefined &&
        containsValue(runtime.result, firstFinding) &&
        failedCall !== undefined &&
        containsInNamedField(runtime.result, /fail|miss|error/i, (value) =>
          containsRoundIdentity(value, failedCall.label, runtime.calls.indexOf(failedCall)),
        ),
      details: "loop scenario must return the alpha finding and preserve the failed round by identity",
    });
    assertions.push({
      name: "loop:truthful-termination",
      passed:
        containsInNamedField(runtime.result, /complete/i, (value) => value === false) &&
        containsInNamedField(runtime.result, /termin|reason|status/i, (value) => typeof value === "string"),
      details: "loop scenario must return a termination reason and must not claim complete after a failed round",
    });
  }
  if (scenario.id === "full-retry") {
    const controlAttempts = runtime.events.filter(
      (event): event is RuntimeEvent & { type: "control-attempt" } =>
        event.type === "control-attempt" && event.helper === "retry",
    );
    const firstCall = runtime.calls[0];
    const acceptedCall = runtime.calls[1];
    assertions.push({
      name: "retry:exact-control-contract",
      passed:
        runtime.calls.length === 2 &&
        controlAttempts.length === 2 &&
        controlAttempts[0]?.accepted === false &&
        controlAttempts[1]?.accepted === true &&
        firstCall?.structured === true &&
        acceptedCall?.structured === true,
      details: "retry scenario must use synchronous false-then-true acceptance over exactly two structured attempts",
    });
    assertions.push({
      name: "retry:returned-ledger",
      passed:
        firstCall !== undefined &&
        acceptedCall !== undefined &&
        containsInNamedField(
          runtime.result,
          /attempt|ledger|history/i,
          (value) =>
            containsResultProjection(value, firstCall.result) && containsResultProjection(value, acceptedCall.result),
        ) &&
        containsValue(runtime.result, acceptedCall.result) &&
        containsInNamedField(runtime.result, /exhaust/i, (value) => value === false),
      details: "retry scenario must return every attempt, the accepted result, and explicit non-exhaustion",
    });
  }
  return assertions;
}

function sampleSchema(schema: unknown, label: string, taskIdentity?: string): unknown {
  if (isRecord(schema) && schema.type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    return Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, sampleProperty(key, value, label, taskIdentity)]),
    );
  }
  return sampleProperty("value", schema, label, taskIdentity);
}

function sampleProperty(key: string, schema: unknown, label: string, taskIdentity?: string): unknown {
  if (isRecord(schema) && Object.hasOwn(schema, "const")) {
    return schema.const;
  }
  if (isRecord(schema) && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  const type = isRecord(schema) ? schema.type : undefined;
  if (type === "string" && taskIdentity && /(?:^id$|id$|identity|work.?unit|^unit$)/i.test(key)) {
    return taskIdentity;
  }
  if (type === "boolean") {
    return true;
  }
  if (type === "number" || type === "integer") {
    return 1;
  }
  if (type === "array") {
    return [];
  }
  if (type === "object") {
    return sampleSchema(schema, label, taskIdentity);
  }
  return `${key}:${label}`;
}

function callWithin(calls: RuntimeCall[], start?: RuntimeEvent, end?: RuntimeEvent): RuntimeCall | undefined {
  if (!start || !end) {
    return undefined;
  }
  return calls.find(({ index }) => start.index < index && index < end.index);
}

function findTaskCall(calls: RuntimeCall[], workId: string): RuntimeCall | undefined {
  return calls.find(({ label, prompt }) => resolveWriteTaskIdentity(label, prompt) === workId);
}

function containsInNamedField(
  container: unknown,
  fieldPattern: RegExp,
  predicate: (value: unknown) => boolean,
): boolean {
  if (Array.isArray(container)) {
    return container.some((value) => containsInNamedField(value, fieldPattern, predicate));
  }
  if (!isRecord(container)) {
    return false;
  }
  for (const [key, value] of Object.entries(container)) {
    if (fieldPattern.test(key) && predicate(value)) {
      return true;
    }
    if (containsInNamedField(value, fieldPattern, predicate)) {
      return true;
    }
  }
  return false;
}

function containsIdentity(container: unknown, identity: string): boolean {
  if (typeof container === "string") {
    return container.toLowerCase() === identity.toLowerCase();
  }
  if (Array.isArray(container)) {
    return container.some((value) => containsIdentity(value, identity));
  }
  if (!isRecord(container)) {
    return false;
  }
  return Object.entries(container).some(
    ([key, value]) => key.toLowerCase() === identity.toLowerCase() || containsIdentity(value, identity),
  );
}

function containsRoundIdentity(container: unknown, label: string, zeroBasedIndex: number): boolean {
  if (typeof container === "number") {
    return container === zeroBasedIndex || container === zeroBasedIndex + 1;
  }
  if (typeof container === "string") {
    const normalized = container.toLowerCase();
    return (
      normalized === label.toLowerCase() ||
      normalized === String(zeroBasedIndex) ||
      normalized === String(zeroBasedIndex + 1) ||
      new RegExp(`\\bround[-_: ]?${zeroBasedIndex + 1}\\b`, "i").test(container)
    );
  }
  if (Array.isArray(container)) {
    return container.some((value) => containsRoundIdentity(value, label, zeroBasedIndex));
  }
  return (
    isRecord(container) &&
    Object.entries(container).some(
      ([key, value]) =>
        containsRoundIdentity(key, label, zeroBasedIndex) || containsRoundIdentity(value, label, zeroBasedIndex),
    )
  );
}

function containsTaskResult(container: unknown, workId: string, expected: unknown): boolean {
  if (Array.isArray(container)) {
    return container.some((value) => containsTaskResult(value, workId, expected));
  }
  if (!isRecord(container)) {
    return false;
  }
  for (const [key, value] of Object.entries(container)) {
    if (new RegExp(`\\b${workId}\\b`, "i").test(key) && containsValue(value, expected)) {
      return true;
    }
  }
  const values = Object.values(container);
  if (
    values.some((value) => typeof value === "string" && value.toLowerCase() === workId.toLowerCase()) &&
    values.some((value) => containsValue(value, expected))
  ) {
    return true;
  }
  return values.some((value) => containsTaskResult(value, workId, expected));
}

function containsTaskResultEvidence(container: unknown, identity: string, expected: unknown): boolean {
  if (isDeepStrictEqual(container, expected)) {
    return true;
  }
  if (Array.isArray(container)) {
    return container.some((value) => containsTaskResultEvidence(value, identity, expected));
  }
  if (!isRecord(container)) {
    return false;
  }
  if (isRecord(expected) && containsIdentity(container, identity)) {
    const producedPayload = Object.entries(expected).filter(
      ([, value]) =>
        typeof value !== "boolean" &&
        !(typeof value === "string" && value.toLowerCase() === identity.toLowerCase()) &&
        !(Array.isArray(value) && value.length === 0),
    );
    if (producedPayload.some(([, value]) => containsValue(container, value))) {
      return true;
    }
  }
  return Object.values(container).some((value) => containsTaskResultEvidence(value, identity, expected));
}

function containsNamedResultProjection(container: unknown, expected: unknown, keys: string[]): boolean {
  if (Array.isArray(container)) {
    return container.some((value) => containsNamedResultProjection(value, expected, keys));
  }
  if (!isRecord(container) || !isRecord(expected)) return false;
  if (
    keys.every(
      (key) =>
        Object.hasOwn(expected, key) &&
        Object.hasOwn(container, key) &&
        isDeepStrictEqual(container[key], expected[key]),
    )
  ) {
    return true;
  }
  return Object.values(container).some((value) => containsNamedResultProjection(value, expected, keys));
}

function containsResultProjection(container: unknown, expected: unknown): boolean {
  if (isDeepStrictEqual(container, expected)) return true;
  if (Array.isArray(container)) {
    return container.some((value) => containsResultProjection(value, expected));
  }
  if (!isRecord(container)) return false;
  if (isRecord(expected)) {
    const expectedEntries = Object.entries(expected);
    if (
      expectedEntries.length > 0 &&
      expectedEntries.every(([key, value]) => Object.hasOwn(container, key) && isDeepStrictEqual(container[key], value))
    ) {
      return true;
    }
  }
  return Object.values(container).some((value) => containsResultProjection(value, expected));
}

function containsValue(container: unknown, expected: unknown): boolean {
  if (isDeepStrictEqual(container, expected)) {
    return true;
  }
  if (Array.isArray(container)) {
    return container.some((value) => containsValue(value, expected));
  }
  return isRecord(container) && Object.values(container).some((value) => containsValue(value, expected));
}

function promptContainsValue(prompt: string, value: unknown): boolean {
  if (typeof value === "string") {
    return prompt.includes(value);
  }
  const serialized = JSON.stringify(value);
  return serialized !== undefined && prompt.includes(serialized);
}

function promptContainsCandidate(prompt: string, candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate.id === "string" &&
    typeof candidate.proposal === "string" &&
    prompt.includes(candidate.id) &&
    prompt.includes(candidate.proposal)
  );
}

function isIdentityKey(key: string): boolean {
  return /^(?:id|candidate.?id)$/i.test(key);
}

function isDecisionBooleanKey(key: string): boolean {
  return /^(?:accept|accepted|pass|passed|selected)$/i.test(key);
}

function isDecisionExplanationKey(key: string): boolean {
  return /^(?:reason|rationale|explanation)$/i.test(key);
}

function hasDecisionProperties(properties: Record<string, unknown>): boolean {
  return Object.keys(properties).some(
    (key) => isDecisionBooleanKey(key) || isDecisionExplanationKey(key) || /^(?:decision|verdict|score)$/i.test(key),
  );
}

function schemaLiteralOr(schema: unknown, fallback: unknown): unknown {
  if (isRecord(schema) && Object.hasOwn(schema, "const")) {
    return schema.const;
  }
  if (isRecord(schema) && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  return fallback;
}

function isCandidateSchema(schema: unknown): boolean {
  if (!isRecord(schema) || schema.type !== "object") {
    return false;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.hasOwn(properties, "id") && Object.hasOwn(properties, "proposal") && !hasDecisionProperties(properties);
}

function schemaContainsCandidate(schema: unknown): boolean {
  if (isCandidateSchema(schema)) {
    return true;
  }
  if (!isRecord(schema)) {
    return false;
  }
  if (
    (Object.hasOwn(schema, "const") && generatedCandidatesFromResult(schema.const) !== null) ||
    (Array.isArray(schema.enum) && generatedCandidatesFromResult(schema.enum) !== null)
  ) {
    return true;
  }
  if (schema.type === "array") {
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    return (
      prefixItems.some((itemSchema) => schemaContainsCandidate(itemSchema)) ||
      (schema.items !== false && (schema.items === undefined || schemaContainsCandidate(schema.items)))
    );
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.values(properties).some((propertySchema) => schemaContainsCandidate(propertySchema));
}

function isGenerateFilterGeneratorSchema(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (hasDecisionProperties(properties)) {
    return false;
  }
  return schemaContainsCandidate(schema);
}

function candidateFromSchema(
  schema: unknown,
  candidate: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const sampled = sampleSchema(schema, label, typeof candidate.id === "string" ? candidate.id : undefined);
  if (!isRecord(sampled)) {
    return candidate;
  }
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  return {
    ...sampled,
    id: schemaLiteralOr(properties.id, candidate.id),
    proposal: schemaLiteralOr(properties.proposal, candidate.proposal),
  };
}

function fillGeneratorSchema(
  schema: unknown,
  candidates: Array<Record<string, unknown>>,
  label: string,
): GeneratorFixtureValue {
  if (isRecord(schema) && Object.hasOwn(schema, "const")) {
    return {
      value: schema.const,
      consumed: generatedCandidatesFromResult(schema.const)?.length ?? 0,
    };
  }
  if (isCandidateSchema(schema)) {
    const candidate = candidates[0] ?? { id: "signal-a", proposal: "proposal:signal-a" };
    return { value: candidateFromSchema(schema, candidate, label), consumed: 1 };
  }
  if (!isRecord(schema)) {
    return { value: candidates, consumed: candidates.length };
  }
  if (schema.type === "array") {
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    const prefixed = prefixItems.map((itemSchema, index) => {
      const candidate = candidates[index] ?? { id: `signal-${index + 1}`, proposal: `proposal:signal-${index + 1}` };
      return candidateFromSchema(itemSchema, candidate, label);
    });
    if (schema.items === false) {
      return { value: prefixed, consumed: prefixed.length };
    }
    const enumeratedItems =
      isRecord(schema.items) && Array.isArray(schema.items.enum)
        ? generatedCandidatesFromResult(schema.items.enum)
        : null;
    if (enumeratedItems) {
      const maxItems =
        typeof schema.maxItems === "number" && Number.isFinite(schema.maxItems)
          ? Math.max(0, Math.floor(schema.maxItems))
          : enumeratedItems.length + prefixed.length;
      const selected = enumeratedItems.slice(0, Math.max(0, maxItems - prefixed.length));
      return { value: [...prefixed, ...selected], consumed: prefixed.length + selected.length };
    }
    const remaining = candidates.slice(prefixed.length);
    return {
      value: [...prefixed, ...remaining.map((candidate) => candidateFromSchema(schema.items, candidate, label))],
      consumed: prefixed.length + remaining.length,
    };
  }
  const sampled = sampleSchema(schema, label);
  if (!isRecord(sampled)) {
    return { value: sampled, consumed: 0 };
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  let consumed = 0;
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!schemaContainsCandidate(propertySchema)) {
      continue;
    }
    const nested = fillGeneratorSchema(propertySchema, candidates.slice(consumed), label);
    sampled[key] = nested.value;
    consumed += nested.consumed;
  }
  return { value: sampled, consumed };
}

function createGeneratorResult(schema: unknown, candidates: Array<Record<string, unknown>>, label: string): unknown {
  if (isCandidateSchema(schema)) {
    const duplicate = candidates.find(({ id }) => id === "shared") ?? candidates[0];
    return duplicate ? candidateFromSchema(schema, duplicate, label) : sampleSchema(schema, label);
  }
  return fillGeneratorSchema(schema, candidates, label).value;
}

function generatedCandidatesFromResult(result: unknown): Array<Record<string, unknown>> | null {
  const candidates: Array<Record<string, unknown>> = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (typeof value.id === "string" && typeof value.proposal === "string") {
      candidates.push(value);
      return;
    }
    for (const nested of Object.values(value)) {
      collect(nested);
    }
  };
  collect(result);
  return candidates.length > 0 ? candidates : null;
}

function fillFilterDecisionSchema(schema: unknown, identity: string, accepted: boolean, label: string): unknown {
  if (!isRecord(schema) || schema.type !== "object") {
    return sampleSchema(schema, label, identity);
  }
  const sampled = sampleSchema(schema, label, identity);
  if (!isRecord(sampled)) {
    return sampled;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (isIdentityKey(key)) {
      sampled[key] = schemaLiteralOr(propertySchema, identity);
    } else if (key === "proposal") {
      sampled[key] = schemaLiteralOr(propertySchema, `proposal:${identity}`);
    } else if (isDecisionBooleanKey(key)) {
      sampled[key] = schemaLiteralOr(propertySchema, accepted);
    } else if (isDecisionExplanationKey(key)) {
      sampled[key] = schemaLiteralOr(propertySchema, `filter:${identity}`);
    } else if (isRecord(propertySchema) && propertySchema.type === "object") {
      sampled[key] = fillFilterDecisionSchema(propertySchema, identity, accepted, label);
    }
  }
  return sampled;
}

function createFilterDecisionResult(schema: unknown, identity: string, accepted: boolean): unknown {
  const result = fillFilterDecisionSchema(schema, identity, accepted, `filter:${identity}`);
  if (isRecord(result) && Object.keys(result).length > 0) {
    return result;
  }
  return { id: identity, accepted, reason: `filter:${identity}` };
}

function filterDecisionIsAccepted(result: unknown): boolean {
  if (Array.isArray(result)) {
    return result.some((value) => filterDecisionIsAccepted(value));
  }
  if (!isRecord(result)) {
    return false;
  }
  return Object.entries(result).some(
    ([key, value]) =>
      (isDecisionBooleanKey(key) && value === true) ||
      ((!isDecisionBooleanKey(key) || value !== false) && filterDecisionIsAccepted(value)),
  );
}

function containsCandidateProjection(container: unknown, candidate: Record<string, unknown>): boolean {
  return containsNamedResultProjection(container, candidate, ["id", "proposal"]);
}

function decisionPayloadValues(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result.flatMap((value) => decisionPayloadValues(value));
  }
  if (!isRecord(result)) {
    return [];
  }
  return Object.entries(result).flatMap(([key, value]) => {
    if (isDecisionExplanationKey(key)) {
      return [value];
    }
    return decisionPayloadValues(value);
  });
}

function containsFilterDecisionEvidence(container: unknown, result: unknown, identity: string): boolean {
  if (containsResultProjection(container, result)) {
    return true;
  }
  if (!containsIdentity(container, identity)) {
    return false;
  }
  return decisionPayloadValues(result).every((value) => containsValue(container, value));
}

function singleFieldProjection(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  const values = Object.values(value);
  return values.length === 1 ? values : [];
}

function jsonValuesInText(text: string): unknown[] {
  const values: unknown[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{" || character === "[") {
        depth++;
      } else if (character === "}" || character === "]") {
        depth--;
        if (depth === 0) {
          try {
            const parsed: unknown = JSON.parse(text.slice(start, end + 1));
            values.push(parsed);
          } catch {
            // Continue scanning other balanced JSON candidates in the prompt.
          }
          start = end;
          break;
        }
      }
    }
  }
  return values;
}

function promptContainsJsonProjection(prompt: string, result: unknown): boolean {
  return promptContainsValue(prompt, result) || jsonValuesInText(prompt).some((value) => containsValue(value, result));
}

function promptContainsResultOrSingleFieldProjection(prompt: string, result: unknown): boolean {
  return (
    promptContainsJsonProjection(prompt, result) ||
    singleFieldProjection(result).some((value) => promptContainsJsonProjection(prompt, value))
  );
}

function containsMissingCoverage(container: unknown, identity: string): boolean {
  if (Array.isArray(container)) {
    return container.some((value) => containsMissingCoverage(value, identity));
  }
  if (!isRecord(container)) {
    return false;
  }
  if (containsIdentity(container, identity)) {
    const missing = Object.entries(container).some(([key, value]) => {
      if (/^(?:missing|failed|unavailable)$/i.test(key)) {
        return value === true || containsIdentity(value, identity);
      }
      if (/^status$/i.test(key)) {
        return typeof value === "string" && /miss|fail|unavailable/i.test(value);
      }
      if (/^(?:result|value|data)$/i.test(key)) {
        return value === null;
      }
      if (/^missing.*ids?$/i.test(key)) {
        return containsIdentity(value, identity);
      }
      return false;
    });
    if (missing) {
      return true;
    }
  }
  return Object.values(container).some((value) => containsMissingCoverage(value, identity));
}

function judgedAttemptFromPrompt(prompt: string, candidateResult: unknown): unknown {
  return jsonValuesInText(prompt).find((value) => containsResultProjection(value, candidateResult));
}

function containsResultOrSingleFieldProjection(container: unknown, result: unknown): boolean {
  return (
    containsValue(container, result) || singleFieldProjection(result).some((value) => containsValue(container, value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function serializable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function failure(stage: Exclude<ComprehensionFailureStage, "assertion">, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    stage,
    message,
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}
