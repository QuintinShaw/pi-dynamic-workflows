/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { shorten, statusIcon, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";
import { shortModel } from "./workflow-ui.js";

// `tokenUsage` is included so the detailed panel's live token/s counter refreshes
// as tokens accrue (not only on agent start/end). It is harmless in compact mode —
// it redraws identical content.
const RUN_EVENTS = [
  "agentQueued",
  "agentSession",
  "agentStart",
  "agentUsage",
  "agentHistory",
  "agentEnd",
  "phase",
  "log",
  "tokenUsage",
  "concurrencyChanged",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
];
/** Events after which a run is gone and its token-rate samples can be dropped. */
const RUN_END_EVENTS = ["complete", "error", "stopped"] as const;

export interface TaskPanelOptions {
  storage?: WorkflowStorage;
  cwd?: string;
  /**
   * Live settings loader. When provided, the panel reads it fresh (with a short
   * TTL cache) on each render so `/workflows-progress` takes effect without a
   * restart. Omitted in tests / minimal hosts → always compact.
   */
  loadSettings?: () => WorkflowSettings;
}

/** Default cap on the JSON-dump fallback in a delivered result summary. Overridable
 *  via the `deliveredResultMaxChars` setting in ~/.pi/workflows/settings.json. */
const DEFAULT_DELIVERED_MAX_CHARS = 400;

/** Human-readable byte size for the dropped-tail hint: 512 B, 3.2 KB, 1.4 MB. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pick a clean human-readable summary from a workflow result, in order of
 * preference: a `verdict`/`report`/`summary` string field, a bare string
 * result, else a JSON dump capped at `maxChars`. When the dump is truncated the
 * dropped size is reported (the full result is still reachable via the pointer
 * that {@link deliverText} appends).
 */
function summarizeResult(result: unknown, maxChars: number = DEFAULT_DELIVERED_MAX_CHARS): string {
  if (typeof result === "string") return result;
  if (result == null) return "null";
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    for (const key of ["verdict", "report", "summary"] as const) {
      const val = obj[key];
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  const json = JSON.stringify(result, null, 2);
  if (json.length <= maxChars) return json;
  // Slice once (the kept head); derive the dropped size by byte-length subtraction
  // so we don't also allocate the (potentially large) truncated tail to measure it.
  const kept = json.slice(0, maxChars);
  const droppedBytes = Buffer.byteLength(json, "utf8") - Buffer.byteLength(kept, "utf8");
  return `${kept}\n…(truncated ${formatBytes(droppedBytes)})`;
}

function fitLine(line: string, width?: number): string {
  if (typeof width !== "number" || !Number.isFinite(width)) return line;
  const maxWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth);
}

function wrapLine(line: string, width?: number): string[] {
  if (typeof width !== "number" || !Number.isFinite(width) || visibleWidth(line) <= width) return [line];
  return wrapTextWithAnsi(line, Math.max(1, Math.floor(width)));
}

export function deliverText(run: ManagedRun, opts: { resultPath?: string; maxChars?: number } = {}): string {
  const summary = summarizeResult(run.result?.result, opts.maxChars);
  const tokens = run.result?.tokenUsage ? ` · ${run.result.tokenUsage.total.toLocaleString()} tokens` : "";
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
  const lines = [
    `✓ Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}${duration}).`,
    "",
    summary,
  ];
  // Always point at the full persisted result so the tail is never lost — even when
  // the summary above is a complete verdict/summary field or an untruncated dump.
  if (opts.resultPath) lines.push("", `↳ Full result: ${opts.resultPath}`);
  return lines.join("\n");
}

/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
function persistedResultPath(manager: WorkflowManager, runId: string): string | undefined {
  try {
    return join(manager.getPersistence().getRunsDir(), `${runId}.json`);
  } catch {
    return undefined;
  }
}

/** Delivered JSON-dump truncation threshold from settings (already normalized),
 *  defaulting to 400 when unset or unreadable. */
function deliveredMaxChars(opts: { loadSettings?: () => WorkflowSettings }): number {
  try {
    return opts.loadSettings?.().deliveredResultMaxChars ?? DEFAULT_DELIVERED_MAX_CHARS;
  } catch {
    return DEFAULT_DELIVERED_MAX_CHARS;
  }
}

/**
 * When a background run finishes (or fails), deliver its result back into the
 * conversation AND continue the turn so the assistant can act on it — without
 * blocking the user meanwhile:
 *
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle, feeding the
 *    result to the model so the paused conversation continues.
 *  - `deliverAs: "followUp"` means that if the user is busy in another turn, the
 *    result is queued and picked up after that turn finishes — never interrupting.
 *
 * Set up once per extension; idempotent via an internal guard.
 */
export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: { loadSettings?: () => WorkflowSettings } = {},
): void {
  // Mutable holder on manager so shared across re-calls (e.g. session_start after /reload).
  const m = manager as unknown as { __deliveryInstalled?: boolean; __holder?: { pi: ExtensionAPI } };
  if (m.__deliveryInstalled) {
    // Refresh pi reference only — listeners stay registered.
    if (m.__holder) m.__holder.pi = pi;
    return;
  }
  m.__deliveryInstalled = true;
  m.__holder = { pi };

  const deliver = (content: string) => {
    try {
      const ret = m.__holder?.pi.sendMessage(
        { customType: "workflow-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      // sendMessage may return a promise; a sync try/catch can't catch its
      // rejection, so swallow the async path too. A stale ctx after /reload is
      // the expected failure — the result is still visible via /workflows.
      void Promise.resolve(ret).catch(() => {});
    } catch {
      // Synchronous failure (e.g. stale ctx) — result still visible via /workflows.
    }
  };

  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    if (run?.background) {
      deliver(deliverText(run, { resultPath: persistedResultPath(manager, runId), maxChars: deliveredMaxChars(opts) }));
    }
  });
  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    if (!manager.getRun(runId)?.background) return;
    deliver(`✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`);
  });
  // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
  // user it is resumable once their budget refills, rather than letting it look dead.
  // Manual pause() also emits "paused" but with no reason — guard so only the
  // usage-limit case delivers a message.
  manager.on(
    "paused",
    ({
      runId,
      reason,
      error,
      resetHint,
    }: {
      runId: string;
      reason?: string;
      error?: { message?: string };
      resetHint?: string;
    }) => {
      if (reason !== "usage_limit") return;
      if (!manager.getRun(runId)?.background) return;
      const when = resetHint ? ` (${resetHint})` : "";
      const cause = error?.message ?? "provider usage limit reached";
      deliver(
        `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
          `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`,
      );
    },
  );
}

export function renderPanel(manager: WorkflowManager, theme: Theme, width?: number): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const rows = active.flatMap((r) => {
    const live = manager.getRun(r.runId);
    const agents = live?.snapshot.agents ?? r.agents;
    const done = agents.filter((a) => a.status === "done").length;
    const running = agents.filter((a) => a.status === "running");
    const paused = agents.filter((a) => a.status === "paused");
    const queued = agents.filter((a) => a.status === "queued").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const phase = live?.snapshot.currentPhase ? ` · ${live.snapshot.currentPhase}` : "";
    const summary = `  ${icon} ${r.workflowName}  ${done}/${agents.length} agents · ${running.length} running · ${paused.length} paused · ${queued} not started${phase}`;
    const pausedLines = paused.length
      ? wrapLine(
          `    Paused mid-run (${paused.length}): ${paused
            .map((agent) => `${agent.label}${agent.sessionFile ? " (session saved)" : " (fresh restart)"}`)
            .join(", ")}`,
          width,
        )
      : [];
    if (!running.length) return [summary, ...pausedLines];
    const cap = live?.execution?.effectiveConcurrency ?? r.effectiveConcurrency ?? running.length;
    return [
      summary,
      ...wrapLine(
        `    Running now (${running.length}/${cap}): ${running.map((agent) => agent.label).join(", ")}`,
        width,
      ),
      ...pausedLines,
    ];
  });
  // Finished runs leave this live panel but are kept in the navigator. Tell the
  // user so a completed run doesn't look like it vanished.
  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  const hint = theme.fg(
    "dim",
    finished > 0
      ? `  /workflows — open navigator (${finished} finished kept in history)`
      : "  /workflows — open navigator",
  );
  return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint].map((line) => fitLine(line, width));
}

// ─── Detailed mode: live token rate ────────────────────────────────────────────

/** Rolling window for the token/s rate. Older samples age out so a stall decays to 0. */
const RATE_WINDOW_MS = 10_000;
/** Per-invocation samples grouped by run. Stable execution IDs prevent duplicate
 * labels from sharing a token-rate series. */
const tokenSamples = new Map<string, Map<string, Array<{ ts: number; total: number }>>>();
const RUN_TOTAL_SAMPLE = "__run__";

/** Record a token-total sample for one invocation (or the run aggregate by default). */
export function sampleTokens(runId: string, total: number, now: number, executionId = RUN_TOTAL_SAMPLE): void {
  const byAgent = tokenSamples.get(runId) ?? new Map<string, Array<{ ts: number; total: number }>>();
  const samples = byAgent.get(executionId) ?? [];
  const last = samples[samples.length - 1];
  if (last && last.ts === now && last.total === total) return;
  samples.push({ ts: now, total });
  while (samples.length > 2 && now - samples[0].ts > RATE_WINDOW_MS) samples.shift();
  byAgent.set(executionId, samples);
  tokenSamples.set(runId, byAgent);
}

function sampleRate(samples: Array<{ ts: number; total: number }> | undefined): number {
  if (!samples || samples.length < 2) return 0;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedMs = newest.ts - oldest.ts;
  const delta = newest.total - oldest.total;
  return elapsedMs > 0 && delta > 0 ? (delta / elapsedMs) * 1000 : 0;
}

/** Tokens/second for one invocation, or the aggregate compatibility series. */
export function tokensPerSecond(runId: string, executionId = RUN_TOTAL_SAMPLE): number {
  return sampleRate(tokenSamples.get(runId)?.get(executionId));
}

/** Forget a run or one terminal invocation's samples. */
export function clearTokenSamples(runId: string, executionId?: string): void {
  if (!executionId) {
    tokenSamples.delete(runId);
    return;
  }
  const byAgent = tokenSamples.get(runId);
  byAgent?.delete(executionId);
  if (byAgent?.size === 0) tokenSamples.delete(runId);
}

/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export function clampMaxAgents(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 8;
  return Math.min(1000, Math.floor(value));
}

/** Per-phase + per-agent body for one run in detailed mode (mirrors renderWorkflowLines). */
function renderRunBody(
  snap: WorkflowSnapshot,
  agents: WorkflowAgentSnapshot[],
  maxAgents: number,
  theme: Theme,
): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const lines: string[] = [];
  // Group agents by phase, declared order first then discovery order (as the navigator does).
  const order = snap.phases.length ? [...snap.phases] : [];
  const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
  for (const a of agents) {
    const key = a.phase ?? "(no phase)";
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)?.push(a);
    if (!order.includes(key)) order.push(key);
  }
  for (const title of order) {
    const phaseAgents = byPhase.get(title) ?? [];
    if (!phaseAgents.length) continue;
    const done = phaseAgents.filter((a) => a.status === "done").length;
    const running = phaseAgents.filter((a) => a.status === "running").length;
    const paused = phaseAgents.filter((a) => a.status === "paused").length;
    const queued = phaseAgents.filter((a) => a.status === "queued").length;
    const errors = phaseAgents.filter((a) => a.status === "error").length;
    const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
    const complete = done + errors + skipped === phaseAgents.length;
    const marker =
      paused > 0 ? "⏸" : running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
    const phaseTokens = phaseAgents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    const phaseMeta = [
      `${done}/${phaseAgents.length} agents`,
      running ? `${running} running` : "",
      paused ? `${paused} paused` : "",
      queued ? `${queued} not started` : "",
      errors ? `${errors} errors` : "",
      phaseTokens > 0 ? `${fmtTokensShort(phaseTokens)} tok` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(theme.fg("accent", `  ${marker} ${title}`) + dim(`  ${phaseMeta}`));

    const visible = phaseAgents.slice(-maxAgents);
    for (const a of visible) {
      const tok = a.tokens ? dim(` ${a.tokensEstimated ? "~" : ""}${fmtTokensShort(a.tokens)} tok`) : "";
      const mdl = shortModel(a.model);
      const model = mdl ? dim(` · ${mdl}`) : "";
      const state =
        a.status === "paused" ? `paused mid-run (${a.sessionFile ? "session saved" : "fresh restart"})` : a.status;
      lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${tok}${model}${dim(` · ${state}`)}`);
    }
    if (phaseAgents.length > visible.length) {
      lines.push(dim(`    … ${phaseAgents.length - visible.length} earlier agents`));
    }
  }
  return lines;
}

