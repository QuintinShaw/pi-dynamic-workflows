/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentUsage, WorkflowAgent } from "./agent.js";
import { MAX_AGENTS_PER_RUN } from "./config.js";
import { preview, recomputeWorkflowSnapshot, type WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  createRunPersistence,
  generateRunId,
  type LoadedPersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import {
  type JournalEntry,
  normalizeConcurrency,
  parseWorkflowScript,
  type ResumeAgentState,
  runWorkflow,
  WORKFLOW_PAUSE_ABORT_REASON,
  type WorkflowRunResult,
} from "./workflow.js";
import { removeWorktree, type Worktree } from "./worktree.js";

interface DurableAgentMetadata {
  result?: unknown;
  usage?: AgentUsage;
  startedAt?: string;
  endedAt?: string;
  callHash?: string;
  sessionFile?: string;
  worktree?: Worktree;
}

interface DurableExecutionControls {
  concurrency: number;
  maxAgents: number;
  agentRetries: number;
  agentTimeoutMs: number | null;
  tokenBudget: number | null;
}

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
  /** Serializable execution controls retained across resume. */
  execution: DurableExecutionControls;
  /** Exact usage already consumed before a cold resume. */
  usageBaseline: NonNullable<WorkflowSnapshot["tokenUsage"]>;
  /** Result, exact usage, and timestamps not carried by the display snapshot. */
  durableAgents: Map<string, DurableAgentMetadata>;
  sessionId?: string;
  persistTimer?: ReturnType<typeof setTimeout>;
  /** Current execution settlement, retained across pause so resume can serialize behind it. */
  executionPromise?: Promise<WorkflowRunResult>;
  /** Prevent a stopped run that is still unwinding from recreating its deleted artifact. */
  deleted?: boolean;
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /** First required persistence failure; aborts execution and is surfaced to the caller. */
  durabilityError?: WorkflowError;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
  /** Undefined means eligible; false explicitly disables usage-limit auto-resume. */
  autoResume?: boolean;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Replay these journaled results for the unchanged prefix (resume). */
  resumeJournal?: ReadonlyMap<string | number, JournalEntry>;
  /** Reopen incomplete Pi child sessions instead of starting those invocations fresh. */
  resumeAgents?: ReadonlyMap<string, ResumeAgentState>;
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
  /** Whether provider usage-limit pauses are eligible for scheduler auto-resume. */
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
  /** Persist subagent transcripts through the existing opt-in agent setting. Default false. */
  persistAgentSessions?: boolean;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: ReturnType<typeof createRunPersistence>;
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
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = normalizeConcurrency(options.concurrency ?? 8);
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

  /** Reconcile persisted work not owned by a live process into restart-safe rows. */
  private recoverStaleRuns(): void {
    let persistedRuns: LoadedPersistedRunState[];
    try {
      persistedRuns = this.listAllRuns();
    } catch {
      return;
    }

    for (const persisted of persistedRuns) {
      if (this.runs.has(persisted.runId)) continue;
      let lease: RunLease | null = null;
      try {
        lease = this.persistence.acquireRunLease(persisted.runId);
        if (!lease) continue;
        const current = this.persistence.load(persisted.runId) ?? persisted;
        const status = current.status === "running" ? "paused" : current.status;
        const resumable = status === "pending" || status === "paused" || status === "failed";
        const agents = current.agents.map((agent) => {
          if (agent.status !== "running") return agent;
          return resumable
            ? { ...agent, status: "paused" as const, endedAt: undefined }
            : {
                ...agent,
                status: "skipped" as const,
                endedAt: agent.endedAt ?? current.completedAt ?? current.updatedAt,
              };
        });
        if (status !== current.status || agents.some((agent, index) => agent !== current.agents[index])) {
          this.persistence.save({ ...current, status, agents });
        }
      } catch {
        // Recovery is best-effort per run; one bad artifact must not block the rest.
      } finally {
        if (lease) this.persistence.releaseRunLease(lease);
      }
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
   * The host session's model registry, when set. Read lazily (e.g. by the
   * workflow tool's model routing guideline) since `setModelRegistry` is called
   * from `session_start`, which runs after the tool is created — a snapshot
   * taken at tool-creation time would miss it.
   */
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  private cleanupWorktrees(worktrees: Array<Worktree | undefined>): void {
    const seen = new Set<string>();
    for (const worktree of worktrees) {
      if (!worktree?.isolated || seen.has(worktree.cwd)) continue;
      seen.add(worktree.cwd);
      void removeWorktree(worktree);
    }
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
    const controls = this.resolveExecutionControls(exec);

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
      execution: controls,
      usageBaseline: this.zeroUsage(),
      durableAgents: new Map(),
      sessionId: this.sessionId,
      background: true,
      autoResume: exec.autoResume,
      lease,
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
    const promise = this.beginExecution(managed, script, args, exec);
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
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    try {
      this.persistRun(managed, true);
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(managed.runId);
      throw err;
    }
    return this.beginExecution(managed, script, args, exec);
  }

  private beginExecution(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const promise = this.executeRun(managed, script, args, exec);
    managed.executionPromise = promise;
    void promise.then(
      () => {
        if (managed.executionPromise === promise) managed.executionPromise = undefined;
      },
      () => {
        if (managed.executionPromise === promise) managed.executionPromise = undefined;
      },
    );
    return promise;
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
    const controls = this.resolveExecutionControls(exec);
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
      execution: controls,
      usageBaseline: this.zeroUsage(),
      durableAgents: new Map(),
      sessionId: this.sessionId,
      background: false,
      autoResume: exec.autoResume,
    };
  }

  private zeroUsage(): NonNullable<WorkflowSnapshot["tokenUsage"]> {
    return { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
  }

  private addUsage(left: AgentUsage | undefined, right: AgentUsage): AgentUsage {
    return {
      input: (left?.input ?? 0) + right.input,
      output: (left?.output ?? 0) + right.output,
      cacheRead: (left?.cacheRead ?? 0) + right.cacheRead,
      cacheWrite: (left?.cacheWrite ?? 0) + right.cacheWrite,
      total: (left?.total ?? 0) + right.total,
      cost: (left?.cost ?? 0) + right.cost,
      estimated: right.estimated === true,
    };
  }

  private resolveExecutionControls(exec: ExecOptions): DurableExecutionControls {
    return {
      concurrency: normalizeConcurrency(exec.concurrency ?? this.concurrency),
      maxAgents: exec.maxAgents ?? MAX_AGENTS_PER_RUN,
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
    const { resumeJournal, resumeAgents, externalSignal, onProgress, confirm } = exec;
    const controls = managed.execution;
    const runtimeTokenBudget =
      resumeJournal && controls.tokenBudget !== null
        ? Math.max(0, controls.tokenBudget - managed.usageBaseline.total)
        : controls.tokenBudget;
    const progress = () => onProgress?.(managed.snapshot);
    const refresh = () => {
      managed.snapshot = recomputeWorkflowSnapshot(managed.snapshot);
      progress();
    };
    const agentsByExecutionId = new Map(
      managed.snapshot.agents.flatMap((agent) => (agent.executionId ? [[agent.executionId, agent] as const] : [])),
    );
    const findAgent = (executionId: string) => agentsByExecutionId.get(executionId);
    const invocationBaselines = new Map(
      managed.snapshot.agents.flatMap((agent) => {
        const usage =
          agent.executionId && agent.status !== "done"
            ? managed.durableAgents.get(agent.executionId)?.usage
            : undefined;
        return agent.executionId && usage ? [[agent.executionId, { ...usage, estimated: false }] as const] : [];
      }),
    );
    const resumePhaseUsage = new Map<string, number>();
    if (resumeJournal) {
      for (const agent of managed.snapshot.agents) {
        if (!agent.phase || !agent.executionId) continue;
        const total = managed.durableAgents.get(agent.executionId)?.usage?.total ?? 0;
        resumePhaseUsage.set(agent.phase, (resumePhaseUsage.get(agent.phase) ?? 0) + total);
      }
    }
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
        concurrency: controls.concurrency,
        agentRetries: controls.agentRetries,
        maxAgents: controls.maxAgents,
        agentTimeoutMs: controls.agentTimeoutMs,
        tokenBudget: runtimeTokenBudget,
        confirm,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        resumeAgents,
        resumePhaseUsage,
        onResumeMiss: (replayedExecutionIds) => {
          if (!resumeJournal) return;
          managed.journal = managed.journal.filter((entry) =>
            replayedExecutionIds.has(entry.executionId ?? `${managed.runId}:${entry.index}`),
          );
          this.requirePersist(managed);
        },
        onAgentJournal: (entry) => {
          const baseline = entry.executionId ? invocationBaselines.get(entry.executionId) : undefined;
          const usage = entry.usage
            ? entry.usage.estimated
              ? baseline
              : this.addUsage(baseline, entry.usage)
            : baseline;
          const reconciled = { ...entry, usage: usage ? { ...usage, estimated: false } : undefined };
          managed.journal = managed.journal.filter(
            (existing) =>
              (existing.executionId ?? `${managed.runId}:${existing.index}`) !==
              (reconciled.executionId ?? `${managed.runId}:${reconciled.index}`),
          );
          managed.journal.push(reconciled);
          managed.journal.sort(
            (left, right) =>
              left.index - right.index || (left.executionId ?? "").localeCompare(right.executionId ?? ""),
          );
          // Persist the completed result before the separate terminal-row callback;
          // a crash between callbacks must replay rather than rerun and recharge it.
          this.requirePersist(managed);
        },
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
          progress();
        },
        onAgentQueued: (event) => {
          let agent = findAgent(event.executionId);
          if (!agent) {
            agent = {
              id: managed.snapshot.agents.length + 1,
              executionId: event.executionId,
              callIndex: event.callIndex,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "queued",
              model: event.model,
            };
            managed.snapshot.agents.push(agent);
            agentsByExecutionId.set(event.executionId, agent);
          } else if (!event.replayed) {
            agent.status = "queued";
            agent.label = event.label;
            agent.phase = event.phase;
            agent.prompt = event.prompt;
            agent.resultPreview = undefined;
            agent.error = undefined;
            agent.errorCode = undefined;
            agent.recoverable = undefined;
            agent.tokensEstimated = false;
            const metadata = managed.durableAgents.get(event.executionId) ?? {};
            metadata.result = undefined;
            metadata.endedAt = undefined;
            if (!event.resuming) {
              metadata.sessionFile = undefined;
              metadata.worktree = undefined;
            }
            managed.durableAgents.set(event.executionId, metadata);
            if (event.model) agent.model = event.model;
          }
          const queuedMetadata = managed.durableAgents.get(event.executionId) ?? {};
          queuedMetadata.callHash = event.callHash;
          managed.durableAgents.set(event.executionId, queuedMetadata);
          this.schedulePersist(managed);
          this.emit("agentQueued", { runId: managed.runId, ...event });
          refresh();
        },
        onAgentSession: (event) => {
          const metadata = managed.durableAgents.get(event.executionId) ?? {};
          metadata.sessionFile = event.sessionFile;
          metadata.worktree = event.worktree;
          metadata.callHash = event.callHash;
          managed.durableAgents.set(event.executionId, metadata);
          this.requirePersist(managed);
          this.emit("agentSession", { runId: managed.runId, ...event });
          refresh();
        },
        onAgentStart: (event) => {
          const agent = findAgent(event.executionId);
          if (agent && !event.replayed) {
            agent.status = "running";
            if (event.model) agent.model = event.model;
            const metadata = managed.durableAgents.get(event.executionId) ?? {};
            metadata.startedAt = new Date().toISOString();
            metadata.endedAt = undefined;
            managed.durableAgents.set(event.executionId, metadata);
          }
          this.schedulePersist(managed);
          this.emit("agentStart", { runId: managed.runId, ...event });
          refresh();
        },
        onAgentUsage: (event) => {
          const usage = event.replayed
            ? { ...event.usage, estimated: false }
            : this.addUsage(invocationBaselines.get(event.executionId), event.usage);
          const agent = findAgent(event.executionId);
          if (agent) {
            agent.usage = usage;
            agent.tokenUsage = usage;
            agent.tokens = usage.total;
            agent.tokensEstimated = usage.estimated === true;
            if (!usage.estimated) {
              const metadata = managed.durableAgents.get(event.executionId) ?? {};
              metadata.usage = { ...usage, estimated: false };
              managed.durableAgents.set(event.executionId, metadata);
            }
          }
          this.emit("agentUsage", { runId: managed.runId, ...event, usage });
          progress();
        },
        onAgentEnd: (event) => {
          const agent = findAgent(event.executionId);
          const baseline = invocationBaselines.get(event.executionId);
          const usage = event.replayed
            ? event.usage
              ? { ...event.usage, estimated: false }
              : baseline
            : event.usage
              ? this.addUsage(baseline, event.usage)
              : baseline;
          if (agent) {
            const alreadyCompleted = agent.status === "done";
            const terminalStatus = managed.status === "aborted" ? "skipped" : event.status;
            agent.status = terminalStatus;
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            if (!alreadyCompleted || usage) agent.tokens = usage?.total ?? event.tokens;
            agent.tokensEstimated = usage?.estimated === true;
            if (usage) {
              agent.usage = usage;
              agent.tokenUsage = usage;
            }
            if (event.model) agent.model = event.model;
            const metadata = managed.durableAgents.get(event.executionId) ?? {};
            metadata.result = event.result;
            metadata.worktree = terminalStatus === "paused" ? (event.worktree ?? metadata.worktree) : undefined;
            if (terminalStatus === "paused") metadata.endedAt = undefined;
            else metadata.endedAt ??= new Date().toISOString();
            if (usage && !usage.estimated) metadata.usage = { ...usage, estimated: false };
            metadata.callHash = event.callHash;
            managed.durableAgents.set(event.executionId, metadata);
          }
          this.requirePersist(managed);
          this.emit("agentEnd", { runId: managed.runId, ...event, usage });
          refresh();
        },
        onAgentHistory: (event) => {
          const agent = findAgent(event.executionId);
          if (agent) agent.history = event.history;
          this.emit("agentHistory", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          const baseline = managed.usageBaseline;
          managed.snapshot.tokenUsage = {
            input: baseline.input + usage.input,
            output: baseline.output + usage.output,
            total: baseline.total + usage.total,
            cost: (baseline.cost ?? 0) + usage.cost,
            cacheRead: (baseline.cacheRead ?? 0) + (usage.cacheRead ?? 0),
            cacheWrite: (baseline.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
          };
          this.requirePersist(managed);
          this.emit("tokenUsage", { runId: managed.runId, usage: managed.snapshot.tokenUsage });
          progress();
        },
      });

      managed.status = "completed";
      const finalUsage = managed.snapshot.tokenUsage;
      const completedResult: WorkflowRunResult = {
        ...result,
        tokenUsage: finalUsage
          ? {
              input: finalUsage.input,
              output: finalUsage.output,
              total: finalUsage.total,
              cost: finalUsage.cost ?? 0,
              cacheRead: finalUsage.cacheRead,
              cacheWrite: finalUsage.cacheWrite,
            }
          : result.tokenUsage,
      };
      managed.result = completedResult;
      managed.snapshot.result = result.result;
      managed.snapshot.durationMs = result.durationMs;
      this.requirePersist(managed);
      this.releaseRunLease(managed);
      this.emit("complete", { runId: managed.runId, result: managed.result });

      return completedResult;
    } catch (error) {
      const durableError = managed.durabilityError;
      const workflowError =
        durableError ??
        (error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            ));

      const lifecycleAbort =
        managed.controller.signal.aborted && (managed.status === "paused" || managed.status === "aborted");
      const usageLimitPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
      if (durableError) {
        managed.status = "failed";
      } else if (managed.controller.signal.aborted) {
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
      if (usageLimitPaused) {
        this.emit("paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else if (!lifecycleAbort && this.listenerCount("error") > 0) {
        // pause()/stop() already emitted their lifecycle event. Only unexpected
        // failures and external aborts reach the error channel.
        this.emit("error", { runId: managed.runId, error: workflowError });
      }

      // Persist final state. A durability failure cannot safely expose a stale,
      // resumable artifact that would rerun already-paid work.
      if (durableError) {
        managed.deleted = true;
        this.persistence.delete(managed.runId);
        this.runs.delete(managed.runId);
      } else {
        this.persistRun(managed);
      }
      this.releaseRunLease(managed);

      throw workflowError;
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private requirePersist(managed: ManagedRun): void {
    try {
      this.persistRun(managed, true);
    } catch (error) {
      const durabilityError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.PERSISTENCE_ERROR,
              { recoverable: false, details: error },
            );
      managed.durabilityError ??= durabilityError;
      managed.controller.abort(durabilityError);
      throw durabilityError;
    }
  }

  private schedulePersist(managed: ManagedRun): void {
    if (managed.deleted || managed.persistTimer) return;
    managed.persistTimer = setTimeout(() => this.persistRun(managed), 100);
  }

  private persistRun(managed: ManagedRun, required = false): void {
    if (managed.persistTimer) {
      clearTimeout(managed.persistTimer);
      managed.persistTimer = undefined;
    }
    if (managed.deleted) return;
    try {
      this.persistence.save({
        runId: managed.runId,
        workflowName: managed.snapshot.name,
        workflowDescription: managed.snapshot.description,
        script: managed.script,
        args: managed.args,
        sessionId: managed.sessionId,
        journal: managed.journal.map((entry) => ({
          index: entry.index,
          executionId: entry.executionId,
          hash: entry.hash,
          result: entry.result,
          usage: entry.usage ? { ...entry.usage, estimated: false } : undefined,
          storeDelta: entry.storeDelta,
        })),
        status: managed.status,
        autoResume: managed.autoResume,
        pauseReason:
          managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
            ? "usage_limit"
            : undefined,
        resetHint:
          managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
            ? managed.error.resetHint
            : undefined,
        phases: [...managed.snapshot.phases],
        currentPhase: managed.snapshot.currentPhase,
        agents: managed.snapshot.agents.map((agent) => {
          const executionId = agent.executionId ?? `${managed.runId}:${agent.callIndex ?? agent.id - 1}`;
          const metadata = managed.durableAgents.get(executionId);
          return {
            id: agent.id,
            executionId,
            callIndex: agent.callIndex ?? agent.id - 1,
            label: agent.label,
            phase: agent.phase,
            prompt: agent.prompt,
            status: agent.status,
            result: metadata?.result,
            resultPreview: agent.resultPreview,
            error: agent.error,
            errorCode: agent.errorCode,
            recoverable: agent.recoverable,
            history: agent.history,
            usage: metadata?.usage ? { ...metadata.usage, estimated: false } : undefined,
            tokens: metadata?.usage?.total ?? (agent.tokensEstimated ? undefined : agent.tokens),
            startedAt: metadata?.startedAt,
            endedAt: metadata?.endedAt,
            model: agent.model,
            callHash: metadata?.callHash,
            sessionFile: metadata?.sessionFile,
            worktree: metadata?.worktree,
          };
        }),
        logs: [...managed.snapshot.logs],
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
        concurrency: managed.execution.concurrency,
        maxAgents: managed.execution.maxAgents,
        agentRetries: managed.execution.agentRetries,
        agentTimeoutMs: managed.execution.agentTimeoutMs,
        tokenBudget: managed.execution.tokenBudget,
      });
    } catch (err) {
      if (required) {
        throw new WorkflowError(err instanceof Error ? err.message : String(err), WorkflowErrorCode.PERSISTENCE_ERROR, {
          recoverable: false,
          details: err,
        });
      }
      console.warn("[workflow-manager] Persist run failed:", err);
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.status = "paused";
    for (const agent of managed.snapshot.agents) {
      if (agent.status === "running") agent.status = "paused";
    }
    managed.snapshot = recomputeWorkflowSnapshot(managed.snapshot);
    managed.controller.abort(WORKFLOW_PAUSE_ABORT_REASON);
    this.emit("paused", { runId });
    this.persistRun(managed);
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
   * this keeps the existing single-arg `resume(runId)` callers (e.g. the
   * UsageLimitScheduler) unchanged. `opts.args` overrides the persisted args
   * only when provided; otherwise the persisted args are kept.
   */
  async resume(runId: string, opts?: { script?: string; args?: unknown }): Promise<boolean> {
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;
    if (active?.executionPromise) await active.executionPromise.catch(() => {});

    const settled = this.runs.get(runId);
    if (settled?.status === "running" || settled?.status === "aborted") return false;
    const preflight = this.persistence.load(runId);
    if (!preflight?.script || preflight.status === "completed" || preflight.status === "aborted") return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    const persisted = this.persistence.load(runId);
    if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted") {
      this.persistence.releaseRunLease(lease);
      return false;
    }

    // Use the edited script when supplied, else the persisted one (backward-compat).
    const script = opts?.script ?? persisted.script;
    const args = opts?.args !== undefined ? opts.args : persisted.args;
    const controls = this.resolveExecutionControls({
      concurrency: persisted.concurrency,
      maxAgents: persisted.maxAgents,
      agentRetries: persisted.agentRetries,
      agentTimeoutMs: persisted.agentTimeoutMs !== undefined ? persisted.agentTimeoutMs : this.defaultAgentTimeoutMs,
      tokenBudget: persisted.tokenBudget !== undefined ? persisted.tokenBudget : null,
      autoResume: persisted.autoResume,
    });
    const resumeAgentEntries: Array<readonly [string, ResumeAgentState]> = this.persistAgentSessions
      ? persisted.agents.flatMap((agent) =>
          agent.status === "paused" && agent.sessionFile
            ? [
                [
                  agent.executionId,
                  { sessionFile: agent.sessionFile, worktree: agent.worktree, callHash: agent.callHash },
                ] as const,
              ]
            : [],
        )
      : [];
    const resumableAgentIds = new Set(resumeAgentEntries.map(([executionId]) => executionId));
    const incompatibleWorktrees = persisted.agents.flatMap((agent) =>
      agent.worktree && !resumableAgentIds.has(agent.executionId) ? [agent.worktree] : [],
    );
    const agents = persisted.agents.map((agent) => ({
      id: agent.id,
      executionId: agent.executionId,
      callIndex: agent.callIndex,
      label: agent.label,
      phase: agent.phase,
      prompt: agent.prompt,
      status: agent.status === "running" ? ("paused" as const) : agent.status,
      resultPreview: agent.resultPreview ?? (agent.result !== undefined ? preview(agent.result) : undefined),
      error: agent.error,
      errorCode: agent.errorCode,
      recoverable: agent.recoverable,
      history: agent.history,
      tokens: agent.usage?.total ?? agent.tokens,
      tokensEstimated: false,
      usage: agent.usage ? { ...agent.usage, estimated: false } : undefined,
      tokenUsage: agent.usage ? { ...agent.usage, estimated: false } : undefined,
      model: agent.model,
    }));
    const aggregateUsage = agents.reduce((total, agent) => {
      const usage = agent.usage;
      if (usage) {
        total.input += usage.input;
        total.output += usage.output;
        total.total += usage.total;
        total.cost = (total.cost ?? 0) + usage.cost;
        total.cacheRead = (total.cacheRead ?? 0) + usage.cacheRead;
        total.cacheWrite = (total.cacheWrite ?? 0) + usage.cacheWrite;
      } else if (agent.status === "done" && agent.tokens !== undefined) {
        // v1 rows carried only a terminal token total.
        total.total += agent.tokens;
      }
      return total;
    }, this.zeroUsage());
    const usageBaseline = persisted.tokenUsage ? { ...persisted.tokenUsage } : aggregateUsage;
    const startedAt = new Date(persisted.startedAt);
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: recomputeWorkflowSnapshot({
        name: persisted.workflowName,
        description: persisted.workflowDescription,
        phases: [...persisted.phases],
        currentPhase: persisted.currentPhase,
        logs: [...persisted.logs],
        agents,
        agentCount: agents.length,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        result: persisted.result,
        durationMs: persisted.durationMs,
        tokenUsage: usageBaseline,
        runId,
      }),
      controller: new AbortController(),
      startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
      // The (possibly edited) script + args become the run's own — persistRun()
      // writes them below, so a later resume sees the edited script.
      script,
      args,
      journal: persisted.journal ?? [],
      execution: controls,
      usageBaseline,
      durableAgents: new Map(
        persisted.agents.map((agent) => [
          agent.executionId,
          {
            result: agent.result,
            usage: agent.usage ? { ...agent.usage, estimated: false } : undefined,
            startedAt: agent.startedAt,
            endedAt: agent.status === "running" || agent.status === "paused" ? undefined : agent.endedAt,
            callHash: agent.callHash,
            sessionFile: agent.sessionFile,
            worktree: resumableAgentIds.has(agent.executionId) ? agent.worktree : undefined,
          },
        ]),
      ),
      sessionId: persisted.sessionId,
      background: true,
      autoResume: persisted.autoResume,
      lease,
    };
    this.runs.set(runId, managed);
    try {
      this.persistRun(managed, true);
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    this.cleanupWorktrees(incompatibleWorktrees);
    const resumeJournal = new Map(managed.journal.map((entry) => [entry.executionId ?? entry.index, entry] as const));
    const resumeAgents = resumeAgentEntries.length ? new Map<string, ResumeAgentState>(resumeAgentEntries) : undefined;
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    void this.beginExecution(managed, script, args, { resumeJournal, resumeAgents }).catch(() => {});
    return true;
  }

  /** Restart a saved run with the same durable execution controls. */
  restart(runId: string): { runId: string; promise: Promise<WorkflowRunResult> } | null {
    const active = this.runs.get(runId);
    if (active?.status === "running" || active?.executionPromise) return null;
    const sourceLease = this.persistence.acquireRunLease(runId);
    if (!sourceLease) return null;
    try {
      const persisted = this.persistence.load(runId);
      if (!persisted?.script || !["paused", "completed", "failed", "aborted"].includes(persisted.status)) return null;
      if (persisted.status === "paused") {
        const endedAt = new Date().toISOString();
        const preservedWorktrees = persisted.agents.map((agent) => agent.worktree);
        try {
          this.persistence.save({
            ...persisted,
            status: "aborted",
            autoResume: false,
            pauseReason: undefined,
            resetHint: undefined,
            agents: persisted.agents.map((agent) =>
              agent.status === "queued" || agent.status === "running" || agent.status === "paused"
                ? { ...agent, status: "skipped" as const, endedAt: agent.endedAt ?? endedAt, worktree: undefined }
                : agent,
            ),
          });
        } catch (error) {
          throw new WorkflowError(
            error instanceof Error ? error.message : String(error),
            WorkflowErrorCode.PERSISTENCE_ERROR,
            { recoverable: false, details: error },
          );
        }
        if (active) {
          active.status = "aborted";
          active.autoResume = false;
          for (const agent of active.snapshot.agents) {
            if (agent.status === "queued" || agent.status === "running" || agent.status === "paused") {
              agent.status = "skipped";
            }
          }
          active.snapshot = recomputeWorkflowSnapshot(active.snapshot);
        }
        this.cleanupWorktrees(preservedWorktrees);
        this.emit("stopped", { runId });
      }
      return this.startInBackground(persisted.script, persisted.args, {
        concurrency: persisted.concurrency,
        maxAgents: persisted.maxAgents,
        agentRetries: persisted.agentRetries,
        agentTimeoutMs: persisted.agentTimeoutMs !== undefined ? persisted.agentTimeoutMs : this.defaultAgentTimeoutMs,
        tokenBudget: persisted.tokenBudget !== undefined ? persisted.tokenBudget : null,
        autoResume: persisted.autoResume,
      });
    } finally {
      this.persistence.releaseRunLease(sourceLease);
    }
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) {
      if (managed.status !== "running" && managed.status !== "paused") return false;
      const preservedWorktrees = [...managed.durableAgents.values()].map((metadata) => metadata.worktree);
      if (!managed.lease) {
        managed.lease = this.persistence.acquireRunLease(runId) ?? undefined;
        if (!managed.lease) return false;
      }
      const endedAt = new Date().toISOString();
      for (const agent of managed.snapshot.agents) {
        if (agent.status !== "queued" && agent.status !== "running" && agent.status !== "paused") continue;
        agent.status = "skipped";
        const executionId = agent.executionId;
        if (executionId) {
          const metadata = managed.durableAgents.get(executionId) ?? {};
          metadata.endedAt ??= endedAt;
          metadata.worktree = undefined;
          managed.durableAgents.set(executionId, metadata);
        }
      }
      managed.snapshot = recomputeWorkflowSnapshot(managed.snapshot);
      managed.status = "aborted";
      managed.controller.abort();
      try {
        this.requirePersist(managed);
      } catch (error) {
        managed.deleted = true;
        this.persistence.delete(runId);
        this.runs.delete(runId);
        throw error;
      }
      // Active execution owns its local worktree and cleans it while unwinding.
      // Manager cleanup is only for cold/settled preserved worktrees.
      if (!managed.executionPromise) this.cleanupWorktrees(preservedWorktrees);
      this.emit("stopped", { runId });
      if (!managed.executionPromise) this.releaseRunLease(managed);
      return true;
    }

    const persisted = this.persistence.load(runId);
    if (!persisted || (persisted.status !== "running" && persisted.status !== "paused")) return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      const current = this.persistence.load(runId);
      if (!current || (current.status !== "running" && current.status !== "paused")) return false;
      const preservedWorktrees = current.agents.map((agent) => agent.worktree);
      try {
        this.persistence.save({
          ...current,
          status: "aborted",
          pauseReason: undefined,
          resetHint: undefined,
          agents: current.agents.map((agent) =>
            agent.status === "queued" || agent.status === "running" || agent.status === "paused"
              ? {
                  ...agent,
                  status: "skipped" as const,
                  endedAt: agent.endedAt ?? new Date().toISOString(),
                  worktree: undefined,
                }
              : agent,
          ),
        });
      } catch (error) {
        throw new WorkflowError(
          error instanceof Error ? error.message : String(error),
          WorkflowErrorCode.PERSISTENCE_ERROR,
          { recoverable: false, details: error },
        );
      }
      this.cleanupWorktrees(preservedWorktrees);
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
  listRuns(): LoadedPersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): LoadedPersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /** Delete a terminal persisted run. Running and paused work must be stopped first. */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    const persisted = this.persistence.load(runId);
    const status = managed?.status ?? persisted?.status;
    if (status === "running" || status === "paused" || (!managed && !persisted)) return false;

    const acquiredLease = managed?.lease ? null : this.persistence.acquireRunLease(runId);
    const lease = managed?.lease ?? acquiredLease;
    if (!lease) return false;

    try {
      const current = this.persistence.load(runId);
      const currentStatus = managed?.status ?? current?.status;
      if (currentStatus === "running" || currentStatus === "paused" || (!managed && !current)) return false;

      if (managed) {
        managed.deleted = true;
        if (managed.persistTimer) {
          clearTimeout(managed.persistTimer);
          managed.persistTimer = undefined;
        }
      }
      const deleted = this.persistence.delete(runId);
      if (!deleted) {
        if (managed) managed.deleted = false;
        return false;
      }
      this.runs.delete(runId);
      if (managed?.lease?.token === lease.token) this.releaseRunLease(managed);
      return true;
    } finally {
      if (acquiredLease) this.persistence.releaseRunLease(acquiredLease);
    }
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
