import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
  callId?: string;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  /** Full agent result, retained for the interactive detail pager. */
  result?: unknown;
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
  tokens?: number;
  /** Per-agent token usage breakdown (fresh input+output vs cached), when known. */
  tokenUsage?: AgentUsage;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /** Child SessionManager identity, captured before the first prompt. */
  sessionId?: string;
  /** Child session file, absent for in-memory child sessions. */
  sessionFile?: string;
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
    /** True when the totals include character-heuristic estimates (#209). */
    estimated?: boolean;
  };
  runId?: string;
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

/**
 * Displayable fresh/cached figures from a usage breakdown and/or a scalar
 * estimate. The token pipeline has two sources that don't always agree: the
 * provider-reported breakdown (input/output/cacheRead/cacheWrite) and a scalar
 * estimate (`total` at run level, `tokens` per agent) that keeps accruing even
 * when the provider reports nothing. Two rules:
 * - `fresh` counts input+output+cacheWrite: cache writes are first-time
 *   ingestion billed at full (or premium) price, so hiding them would
 *   under-report real spend; only cacheRead is the cheap reuse shown apart.
 * - `fresh` is never less than what the estimate can account for after
 *   removing cache reads, so estimate-only providers, cost-only providers
 *   (billed but zero token counts), and mixed runs keep the count the display
 *   showed before the split existed, instead of a false "0 tok".
 */
export function tokenFigures(
  usage: Partial<AgentUsage> | undefined,
  scalarTokens?: number,
): { fresh: number; cacheRead: number; estimated: boolean } {
  const cacheRead = usage?.cacheRead ?? 0;
  const reported = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
  const estimate = Math.max(scalarTokens ?? 0, usage?.total ?? 0);
  return { fresh: Math.max(reported, estimate - cacheRead), cacheRead, estimated: usage?.estimated === true };
}

/** Sum a set of agents into fresh vs cacheRead totals, via {@link tokenFigures}. */
export function aggregateAgentUsage(agents: ReadonlyArray<Pick<WorkflowAgentSnapshot, "tokens" | "tokenUsage">>): {
  fresh: number;
  cacheRead: number;
  estimated: boolean;
} {
  let fresh = 0;
  let cacheRead = 0;
  let estimated = false;
  for (const a of agents) {
    const f = tokenFigures(a.tokenUsage, a.tokens);
    fresh += f.fresh;
    cacheRead += f.cacheRead;
    if (f.estimated) estimated = true;
  }
  return { fresh, cacheRead, estimated };
}

/**
 * Format a token count for a display surface: "12.4K tok" on its own, or
 * "89K tok · 3.0M cached" when there were cache reads. The cache segment is shown
 * only when `cacheRead > 0`, so a non-caching provider (or a single-turn agent that
 * never re-reads its cache) reads as a plain "tok" rather than a bare, contextless
 * "fresh". `fmt` adapts the number style per surface (compact in panels, full in
 * the print view).
 */
export function fmtTokenCount(fresh: number, cacheRead: number, fmt: (n: number) => string): string {
  const f = fmt(fresh) || "0";
  return cacheRead > 0 ? `${f} tok · ${fmt(cacheRead)} cached` : `${f} tok`;
}

/**
 * Like {@link fmtTokenCount}, but "" when nothing is known yet (both figures 0),
 * so surfaces omit the segment instead of rendering a false "0 tok" — e.g. for a
 * journal-replayed resume or a run whose agents were all skipped. Every surface
 * should use this rather than re-implementing the zero guard. When
 * `figures.estimated` is set the segment is prefixed with `~` (#209) so a
 * heuristic-derived total never renders as metered. The marker covers the whole
 * segment (fresh + cached) even when only one component is heuristic —
 * conservative by design.
 */
export function fmtTokenSegment(
  figures: { fresh: number; cacheRead: number; estimated?: boolean },
  fmt: (n: number) => string,
): string {
  if (figures.fresh + figures.cacheRead <= 0) return "";
  const rendered = fmtTokenCount(figures.fresh, figures.cacheRead, fmt);
  // "~" marks character-heuristic figures so an estimate never reads as a
  // metered total (#209).
  return figures.estimated ? `~${rendered}` : rendered;
}

/**
 * "$1.23" from one cent up, four decimals below it, and "<$0.0001" for
 * anything smaller — a real cost never rounds to a zero-looking "$0.00".
 */
export function fmtCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}

/** Full (non-compact) number style for print/text surfaces: locale-grouped digits. */
// Reuse one formatter across render calls. No locale argument means the
// runtime default, matching toLocaleString() semantics.
const FULL_NUMBER_FORMAT = new Intl.NumberFormat();
export const fmtFull = (n: number): string => FULL_NUMBER_FORMAT.format(n);

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

export interface EmptyFleetSummary {
  /** True when the run launched at least one agent but every one of them returned no usable result. */
  allEmpty: boolean;
  /** Agents that ran to a terminal state and returned null (recoverable failure exhausted, e.g. AGENT_EMPTY_OUTPUT). */
  emptyCount: number;
  /** Agents that produced a real result. */
  doneCount: number;
  /** Labels of the empty agents, capped for a readable warning line. */
  emptyLabels: string[];
}

