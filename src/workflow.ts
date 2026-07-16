import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { AgentTelemetry, AgentUsage } from "./agent.js";
import {
  resolveAgentModelSpec,
  resolveAgentThinkingLevel,
  resolveModelAlias,
  WorkflowAgent,
  type WorkflowAgentOptions,
} from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import {
  type JsonTreePrototypes,
  normalizeJsonChildArgs,
  normalizeJsonResult,
  normalizeJsonTree,
} from "./json-value.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import {
  canonicalModelSpec,
  isThinkingLevel,
  type ModelThinkingLevel,
  resolveModelSpecWithThinking,
  splitModelSpecThinking,
} from "./model-spec.js";
import { loadModelTierConfig, type ModelTierConfig } from "./model-tier-config.js";
import { createAgentStoreTools, SharedStore } from "./shared-store.js";
import type { WorkflowSchema } from "./structured-output.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowScriptDescriptor {
  scriptPath: string;
}

/** Injectable secure-open filesystem seam used by deterministic TOCTOU tests. */
export interface WorkflowScriptFsLayer {
  realpathSync(path: string): string;
  lstatSync(path: string): Stats;
  statSync(path: string): Stats;
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): Stats;
  readFileSync(fd: number, encoding: "utf8"): string;
  closeSync(fd: number): void;
}

export type AgentTypePolicy = "fallback" | "error";

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model/tier. */
  model?: string;
}

/** One cached agent() result, keyed by its deterministic call index. */
export interface JournalEntry {
  index: number;
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result: unknown;
  /**
   * Per-agent write delta (keys set by this agent) for additive replay on resume.
   * Replaces the former full-map snapshot to fix parallel-agent ordering: applying
   * deltas in callSeq order accumulates all agents' writes correctly regardless of
   * which agent finished first. Absent on older journal entries.
   */
  storeDelta?: Record<string, unknown>;
  /** Monotonic execution-time version for each storeDelta key. */
  storeVersions?: Record<string, number>;
  /** Exact telemetry captured when this entry last ran live. */
  telemetry?: AgentTelemetry;
  /** Logical child agents represented by an atomic workflow() entry. */
  agentCount?: number;
  /** Explicit encoding for an atomic child that completed with no return value. */
  resultKind?: "void";
  /** Child agent events needed to reconstruct a fresh manager report on atomic replay. */
  childAgents?: JournaledChildAgent[];
}

export interface JournaledChildAgent {
  /** Internal deterministic invocation identity used to correlate duplicate labels. */
  callId?: string;
  label: string;
  phase?: string;
  prompt: string;
  result: unknown;
  tokens?: number;
  tokenUsage?: AgentUsage;
  model?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  telemetry?: AgentTelemetry;
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  depth: number;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `.pi/agents` (project) +
   * `~/.pi/agent/agents` (user, primary) + `~/.pi/agents` (user, deprecated
   * fallback). Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  /** Unknown explicit agentType behavior. Default: "fallback". */
  agentTypePolicy?: AgentTypePolicy;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /** Resume: cached agent results keyed by deterministic call index. */
  resumeJournal?: Map<number, JournalEntry>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Internal: require this invocation's result to be an exact persisted JSON snapshot. */
  requireJsonResult?: boolean;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /** Internal: cumulative usage restored before a cold resume. */
  initialTokenUsage?: Partial<SharedRuntime["tokenUsage"]>;
  /** Internal: tier configuration snapshotted by the parent atomic workflow. */
  modelTierConfig?: ModelTierConfig | null;
  /**
   * Shared store for this run. One instance is created per top-level run and
   * propagated into nested workflow() calls. Pass an existing instance to share
   * state across a parent and child run; omit to create a fresh isolated store.
   */
  sharedStore?: SharedStore;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
   * default (and journals it), so a detached/background run never hangs.
   */
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { callId?: string; label: string; phase?: string; prompt: string; model?: string }) => void;
  onAgentEnd?: (event: {
    callId?: string;
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    tokenUsage?: AgentUsage;
    worktree?: string;
    model?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    telemetry?: AgentTelemetry;
  }) => void;
  onAgentHistory?: (event: { callId?: string; label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  onTokenUsage?: (usage: WorkflowTokenUsage) => void;
  /** Internal cumulative accounting snapshots emitted after each finalized attempt. */
  onTokenUsageProgress?: (usage: WorkflowTokenUsage) => void;
}

export interface WorkflowTokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface AgentOptions<TSchemaDef extends WorkflowSchema | undefined = WorkflowSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * The workflow author chooses per-agent models per the routing policy in the
   * tool guidelines (e.g. a lighter model for exploration, the main model for
   * analysis). When omitted, the session's main model is used.
   */
  model?: string;
  /**
   * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
   * model-tiers config (see /workflows-models). An explicit `model` takes
   * precedence; a tier takes precedence over the phase model. When the tier has
   * no configured entry it falls back to the session's main model.
   */
  tier?: string;
  /** Explicit Pi thinking level; wins over model suffix and inherited thinking. */
  effort?: ModelThinkingLevel;
  isolation?: "worktree";
  /**
   * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist, model, and body prompt
   * to this agent. An explicit `model` overrides the definition's model; the
   * definition's model overrides `tier`/phase. An unknown name logs a warning
   * and falls back to default tools/model (with the name as a prose hint).
   */
  agentType?: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
}

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
}

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
// This intentionally covers the same dot-property and zero-argument constructor
// forms as the former source-text blocklist. Computed and optional-chaining forms
// remain outside this parse-time check; the runtime prelude remains authoritative.
function isNondeterministicCall(node: AnyNode): boolean {
  if (node.type === "NewExpression") {
    const callee = node.callee as AnyNode;
    return callee.type === "Identifier" && callee.name === "Date" && (node.arguments as AnyNode[]).length === 0;
  }

  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AnyNode;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const object = callee.object as AnyNode;
  const property = callee.property as AnyNode;
  return (
    object.type === "Identifier" &&
    property.type === "Identifier" &&
    ((object.name === "Date" && property.name === "now") || (object.name === "Math" && property.name === "random"))
  );
}

