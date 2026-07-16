/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import { MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import { preview, type WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { normalizeJsonTree } from "./json-value.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedExecutionPolicy,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import {
  type AgentTypePolicy,
  type JournalEntry,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowRunResult,
  type WorkflowTokenUsage,
} from "./workflow.js";

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Effective policy for this run; persisted so cold resume keeps strict overrides. */
  agentTypePolicy: AgentTypePolicy;
  /** Effective execution cwd and limits, persisted for cold resume. */
  executionPolicy: PersistedExecutionPolicy;
  /** Monotonic in-process generation used to reject stale persistence writes. */
  generation: number;
  /** Settlement of the currently active generation, including its final persistence write. */
  settlement?: Promise<void>;
  /** Bounded cancellation cleanup shared by pause/stop/resume. */
  cancellationSettlement?: Promise<boolean>;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /** Prevent stale execution settlement from releasing the lease before durable cleanup is safe. */
  leaseReleaseBlocked?: boolean;
  /** True when durable cleanup must remove the run rather than save an aborted marker. */
  deletionRequested?: boolean;
  /** Eventual retry loop that retains the lease until durable cleanup succeeds. */
  durableCleanupSettlement?: Promise<void>;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
  /**
   * Auto-resume eligibility for this run (see ExecOptions.autoResume). Set once
   * at creation and carried through resume() so it survives pause/resume cycles.
   * Undefined means eligible (default-on); false opts out.
   */
  autoResume?: boolean;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /** Unknown explicit agentType behavior. Default: manager policy, then fallback. */
  agentTypePolicy?: AgentTypePolicy;
  /** Per-run execution cwd. Defaults to the manager construction cwd. */
  cwd?: string;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
  /**
   * Whether this run is eligible for auto-resume when it pauses on a provider
   * usage limit. Default-on: omit or pass true to stay eligible, pass false to
   * opt out. Persisted on the run so a cold-start UsageLimitScheduler respects
   * it too. See usage-limit-scheduler.ts.
   */
  autoResume?: boolean;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /**
   * The host Pi session's model registry. When provided, workflow subagents
   * resolve models against the same registry as the main session, including
   * extension-registered providers such as ollama-cloud.
   */
  modelRegistry?: ModelRegistry;
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Unknown explicit agentType behavior. Default: "fallback". */
  agentTypePolicy?: AgentTypePolicy;
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory. Default false (in-memory, discarded).
   */
  persistAgentSessions?: boolean;
  /** Exact, case-insensitive symbolic model aliases from effective workflow settings. */
  modelAliases?: Record<string, string>;
  /** Reject unresolved requested model specs. */
  strictModelResolution?: boolean;
  /**
   * Maximum time pause/stop/delete waits for an abort-ignoring generation before
   * invalidating it and durably making it non-resumable. Default: 5 seconds.
   */
  cancellationGraceMs?: number;
}

export const DEFAULT_CANCELLATION_GRACE_MS = 5_000;

