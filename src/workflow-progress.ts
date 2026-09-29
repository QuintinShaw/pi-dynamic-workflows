import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgentSnapshot } from "./display.js";
import type { PersistedRunState } from "./run-persistence.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";

const PROGRESS_INTERVAL_MS = 1000;
const PREVIEW_CHARS = 2000;
const PROMPT_CHARS = 500;
const RETAINED_TERMINAL_RUNS = 20;

export interface WorkflowProgressAgent {
  id: number;
  label: string;
  status: WorkflowAgentSnapshot["status"];
  phase?: string;
  model?: string;
  tokens?: number;
  estimatedTokens?: boolean;
  promptPreview?: string;
  resultPreview?: string;
  error?: string;
  sessionFile?: string;
}

/** `agentIds` is complete; `agents` contains only rows changed since the previous entry. */
export interface WorkflowProgress {
  version: 1;
  runId: string;
  name: string;
  status: Exclude<PersistedRunState["status"], "pending">;
  cwd: string;
  currentPhase?: string;
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  tokens?: number;
  estimatedTokens?: boolean;
  cost?: number;
  durationMs?: number;
  resultPreview?: string;
  error?: string;
  agentIds: number[];
  agents: WorkflowProgressAgent[];
}

function clip(value: string | undefined, limit = PREVIEW_CHARS): string | undefined {
  if (value === undefined) return undefined;
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function resultPreview(value: unknown): string | undefined {
  if (typeof value === "string") return clip(value);
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  // Agents already have compact structured previews. Do not enumerate large
  // results, invoke their getters, or serialize them again on each update.
  return "Structured result";
}

function snapshot(run: ManagedRun | PersistedRunState, cwd: string): WorkflowProgress {
  const live = "snapshot" in run;
  const source = live ? run.snapshot : run;
  const status = run.status === "pending" ? "running" : run.status;
  const agents: WorkflowProgressAgent[] = source.agents.map((agent) => ({
    id: agent.id,
    label: clip(agent.label, PROMPT_CHARS) ?? "",
    status: agent.status,
    phase: clip(agent.phase, PROMPT_CHARS),
    model: clip(agent.model, PROMPT_CHARS),
    tokens: agent.tokens ?? agent.tokenUsage?.total,
    estimatedTokens: agent.tokenUsage?.estimated,
    promptPreview: clip(agent.prompt, PROMPT_CHARS),
    resultPreview:
      typeof agent.result === "string"
        ? clip(agent.result)
        : (clip(agent.resultPreview) ?? resultPreview(agent.result)),
    error: clip(agent.error),
    sessionFile: agent.sessionFile,
  }));
  const usage = source.tokenUsage;
  const agentTokens = agents.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0);
  const tokens =
    usage?.total === undefined && !agents.some((agent) => agent.tokens !== undefined)
      ? undefined
      : Math.max(usage?.total ?? 0, agentTokens);
  return {
    version: 1,
    runId: run.runId,
    name: clip(live ? run.snapshot.name : run.workflowName, PROMPT_CHARS) ?? "",
    status,
    cwd,
    currentPhase: clip(source.currentPhase, PROMPT_CHARS),
    agentCount: agents.length,
    runningCount: agents.filter((agent) => agent.status === "running").length,
    doneCount: agents.filter((agent) => agent.status === "done").length,
    errorCount: agents.filter((agent) => agent.status === "error").length,
    tokens,
    estimatedTokens: usage?.estimated || agents.some((agent) => agent.estimatedTokens) || undefined,
    cost: usage?.cost,
    durationMs: live ? run.result?.durationMs : run.durationMs,
    resultPreview: resultPreview(live ? run.result?.result : run.result),
    error: clip(live ? run.error?.message : run.error),
    agentIds: agents.map((agent) => agent.id),
    agents,
  };
}