function containsNondeterministicCall(node: AnyNode): boolean {
  if (isNondeterministicCall(node)) return true;
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        if (
          value.some((child) => child && typeof child === "object" && containsNondeterministicCall(child as AnyNode))
        ) {
          return true;
        }
      } else if (containsNondeterministicCall(value as AnyNode)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  // Snapshot effective settings once so external mutation cannot change routing
  // between agents while leaving their deterministic call hashes unchanged.
  const modelAliases = options.modelAliases ? { ...options.modelAliases } : undefined;
  const strictModelResolution = options.strictModelResolution ?? false;
  const modelTierConfig = options.modelTierConfig === undefined ? loadModelTierConfig() : options.modelTierConfig;
  const sessionModel = options.session?.model ? canonicalModelSpec(options.session.model) : undefined;
  // mainModel is the tier fallback, while session.model is the actual default
  // used by an untagged agent when no configured medium tier applies.
  const effectiveMainModel = options.mainModel ?? sessionModel;
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  const agentTypePolicy = options.agentTypePolicy ?? "fallback";
  if (agentTypePolicy !== "fallback" && agentTypePolicy !== "error") {
    throw new WorkflowError(
      'agentTypePolicy must be "fallback" or "error"',
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const agentRunner = options.agent ?? new WorkflowAgent({ ...options, modelAliases, strictModelResolution });
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  const runReplayIdentity = JSON.stringify({
    args: normalizedReplayValue(options.args),
    cwd: baseCwd,
    maxAgents,
    agentTimeoutMs,
    tokenBudget: options.tokenBudget ?? null,
    concurrency,
    agentRetries: normalizeAgentRetries(options.agentRetries ?? 0),
    agentTypePolicy,
    instructions: options.instructions ?? null,
    toolNames: options.tools?.map((tool) => tool.name).sort() ?? [],
  });
  const restoredUsage = options.initialTokenUsage;
  // Global caps + budget are shared with any nested workflow() so they hold across nesting.
  const shared: SharedRuntime = options.sharedRuntime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: restoredUsage?.total ?? 0,
    tokenUsage: {
      input: restoredUsage?.input ?? 0,
      output: restoredUsage?.output ?? 0,
      total: restoredUsage?.total ?? 0,
      cost: restoredUsage?.cost ?? 0,
      cacheRead: restoredUsage?.cacheRead ?? 0,
      cacheWrite: restoredUsage?.cacheWrite ?? 0,
    },
    depth: 0,
  };
  const limiter = shared.limiter;
  const runSignal = options.signal ?? new AbortController().signal;
  // Async context gives each parallel/pipeline operation a cancellable signal
  // without poisoning the workflow-wide signal when user code catches its error.
  const operationSignals = new AsyncLocalStorage<AbortSignal>();
  const currentSignal = () => operationSignals.getStore() ?? runSignal;
  // Unlike shared.agentCount, this counter belongs only to this invocation. It is
  // what an atomic parent journal records, so concurrent parent work is excluded.
  let localAgentCount = 0;

  // One store instance per run; nested workflow() calls inherit the parent's store
  // so all agents across nesting levels share the same key-value space.
  const store: SharedStore = options.sharedStore ?? new SharedStore();
  let scriptJsonPrototypes: JsonTreePrototypes | undefined;

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  const throwIfAborted = (signal = currentSignal()) => {
    if (signal.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const agent = async (prompt: string, agentOptions: AgentOptions = {}) => {
    const executionSignal = currentSignal();
    throwIfAborted(executionSignal);

    // Check agent limit
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }

    const assignedPhase = agentOptions.phase ?? state.currentPhase;

    // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
    // without touching the run's overall budget. Soft (spent accrues post-agent),
    // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
    // work so later phases still proceed.
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }

    const requestedLabel = agentOptions.label?.trim();
    if (
      agentOptions.effort !== undefined &&
      (typeof agentOptions.effort !== "string" || !isThinkingLevel(agentOptions.effort))
    ) {
      throw new WorkflowError(
        `Unknown effort "${String(agentOptions.effort)}"`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }

    // Resolve a named agentType to its bound definition (tools/model/prompt).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      if (agentTypePolicy === "error") {
        throw new WorkflowError(
          `Unknown agentType "${agentOptions.agentType}"`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
    // The "explicit-level" model is opts.model, else the definition's model — either
    // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
    // the phase model) decides inside WorkflowAgent.run().
    const explicitModel = agentOptions.model ?? agentDef?.model;
    const modelSpec =
      explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
    // For display in /workflows: the model this agent runs on — its explicit/phase
    // spec, else the session's main model. The real resolved id overrides this via
    // onModelResolved once the subagent session is created.
    let displayModel = modelSpec ?? effectiveMainModel;
    const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
    const retryAttempts = normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0);
    const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
    const routeIdentity = effectiveRouteIdentity({
      modelSpec,
      tier: agentOptions.tier,
      aliases: modelAliases,
      strict: strictModelResolution,
      tierConfig: modelTierConfig,
      mainModel: effectiveMainModel,
      sessionModel,
      effort: agentOptions.effort,
      inheritedThinking: options.session?.thinkingLevel,
      modelRegistry:
        options.modelRegistry ?? (agentRunner instanceof WorkflowAgent ? agentRunner.getModelRegistry() : undefined),
    });

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const callIndex = state.callSeq++;
    const callHash = hashAgentCall(
      prompt,
      modelSpec,
      assignedPhase,
      agentOptions,
      agentDefinitionKey(agentDef),
      routeIdentity,
      runReplayIdentity,
      timeout,
      retryAttempts,
      resolvedIsolation,
    );
    // Store delta key: callIndex alone is NOT run-unique. A nested workflow()
    // call (see workflowFn below) shares this run's SharedStore instance but
    // restarts its own callSeq at 0, so a parent agent and a concurrently
    // running nested-run agent can both get callIndex 0 and collide in
    // SharedStore.agentDeltas — whichever commits last steals/overwrites the
    // other's journaled delta. Composing the run's own runId (unique per
    // top-level run AND per nested run, see `${runId}-nested${shared.depth}`
    // below) with callIndex makes the key unique across the whole store.
    const deltaKey = `${runId}:${callIndex}`;

    // Reserve the agent slot synchronously — atomic with the limit/budget gate
    // above (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
    // spent accrues after each agent, matching Claude Code; in-flight agents may
    // push slightly past total, then further agent() calls throw.)
    shared.agentCount++;
    localAgentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    const cached = options.resumeJournal?.get(callIndex);
    const hashMatches = cached != null && cached.hash === callHash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
      const replayTelemetry: AgentTelemetry = cached.telemetry
        ? { ...cached.telemetry, execution: "replay" }
        : { execution: "replay", requestedModelSpec: modelSpec };
      displayModel = replayTelemetry.resolvedModel ?? displayModel;
      options.onAgentStart?.({ callId: deltaKey, label, phase: assignedPhase, prompt, model: displayModel });
      options.onAgentEnd?.({
        callId: deltaKey,
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: 0,
        model: displayModel,
        telemetry: replayTelemetry,
      });
      // Captured write versions preserve live execution order even though replay
      // visits calls in lexical call-index order.
      if (cached.storeDelta) store.applyDelta(cached.storeDelta, cached.storeVersions);
      return cached.result;
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);

    return limiter(async () => {
      throwIfAborted(executionSignal);
      const maxAttempts = retryAttempts + 1;

      options.onAgentStart?.({ callId: deltaKey, label, phase: assignedPhase, prompt, model: displayModel });

      // Optional per-agent worktree isolation (deterministic name -> stable resume keys).
      // Precedence: explicit call-site isolation > agentDef isolation.
      // Note: passing { isolation: undefined } falls through ?? to the def's value — there
      // is no sentinel to suppress a def's isolation at the call site. Remove the agentType
      // or override with a def that has no isolation field if opt-out is needed.
      let worktree: Worktree | undefined;
      if (resolvedIsolation === "worktree") {
        worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
        if (!worktree.isolated) log(`isolation ignored for "${label}" (${worktree.reason})`);
      }
      const runCwd = worktree?.isolated ? worktree.cwd : undefined;

      // Aggregate only finalized attempt-local telemetry. A timed-out runner can
      // keep invoking callbacks after retry starts, so callbacks must never write
      // directly into state shared by attempts.
      let telemetry: AgentTelemetry | undefined;
      const recordTokens = (result: unknown, usage: AgentUsage | undefined): number => {
        const tokens = usage && usage.total > 0 ? usage.total : estimateTokens(result) + estimateTokens(prompt);
        if (usage) {
          shared.tokenUsage.input += usage.input;
          shared.tokenUsage.output += usage.output;
          shared.tokenUsage.cost += usage.cost;
          shared.tokenUsage.cacheRead += usage.cacheRead;
          shared.tokenUsage.cacheWrite += usage.cacheWrite;
        }
        shared.tokenUsage.total += tokens;
        shared.spent += tokens;
        // Publish cumulative usage as soon as an attempt is finalized. Journal
        // persistence may fail before onAgentEnd or the normal workflow return,
        // but the manager still needs the exact consumed budget for its failure
        // snapshot and a later cold resume.
        options.onTokenUsageProgress?.({ ...shared.tokenUsage });
        return tokens;
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const attemptDeltaKey = `${deltaKey}:attempt${attempt}`;
          const attemptController = new AbortController();
          const attemptSignal = combineAbortSignals(executionSignal, attemptController.signal);
          let callbacksOpen = true;
          let attemptDisplayModel = displayModel;
          let attemptUsage: AgentUsage | undefined;
          let attemptTelemetry: AgentTelemetry | undefined;
          let accountedUsage: AgentUsage | undefined;
          let usageRecorded = false;
          let accountedTokens = 0;
          let journalFailure: unknown;
          const finalizeAttempt = (settled: boolean) => {
            callbacksOpen = false;
            if (settled) displayModel = attemptDisplayModel;
            accountedUsage = attemptUsage ?? attemptTelemetry?.usage;
            if (!attemptTelemetry && !accountedUsage && settled) return;
            const finalized: AgentTelemetry = {
              ...(attemptTelemetry ?? { execution: "live", requestedModelSpec: modelSpec }),
              usage: accountedUsage ? { ...accountedUsage } : undefined,
              accountingStatus: settled && accountedUsage ? "exact" : "incomplete",
              accountingIncompleteAttempts: settled ? undefined : 1,
            };
            telemetry = mergeAgentTelemetry(telemetry, finalized);
          };
          try {
            throwIfAborted(executionSignal);

            // Each retry has its own cancellation signal and store scope. A timed-out
            // runner may ignore cancellation, but its closed tools cannot contaminate
            // a later attempt.
            const runnerPromise = agentRunner.run(prompt, {
              label,
              // Identifiable name for persisted sessions (persistAgentSessions).
              sessionName: `workflow:${runId} ${label}`,
              schema: agentOptions.schema,
              signal: attemptSignal,
              instructions: buildAgentInstructions(assignedPhase, agentOptions, agentDef, resolvedIsolation),
              model: modelSpec,
              tier: agentOptions.tier,
              effort: agentOptions.effort,
              modelRegistry: options.modelRegistry,
              modelTierConfig,
              modelAliases,
              strictModelResolution,
              skills: agentDef?.skills,
              toolNames: agentDef?.tools,
              disallowedToolNames: agentDef?.disallowedTools,
              systemTools: createAgentStoreTools(store, attemptDeltaKey),
              cwd: runCwd,
              onModelResolved: (id: string) => {
                if (callbacksOpen) attemptDisplayModel = id;
              },
              onModelFallback: (spec: string) => {
                // Make the silent degrade visible in /workflows, not just console.
                if (callbacksOpen) log(`${label}: model "${spec}" unavailable — using the session default`);
              },
              onUsage: (usage: AgentUsage) => {
                if (callbacksOpen) attemptUsage = { ...usage };
              },
              onTelemetry: (value: AgentTelemetry) => {
                if (callbacksOpen) attemptTelemetry = mergeAgentTelemetry(attemptTelemetry, value);
              },
              onHistory: (history: AgentHistoryEntry[]) => {
                if (callbacksOpen) options.onAgentHistory?.({ callId: deltaKey, label, phase: assignedPhase, history });
              },
            });
            let result: unknown;
            try {
              result = await withTimeout(runnerPromise, timeout, label, () => attemptController.abort());
            } catch (error) {
              attemptController.abort();
              const settled = await waitForRunnerSettlement(runnerPromise, RUNNER_CLEANUP_GRACE_MS);
              finalizeAttempt(settled);
              throw error;
            }
            finalizeAttempt(true);

            throwIfAborted(executionSignal);
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            accountedTokens = recordTokens(result, accountedUsage);
            usageRecorded = true;
            const preparedDelta = store.prepareDelta(attemptDeltaKey);
            try {
              options.onAgentJournal?.({
                index: callIndex,
                hash: callHash,
                result,
                storeDelta: preparedDelta.values,
                storeVersions: preparedDelta.versions,
                telemetry,
              });
            } catch (error) {
              journalFailure = error;
              throw error;
            }
            store.commitDelta(attemptDeltaKey);
            options.onAgentEnd?.({
              callId: deltaKey,
              label,
              phase: assignedPhase,
              result,
              tokens: accountedTokens,
              tokenUsage: accountedUsage,
              worktree: runCwd,
              model: displayModel,
              telemetry,
            });
            return result;
          } catch (error) {
            attemptController.abort();
            // A failed attempt has no durable journal entry, so its writes must not
            // remain observable or contaminate a retry/child invocation delta.
            store.discardDelta(attemptDeltaKey);
            if (!usageRecorded && (accountedUsage || !executionSignal.aborted)) {
              accountedTokens = recordTokens(null, accountedUsage);
              usageRecorded = true;
            }
            if (executionSignal.aborted) throw error;
            if (journalFailure !== undefined) throw journalFailure;

            const workflowError = wrapError(error, { agentLabel: label });
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);

            if (workflowError.recoverable && attempt < maxAttempts) {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              continue;
            }

            options.onAgentEnd?.({
              callId: deltaKey,
              label,
              phase: assignedPhase,
              result: null,
              tokens: accountedTokens,
              tokenUsage: accountedUsage,
              worktree: runCwd,
              model: displayModel,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
              telemetry,
            });

            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              return null;
            }
            throw workflowError;
          }
        }
        return null;
      } finally {
        // Always tear down the worktree, even on timeout/abort.
        if (worktree?.isolated) await removeWorktree(worktree);
      }
    });
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    const parentSignal = currentSignal();
    throwIfAborted(parentSignal);
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    const operationController = new AbortController();
    const operationSignal = combineAbortSignals(parentSignal, operationController.signal);
    let terminalFailure: WorkflowError | undefined;
    const branches = thunks.map((thunk, index) =>
      operationSignals.run(operationSignal, async () => {
        try {
          return await thunk();
        } catch (error) {
          if (parentSignal.aborted || operationController.signal.aborted) throw error;
          const workflowError = wrapError(error);
          if (!workflowError.recoverable) {
            terminalFailure ??= workflowError;
            operationController.abort();
            throw workflowError;
          }
          log(`parallel[${index}] failed: ${workflowError.message}`);
          return null;
        }
      }),
    );
    const settled = await Promise.allSettled(branches);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (terminalFailure) throw terminalFailure;
    if (failure) throw failure.reason;
    return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value);
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    const parentSignal = currentSignal();
    throwIfAborted(parentSignal);
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    const operationController = new AbortController();
    const operationSignal = combineAbortSignals(parentSignal, operationController.signal);
    let terminalFailure: WorkflowError | undefined;
    const branches = items.map((item, index) =>
      operationSignals.run(operationSignal, async () => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted(operationSignal);
            value = await stage(value, item, index);
            throwIfAborted(operationSignal);
          } catch (error) {
            if (parentSignal.aborted || operationController.signal.aborted) throw error;
            const workflowError = wrapError(error);
            if (!workflowError.recoverable) {
              terminalFailure ??= workflowError;
              operationController.abort();
              throw workflowError;
            }
            log(`pipeline[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }
        return value;
      }),
    );
    const settled = await Promise.allSettled(branches);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (terminalFailure) throw terminalFailure;
    if (failure) throw failure.reason;
    return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value);
  };

  // Nested workflow(): run a saved workflow, raw script, or cwd-contained script
  // path inline. The completed child is one atomic parent journal entry: a crash
  // during the child leaves no partial parent entry, so resume reruns it entirely.
  const workflowFn = async (nameOrDescriptor: string | WorkflowScriptDescriptor, ...childArgList: unknown[]) => {
    throwIfAborted();
    if (shared.depth >= 1) {
      throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    if (childArgList.length > 1) {
      throw scriptValidationError("workflow() accepts at most one child args value");
    }
    const childArgsSupplied = childArgList.length === 1;
    let childArgs: unknown;
    if (childArgsSupplied) {
      try {
        childArgs = normalizeJsonChildArgs(childArgList[0], scriptJsonPrototypes);
      } catch {
        throw scriptValidationError("workflow() child args must be deterministic JSON-serializable values");
      }
    }

    const resolved = resolveChildWorkflow(nameOrDescriptor, baseCwd, options.loadSavedWorkflow);
    const callIndex = state.callSeq++;
    const callHash = hashWorkflowCall(
      resolved.identity,
      resolved.script,
      childArgsSupplied,
      childArgs,
      agentRegistrySnapshotKey(agentRegistry),
      agentTypePolicy,
      childEffectiveRoutesIdentity(resolved.script, {
        agentRegistry,
        aliases: modelAliases,
        strict: strictModelResolution,
        tierConfig: modelTierConfig,
        mainModel: effectiveMainModel,
        sessionModel,
        inheritedThinking: options.session?.thinkingLevel,
        modelRegistry:
          options.modelRegistry ?? (agentRunner instanceof WorkflowAgent ? agentRunner.getModelRegistry() : undefined),
      }),
      runReplayIdentity,
    );
    const cached = options.resumeJournal?.get(callIndex);
    const hashMatches = cached != null && cached.hash === callHash;
    if (hashMatches && callIndex < state.firstMiss) {
      const childAgentCount = validateReplayedAgentCount(cached.agentCount);
      let replayResult: unknown;
      if (cached.resultKind === "void") {
        if (cached.result !== null) {
          throw scriptValidationError("replayed atomic void child result must use the canonical null encoding");
        }
        replayResult = undefined;
      } else {
        try {
          replayResult = normalizeJsonResult(cached.result);
        } catch {
          throw scriptValidationError("replayed atomic child result must be deterministic JSON-serializable values");
        }
      }
      if (shared.agentCount + childAgentCount > maxAgents) {
        throw new WorkflowError(
          `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
          WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
          { recoverable: false },
        );
      }
      shared.agentCount += childAgentCount;
      localAgentCount += childAgentCount;
      for (const childAgent of cached.childAgents ?? []) {
        const telemetry: AgentTelemetry = childAgent.telemetry
          ? { ...childAgent.telemetry, execution: "replay" }
          : { execution: "replay" };
        options.onAgentStart?.({
          callId: childAgent.callId,
          label: childAgent.label,
          phase: childAgent.phase,
          prompt: childAgent.prompt,
          model: childAgent.model,
        });
        options.onAgentEnd?.({
          ...childAgent,
          tokens: 0,
          tokenUsage: undefined,
          telemetry,
        });
      }
      if (cached.storeDelta) store.applyDelta(cached.storeDelta, cached.storeVersions);
      return replayResult;
    }
    if (!hashMatches) state.firstMiss = Math.min(state.firstMiss, callIndex);

    const childStore = store.createChildScope();
    const childAgents: JournaledChildAgent[] = [];
    // callIndex is unique for every child invocation in this parent, including
    // sequential failed children at the same nesting depth.
    const childRunId = `${runId}-child${callIndex}`;
    shared.depth++;
    try {
      const child = await runWorkflow(resolved.script, {
        ...options,
        args: childArgsSupplied ? childArgs : undefined,
        mainModel: effectiveMainModel,
        modelAliases,
        strictModelResolution,
        agentRegistry,
        modelTierConfig,
        sharedRuntime: shared,
        // Child writes remain in an overlay until the entire invocation succeeds.
        sharedStore: childStore,
        resumeJournal: undefined,
        resumeFromRunId: undefined,
        onAgentJournal: () => {},
        onAgentStart: (event) => {
          childAgents.push({ ...event, result: undefined });
          options.onAgentStart?.(event);
        },
        onAgentEnd: (event) => {
          const captured = childAgents.find((agent) => agent.callId === event.callId);
          if (captured) Object.assign(captured, event);
          options.onAgentEnd?.(event);
        },
        requireJsonResult: true,
        runId: childRunId,
        persistLogs: false,
      });
      const childAgentCount = child.agentCount;
      const isVoidResult = child.result === undefined;
      const journalResult = isVoidResult ? null : normalizeJsonTree(child.result);
      const returnedResult = isVoidResult ? undefined : normalizeJsonTree(journalResult);
      const preparedDelta = childStore.prepareChildScope();
      options.onAgentJournal?.({
        index: callIndex,
        hash: callHash,
        result: journalResult,
        storeDelta: preparedDelta.values,
        storeVersions: preparedDelta.versions,
        agentCount: childAgentCount,
        resultKind: isVoidResult ? "void" : undefined,
        childAgents,
      });
      childStore.commitChildScope(preparedDelta);
      localAgentCount += childAgentCount;
      return returnedResult;
    } finally {
      childStore.dispose();
      shared.depth--;
    }
  };

  // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
  // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
  // Injected as globals so workflow scripts compose them directly. ──

  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_v, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return { real: votes.length > 0 && realCount / votes.length >= threshold, realCount, total: votes.length, votes };
  };

  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallel(
              Array.from(
                { length: judges },
                (_v, j) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      label: `judge ${idx + 1}.${j + 1}`,
                      schema: JUDGE_SCHEMA,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    return best;
  };

  const loopUntilDry = async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
    const maxRounds = opts.maxRounds ?? 50;
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result, don't abort.
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) break;
        throw error;
      }
      const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return all;
  };

  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };
  const completenessCheck = (taskArgs: unknown, results: unknown) =>
    agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
  // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      const verdict = await validator(last);
      if (verdict?.ok) return { ok: true, value: last, attempts: i + 1 };
      feedback = verdict?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, attempts };
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const callIndex = state.callSeq++;
    const callHash = hashCheckpoint(promptText, checkpointOptions, runReplayIdentity);
    const cached = options.resumeJournal?.get(callIndex);
    if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
      shared.agentCount++;
      localAgentCount++;
      return cached.result; // replay the journaled human reply
    }
    if (cached == null || cached.hash !== callHash) state.firstMiss = Math.min(state.firstMiss, callIndex);
    shared.agentCount++;
    localAgentCount++;

    let reply: unknown;
    if (options.confirm) {
      reply = await options.confirm(promptText, checkpointOptions);
    } else if (checkpointOptions.headless === "abort") {
      throw new WorkflowError(
        `checkpoint "${promptText}" needs human input but none is available (headless run)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
    } else {
      reply = checkpointOptions.default ?? true;
    }
    throwIfAborted();
    options.onAgentJournal?.({ index: callIndex, hash: callHash, result: reply });
    return reply;
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    workflow: workflowFn,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  scriptJsonPrototypes = new vm.Script(
    "({ arrayPrototype: Array.prototype, objectPrototype: Object.prototype })",
  ).runInContext(context) as JsonTreePrototypes;

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  try {
    const rawResult = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
    let result = rawResult;
    if (options.requireJsonResult && rawResult !== undefined) {
      try {
        result = normalizeJsonResult(rawResult, scriptJsonPrototypes);
      } catch {
        throw scriptValidationError("workflow() child result must be deterministic JSON-serializable values");
      }
    }

    // Persist logs
    const logFile = logger.persist();
    if (logFile) {
      log(`Logs persisted to ${logFile}`);
    }

    // Emit final token usage
    options.onTokenUsage?.(shared.tokenUsage);

    return {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: options.sharedRuntime ? localAgentCount : shared.agentCount,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: shared.tokenUsage,
    };
  } finally {
    // Dispose the store only when this run created it; nested runs inherit the
    // parent's store and must not tear it down while the parent is still running.
    if (!options.sharedStore) store.dispose();
  }
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  if (containsNondeterministicCall(ast)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function scriptValidationError(message: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

export function resolveWorkflowScriptPath(
  scriptPath: string,
  cwd: string,
  fsOverride: Partial<WorkflowScriptFsLayer> = {},
): { script: string; identity: string } {
  if (typeof scriptPath !== "string" || scriptPath.trim().length === 0) {
    throw scriptValidationError("workflow() scriptPath must be a non-empty string");
  }
  const fs: WorkflowScriptFsLayer = {
    realpathSync,
    lstatSync,
    statSync,
    openSync,
    fstatSync,
    readFileSync: (fd, encoding) => readFileSync(fd, encoding),
    closeSync,
    ...fsOverride,
  };
  let root: string;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    throw scriptValidationError("workflow cwd does not exist");
  }
  const candidate = resolve(root, scriptPath);
  if (!isPathInside(root, candidate)) {
    throw scriptValidationError("workflow() scriptPath escapes workflow cwd");
  }

  let realPath: string;
  let expected: Stats;
  try {
    const candidateStat = fs.lstatSync(candidate);
    realPath = fs.realpathSync(candidate);
    if (!isPathInside(root, realPath)) {
      throw scriptValidationError("workflow() scriptPath escapes workflow cwd");
    }
    // Because candidate is rooted at the canonical cwd, a different canonical
    // path means at least one path component was a symlink.
    if (candidateStat.isSymbolicLink() || realPath !== candidate) {
      throw scriptValidationError("workflow() scriptPath must not contain symlinks");
    }
    expected = fs.statSync(realPath);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw scriptValidationError("workflow() scriptPath does not exist");
  }
  if (!expected.isFile()) {
    throw scriptValidationError("workflow() scriptPath must reference a file");
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw scriptValidationError("secure workflow scriptPath loading is not supported on this platform");
  }

  let fd: number;
  try {
    fd = fs.openSync(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string }).code === "ELOOP") {
      throw scriptValidationError("workflow() scriptPath must not contain symlinks");
    }
    throw scriptValidationError("workflow() scriptPath could not be opened securely");
  }

  let result: { script: string; identity: string } | undefined;
  let secureReadError: WorkflowError | undefined;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw scriptValidationError("workflow() scriptPath must reference a file");
    }
    if (!sameFileIdentity(expected, opened)) {
      throw scriptValidationError("workflow() scriptPath changed during secure open");
    }
    let currentPath: string;
    let current: Stats;
    try {
      currentPath = fs.realpathSync(candidate);
      current = fs.statSync(currentPath);
    } catch {
      throw scriptValidationError("workflow() scriptPath changed during secure open");
    }
    if (currentPath !== realPath || !isPathInside(root, currentPath) || !sameFileIdentity(opened, current)) {
      throw scriptValidationError("workflow() scriptPath changed during secure open");
    }
    result = { script: fs.readFileSync(fd, "utf8"), identity: `path:${realPath}` };
  } catch (error) {
    secureReadError =
      error instanceof WorkflowError
        ? error
        : scriptValidationError("workflow() scriptPath could not be read securely");
  }
  try {
    fs.closeSync(fd);
  } catch {
    secureReadError ??= scriptValidationError("workflow() scriptPath descriptor could not be closed");
  }
  if (secureReadError) throw secureReadError;
  if (!result) throw scriptValidationError("workflow() scriptPath could not be read securely");
  return result;
}

function resolveChildWorkflow(
  reference: string | WorkflowScriptDescriptor,
  cwd: string,
  loadSavedWorkflow: ((name: string) => string | undefined) | undefined,
): { script: string; identity: string } {
  if (typeof reference === "string") {
    const saved = loadSavedWorkflow?.(reference);
    return saved === undefined
      ? { script: reference, identity: `raw:${reference}` }
      : { script: saved, identity: `saved:${reference}` };
  }

  if (!isWorkflowScriptDescriptor(reference)) {
    throw scriptValidationError("workflow() descriptor must contain exactly one string scriptPath");
  }

  return resolveWorkflowScriptPath(reference.scriptPath, cwd);
}

function isWorkflowScriptDescriptor(value: unknown): value is WorkflowScriptDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "scriptPath") return false;
  const scriptPath = (value as { scriptPath?: unknown }).scriptPath;
  return typeof scriptPath === "string" && scriptPath.trim().length > 0;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

function hashWorkflowCall(
  identity: string,
  script: string,
  argsSupplied: boolean,
  args: unknown,
  agentRegistryKey: string,
  agentTypePolicy: AgentTypePolicy,
  routeIdentity: string,
  runIdentity: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        identity,
        script,
        argsSupplied,
        args: argsSupplied ? args : null,
        agentRegistry: agentRegistryKey,
        agentTypePolicy,
        routeIdentity,
        runIdentity,
      }),
    )
    .digest("hex");
}

function agentRegistrySnapshotKey(registry: AgentRegistry): string {
  return JSON.stringify(
    [...registry.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => [name, agentDefinitionKey(definition)]),
  );
}

function validateReplayedAgentCount(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw scriptValidationError("replayed atomic child agentCount must be a non-negative integer");
  }
  return value as number;
}

function normalizedReplayValue(value: unknown): unknown {
  if (value === undefined) return { kind: "undefined" };
  try {
    return { kind: "json", value: normalizeJsonTree(value) };
  } catch {
    return { kind: "unsupported", type: Object.prototype.toString.call(value) };
  }
}

function effectiveRouteIdentity(options: {
  modelSpec?: string;
  tier?: string;
  aliases?: Record<string, string>;
  strict: boolean;
  tierConfig: ModelTierConfig | null;
  mainModel?: string;
  sessionModel?: string;
  effort?: ModelThinkingLevel;
  inheritedThinking?: string;
  modelRegistry?: WorkflowAgentOptions["modelRegistry"];
}): string {
  const requested =
    resolveAgentModelSpec(
      { model: options.modelSpec, tier: options.tier },
      options.mainModel,
      () => options.tierConfig,
    ) ??
    options.sessionModel ??
    options.mainModel;
  const aliased = requested ? resolveModelAlias(requested, options.aliases) : undefined;
  const resolved =
    aliased && options.modelRegistry ? resolveModelSpecWithThinking(aliased, options.modelRegistry) : undefined;
  const fallbackParsed = aliased && !options.modelRegistry ? splitModelSpecThinking(aliased) : undefined;
  const resolvedModel = resolved?.model ? `${resolved.model.provider}/${resolved.model.id}` : undefined;
  const thinking = resolveAgentThinkingLevel(
    options.effort,
    resolved?.thinkingLevel ?? fallbackParsed?.thinkingLevel,
    options.inheritedThinking as ModelThinkingLevel | undefined,
  );
  return JSON.stringify({
    requested: requested ?? null,
    aliased: aliased ?? null,
    resolved: resolvedModel ?? null,
    thinking: thinking ?? null,
    strict: options.strict,
  });
}

function childEffectiveRoutesIdentity(
  script: string,
  options: {
    agentRegistry: AgentRegistry;
    aliases?: Record<string, string>;
    strict: boolean;
    tierConfig: ModelTierConfig | null;
    mainModel?: string;
    sessionModel?: string;
    inheritedThinking?: string;
    modelRegistry?: WorkflowAgentOptions["modelRegistry"];
  },
): string {
  const { meta, body } = parseWorkflowScript(script);
  const routing = parseModelRoutingFromMeta(meta.phases, meta.model);
  const program = parse(body, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
  }) as AnyNode;
  let currentPhase = meta.phases?.[0]?.title;
  let agentReferences = 0;
  let directAgentCalls = 0;
  let helperReferences = 0;
  let directHelperCalls = 0;
  let dynamicRoute = false;
  const routes: string[] = [];
  const agentBackedHelpers = new Set(["verify", "judgePanel", "completenessCheck"]);

  const visit = (node: AnyNode): void => {
    if (node.type === "Identifier" && node.name === "agent") agentReferences++;
    if (node.type === "Identifier" && agentBackedHelpers.has(node.name)) helperReferences++;
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      if (node.callee.name === "phase") {
        const title = literalString(node.arguments?.[0]);
        if (title !== undefined) currentPhase = title;
        else dynamicRoute = true;
      } else if (node.callee.name === "agent") {
        directAgentCalls++;
        const optionsNode = node.arguments?.[1] as AnyNode | undefined;
        dynamicRoute ||= hasDynamicAgentRouteOptions(optionsNode);
        const agentOptions = literalAgentRouteOptions(optionsNode);
        const assignedPhase = agentOptions.phase ?? currentPhase;
        const agentDef = resolveAgentType(agentOptions.agentType, options.agentRegistry);
        const explicitModel = agentOptions.model ?? agentDef?.model;
        const modelSpec =
          explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routing));
        routes.push(
          effectiveRouteIdentity({
            modelSpec,
            tier: agentOptions.tier,
            aliases: options.aliases,
            strict: options.strict,
            tierConfig: options.tierConfig,
            mainModel: options.mainModel,
            sessionModel: options.sessionModel,
            effort: agentOptions.effort,
            inheritedThinking: options.inheritedThinking,
            modelRegistry: options.modelRegistry,
          }),
        );
      } else if (agentBackedHelpers.has(node.callee.name)) {
        directHelperCalls++;
        routes.push(
          effectiveRouteIdentity({
            modelSpec: resolveModelForPhase(currentPhase, routing),
            aliases: options.aliases,
            strict: options.strict,
            tierConfig: options.tierConfig,
            mainModel: options.mainModel,
            sessionModel: options.sessionModel,
            inheritedThinking: options.inheritedThinking,
            modelRegistry: options.modelRegistry,
          }),
        );
      }
    }
    for (const value of Object.values(node)) {
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object") visit(child as AnyNode);
      } else if ("type" in value) {
        visit(value as AnyNode);
      }
    }
  };
  visit(program);

  const declaredRoutes = [meta.model, ...(meta.phases?.map((phase) => phase.model) ?? [])]
    .filter((model): model is string => model !== undefined)
    .map((modelSpec) =>
      effectiveRouteIdentity({
        modelSpec,
        aliases: options.aliases,
        strict: options.strict,
        tierConfig: options.tierConfig,
        mainModel: options.mainModel,
        sessionModel: options.sessionModel,
        inheritedThinking: options.inheritedThinking,
        modelRegistry: options.modelRegistry,
      }),
    );
  const dynamicAgentReference =
    agentReferences > directAgentCalls || helperReferences > directHelperCalls || dynamicRoute;
  return JSON.stringify({
    routes,
    declaredRoutes,
    // Atomic children may invoke agent-backed globals through aliases, computed
    // members, or user-defined wrappers that static syntax inspection cannot
    // resolve soundly. Conservatively bind the child cache to the complete
    // routing environment so no such call can replay across a route change.
    routingEnvironment: {
      aliases: modelAliasesIdentity(options.aliases),
      tiers: options.tierConfig?.tiers ?? null,
      models: modelRegistrySnapshotKey(options.modelRegistry),
      mainModel: options.mainModel ?? null,
      inheritedThinking: options.inheritedThinking ?? null,
      strict: options.strict,
    },
    dynamic: dynamicAgentReference
      ? {
          aliases: modelAliasesIdentity(options.aliases),
          tiers: options.tierConfig?.tiers ?? null,
          models: modelRegistrySnapshotKey(options.modelRegistry),
          defaultRoute: effectiveRouteIdentity({
            aliases: options.aliases,
            strict: options.strict,
            tierConfig: options.tierConfig,
            mainModel: options.mainModel,
            sessionModel: options.sessionModel,
            inheritedThinking: options.inheritedThinking,
            modelRegistry: options.modelRegistry,
          }),
        }
      : null,
  });
}

function hasDynamicAgentRouteOptions(node: AnyNode | undefined): boolean {
  if (!node) return false;
  if (node.type !== "ObjectExpression") return true;
  for (const property of node.properties as AnyNode[]) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") return true;
    const key = propertyKey(property.key as AnyNode, "agent options");
    if (!["model", "tier", "effort", "phase", "agentType"].includes(key)) continue;
    if (literalString(property.value as AnyNode) === undefined) return true;
  }
  return false;
}

function literalAgentRouteOptions(node: AnyNode | undefined): {
  model?: string;
  tier?: string;
  effort?: ModelThinkingLevel;
  phase?: string;
  agentType?: string;
} {
  if (node?.type !== "ObjectExpression") return {};
  const result: { model?: string; tier?: string; effort?: ModelThinkingLevel; phase?: string; agentType?: string } = {};
  for (const property of node.properties as AnyNode[]) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") continue;
    const key = propertyKey(property.key as AnyNode, "agent options");
    const value = literalString(property.value as AnyNode);
    if (value === undefined) continue;
    if (key === "model" || key === "tier" || key === "phase" || key === "agentType") result[key] = value;
    if (key === "effort" && isThinkingLevel(value)) result.effort = value;
  }
  return result;
}

function literalString(node: AnyNode | undefined): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function modelAliasesIdentity(aliases: Record<string, string> | undefined): string {
  return JSON.stringify(
    Object.entries(aliases ?? {})
      .map(([key, value]) => [key.trim().toLowerCase(), value.trim()] as const)
      .filter(([key, value]) => key && value)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function modelRegistrySnapshotKey(registry: WorkflowAgentOptions["modelRegistry"]): unknown {
  if (!registry) return null;
  try {
    return registry
      .getAll()
      .map((model) => [model.provider, model.id, model.name ?? null])
      .sort(([leftProvider, leftId], [rightProvider, rightId]) =>
        `${leftProvider}/${leftId}`.localeCompare(`${rightProvider}/${rightId}`),
      );
  } catch {
    return "unavailable";
  }
}

/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions, runIdentity: string): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
    runIdentity,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
  routeIdentity: string,
  runIdentity: string,
  timeout: number | null,
  retries: number,
  isolation: "worktree" | undefined,
): string {
  const identity = JSON.stringify({
    prompt,
    label: options.label ?? null,
    model: model ?? null,
    tier: options.tier ?? null,
    effort: options.effort ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition includes its prompt, skills, tools, model, and isolation.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
    routeIdentity,
    runIdentity,
    timeout,
    retries,
    isolation: isolation ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use resolvedIsolation so the annotation fires whether isolation came from
  // the call site or from the agentDef's isolation field.
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: WorkflowSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function mergeAgentTelemetry(current: AgentTelemetry | undefined, next: AgentTelemetry): AgentTelemetry {
  if (!current) {
    return {
      ...next,
      activeToolNames: next.activeToolNames ? [...next.activeToolNames] : undefined,
      usage: next.usage ? { ...next.usage } : undefined,
    };
  }
  const usage =
    current.usage && next.usage
      ? {
          input: current.usage.input + next.usage.input,
          output: current.usage.output + next.usage.output,
          cacheRead: current.usage.cacheRead + next.usage.cacheRead,
          cacheWrite: current.usage.cacheWrite + next.usage.cacheWrite,
          total: current.usage.total + next.usage.total,
          cost: current.usage.cost + next.usage.cost,
        }
      : (next.usage ?? current.usage);
  const accountingIncompleteAttempts =
    (current.accountingIncompleteAttempts ?? 0) + (next.accountingIncompleteAttempts ?? 0);
  const accountingStatus =
    current.accountingStatus === "incomplete" || next.accountingStatus === "incomplete"
      ? "incomplete"
      : (next.accountingStatus ?? current.accountingStatus);
  return {
    ...current,
    ...next,
    activeToolNames: next.activeToolNames ? [...next.activeToolNames] : current.activeToolNames,
    usage: usage ? { ...usage } : undefined,
    accountingStatus,
    accountingIncompleteAttempts: accountingIncompleteAttempts || undefined,
  };
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/**
 * Run a promise with a timeout.
 */
function combineAbortSignals(parent: AbortSignal | undefined, attempt: AbortSignal): AbortSignal {
  return parent ? AbortSignal.any([parent, attempt]) : attempt;
}

// Give an aborted SDK session a short chance to finish its finally/dispose path
// and publish exact usage before retrying. An injected runner may ignore abort,
// so this wait is deliberately bounded and incomplete accounting is persisted.
const RUNNER_CLEANUP_GRACE_MS = 50;

async function waitForRunnerSettlement(promise: Promise<unknown>, graceMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (settled: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      resolve(settled);
    };
    const timeoutId = setTimeout(() => finish(false), graceMs);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