const UNSAFE_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafePlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || UNSAFE_MERGE_KEYS.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function resumeValidationError(message: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

export interface ResumeOptions {
  script?: string;
  args?: unknown;
  argsPatch?: Record<string, unknown>;
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeRetries(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  /** Run ids deleted while an execution may still be unwinding. */
  private deletedRunIds = new Set<string>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The host Pi session's model registry, shared with subagents. */
  private modelRegistry?: ModelRegistry;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultAgentRetries: number;
  private agentTypePolicy: AgentTypePolicy;
  private persistAgentSessions: boolean;
  private modelAliases?: Record<string, string>;
  private strictModelResolution: boolean;
  private cancellationGraceMs: number;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.agentTypePolicy = options.agentTypePolicy ?? "fallback";
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.modelAliases = options.modelAliases ? { ...options.modelAliases } : undefined;
    this.strictModelResolution = options.strictModelResolution ?? false;
    this.cancellationGraceMs = Math.max(1, Math.floor(options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS));
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            this.persistence.save({ ...p, status: "paused" });
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Set the host session's model registry so subagents resolve models consistently. */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /**
   * Expose the host session's model registry to integrations sharing this
   * manager. Workflow execution reads the same registry internally.
   */
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  private resolveExecutionPolicy(exec: ExecOptions = {}, legacy?: PersistedRunState): PersistedExecutionPolicy {
    const persisted = legacy?.executionPolicy;
    if (persisted) return { ...persisted };
    const cwd = exec.cwd ?? legacy?.cwd ?? this.cwd;
    return {
      cwd,
      maxAgents: exec.maxAgents ?? MAX_AGENTS_PER_RUN,
      agentTimeoutMs: exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs,
      tokenBudget: exec.tokenBudget ?? null,
      concurrency: normalizeConcurrency(exec.concurrency ?? this.concurrency),
      agentRetries: normalizeRetries(exec.agentRetries ?? this.defaultAgentRetries),
      agentTypePolicy: exec.agentTypePolicy ?? legacy?.agentTypePolicy ?? this.agentTypePolicy,
    };
  }

  private trackExecution<T>(managed: ManagedRun, execution: Promise<T>): Promise<T> {
    managed.settlement = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private ownsGeneration(managed: ManagedRun, generation: number): boolean {
    return (
      !this.deletedRunIds.has(managed.runId) &&
      this.runs.get(managed.runId) === managed &&
      managed.generation === generation
    );
  }

  private settlementWithinGrace(settlement: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        resolve(false);
      }, this.cancellationGraceMs);
      timer.unref?.();
      settlement.then(() => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Verify that persistence reflects the requested lifecycle state before releasing its lease. */
  private durableCancellationCleanupIsSafe(managed: ManagedRun): boolean {
    try {
      const persisted = this.persistence.load(managed.runId);
      if (managed.deletionRequested) return persisted === null;
      if (managed.status === "paused") return persisted?.status === "paused";
      return persisted === null || persisted.status === "aborted";
    } catch {
      return false;
    }
  }

  /**
   * Keep retrying the requested lifecycle marker/deletion while retaining the
   * lease. A legitimate pause is never deleted as a persistence fallback because
   * that would silently destroy resumability. An aborted run (stop or cancellation
   * timeout) may fall back to deletion because both outcomes are non-resumable.
   */
  private retainLeaseUntilDurableCleanup(managed: ManagedRun): void {
    managed.leaseReleaseBlocked = true;
    if (managed.durableCleanupSettlement) return;

    let attempt = () => {};
    const settlement = new Promise<void>((resolve) => {
      attempt = () => {
        try {
          if (managed.deletionRequested) {
            this.persistence.delete(managed.runId, { preserveLock: true });
          } else if (managed.status === "paused") {
            this.persistRun(managed, true);
          } else {
            try {
              this.persistRun(managed, true);
            } catch {
              this.persistence.delete(managed.runId, { preserveLock: true });
            }
          }
        } catch {
          // Verification below keeps the lease when cleanup remains unsafe.
        }

        if (this.durableCancellationCleanupIsSafe(managed)) {
          managed.durableCleanupSettlement = undefined;
          managed.leaseReleaseBlocked = false;
          this.releaseRunLease(managed);
          resolve();
          return;
        }

        const timer = setTimeout(attempt, Math.min(this.cancellationGraceMs, 100));
        timer.unref?.();
      };
    });
    managed.durableCleanupSettlement = settlement;
    attempt();
  }

  /**
   * Bound cancellation settlement, but release paused/stopped/deleted runs only
   * after persistence reflects a safe lifecycle marker. Failed pause writes keep
   * retrying the paused marker; failed stop/delete cleanup retains the lease so a
   * second process cannot recover or resume stale state.
   */
  private scheduleCancellationCleanup(managed: ManagedRun): Promise<boolean> {
    const requiresDurableCleanup =
      managed.deletionRequested || managed.status === "paused" || managed.status === "aborted";
    if (requiresDurableCleanup && managed.lease) managed.leaseReleaseBlocked = true;
    if (managed.cancellationSettlement) {
      if (requiresDurableCleanup) {
        void managed.cancellationSettlement.then(() => this.retainLeaseUntilDurableCleanup(managed));
      }
      return managed.cancellationSettlement;
    }
    const generation = managed.generation;
    const settlement = managed.settlement;
    if (!settlement) {
      if (requiresDurableCleanup) this.retainLeaseUntilDurableCleanup(managed);
      else this.releaseRunLease(managed);
      return Promise.resolve(true);
    }
    managed.cancellationSettlement = this.settlementWithinGrace(settlement).then((settled) => {
      if (settled) {
        if (requiresDurableCleanup) this.retainLeaseUntilDurableCleanup(managed);
        return true;
      }
      if (this.ownsGeneration(managed, generation)) {
        managed.leaseReleaseBlocked = true;
        managed.generation++;
        managed.status = "aborted";
        managed.error = new WorkflowError(
          `Workflow cancellation did not settle within ${this.cancellationGraceMs}ms; the run was aborted and cannot be resumed safely.`,
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: false },
        );
      }
      this.retainLeaseUntilDurableCleanup(managed);
      return false;
    });
    return managed.cancellationSettlement;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const parsed = parseWorkflowScript(script);
    const executionPolicy = this.resolveExecutionPolicy(exec);
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    const controller = new AbortController();
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      agentTypePolicy: executionPolicy.agentTypePolicy,
      executionPolicy,
      generation: 1,
      journal: [],
      background: true,
      lease,
      autoResume: exec.autoResume,
    };

    this.runs.set(runId, managed);

    try {
      this.persistRun(managed, true);
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.trackExecution(managed, this.executeRun(managed, script, args, exec));
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const executionPolicy = this.resolveExecutionPolicy(exec);
    const managed = this.createManaged(script, args, executionPolicy);
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    managed.autoResume = exec.autoResume;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.trackExecution(managed, this.executeRun(managed, script, args, exec));
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args: unknown, executionPolicy: PersistedExecutionPolicy): ManagedRun {
    const parsed = parseWorkflowScript(script);
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    return {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      agentTypePolicy: executionPolicy.agentTypePolicy,
      executionPolicy,
      generation: 1,
      journal: [],
      background: false,
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const { resumeJournal, externalSignal, onProgress, confirm } = exec;
    const generation = managed.generation;
    const owns = () => this.ownsGeneration(managed, generation);
    const policy = managed.executionPolicy;
    const progress = () => onProgress?.(managed.snapshot);
    const updateTokenUsage = (usage: WorkflowTokenUsage) => {
      if (!owns()) return;
      managed.snapshot.tokenUsage = usage;
      this.emit("tokenUsage", { runId: managed.runId, usage });
      progress();
    };
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
      const result = await runWorkflow(script, {
        cwd: policy.cwd,
        args,
        // Use the managed run's persisted id as the workflow runId so the value
        // returned in result.runId matches the id that listRuns()/resume() use.
        // Otherwise runWorkflow mints an ephemeral `run-<ts>` id and the sync
        // path would surface a non-resumable id to the model.
        runId: managed.runId,
        agent: this.agent,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
        persistAgentSessions: this.persistAgentSessions,
        modelAliases: this.modelAliases,
        strictModelResolution: this.strictModelResolution,
        signal: managed.controller.signal,
        concurrency: policy.concurrency,
        agentRetries: policy.agentRetries,
        agentTypePolicy: policy.agentTypePolicy,
        maxAgents: policy.maxAgents,
        agentTimeoutMs: policy.agentTimeoutMs,
        tokenBudget: policy.tokenBudget,
        initialTokenUsage: resumeJournal ? managed.snapshot.tokenUsage : undefined,
        confirm,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        onAgentJournal: (entry) => {
          if (!owns()) return;
          // The store commits only after this callback returns. Require the journal
          // write and restore the in-memory journal if persistence fails.
          const previous = managed.journal;
          managed.journal = [...managed.journal.filter((e) => e.index !== entry.index), entry];
          try {
            this.persistRun(managed, true);
          } catch (error) {
            managed.journal = previous;
            throw error;
          }
        },
        onLog: (message) => {
          if (!owns()) return;
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          if (!owns()) return;
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          if (!owns()) return;
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            callId: event.callId,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
          });
          this.emit("agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          if (!owns()) return;
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find(
              (candidate) =>
                candidate.status === "running" &&
                (event.callId ? candidate.callId === event.callId : candidate.label === event.label),
            );
          if (agent) {
            const hasErrorMetadata = event.error !== undefined || event.errorCode !== undefined;
            agent.status = hasErrorMetadata ? "error" : "done";
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.tokens = event.tokens;
            if (event.tokenUsage) agent.tokenUsage = event.tokenUsage;
            agent.telemetry = event.telemetry;
            if (event.model) agent.model = event.model;
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          if (!owns()) return;
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find(
              (candidate) =>
                candidate.status === "running" &&
                (event.callId ? candidate.callId === event.callId : candidate.label === event.label),
            );
          if (agent) {
            agent.history = event.history;
          }
          this.emit("agentHistory", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsageProgress: updateTokenUsage,
        onTokenUsage: updateTokenUsage,
      });

      if (!owns()) {
        throw new WorkflowError("Workflow generation no longer owns this run", WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: false,
        });
      }
      managed.status = "completed";
      managed.result = result;
      this.emit("complete", { runId: managed.runId, result });

      // Persist final state
      this.persistRun(managed);
      this.releaseRunLease(managed);

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            );

      if (!owns()) {
        this.releaseRunLease(managed);
        throw workflowError;
      }

      const usageLimitPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
      if (managed.controller.signal.aborted) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
        if (managed.status === "running") {
          managed.status = "aborted";
        }
      } else if (usageLimitPaused) {
        // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
        // the persisted journal (completed agent results) is replayed by resume()
        // once the budget refills — instead of the user starting from scratch.
        managed.status = "paused";
        managed.leaseReleaseBlocked = Boolean(managed.lease);
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      if (usageLimitPaused) {
        this.emit("paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else if (this.listenerCount("error") > 0) {
        this.emit("error", { runId: managed.runId, error: workflowError });
      }

      // Persist final state. A usage-limit pause has no external cancellation
      // cleanup callback, so it starts its own durable-marker retry before the
      // execution lease can be released.
      this.persistRun(managed);
      if (usageLimitPaused) this.retainLeaseUntilDurableCleanup(managed);
      else this.releaseRunLease(managed);

      throw workflowError;
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    if (managed.leaseReleaseBlocked) {
      if (!this.durableCancellationCleanupIsSafe(managed)) return;
      managed.leaseReleaseBlocked = false;
    }
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private persistRun(managed: ManagedRun, required = false) {
    if (this.deletedRunIds.has(managed.runId)) return;
    const current = this.runs.get(managed.runId);
    if (current && current.generation !== managed.generation) return;
    try {
      this.persistence.save({
        runId: managed.runId,
        workflowName: managed.snapshot.name,
        // Persist the real script + journal so the run can be resumed. Runs live
        // in workflow run storage — protect via directory permissions, not blanking.
        script: managed.script,
        args: managed.args,
        cwd: managed.executionPolicy.cwd,
        executionPolicy: managed.executionPolicy,
        agentTypePolicy: managed.agentTypePolicy,
        sessionId: this.sessionId,
        journal: managed.journal,
        status: managed.status,
        // Persisted every write (not just at pause) so a stale read during the
        // "paused" event race (see UsageLimitScheduler) is still correct — this
        // is fixed at run-start and doesn't change over the run's lifetime.
        autoResume: managed.autoResume,
        // Why a usage-limit pause happened, so the navigator / a future cold start
        // can show it and (eventually) re-arm resume after the budget refills.
        pauseReason:
          managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
            ? "usage_limit"
            : undefined,
        resetHint:
          managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
            ? managed.error.resetHint
            : undefined,
        phases: managed.snapshot.phases,
        currentPhase: managed.snapshot.currentPhase,
        agents: managed.snapshot.agents.map((a) => ({
          ...a,
          startedAt: managed.startedAt.toISOString(),
          endedAt: new Date().toISOString(),
        })),
        logs: managed.snapshot.logs,
        result: managed.result?.result,
        tokenUsage: managed.snapshot.tokenUsage
          ? {
              input: managed.snapshot.tokenUsage.input,
              output: managed.snapshot.tokenUsage.output,
              total: managed.snapshot.tokenUsage.total,
              cost: managed.snapshot.tokenUsage.cost,
              cacheRead: managed.snapshot.tokenUsage.cacheRead,
              cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
            }
          : undefined,
        startedAt: managed.startedAt.toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
        durationMs: managed.result?.durationMs,
      });
    } catch (err) {
      if (required) throw err;
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    managed.leaseReleaseBlocked = Boolean(managed.lease);
    this.emit("paused", { runId });
    this.persistRun(managed);
    // A normal pause remains resumable after settlement. The bounded cleanup
    // invalidates an abort-ignoring generation and makes it durably non-resumable.
    void this.scheduleCancellationCleanup(managed);
    return true;
  }

  /** Resume with the persisted input, an edited script/input replacement, or a safe shallow args patch. */
  async resume(runId: string, options: ResumeOptions = {}): Promise<boolean> {
    const hasArgs = Object.hasOwn(options, "args");
    const hasArgsPatch = Object.hasOwn(options, "argsPatch");
    if (hasArgs && hasArgsPatch) {
      throw resumeValidationError("resume args and argsPatch are mutually exclusive");
    }
    if (hasArgsPatch && !isSafePlainObject(options.argsPatch)) {
      throw resumeValidationError("resume argsPatch must be a safe plain object");
    }

    const active = this.runs.get(runId);
    if (active?.status === "running" || active?.status === "aborted") return false;
    // A paused generation keeps exclusive ownership while it unwinds. This wait
    // is bounded; timeout invalidates that generation and makes the run safely
    // non-resumable instead of allowing overlap or hanging forever.
    const settled = active?.cancellationSettlement
      ? await active.cancellationSettlement
      : active?.settlement
        ? await this.settlementWithinGrace(active.settlement)
        : true;
    if (!settled) {
      throw (
        active?.error ??
        new WorkflowError(
          `Workflow cancellation did not settle within ${this.cancellationGraceMs}ms; the run cannot be resumed safely.`,
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: false },
        )
      );
    }

    // Acquire first, then reload every persisted field under the lease. This
    // closes the status/script/args/journal/policy TOCTOU window between callers.
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    let leaseTransferred = false;
    try {
      const persisted = this.persistence.load(runId);
      if (
        !persisted?.script ||
        persisted.status === "running" ||
        persisted.status === "completed" ||
        persisted.status === "aborted"
      ) {
        return false;
      }

      let resumedArgs = hasArgs ? options.args : persisted.args;
      if (hasArgsPatch) {
        const argsPatch = options.argsPatch as Record<string, unknown>;
        if (persisted.args !== undefined && !isSafePlainObject(persisted.args)) {
          throw resumeValidationError("persisted workflow args are incompatible with argsPatch");
        }
        try {
          const normalizedPatch = normalizeJsonTree(argsPatch) as Record<string, unknown>;
          resumedArgs = normalizeJsonTree({
            ...((persisted.args as Record<string, unknown> | undefined) ?? {}),
            ...normalizedPatch,
          });
        } catch {
          throw resumeValidationError("resume argsPatch must contain only plain JSON values");
        }
      }

      const script = options.script ?? persisted.script;
      const parsed = parseWorkflowScript(script);
      const executionPolicy = this.resolveExecutionPolicy({}, persisted);
      const managed: ManagedRun = {
        runId,
        status: "running",
        snapshot: {
          name: parsed.meta.name,
          phases: persisted.phases ?? [],
          logs: persisted.logs ?? [],
          agents: [],
          agentCount: 0,
          runningCount: 0,
          doneCount: 0,
          errorCount: 0,
          tokenUsage: persisted.tokenUsage
            ? {
                input: persisted.tokenUsage.input,
                output: persisted.tokenUsage.output,
                total: persisted.tokenUsage.total,
                cost: persisted.tokenUsage.cost,
                cacheRead: persisted.tokenUsage.cacheRead,
                cacheWrite: persisted.tokenUsage.cacheWrite,
              }
            : undefined,
        },
        controller: new AbortController(),
        startedAt: new Date(),
        script,
        args: resumedArgs,
        agentTypePolicy: executionPolicy.agentTypePolicy,
        executionPolicy,
        generation: (active?.generation ?? 0) + 1,
        journal: persisted.journal ?? [],
        background: true,
        lease,
        autoResume: persisted.autoResume,
      };
      this.runs.set(runId, managed);
      try {
        this.persistRun(managed, true);
      } catch (error) {
        if (active) this.runs.set(runId, active);
        else this.runs.delete(runId);
        throw error;
      }
      leaseTransferred = true;

      const resumeJournal = new Map((persisted.journal ?? []).map((entry) => [entry.index, entry] as const));
      this.emit("resumed", { runId });
      const execution = this.trackExecution(managed, this.executeRun(managed, script, resumedArgs, { resumeJournal }));
      execution.catch(() => {});
      return true;
    } finally {
      if (!leaseTransferred) this.persistence.releaseRunLease(lease);
    }
  }

  /** Acquire and revalidate a settled paused run before cross-process mutation. */
  private acquireSettledPausedRunLease(managed: ManagedRun): boolean {
    if (managed.status !== "paused" || managed.lease) return true;

    let lease: RunLease | null = null;
    try {
      lease = this.persistence.acquireRunLease(managed.runId);
      if (!lease) return false;
      if (this.persistence.load(managed.runId)?.status !== "paused") {
        this.persistence.releaseRunLease(lease);
        return false;
      }
      managed.lease = lease;
      return true;
    } catch {
      if (lease) this.persistence.releaseRunLease(lease);
      return false;
    }
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;
    if (!this.acquireSettledPausedRunLease(managed)) return false;

    managed.controller.abort();
    managed.status = "aborted";
    managed.leaseReleaseBlocked = Boolean(managed.lease);
    this.emit("stopped", { runId });
    this.persistRun(managed);
    void this.scheduleCancellationCleanup(managed);
    return true;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /** Resolve an explicit report ID without applying navigator session filtering. */
  getRunForReport(runId: string): PersistedRunState | null {
    return this.persistence.load(runId);
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed && !this.acquireSettledPausedRunLease(managed)) return false;
    if (managed) {
      this.deletedRunIds.add(runId);
      managed.deletionRequested = true;
      managed.leaseReleaseBlocked = Boolean(managed.lease);
      managed.controller.abort();
      // Retain the token during the grace period and, if deletion fails, across
      // retries so stale running state can never be resumed concurrently.
      void this.scheduleCancellationCleanup(managed);
      managed.generation++;
    }
    this.runs.delete(runId);
    return this.persistence.delete(runId, { preserveLock: Boolean(managed?.lease) });
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