/** Publish display state as native Pi session entries, outside model context. */
export function installWorkflowProgress(
  pi: Pick<ExtensionAPI, "appendEntry">,
  manager: WorkflowManager,
  sessionId: string,
): (reason?: "handoff" | "shutdown") => void {
  const previous = new Map<string, { header: string; agents: Map<number, string>; terminal: boolean }>();
  const owned = new Set<string>();
  const dirty = new Set<string>();
  const urgent = new Set<string>();
  const deleted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let microtaskQueued = false;
  let disposed = false;

  const publish = (runId: string) => {
    if (disposed) return;
    dirty.delete(runId);
    try {
      if (deleted.delete(runId)) {
        if (!owned.has(runId)) return;
        pi.appendEntry("pi-dynamic-workflows:progress", { version: 1, runId, deleted: true });
        previous.delete(runId);
        owned.delete(runId);
        return;
      }
      const persistence = manager.getPersistence();
      const run = manager.getRun(runId) ?? persistence.loadPreview?.(runId) ?? persistence.load(runId);
      if (!run || run.sessionId !== sessionId) return;
      owned.add(runId);
      const packet = snapshot(run, manager.getCwd());
      const { agents, ...header } = packet;
      const serializedHeader = JSON.stringify(header);
      const last = previous.get(runId);
      const serializedAgents = new Map(agents.map((agent) => [agent.id, JSON.stringify(agent)]));
      const changed = agents.filter((agent) => last?.agents.get(agent.id) !== serializedAgents.get(agent.id));
      if (last?.header === serializedHeader && changed.length === 0) return;
      pi.appendEntry("pi-dynamic-workflows:progress", { ...header, agents: changed });
      const terminal = packet.status === "completed" || packet.status === "failed" || packet.status === "aborted";
      previous.set(runId, { header: serializedHeader, agents: serializedAgents, terminal });
      if (terminal) {
        const retained = [...previous].filter(([, value]) => value.terminal);
        for (const [id] of retained.slice(0, Math.max(0, retained.length - RETAINED_TERMINAL_RUNS)))
          previous.delete(id);
      }
    } catch {
      // A UI observer must never fail the workflow. A subsequent event can
      // retry, but an unavailable host must not create an automatic retry loop.
    }
  };

  const scheduleImmediate = ({ runId }: { runId: string }) => {
    urgent.add(runId);
    if (microtaskQueued) return;
    microtaskQueued = true;
    queueMicrotask(() => {
      microtaskQueued = false;
      for (const id of urgent) publish(id);
      urgent.clear();
      if (dirty.size === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    });
  };
  const scheduleProgress = ({ runId }: { runId: string }) => {
    dirty.add(runId);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const id of dirty) publish(id);
      dirty.clear();
    }, PROGRESS_INTERVAL_MS);
    timer.unref?.();
  };
  const remove = ({ runId }: { runId: string }) => {
    if (!owned.has(runId)) return;
    deleted.add(runId);
    scheduleImmediate({ runId });
  };
  const lifecycleEvents = ["started", "resumed", "paused", "complete", "error", "stopped"];
  const progressEvents = [
    "agentStart",
    "agentEnd",
    "agentModel",
    "agentSession",
    "agentUsage",
    "agentHistory",
    "tokenUsage",
    "phase",
    "log",
  ];
  for (const event of lifecycleEvents) manager.on(event, scheduleImmediate);
  for (const event of progressEvents) manager.on(event, scheduleProgress);
  manager.on("deleted", remove);

  try {
    // Completed history is already in Pi's entries. Reconcile only work that
    // may have continued, paused, or changed owners during session replacement.
    for (const runs of [() => manager.listLiveRuns(), () => manager.listRuns()]) {
      for (const run of runs()) {
        if (run.sessionId !== sessionId) continue;
        // Keep only ownership metadata for historical runs, so later deletion
        // removes their durable UI entries without loading their agents/results.
        owned.add(run.runId);
        if (run.status === "running" || run.status === "paused" || run.status === "pending" || run.pendingDelivery) {
          scheduleImmediate({ runId: run.runId });
        }
      }
    }
  } catch {
    // Best-effort initial reconciliation; live events remain subscribed.
  }

  return (reason) => {
    if (disposed) return;
    if (reason === "handoff") {
      try {
        // Retire only work that adoption can move. Completed history without
        // pending delivery stays in this session; inspect summaries, not results.
        for (const runs of [
          () =>
            manager
              .listLiveRuns()
              .filter((run) => run.status === "running" || run.status === "paused" || run.pendingDelivery),
          () => manager.listRuns().filter((run) => run.pendingDelivery),
        ]) {
          for (const run of runs()) {
            if (run.sessionId === sessionId) {
              deleted.add(run.runId);
              urgent.add(run.runId);
            }
          }
        }
      } catch {
        // Flush already queued state even if the history store is unavailable.
      }
    }
    // Shutdown is the last point where appendEntry targets the outgoing
    // session. Pause/terminal events may still be waiting for their microtask.
    if (reason) {
      for (const runId of new Set([...dirty, ...urgent])) publish(runId);
    }
    disposed = true;
    if (timer) clearTimeout(timer);
    for (const event of lifecycleEvents) manager.off(event, scheduleImmediate);
    for (const event of progressEvents) manager.off(event, scheduleProgress);
    manager.off("deleted", remove);
    dirty.clear();
    urgent.clear();
    deleted.clear();
    previous.clear();
    owned.clear();
  };
}
