import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { WorkflowMeta } from "./workflow.js";
import type { Worktree } from "./worktree.js";

export type WorkflowAgentStatus = "queued" | "running" | "paused" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  /** Stable runtime identity (`runId:callIndex`). */
  executionId?: string;
  callIndex?: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** Tokens used by this agent. */
  tokens?: number;
  /** Whether tokens is a live streaming estimate. */
  tokensEstimated?: boolean;
  startedAt?: string;
  endedAt?: string;
  /** Absolute cumulative usage for this invocation. */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
    estimated?: boolean;
  };
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /** File-backed Pi child session used to continue this invocation after pause/restart. */
  sessionFile?: string;
  /** Preserved isolated cwd required by a resumed child session. */
  worktree?: Worktree;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  runId?: string;
  requestedConcurrency?: number;
  effectiveConcurrency?: number;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((phase) => phase.title) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  // Mutable state captured by the component closure so re-renders
  // always read the latest snapshot even though the factory ran once.
  let snapshot: WorkflowSnapshot | undefined;
  let completed = false;

  // Store the factory so update()/complete() can re-register it to trigger re-render.
  const widgetFactory = (_tui: unknown, theme: Theme) => ({
    render: () => (snapshot ? renderWorkflowLines(snapshot, options, theme) : []),
    invalidate: () => {},
  });

  if (ctx.hasUI) {
    ctx.ui.setWidget(key, widgetFactory, { placement });
  }

  return {
    update(s) {
      snapshot = s;
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, statusLine(s, completed));
      ctx.ui.setWidget(key, widgetFactory, { placement });
    },
    complete(s) {
      snapshot = s;
      completed = true;
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, statusLine(s, true));
      ctx.ui.setWidget(key, widgetFactory, { placement });
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

/** Minimal theme surface so rendering works without a real Theme (tool output, tests). */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Identity passthrough for contexts where no theme is available (tool text output). */
const NO_THEME: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

export function renderWorkflowLines(
  snapshot: WorkflowSnapshot,
  options: WorkflowDisplayOptions = {},
  theme: ThemeLike = NO_THEME,
): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const showResultPreviews = options.showResultPreviews ?? false;
  const queuedCount = snapshot.agents.filter((agent) => agent.status === "queued").length;
  const pausedAgents = snapshot.agents.filter((agent) => agent.status === "paused");
  const skippedCount = snapshot.agents.filter((agent) => agent.status === "skipped").length;
  const usage = snapshot.tokenUsage;
  const costInfo = usage?.cost ? ` · $${usage.cost.toFixed(4)}` : "";
  const tokenInfo = usage ? ` · ${usage.total.toLocaleString()} tokens${costInfo}` : "";
  const state = [
    snapshot.runningCount ? `${snapshot.runningCount} running` : "",
    pausedAgents.length ? `${pausedAgents.length} paused mid-run` : "",
    queuedCount ? `${queuedCount} not started` : "",
    snapshot.errorCount ? `${snapshot.errorCount} errors` : "",
    skippedCount ? `${skippedCount} skipped` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `${theme.bold(`◆ Workflow: ${snapshot.name}`)} (${snapshot.doneCount}/${snapshot.agentCount} done${state ? `, ${state}` : ""}${tokenInfo})`,
  ];
  const activeLabels = snapshot.agents.filter((agent) => agent.status === "running").map((agent) => agent.label);
  if (activeLabels.length) {
    lines.push(
      `  Running now (${activeLabels.length}/${snapshot.effectiveConcurrency ?? activeLabels.length}): ${activeLabels.join(", ")}`,
    );
  }
  if (pausedAgents.length) {
    lines.push(
      `  Paused mid-run (${pausedAgents.length}): ${pausedAgents
        .map((agent) => `${agent.label}${agent.sessionFile ? " (session saved)" : " (fresh restart)"}`)
        .join(", ")}`,
    );
  }

  const phaseNames = snapshot.phases.length
    ? snapshot.phases
    : unique(snapshot.agents.map((agent) => agent.phase).filter(Boolean) as string[]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const paused = agents.filter((agent) => agent.status === "paused").length;
    const queued = agents.filter((agent) => agent.status === "queued").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker =
      paused > 0 ? "⏸" : running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      theme.fg("accent", `  ${marker} ${phase}`) +
        theme.fg(
          "dim",
          ` ${done}/${agents.length}${running ? ` · ${running} running` : ""}${paused ? ` · ${paused} paused` : ""}${queued ? ` · ${queued} not started` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
        ),
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `[${agent.id}]`;
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      const agentTokens = formatAgentTokens(agent, theme);
      lines.push(
        `    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokens} · ${agentStatusLabel(agent)}${result}`,
      );
    }
    if (agents.length > visibleAgents.length)
      lines.push(theme.fg("dim", `    … ${agents.length - visibleAgents.length} earlier agents`));
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push(theme.fg("accent", "  Unphased"));
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      const agentTokens = formatAgentTokens(agent, theme);
      lines.push(
        `    [${agent.id}] ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokens} · ${agentStatusLabel(agent)}${result}`,
      );
    }
  }

  return lines;
}

function agentStatusLabel(agent: WorkflowAgentSnapshot): string {
  if (agent.status !== "paused") return agent.status;
  return agent.sessionFile ? "paused mid-run (session saved)" : "paused mid-run (fresh restart)";
}

function formatAgentTokens(agent: WorkflowAgentSnapshot, theme: ThemeLike): string {
  if (!agent.tokens) return "";
  return theme.fg("dim", ` [${agent.tokensEstimated ? "~" : ""}${agent.tokens.toLocaleString()} tok]`);
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, completed = false): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot)].join("\n");
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  const paused = snapshot.agents.filter((agent) => agent.status === "paused").length;
  if (paused > 0)
    return `workflow ${snapshot.name}: ${paused} paused mid-run, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

export function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "paused":
      return "⏸";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