/**
 * Detect the "empty fleet" case: a run that spent on at least one agent yet got
 * zero usable results back. `agent()` resolves a recoverable failure (e.g.
 * `AGENT_EMPTY_OUTPUT` after retries are exhausted) to `null` rather than
 * throwing, so an all-null fleet still reports the run as completed — without
 * this check the host can mistake "nothing was produced" for "everything
 * succeeded". Agents still queued/running are not counted; only terminal
 * `error` (null result) and `done` (real result) states decide.
 */
export function emptyFleetSummary(agents: WorkflowAgentSnapshot[], maxLabels = 5): EmptyFleetSummary {
  const terminal = agents.filter((agent) => agent.status === "error" || agent.status === "done");
  const empty = terminal.filter((agent) => agent.status === "error");
  const doneCount = terminal.length - empty.length;
  return {
    allEmpty: terminal.length > 0 && doneCount === 0,
    emptyCount: empty.length,
    doneCount,
    emptyLabels: empty.slice(0, maxLabels).map((agent) => agent.label || `agent #${agent.id}`),
  };
}

/**
 * One-line "started in the background" notice pointing at a progress surface
 * that exists in the current host. The task panel and /workflows navigator are
 * TUI components (`ui.custom()` / widget factories) that no-op in RPC hosts
 * such as Paseo even though `ctx.hasUI` is true there — so non-TUI modes are
 * pointed at `/workflows status <id>`, which prints plain text any host can
 * display.
 */
export function backgroundStartNotice(
  name: string,
  runId: string,
  mode: ExtensionContext["mode"] | undefined,
  deliverable: "report" | "result",
): string {
  const where =
    mode === "tui" ? "watch the task panel or /workflows" : `check progress with /workflows status ${runId}`;
  return `/${name} running in the background (${runId}) — ${where}; the ${deliverable} is posted here when it finishes.`;
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

/** The bracketed per-agent token cell (" [89 tok · 3,000 cached]"), or "" when nothing is known yet. */
function agentTokenCell(agent: WorkflowAgentSnapshot, theme: ThemeLike): string {
  const segment = fmtTokenSegment(tokenFigures(agent.tokenUsage, agent.tokens), fmtFull);
  return segment ? theme.fg("dim", ` [${segment}]`) : "";
}

export function renderWorkflowLines(
  snapshot: WorkflowSnapshot,
  options: WorkflowDisplayOptions = {},
  theme: ThemeLike = NO_THEME,
): string[] {
  // A non-positive cap falls back to the default (mirrors clampMaxAgents in
  // the task panel): slice(-0) === slice(0) would otherwise render ALL agents
  // (audit2 #31).
  // Math.floor: a fractional cap like 0.5 would pass the >0 guard yet
  // slice(-0.5) → slice(0) renders ALL agents — same bug class as #31.
  const maxAgents =
    options.maxAgents !== undefined && options.maxAgents > 0 ? Math.max(1, Math.floor(options.maxAgents)) : 8;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  // Build header with token info (and cost when the provider reports it)
  const usage = snapshot.tokenUsage;
  const costInfo = usage?.cost ? ` · ${fmtCost(usage.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(usage), fmtFull);
  const tokenInfo = `${segment ? ` · ${segment}` : ""}${costInfo}`;
  const lines = [
    `${theme.bold(`◆ Workflow: ${snapshot.name}`)} (${snapshot.doneCount}/${snapshot.agentCount} done${state}${tokenInfo})`,
  ];

  const phaseNames = snapshot.phases.length
    ? snapshot.phases
    : unique(snapshot.agents.map((agent) => agent.phase).filter(Boolean) as string[]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  // Single-pass phase bucketing (audit2 #24): per-phase filter() loops made
  // every render O(phases × agents), which dominates at large fleets.
  const agentsByPhase = new Map<string, WorkflowAgentSnapshot[]>();
  for (const agent of snapshot.agents) {
    // Degenerate case: an agent whose phase is "" renders under "Unphased"
    // even when meta.phases declares a ""-titled phase (the phase row then
    // reads 0/0) — same as the pre-bucketing behavior for untitled agents.
    if (!agent.phase) continue;
    let bucket = agentsByPhase.get(agent.phase);
    if (!bucket) {
      bucket = [];
      agentsByPhase.set(agent.phase, bucket);
    }
    bucket.push(agent);
  }

  for (const phase of phaseNames) {
    const agents = agentsByPhase.get(phase) ?? [];
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      theme.fg("accent", `  ${marker} ${phase}`) +
        theme.fg(
          "dim",
          ` ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
        ),
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `[${agent.id}]`;
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(
        `    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokenCell(agent, theme)}${result}`,
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
      lines.push(
        `    [${agent.id}] ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokenCell(agent, theme)}${result}`,
      );
    }
  }

  return lines;
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, completed = false): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot)].join("\n");
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

export function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
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