/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export function renderPanelDetailed(
  manager: WorkflowManager,
  theme: Theme,
  width: number | undefined,
  maxAgents: number,
  now: number,
): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  const knownRunIds = new Set(all.map((run) => run.runId));
  for (const sampledRunId of tokenSamples.keys()) {
    if (!knownRunIds.has(sampledRunId)) tokenSamples.delete(sampledRunId);
  }
  if (!active.length) return [];
  const dim = (t: string) => theme.fg("dim", t);
  const out: string[] = [theme.bold(`Workflows running (${active.length}):`)];

  for (const r of active) {
    const live = manager.getRun(r.runId);
    const snap = live?.snapshot;
    const agents = (snap?.agents ?? r.agents) as WorkflowAgentSnapshot[];
    const done = agents.filter((a) => a.status === "done").length;
    const running = agents.filter((a) => a.status === "running");
    const paused = agents.filter((a) => a.status === "paused");
    const queued = agents.filter((a) => a.status === "queued").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const usage = snap?.tokenUsage ?? r.tokenUsage;
    const total = agents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    const estimated = agents.some((agent) => agent.tokensEstimated && (agent.tokens ?? 0) > 0);
    let rate = 0;
    for (const agent of running) {
      const executionId = agent.executionId ?? `${r.runId}:${agent.callIndex ?? agent.id - 1}`;
      sampleTokens(r.runId, agent.tokens ?? 0, now, executionId);
      rate += tokensPerSecond(r.runId, executionId);
    }
    if (r.status !== "running") rate = 0;
    const meta = [
      `${done}/${agents.length} agents`,
      `${running.length} running`,
      `${paused.length} paused`,
      `${queued} not started`,
      snap?.currentPhase || "",
      total > 0 ? `${estimated ? "~" : ""}${fmtTokensShort(total)} tok` : "",
      // 2 decimals for ≥1¢, 4 for sub-cent so a real cost never shows as "$0.00".
      // (cost is only known once the run finalizes its usage.)
      usage?.cost ? `$${usage.cost.toFixed(usage.cost >= 0.01 ? 2 : 4)}` : "",
      rate > 0 ? `${Math.round(rate)} tok/s` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${icon} ${theme.bold(r.workflowName)}  ${dim(meta)}`);
    if (running.length) {
      const cap = live?.execution?.effectiveConcurrency ?? r.effectiveConcurrency ?? running.length;
      out.push(
        ...wrapLine(
          dim(`    Running now (${running.length}/${cap}): ${running.map((agent) => agent.label).join(", ")}`),
          width,
        ),
      );
    }
    if (paused.length) {
      out.push(
        ...wrapLine(
          theme.fg(
            "warning",
            `    Paused mid-run (${paused.length}): ${paused
              .map((agent) => `${agent.label}${agent.sessionFile ? " (session saved)" : " (fresh restart)"}`)
              .join(", ")}`,
          ),
          width,
        ),
      );
    }
    if (snap) out.push(...renderRunBody(snap, agents, maxAgents, theme));
  }

  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  out.push(
    dim(
      finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator",
    ),
  );
  return out.map((line) => fitLine(line, width));
}

/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export function installTaskPanel(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: TaskPanelOptions = {},
): void {
  // Live-read settings with a ~1s TTL: a render-path disk read every frame would
  // be wasteful, but re-reading at most once a second still makes
  // /workflows-progress take effect "immediately" (no restart).
  let cached: WorkflowSettings = {};
  let cachedAt = Number.NEGATIVE_INFINITY;
  const settings = (): WorkflowSettings => {
    if (!opts.loadSettings) return cached;
    const now = Date.now();
    if (now - cachedAt > 1000) {
      try {
        cached = opts.loadSettings() ?? {};
      } catch {
        cached = {};
      }
      cachedAt = now;
    }
    return cached;
  };
  const hasActiveRun = () => manager.listRuns().some((r) => r.status === "running" || r.status === "paused");

  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      const onEvent = () => tui.requestRender();
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      const onAgentEnd = ({ runId, executionId }: { runId: string; executionId: string }) =>
        clearTokenSamples(runId, executionId);
      manager.on("agentEnd", onAgentEnd);
      const onRunEnd = ({ runId }: { runId: string }) => clearTokenSamples(runId);
      for (const ev of RUN_END_EVENTS) manager.on(ev, onRunEnd);
      // In detailed mode, force a redraw every 2s while a run is active so the
      // token/s rate keeps updating between sparse token events — and decays to 0
      // when an agent stalls. Gated + unref'd so it costs nothing when idle.
      const timer = setInterval(() => {
        if (settings().progressPanelMode === "detailed" && hasActiveRun()) tui.requestRender();
      }, 2000);
      (timer as { unref?: () => void }).unref?.();
      // Purely informational: it lists running runs and re-renders on events. To
      // open the navigator, the user runs /workflows (the panel takes no input).
      const comp: Component & { dispose?(): void } = {
        render: (width: number) => {
          const s = settings();
          if (s.progressPanelMode === "detailed") {
            return renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), Date.now());
          }
          return renderPanel(manager, theme, width);
        },
        invalidate: () => {},
        dispose: () => {
          clearInterval(timer);
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
          manager.off("agentEnd", onAgentEnd);
          for (const ev of RUN_END_EVENTS) manager.off(ev, onRunEnd);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
