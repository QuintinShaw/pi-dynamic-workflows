/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import { MAX_AGENTS_PER_RUN } from "./config.js";
import { preview, type WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  createRunPersistence,
  createTerminalSnapshot,
  generateRunId,
  LEGACY_EXECUTION_OPTIONS,
  type PersistedExecutionOptions,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
  type TerminalSnapshot,
} from "./run-persistence.js";
import { type JournalEntry, parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";
import { canonicalWorkflowCwd, workflowProjectKey } from "./workflow-paths.js";

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
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /** Canonical execution options captured once and reused verbatim on resume. */
  executionOptions: PersistedExecutionOptions;
  /** Immutable session provenance. */
  originSessionId?: string;
  /** Session that requested the current execution and receives background delivery. */
  deliverySessionId?: string;
  /** Created once for a terminal transition and reused by later persistence writes. */
  terminalSnapshot?: TerminalSnapshot;
  terminalAt?: string;
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /** Settlement of this exact execution generation; replacements await it. */
  settlement?: Promise<unknown>;
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

export interface ExplicitResumeOptions {
  /** Explicit callers retarget delivery to the manager/session requesting the resume. */
  intent?: "explicit";
  script?: string;
  args?: unknown;
}

export interface AutomaticResumeOptions {
  /** Automatic recovery preserves the run's existing delivery target. */
  intent: "automatic";
}

export type ResumeOptions = ExplicitResumeOptions | AutomaticResumeOptions;

export interface WorkflowRunMetadata {
  runId: string;
  workflowName: string;
  status: RunStatus;
  cwd: string;
  projectKey: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  currentPhase?: string;
  phases: string[];
  pauseReason?: string;
  agents: {
    total: number;
    queued: number;
    running: number;
    done: number;
    error: number;
    skipped: number;
  };
  journalEntries: number;
  tokenUsage?: PersistedRunState["tokenUsage"];
  terminal?: {
    version: 1;
    outcome: TerminalSnapshot["outcome"];
    terminalAt: string;
    agents: TerminalSnapshot["agents"];
    journalEntries: number;
    hasResultEvidence: boolean;
    errorCode?: WorkflowErrorCode;
    reason?: TerminalSnapshot["reason"];
  };
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
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory. Default false (in-memory, discarded).
   */
  persistAgentSessions?: boolean;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
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
  private persistAgentSessions: boolean;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = canonicalWorkflowCwd(options.cwd ?? process.cwd());
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
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
            this.persistence.save({ ...p, status: "paused", pauseReason: "host_lost", terminalSnapshot: undefined });
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
      journal: [],
      executionOptions: this.resolveExecutionOptions(exec),
      originSessionId: this.sessionId,
      deliverySessionId: this.sessionId,
      background: true,
      lease,
      autoResume: exec.autoResume,
    };

    this.runs.set(runId, managed);

    try {
      this.persistRun(managed);
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
    const promise = this.executeRun(managed, script, args, exec);
    managed.settlement = promise;
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
    const managed = this.createManaged(script, args, exec);
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    managed.autoResume = exec.autoResume;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.executeRun(managed, script, args, exec);
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown, exec: ExecOptions = {}): ManagedRun {
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
      journal: [],
      executionOptions: this.resolveExecutionOptions(exec),
      originSessionId: this.sessionId,
      deliverySessionId: this.sessionId,
      background: false,
    };
  }

  private resolveExecutionOptions(exec: ExecOptions): PersistedExecutionOptions {
    return {
      maxAgents: exec.maxAgents ?? MAX_AGENTS_PER_RUN,
      concurrency: exec.concurrency ?? this.concurrency,
      agentRetries: exec.agentRetries ?? this.defaultAgentRetries,
      agentTimeoutMs: exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs,
      tokenBudget: exec.tokenBudget ?? null,
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const { resumeJournal, externalSignal, onProgress, confirm } = exec;
    const {
      maxAgents,
      agentTimeoutMs: resolvedAgentTimeoutMs,
      tokenBudget,
      concurrency: resolvedConcurrency,
      agentRetries: resolvedAgentRetries,
    } = managed.executionOptions;
    const ownsGeneration = () =>
      this.runs.get(managed.runId) === managed &&
      managed.status === "running" &&
      !!managed.lease &&
      this.persistence.ownsRunLease(managed.lease);
    const progress = () => {
      if (ownsGeneration()) onProgress?.(managed.snapshot);
    };
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
      const result = await runWorkflow(script, {
        cwd: this.cwd,
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
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        // Keep the original ceiling and seed the fresh runtime with persisted
        // cumulative accounting. Replay costs zero; only new work consumes more.
        tokenBudget,
        initialTokenUsage: managed.snapshot.tokenUsage,
        initialTokenSpend: managed.snapshot.tokenUsage?.total ?? 0,
        confirm,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        onAgentJournal: (entry) => {
          if (!ownsGeneration()) return;
          // Append (crash-safe-ish): keep the latest entry per index, then persist.
          managed.journal = managed.journal.filter((e) => e.index !== entry.index);
          managed.journal.push(entry);
          this.persistRun(managed);
        },
        onLog: (message) => {
          if (!ownsGeneration()) return;
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          if (!ownsGeneration()) return;
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          if (!ownsGeneration()) return;
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
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
          if (!ownsGeneration()) return;
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.tokens = event.tokens;
            if (event.tokenUsage) {
              agent.tokenUsage = event.tokenUsage;
              const prior = managed.snapshot.tokenUsage ?? {
                input: 0,
                output: 0,
                total: 0,
                cost: 0,
                cacheRead: 0,
                cacheWrite: 0,
              };
              managed.snapshot.tokenUsage = {
                input: prior.input + event.tokenUsage.input,
                output: prior.output + event.tokenUsage.output,
                total: prior.total + event.tokenUsage.total,
                cost: (prior.cost ?? 0) + (event.tokenUsage.cost ?? 0),
                cacheRead: (prior.cacheRead ?? 0) + (event.tokenUsage.cacheRead ?? 0),
                cacheWrite: (prior.cacheWrite ?? 0) + (event.tokenUsage.cacheWrite ?? 0),
              };
            }
            if (event.model) agent.model = event.model;
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          if (!ownsGeneration()) return;
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.history = event.history;
          }
          this.emit("agentHistory", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          // Usage may arrive while an intentionally paused generation is
          // settling. Accept it while this generation still owns the lease even
          // though status is no longer "running", and persist immediately.
          if (
            this.runs.get(managed.runId) !== managed ||
            !managed.lease ||
            !this.persistence.ownsRunLease(managed.lease)
          )
            return;
          const persistedBase = managed.snapshot.tokenUsage;
          if (!persistedBase || usage.total >= persistedBase.total) managed.snapshot.tokenUsage = { ...usage };
          this.emit("tokenUsage", { runId: managed.runId, usage });
          this.persistRun(managed);
          progress();
        },
      });

      // The public/control-plane run ID is the persisted manager ID. Keep the
      // runtime's legacy internal run-* identifier for subagent session names.
      result.runId = managed.runId;
      if (managed.status !== "running" || !managed.lease || !this.persistence.ownsRunLease(managed.lease)) {
        throw new WorkflowError("Workflow execution no longer owns its run lease", WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: true,
        });
      }
      managed.status = "completed";
      managed.result = result;
      managed.terminalAt ??= new Date().toISOString();
      this.ensureTerminalSnapshot(managed);
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
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      if (managed.status === "failed" || managed.status === "aborted") {
        managed.terminalAt ??= new Date().toISOString();
        this.ensureTerminalSnapshot(managed, {
          error: { code: workflowError.code, message: workflowError.message },
          reason: managed.status === "aborted" ? "aborted" : undefined,
        });
      }
      if (usageLimitPaused) {
        this.emit("paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else if (!managed.controller.signal.aborted) {
        this.emit("error", { runId: managed.runId, error: workflowError });
      }

      // pause()/stop() persist their transition before releasing the lease. Their
      // aborted execution may settle later; never let that stale catch overwrite a
      // resumed owner that acquired the lease in the meantime.
      if (managed.lease && this.persistence.ownsRunLease(managed.lease)) {
        this.persistRun(managed);
        this.releaseRunLease(managed);
      }

      throw workflowError;
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private toPersistedState(managed: ManagedRun): PersistedRunState {
    return {
      runId: managed.runId,
      cwd: this.cwd,
      projectKey: workflowProjectKey(this.cwd),
      workflowName: managed.snapshot.name,
      // Persist the real script + journal so the run can be resumed. Runs live
      // in workflow run storage — protect via directory permissions, not blanking.
      script: managed.script,
      args: managed.args,
      sessionId: managed.originSessionId,
      originSessionId: managed.originSessionId,
      deliverySessionId: managed.deliverySessionId,
      executionOptions: { ...managed.executionOptions },
      journal: managed.journal,
      status: managed.status,
      // Fixed at run start and retained across manual and automatic resumes.
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
      agents: managed.snapshot.agents.map((agent) => ({
        ...agent,
        startedAt: managed.startedAt.toISOString(),
        endedAt: managed.terminalAt ?? new Date().toISOString(),
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
      updatedAt: managed.terminalAt ?? new Date().toISOString(),
      completedAt: managed.status === "completed" ? managed.terminalAt : undefined,
      durationMs: managed.result?.durationMs,
      terminalSnapshot: managed.terminalSnapshot,
    };
  }

  private ensureTerminalSnapshot(
    managed: ManagedRun,
    options: {
      error?: { code?: WorkflowErrorCode; message: string };
      reason?: "stopped" | "aborted";
    } = {},
  ): void {
    if (managed.terminalSnapshot) return;
    managed.terminalSnapshot = createTerminalSnapshot(this.toPersistedState(managed), {
      terminalAt: managed.terminalAt,
      result: managed.result?.result,
      ...options,
    });
  }

  private persistRun(managed: ManagedRun) {
    try {
      this.persistence.save(this.toPersistedState(managed));
    } catch (err) {
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
    if (managed?.status !== "running" || !managed.lease || !this.persistence.ownsRunLease(managed.lease)) {
      return false;
    }

    managed.controller.abort();
    managed.status = "paused";
    this.emit("paused", { runId });
    this.persistRun(managed);
    // Keep the lease until executeRun settles. Its callbacks are fenced by this
    // generation's status and lease, and resume awaits settlement before takeover.
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   *
   * `opts.script` lets the orchestrating model resume with an EDITED script
   * (cached-prefix reuse / iteration): unchanged agent() calls whose content
   * hash still matches the journal entry at their positional callIndex replay
   * from cache, while the first changed or newly inserted call — and everything
   * after it — re-runs live. When `opts.script` is omitted, resume behaves
   * exactly as before and uses the persisted script (auto-resume, TUI resume);
   * this keeps existing v2.14 single-arg and edited-script callers explicit by
   * default. Automatic recovery must pass `{ intent: "automatic" }`, which
   * preserves the persisted delivery session rather than targeting whichever
   * session happens to be active when the timer fires.
   */
  async resume(runId: string, opts: ResumeOptions = { intent: "explicit" }): Promise<boolean> {
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;
    if (active?.settlement) {
      try {
        await active.settlement;
      } catch {
        // Expected for paused/failed generations; settlement is the fence.
      }
      if (this.runs.get(runId)?.status === "aborted") return false;
    }

    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    const persisted = this.persistence.load(runId);
    if (
      !persisted?.script ||
      persisted.status === "running" ||
      persisted.status === "completed" ||
      persisted.status === "aborted"
    ) {
      this.persistence.releaseRunLease(lease);
      return false;
    }

    // Edited script/args are an explicit-resume feature. Automatic recovery
    // deliberately has no fields with which to mutate the persisted execution.
    const explicit = opts.intent !== "automatic" ? opts : undefined;
    const script = explicit?.script ?? persisted.script;
    const args = explicit?.args !== undefined ? explicit.args : persisted.args;

    const controller = new AbortController();
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        tokenUsage: persisted.tokenUsage ? { ...persisted.tokenUsage } : undefined,
      },
      controller,
      startedAt: validDate(persisted.startedAt),
      // The (possibly edited) script + args become the run's own — persistRun()
      // writes them below, so a later resume sees the edited input.
      script,
      args,
      journal: persisted.journal ?? [],
      executionOptions: { ...(persisted.executionOptions ?? LEGACY_EXECUTION_OPTIONS) },
      originSessionId: persisted.originSessionId ?? persisted.sessionId,
      deliverySessionId:
        opts.intent === "automatic" ? persisted.deliverySessionId : (this.sessionId ?? persisted.deliverySessionId),
      background: true,
      lease,
      // Carry the original opt-out forward across resumes; it's fixed at
      // run-start and persistRun() re-persists it on every subsequent write.
      autoResume: persisted.autoResume,
    };
    this.runs.set(runId, managed);
    // Persist before notifying renderers: listRuns() is their source of truth for
    // lifecycle status, while getRun() supplies the live in-memory snapshot.
    this.persistRun(managed);

    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e] as const));
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    const settlement = this.executeRun(managed, script, args, { resumeJournal });
    managed.settlement = settlement;
    void settlement.catch(() => {});
    return true;
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status === "paused" && managed.lease && this.persistence.ownsRunLease(managed.lease)) {
      managed.status = "aborted";
      managed.terminalAt ??= new Date().toISOString();
      this.ensureTerminalSnapshot(managed, { reason: "stopped" });
      this.emit("stopped", { runId });
      this.persistRun(managed);
      // executeRun still owns this lease until its abort settles.
      return true;
    }
    if (managed?.status === "running") {
      if (!managed.lease || !this.persistence.ownsRunLease(managed.lease)) return false;
      managed.controller.abort();
      managed.status = "aborted";
      managed.terminalAt ??= new Date().toISOString();
      this.ensureTerminalSnapshot(managed, { reason: "stopped" });
      this.emit("stopped", { runId });
      this.persistRun(managed);
      this.releaseRunLease(managed);
      return true;
    }

    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      const persisted = this.persistence.load(runId);
      if (persisted?.status !== "paused") return false;
      const terminalAt = new Date().toISOString();
      const stopped: PersistedRunState = {
        ...persisted,
        status: "aborted",
        pauseReason: undefined,
        resetHint: undefined,
        updatedAt: terminalAt,
        deliverySessionId: persisted.deliverySessionId,
        terminalSnapshot: undefined,
      };
      stopped.terminalSnapshot = createTerminalSnapshot(stopped, { terminalAt, reason: "stopped" });
      this.persistence.save(stopped);
      if (managed) {
        managed.controller.abort();
        managed.status = "aborted";
        managed.deliverySessionId = stopped.deliverySessionId;
        managed.terminalAt = terminalAt;
        managed.terminalSnapshot = stopped.terminalSnapshot;
      }
      this.emit("stopped", { runId });
      return true;
    } finally {
      this.persistence.releaseRunLease(lease);
    }
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
    return this.sessionId
      ? all.filter(
          (run) =>
            (run.originSessionId ?? run.sessionId) === this.sessionId || run.deliverySessionId === this.sessionId,
        )
      : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /** Canonical namespace owned by this manager. */
  getCwd(): string {
    return this.cwd;
  }

  /** Bounded cross-session status for assistant recovery in this cwd namespace. */
  listRunMetadata(limit = 20): WorkflowRunMetadata[] {
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    return this.listAllRuns()
      .slice(0, boundedLimit)
      .map((run) => this.toRunMetadata(run));
  }

  /** Redacted status for one run in this cwd namespace, regardless of origin session. */
  getRunMetadata(runId: string): WorkflowRunMetadata | null {
    const run = this.persistence.load(runId);
    return run ? this.toRunMetadata(run) : null;
  }

  private toRunMetadata(run: PersistedRunState): WorkflowRunMetadata {
    const live = this.runs.get(run.runId);
    const agents = live?.snapshot.agents ?? run.agents;
    const count = (status: PersistedRunState["agents"][number]["status"]) =>
      agents.filter((agent) => agent.status === status).length;
    const terminal = run.terminalSnapshot
      ? {
          version: 1 as const,
          outcome: run.terminalSnapshot.outcome,
          terminalAt: run.terminalSnapshot.terminalAt.slice(0, 64),
          agents: {
            total: run.terminalSnapshot.agents.total,
            done: run.terminalSnapshot.agents.done,
            error: run.terminalSnapshot.agents.error,
            skipped: run.terminalSnapshot.agents.skipped,
          },
          journalEntries: run.terminalSnapshot.journalEntries,
          hasResultEvidence: run.terminalSnapshot.resultEvidence !== undefined,
          errorCode: run.terminalSnapshot.error?.code,
          reason: run.terminalSnapshot.reason,
        }
      : undefined;
    return {
      runId: run.runId.slice(0, 256),
      workflowName: run.workflowName.slice(0, 256),
      status: live?.status ?? run.status,
      cwd: this.cwd,
      projectKey: workflowProjectKey(this.cwd),
      startedAt: run.startedAt.slice(0, 64),
      updatedAt: run.updatedAt.slice(0, 64),
      completedAt: run.completedAt?.slice(0, 64),
      durationMs: run.durationMs,
      currentPhase: (live?.snapshot.currentPhase ?? run.currentPhase)?.slice(0, 256),
      phases: (live?.snapshot.phases ?? run.phases).slice(0, 20).map((phase) => phase.slice(0, 256)),
      pauseReason: run.pauseReason === "usage_limit" || run.pauseReason === "host_lost" ? run.pauseReason : undefined,
      agents: {
        total: agents.length,
        queued: count("queued"),
        running: count("running"),
        done: count("done"),
        error: count("error"),
        skipped: count("skipped"),
      },
      journalEntries: run.journal?.length ?? 0,
      tokenUsage: run.tokenUsage
        ? {
            input: run.tokenUsage.input,
            output: run.tokenUsage.output,
            total: run.tokenUsage.total,
            ...(run.tokenUsage.cost === undefined ? {} : { cost: run.tokenUsage.cost }),
            ...(run.tokenUsage.cacheRead === undefined ? {} : { cacheRead: run.tokenUsage.cacheRead }),
            ...(run.tokenUsage.cacheWrite === undefined ? {} : { cacheWrite: run.tokenUsage.cacheWrite }),
          }
        : undefined,
      terminal,
    };
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
    if (managed) this.releaseRunLease(managed);
    this.runs.delete(runId);
    return this.persistence.delete(runId);
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}

function validDate(value: string | undefined): Date {
  const parsed = value ? new Date(value) : new Date(0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

export interface WorkflowManagerRegistryOptions {
  defaultCwd?: string;
  defaultManager?: WorkflowManager;
  createManager?: (canonicalCwd: string) => WorkflowManager;
  /** Called exactly once for each canonical manager, including a seeded default. */
  onCreate?: (manager: WorkflowManager, canonicalCwd: string) => void;
}

/** Extension-owned manager registry. One manager (and one event/delivery surface) per canonical cwd. */
export class WorkflowManagerRegistry {
  private readonly managers = new Map<string, WorkflowManager>();
  private readonly defaultCwd?: string;
  private readonly createManager: (canonicalCwd: string) => WorkflowManager;
  private readonly onCreate?: (manager: WorkflowManager, canonicalCwd: string) => void;
  private sessionId?: string;
  private sessionConfigured = false;
  private mainModel?: string;
  private mainModelConfigured = false;
  private modelRegistry?: ModelRegistry;

  constructor(options: WorkflowManagerRegistryOptions = {}) {
    this.defaultCwd = options.defaultCwd ? canonicalWorkflowCwd(options.defaultCwd) : undefined;
    this.createManager = options.createManager ?? ((cwd) => new WorkflowManager({ cwd }));
    this.onCreate = options.onCreate;
    if (options.defaultManager) {
      const cwd = this.defaultCwd ?? options.defaultManager.getCwd();
      this.add(cwd, options.defaultManager);
    }
  }

  get size(): number {
    return this.managers.size;
  }

  get(cwd?: string): WorkflowManager {
    const canonicalCwd = canonicalWorkflowCwd(cwd ?? this.defaultCwd ?? process.cwd());
    const existing = this.managers.get(canonicalCwd);
    if (existing) return existing;
    return this.add(canonicalCwd, this.createManager(canonicalCwd));
  }

  forEach(callback: (manager: WorkflowManager, canonicalCwd: string) => void): void {
    for (const [cwd, manager] of this.managers) callback(manager, cwd);
  }

  setSessionId(sessionId: string | undefined): void {
    this.sessionConfigured = true;
    this.sessionId = sessionId;
    this.forEach((manager) => {
      manager.setSessionId(sessionId);
    });
  }

  setMainModel(model: string | undefined): void {
    this.mainModelConfigured = true;
    this.mainModel = model;
    this.forEach((manager) => {
      manager.setMainModel(model);
    });
  }

  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
    this.forEach((manager) => {
      manager.setModelRegistry(registry);
    });
  }

  private add(cwd: string, manager: WorkflowManager): WorkflowManager {
    const canonicalCwd = canonicalWorkflowCwd(cwd);
    const existing = this.managers.get(canonicalCwd);
    if (existing) return existing;
    if (manager.getCwd() !== canonicalCwd) {
      throw new Error(`Workflow manager cwd mismatch: expected ${canonicalCwd}, received ${manager.getCwd()}`);
    }
    if (this.sessionConfigured) manager.setSessionId(this.sessionId);
    if (this.mainModelConfigured) manager.setMainModel(this.mainModel);
    if (this.modelRegistry) manager.setModelRegistry(this.modelRegistry);
    this.managers.set(canonicalCwd, manager);
    this.onCreate?.(manager, canonicalCwd);
    return manager;
  }
}
