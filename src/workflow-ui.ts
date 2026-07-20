/**
 * Interactive `/workflows` navigator, modeled on Claude Code's view:
 *
 *   runs ──enter──▶ phases ──enter──▶ agents ──enter──▶ agent detail
 *        ◀──esc───        ◀──esc────         ◀──esc────
 *        ◀── (saved items in runs view) ──enter──▶ saved detail
 *
 * Keys: ↑/↓ (or j/k) select · enter/→ drill in · esc/← back (esc at top closes)
 *       On runs: p pause · x stop · r restart · s save · q quit
 *       On saved: x delete · q quit
 *
 * The state machine and line rendering are pure and unit-tested; the pi-tui
 * Component shell (openWorkflowNavigator) wires them to live manager events.
 */

import {
  type ExtensionAPI,
  type ExtensionUIContext,
  getLanguageFromPath,
  getMarkdownTheme,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { Markdown, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentUsage } from "./agent.js";
import type { ThemeLike, WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
import { aggregateAgentUsage, fmtCost, fmtTokenSegment, tokenFigures } from "./display.js";
import type { PersistedRunState } from "./run-persistence.js";
import { registerSavedWorkflow } from "./saved-commands.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  queued: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  done: "✓",
  failed: "✗",
  error: "✗",
  aborted: "⊘",
  skipped: "⊘",
};

const PLAIN: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

/** Bounded per-overlay cache for expensive Markdown parsing and highlighting. */
class NavigatorTextRenderCache {
  private readonly entries = new Map<string, { lines: string[]; weight: number }>();
  private readonly resultJson = new WeakMap<object, string>();
  private weight = 0;

  get(key: string): string[] | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    // Refresh insertion order so eviction behaves like a small LRU.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.lines;
  }

  stringify(result: object): string {
    const cached = this.resultJson.get(result);
    if (cached !== undefined) return cached;
    let json: string;
    try {
      json = JSON.stringify(result, null, 2) ?? String(result);
    } catch {
      json = String(result);
    }
    this.resultJson.set(result, json);
    return json;
  }

  set(key: string, lines: string[], weight: number): string[] {
    const MAX_ENTRIES = 96;
    const MAX_WEIGHT = 4_000_000;
    if (weight > MAX_WEIGHT) return lines;
    const previous = this.entries.get(key);
    if (previous) this.weight -= previous.weight;
    this.entries.delete(key);
    this.entries.set(key, { lines, weight });
    this.weight += weight;
    while (this.entries.size > MAX_ENTRIES || this.weight > MAX_WEIGHT) {
      const oldest = this.entries.entries().next().value as [string, { lines: string[]; weight: number }] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.weight -= oldest[1].weight;
    }
    return lines;
  }
}

// Border characters for the overlay box
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

export type ViewKind = "runs" | "phases" | "agents" | "detail" | "savedDetail";

export type ItemKind = "run" | "saved";

interface RunRow {
  runId: string;
  name: string;
  status: string;
  done: number;
  total: number;
  /** Fresh tokens for the whole run (see tokenFigures for the fallback rule). */
  fresh: number;
  /** Cache-read tokens for the whole run. */
  cacheRead: number;
  cost: number;
}
interface PhaseRow {
  title: string;
  done: number;
  total: number;
  /** Fresh tokens summed across the phase's agents. */
  fresh: number;
  /** Cache-read tokens summed across the phase's agents. */
  cacheRead: number;
}
interface AgentRow {
  id: number;
  label: string;
  status: string;
  phase?: string;
  tokens?: number;
  tokenUsage?: AgentUsage;
  model?: string;
}

/** Short, human-friendly model label: drop the provider prefix for display. */
/**
 * Coerce a possibly-non-string value from a (corrupt) persisted run to a string,
 * so it can never reach a downstream truncateToWidth()/visibleWidth() as a
 * non-string and crash the whole /workflows overlay via text.slice() (#110).
 * Applied at every Model read boundary that feeds the renderer: phase titles,
 * agent labels/phases, and run names.
 */
function asText(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

/** The (coerced) phase an agent belongs to; "(no phase)" when unset. Shared by
 *  agents()/agentsByPhase() so grouping and the drilled-in filter always agree. */
function agentPhaseKey(a: WorkflowAgentSnapshot): string {
  return a.phase != null ? asText(a.phase) : "(no phase)";
}

/** Build a render-safe AgentRow: coerce label/phase so a non-string value from a
 *  corrupt run can't crash the agent row's truncateToWidth() (#110). */
function toAgentRow(a: WorkflowAgentSnapshot): AgentRow {
  return {
    id: a.id,
    label: asText(a.label),
    status: a.status,
    phase: a.phase != null ? asText(a.phase) : a.phase,
    tokens: a.tokens,
    tokenUsage: a.tokenUsage,
    model: a.model,
  };
}

export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = asText(model);
  const slash = m.indexOf("/");
  return slash > 0 ? m.slice(slash + 1) : m;
}

/** Reads run/phase/agent data from the manager, preferring live snapshots. */
export class NavigatorModel {
  private frameDepth = 0;
  private frameRuns: PersistedRunState[] | undefined;
  private readonly frameSnapshots = new Map<string, { snapshot: WorkflowSnapshot; status: string } | undefined>();

  constructor(
    private readonly manager: Pick<WorkflowManager, "listRuns" | "getRun">,
    private readonly storage?: { list(): SavedWorkflow[]; delete(name: string, location?: string): boolean },
  ) {}

  /** Share persisted data across all model lookups performed by one render. */
  withRenderFrame<T>(render: () => T): T {
    const outermost = this.frameDepth === 0;
    this.frameDepth++;
    try {
      return render();
    } finally {
      this.frameDepth--;
      if (outermost) {
        this.frameRuns = undefined;
        this.frameSnapshots.clear();
      }
    }
  }

  private persistedRuns(): PersistedRunState[] {
    if (this.frameDepth === 0) return this.manager.listRuns();
    if (!this.frameRuns) this.frameRuns = this.manager.listRuns();
    return this.frameRuns;
  }

  private snapshot(runId: string): { snapshot: WorkflowSnapshot; status: string } | undefined {
    if (this.frameDepth > 0 && this.frameSnapshots.has(runId)) return this.frameSnapshots.get(runId);
    const live = this.manager.getRun(runId);
    const value = live
      ? { snapshot: live.snapshot, status: live.status }
      : (() => {
          const p = this.persistedRuns().find((r) => r.runId === runId);
          return p ? { snapshot: persistedToSnapshot(p), status: p.status } : undefined;
        })();
    if (this.frameDepth > 0) this.frameSnapshots.set(runId, value);
    return value;
  }

  runs(): RunRow[] {
    return this.persistedRuns().map((p) => {
      const live = this.manager.getRun(p.runId);
      // Array guard (#110): a structurally corrupt persisted run (agents not an
      // array) would otherwise throw "agents is not iterable" here and crash the
      // runs list itself — i.e. /workflows would fail to open at all.
      const rawAgents = live?.snapshot.agents ?? p.agents;
      const agents = (Array.isArray(rawAgents) ? rawAgents : []) as WorkflowAgentSnapshot[];
      const usage = live?.snapshot.tokenUsage ?? p.tokenUsage;
      // The run-level aggregate is authoritative but only lands when the run
      // ends; per-agent figures update live. Use whichever accounts for more
      // tokens, so live runs show a count in the list (agreeing with the phase
      // view) and finished/legacy runs keep the final aggregate.
      const fromUsage = tokenFigures(usage);
      const fromAgents = aggregateAgentUsage(agents);
      const figures =
        fromAgents.fresh + fromAgents.cacheRead > fromUsage.fresh + fromUsage.cacheRead ? fromAgents : fromUsage;
      return {
        runId: p.runId,
        name: asText(live?.snapshot.name ?? p.workflowName),
        status: live?.status ?? p.status,
        done: agents.filter((a) => a.status === "done").length,
        total: agents.length,
        fresh: figures.fresh,
        cacheRead: figures.cacheRead,
        cost: usage?.cost ?? 0,
      };
    });
  }

  /** Return saved workflows sorted by name, or [] when no storage configured. */
  saved(): SavedWorkflow[] {
    if (!this.storage) return [];
    return this.storage.list().sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Delete a saved workflow by name. */
  deleteSaved(name: string): boolean {
    if (!this.storage) return false;
    return this.storage.delete(name);
  }

  runName(runId: string): string {
    return asText(this.snapshot(runId)?.snapshot.name ?? runId);
  }

  runStatus(runId: string): string {
    // Coerce (#110): a corrupt persisted run can carry a non-string status, which
    // would otherwise crash twoPaneHeader's truncateToWidth() with text.slice().
    return asText(this.snapshot(runId)?.status ?? "unknown");
  }

  phases(runId: string): PhaseRow[] {
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap) return [];
    // Coerce phase keys up front (#110): a non-string phase — from a corrupt
    // persisted run or a script that passed a non-string to phase() — would
    // otherwise reach truncateToWidth() and crash the overlay. Grouping through
    // the shared agentPhaseKey() (not an inline copy) locks the invariant that
    // agents land under the same string the drilled-in agents() filter compares
    // against; the Array.isArray guards mirror agents()/agentsByPhase().
    const order = Array.isArray(snap.phases) ? snap.phases.map(asText) : [];
    const byPhase = new Map<string, AgentRow[]>();
    const agents = Array.isArray(snap.agents) ? snap.agents : [];
    for (const a of agents) {
      const key = agentPhaseKey(a);
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key)?.push(a);
      if (!order.includes(key)) order.push(key);
    }
    return order.map((title) => {
      const agents = byPhase.get(title) ?? [];
      const usage = aggregateAgentUsage(agents);
      return {
        title, // already coerced to a string above
        done: agents.filter((a) => a.status === "done").length,
        total: agents.length,
        fresh: usage.fresh,
        cacheRead: usage.cacheRead,
      };
    });
  }

  agents(runId: string, phase: string): AgentRow[] {
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap || !Array.isArray(snap.agents)) return [];
    return snap.agents.filter((a) => agentPhaseKey(a) === phase).map((a) => toAgentRow(a));
  }

  /**
   * All agents grouped by their (coerced) phase in a SINGLE pass — O(agents).
   * The navigator's phase pane needs each phase's agents (status colour + the
   * selected phase's rows); calling agents() once per phase row was O(phases ×
   * agents) per frame. Callers that render every phase use this instead.
   */
  agentsByPhase(runId: string): Map<string, AgentRow[]> {
    const out = new Map<string, AgentRow[]>();
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap || !Array.isArray(snap.agents)) return out;
    for (const a of snap.agents) {
      const key = agentPhaseKey(a);
      let arr = out.get(key);
      if (!arr) {
        arr = [];
        out.set(key, arr);
      }
      arr.push(toAgentRow(a));
    }
    return out;
  }

  agentDetail(runId: string, agentId: number): WorkflowAgentSnapshot | undefined {
    return this.snapshot(runId)?.snapshot.agents.find((a) => a.id === agentId);
  }
}

type StackFrame = {
  kind: ViewKind;
  cursor: number;
  runId?: string;
  phase?: string;
  agentId?: number;
  savedName?: string;
};

function persistedToSnapshot(p: PersistedRunState): WorkflowSnapshot {
  // Array guards (#110): structurally corrupt persisted arrays must not crash
  // the overlay. Resumable runs also avoid duplicating full results in agents[]
  // and the journal, so rehydrate done agents by namespaced call identity. The
  // positional index remains a fallback for files written before callId existed.
  const agents = (Array.isArray(p.agents) ? p.agents : []).filter((agent) => agent && typeof agent === "object");
  const journalByIndex = new Map<number, unknown>();
  const journalByCallId = new Map<string, unknown>();
  for (const entry of Array.isArray(p.journal) ? p.journal : []) {
    if (entry && typeof entry === "object" && typeof entry.index === "number") {
      journalByIndex.set(entry.index, entry.result);
      journalByCallId.set(`${entry.runId ?? p.runId}:${entry.index}`, entry.result);
    }
  }
  const snapshotAgents = agents.map((a, callIndex) => {
    const journalResult = a.callId ? journalByCallId.get(a.callId) : journalByIndex.get(callIndex);
    const result = a.result === undefined && a.status === "done" ? journalResult : a.result;
    return {
      id: a.id,
      callId: a.callId,
      label: a.label,
      phase: a.phase,
      prompt: a.prompt,
      status: a.status,
      result,
      resultPreview:
        result === undefined ? a.resultPreview : String(typeof result === "string" ? result : JSON.stringify(result)),
      error: a.error,
      errorCode: a.errorCode,
      recoverable: a.recoverable,
      history: a.history,
      tokens: a.tokens,
      tokenUsage: a.tokenUsage,
      model: a.model,
    };
  });
  return {
    name: asText(p.workflowName),
    phases: Array.isArray(p.phases) ? p.phases : [],
    currentPhase: p.currentPhase,
    logs: Array.isArray(p.logs) ? p.logs : [],
    agents: snapshotAgents,
    agentCount: snapshotAgents.length,
    runningCount: snapshotAgents.filter((a) => a.status === "running").length,
    doneCount: snapshotAgents.filter((a) => a.status === "done").length,
    errorCount: snapshotAgents.filter((a) => a.status === "error").length,
    tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
    runId: p.runId,
  };
}

/** Navigation state machine: a stack of (view, cursor) frames plus detail scroll. */
export class NavigatorState {
  private stack: StackFrame[] = [{ kind: "runs", cursor: 0 }];
  scroll = 0;
  tailing = false;
  pagerOpen = false;
  private pageSize = 1;

  private top(): StackFrame {
    return this.stack[this.stack.length - 1];
  }
  get kind(): ViewKind {
    return this.top().kind;
  }
  get cursor(): number {
    return this.top().cursor;
  }
  set cursor(val: number) {
    this.top().cursor = val;
  }
  get runId(): string | undefined {
    return this.top().runId;
  }
  get phase(): string | undefined {
    return this.top().phase;
  }
  get agentId(): number | undefined {
    return this.top().agentId;
  }
  /** The saved workflow name at the cursor in savedDetail view */
  get savedName(): string | undefined {
    return this.top().savedName;
  }
  get depth(): number {
    return this.stack.length;
  }

  /**
   * Determine what kind of item is at the given cursor position in the
   * runs view. Positions before runs.length are "run"; after are "saved".
   */
  itemKindAt(model: NavigatorModel, cursor: number): ItemKind {
    const runCount = model.runs().length;
    return cursor < runCount ? "run" : "saved";
  }

  /** Clamp the cursor to [0, count). */
  clamp(count: number) {
    const t = this.top();
    t.cursor = count <= 0 ? 0 : Math.max(0, Math.min(t.cursor, count - 1));
  }

  move(delta: number, count: number) {
    if (this.kind === "detail" || this.kind === "savedDetail") {
      if (this.kind === "detail") this.pagerOpen = true;
      if (delta < 0) this.tailing = false;
      this.scroll = Math.max(0, this.scroll + delta);
      return;
    }
    if (count <= 0) return;
    const t = this.top();
    t.cursor = (t.cursor + delta + count) % count;
  }

  /** Update the amount moved by page keys to match the rendered viewport. */
  setPageSize(rows: number) {
    this.pageSize = Math.max(1, rows);
  }

  /** Move by almost one viewport, retaining one line of reading context. */
  movePage(direction: -1 | 1, count: number) {
    const delta = direction * Math.max(1, this.pageSize - 1);
    if (this.kind === "detail" || this.kind === "savedDetail") {
      if (this.kind === "detail") this.pagerOpen = true;
      if (direction < 0) this.tailing = false;
      this.scroll = Math.max(0, this.scroll + delta);
      return;
    }
    if (count > 0) this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
  }

  /** Jump to the beginning or end of the current list/detail. End also enables
   * follow mode for a live agent detail; start disables it. */
  jump(edge: "start" | "end", count: number) {
    if (this.kind === "detail" || this.kind === "savedDetail") {
      if (this.kind === "detail") this.pagerOpen = true;
      this.tailing = this.kind === "detail" && edge === "end";
      // renderNavigator knows the body length and clamps this sentinel.
      this.scroll = edge === "start" ? 0 : Number.MAX_SAFE_INTEGER;
      return;
    }
    this.cursor = edge === "start" || count <= 0 ? 0 : count - 1;
  }

  /** Open the full pager without closing an already-open pager. */
  openPager(): boolean {
    if (this.kind !== "detail") return false;
    if (!this.pagerOpen) {
      this.pagerOpen = true;
      this.scroll = 0;
    }
    return true;
  }

  /** Toggle the full pager while retaining the compact agent summary view. */
  togglePager(): boolean {
    if (this.kind !== "detail") return false;
    if (!this.pagerOpen) return this.openPager();
    this.pagerOpen = false;
    this.scroll = 0;
    this.tailing = false;
    return false;
  }

  /** Toggle live follow mode in an agent detail pager. */
  toggleTail(): boolean {
    if (this.kind !== "detail") return false;
    this.pagerOpen = true;
    this.tailing = !this.tailing;
    if (this.tailing) this.scroll = Number.MAX_SAFE_INTEGER;
    return this.tailing;
  }

  /** Drill into the selected item. Returns true if the view changed. */
  drill(model: NavigatorModel): boolean {
    const t = this.top();
    if (t.kind === "runs") {
      const runs = model.runs();
      const saved = model.saved();
      if (t.cursor < runs.length) {
        // Drilling into a run
        const run = runs[t.cursor];
        if (!run) return false;
        this.stack.push({ kind: "phases", cursor: 0, runId: run.runId });
        return true;
      }
      // Drilling into a saved workflow
      const item = saved[t.cursor - runs.length];
      if (!item) return false;
      this.scroll = 0;
      this.tailing = false;
      this.pagerOpen = false;
      this.stack.push({ kind: "savedDetail", cursor: 0, savedName: item.name });
      return true;
    }
    if (t.kind === "phases" && t.runId) {
      const phases = model.phases(t.runId);
      const ph = phases[t.cursor];
      if (!ph) return false;
      this.stack.push({ kind: "agents", cursor: 0, runId: t.runId, phase: ph.title });
      return true;
    }
    if (t.kind === "agents" && t.runId && t.phase) {
      const agents = model.agents(t.runId, t.phase);
      const ag = agents[t.cursor];
      if (!ag) return false;
      this.scroll = 0;
      this.tailing = false;
      this.pagerOpen = false;
      this.stack.push({ kind: "detail", cursor: 0, runId: t.runId, phase: t.phase, agentId: ag.id });
      return true;
    }
    return false;
  }

  /** Pop one level. Returns false when already at the top (caller should close). */
  back(): boolean {
    if (this.kind === "detail" && this.pagerOpen) {
      this.pagerOpen = false;
      this.scroll = 0;
      this.tailing = false;
      return true;
    }
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.scroll = 0;
    this.tailing = false;
    this.pagerOpen = false;
    return true;
  }

  /** The runId at cursor, or undefined when on a saved item. */
  activeRunId(model: NavigatorModel): string | undefined {
    if (this.runId) return this.runId;
    if (this.kind === "runs") {
      const runs = model.runs();
      if (this.cursor < runs.length) return runs[this.cursor]?.runId;
    }
    return undefined;
  }
}

function pad(n: number): string {
  return n.toLocaleString();
}

// ───────────────────────────────────────────────────────────────────────────
// Two-pane (Phases | agents) renderer — Claude-Code parity.
//
// Draws a single combined frame that shares one top rule and one full-height
// vertical divider between a left "Phases" box and a right "<phase> · N agent"
// box. Pure: depends only on state + model + theme + width. All measuring is
// ANSI-aware (visibleWidth) and all padding/truncation goes through
// truncateToWidth so colored cells still align.
// ───────────────────────────────────────────────────────────────────────────

// Light box-drawing glyphs (no heavy/double variants).
const BX = { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", tj: "┬", bj: "┴" } as const;
const CARET = "›";
const DOT = "●";
const ELLIPSIS = "…";

// Tunables (exposed for clarity / future tuning) — see spec §0/§10.
const LW_MIN = 14;
const RW_MIN = 24;
const GAP_NM = 2; // min spaces between agent name and model columns

/** Compact token count: 842, 35k, 35.7k, 1.3M (trailing .0 trimmed). */
function compactTokens(t: number): string {
  if (!t || t <= 0) return "0";
  if (t < 1000) return String(Math.round(t));
  if (t < 1_000_000) {
    const k = t / 1000;
    const s = k >= 100 ? Math.round(k).toString() : trimZero(k.toFixed(1));
    return `${s}k`;
  }
  const m = t / 1_000_000;
  return `${trimZero(m.toFixed(1))}M`;
}
function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function pluralize(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}

/** Aggregate phase status precedence: ERR > RUN > all-done(OK) > PEND. */
function phaseStatusColor(p: { done: number; total: number }, agents: AgentRow[]): string {
  if (agents.some((a) => a.status === "error" || a.status === "failed")) return "error";
  if (agents.some((a) => a.status === "running")) return "warning";
  if (p.total > 0 && p.done === p.total) return "success";
  return "dim";
}

const AGENT_DOT_COLOR: Record<string, string> = {
  running: "warning",
  queued: "dim",
  pending: "dim",
  paused: "dim",
  done: "success",
  completed: "success",
  error: "error",
  failed: "error",
  skipped: "dim",
  aborted: "dim",
};

/** Compute the left ("Phases") box outer width, clamped per spec §3.1. */
function computeLeftWidth(phases: PhaseRow[], width: number): number {
  const titleNeed = visibleWidth("Phases") + 2 /*spaces*/ + 1 /*┌*/ + 1 /*┬*/ + 3 /*min dashes*/;
  let contentMax = 0;
  phases.forEach((p, i) => {
    const idx = String(i + 1);
    const hasAgents = p.total > 0;
    const need =
      2 /*marker*/ +
      visibleWidth(idx) +
      1 /*sp*/ +
      visibleWidth(p.title) +
      (hasAgents ? 1 + visibleWidth(`${p.done}/${p.total}`) : 0);
    if (need > contentMax) contentMax = need;
  });
  const innerNeed = Math.max(contentMax, titleNeed - 2);
  const lwNatural = innerNeed + 2; // + left │ + shared │
  const lwMax = Math.min(40, Math.floor(width * 0.45));
  return Math.max(LW_MIN, Math.min(lwNatural, Math.max(LW_MIN, lwMax)));
}

/** Build a left-pane phase row (content field, exact width = innerW). */
function leftPhaseRow(
  p: PhaseRow,
  i: number,
  selected: boolean,
  agents: AgentRow[],
  innerW: number,
  theme: ThemeLike,
): string {
  const idx = String(i + 1);
  const hasAgents = p.total > 0;
  const progress = hasAgents ? `${p.done}/${p.total}` : "";
  const marker = selected ? `${CARET} ` : "  ";
  // Fixed parts width: marker + idx + space + (space+progress if shown)
  const fixed = 2 + visibleWidth(idx) + 1 + (progress ? 1 + visibleWidth(progress) : 0);
  const nameRoom = Math.max(0, innerW - fixed);
  const name = truncateToWidth(p.title, nameRoom, ELLIPSIS, false);

  const styleMain = (s: string) => (selected ? theme.fg("accent", theme.bold(s)) : hasAgents ? s : theme.fg("dim", s));
  const progStyle = (s: string) =>
    selected ? theme.fg("accent", theme.bold(s)) : theme.fg(phaseStatusColor(p, agents), s);

  const caret = selected ? theme.fg("accent", theme.bold(marker)) : marker;
  let row = caret + styleMain(`${idx} ${name}`);
  if (progress) row += ` ${progStyle(progress)}`;
  return truncateToWidth(row, innerW, "", true); // pad to exact innerW
}

/** Build a right-pane agent row (content field, exact width = innerW). */
function rightAgentRow(
  a: AgentRow,
  selected: boolean,
  modelColStart: number,
  innerW: number,
  theme: ThemeLike,
): string {
  const dotColor = AGENT_DOT_COLOR[a.status] ?? "dim";
  const stats = fmtTokenSegment(tokenFigures(a.tokenUsage, a.tokens), compactTokens);
  const model = shortModel(a.model) ?? "";

  // Stable 2-cell marker so columns never shift on selection: "› " | "  ".
  // Layout: <marker:2><dot><sp><name> … <model> … <stats(right-aligned)>.
  const markerW = 2;
  const statsW = visibleWidth(stats);
  const nameStart = markerW + 2; // marker + dot + space
  let modelStart = Math.max(nameStart + visibleWidth(a.label) + GAP_NM, markerW + modelColStart);
  const statsStart = innerW - statsW;

  // Available room for the model block (between modelStart and stats, min 1 gap).
  let modelRoom = statsStart - 1 - modelStart;
  let nameOut = a.label;
  let modelOut = model;
  if (modelRoom < 0) {
    // No room for model: drop it (spec §4.4 step 1/2), possibly truncate name.
    modelOut = "";
    modelStart = nameStart;
    modelRoom = 0;
    const nameRoom = Math.max(0, statsStart - 1 - nameStart);
    nameOut = truncateToWidth(a.label, nameRoom, ELLIPSIS, false);
  } else {
    modelOut = truncateToWidth(model, modelRoom, ELLIPSIS, false);
    const nameRoom = Math.max(0, modelStart - GAP_NM - nameStart);
    nameOut = truncateToWidth(a.label, nameRoom, ELLIPSIS, false);
  }

  const marker = selected ? theme.fg("accent", theme.bold(`${CARET} `)) : "  ";
  const dot = theme.fg(dotColor, DOT);
  const nameStyled = selected ? theme.fg("accent", theme.bold(nameOut)) : theme.fg("accent", nameOut);
  const modelStyled = modelOut ? theme.fg("dim", modelOut) : "";
  const statsStyled = theme.fg("dim", stats);

  // Assemble with explicit cell padding (visibleWidth-driven gaps).
  let out = marker + dot + " " + nameStyled;
  const afterName = nameStart + visibleWidth(nameOut);
  if (modelOut) {
    out += " ".repeat(Math.max(0, modelStart - afterName)) + modelStyled;
    const afterModel = modelStart + visibleWidth(modelOut);
    out += " ".repeat(Math.max(0, statsStart - afterModel)) + statsStyled;
  } else {
    out += " ".repeat(Math.max(0, statsStart - afterName)) + statsStyled;
  }
  return truncateToWidth(out, innerW, "", true);
}

/** Compose a titled top rule for one box side (between two join chars). */
function topTitleSegment(title: string, innerW: number, leading: boolean, theme: ThemeLike): string {
  // leading=true → right box (one ─ before the title); leading=false → left box.
  const label = ` ${title} `;
  const lead = leading ? BX.h : "";
  let labelOut = label;
  const fixed = visibleWidth(lead) + 1; // + at least one trailing dash
  if (visibleWidth(label) > innerW - fixed) {
    labelOut = truncateToWidth(label, Math.max(0, innerW - fixed), ELLIPSIS, false);
  }
  const used = visibleWidth(lead) + visibleWidth(labelOut);
  const dashes = BX.h.repeat(Math.max(0, innerW - used));
  return theme.fg("muted", lead) + theme.fg("dim", labelOut) + theme.fg("muted", dashes);
}

interface TwoPaneArgs {
  width: number;
  bodyRows: number;
  left: string[]; // pre-rendered left content rows (exact LW-2 cells each)
  right: string[]; // pre-rendered right content rows (exact RW-2 cells each)
  leftTitle: string;
  rightTitle: string;
  leftW: number; // LW
  theme: ThemeLike;
}

/** Emit the full combined frame (top rule, body rows, bottom rule). */
function renderTwoPaneFrame(a: TwoPaneArgs): string[] {
  const { width, bodyRows, left, right, leftTitle, rightTitle, leftW, theme } = a;
  // RW fills the remainder; the divider column is shared (overlaps 1 cell) so
  // net rendered width = LW + RW - 1 = width. Hence RW = width - LW + 1.
  const rightW = width - leftW + 1;
  const leftInner = leftW - 2;
  const rightInner = rightW - 2;
  const bc = (s: string) => theme.fg("muted", s);
  const out: string[] = [];

  // Top rule: ┌ <left title> ┬ <right title> ┐
  out.push(
    bc(BX.tl) +
      topTitleSegment(leftTitle, leftInner, false, theme) +
      bc(BX.tj) +
      topTitleSegment(rightTitle, rightInner, true, theme) +
      bc(BX.tr),
  );

  // Body rows.
  const blankL = " ".repeat(leftInner);
  const blankR = " ".repeat(rightInner);
  for (let r = 0; r < bodyRows; r++) {
    const l = left[r] ?? blankL;
    const rr = right[r] ?? blankR;
    out.push(bc(BX.v) + l + bc(BX.v) + rr + bc(BX.v));
  }

  // Bottom rule: └ ─ ┴ ─ ┘
  out.push(bc(BX.bl) + bc(BX.h.repeat(leftInner)) + bc(BX.bj) + bc(BX.h.repeat(rightInner)) + bc(BX.br));
  return out;
}

/**
 * Render the combined Phases | agents two-pane view. Shared by the "phases"
 * branch (cursor in left/Phases pane) and the "agents" branch (cursor in
 * right/agents pane after drilling in). Returns the full frame as lines.
 */
function renderPhasesAgents(
  state: NavigatorState,
  model: NavigatorModel,
  runId: string,
  width: number,
  theme: ThemeLike,
  bodyCap: number,
): string[] {
  const phases = model.phases(runId);
  // Group agents by phase ONCE per frame (O(agents)). leftPhaseRow needs each
  // visible phase's agents (status colour) and the selected phase's agents drive
  // the right pane; calling model.agents() per phase row was O(phases × agents).
  const agentsByPhase = model.agentsByPhase(runId);
  const agentsOf = (title: string): AgentRow[] => agentsByPhase.get(title) ?? [];
  // Which phase is selected drives the right pane. In "phases" view it's the
  // cursor; in "agents" view it's the drilled-in phase (state.phase).
  const inAgents = state.kind === "agents";
  let selPhaseIdx = inAgents ? phases.findIndex((p) => p.title === state.phase) : state.cursor;
  if (selPhaseIdx < 0) selPhaseIdx = 0;
  const selPhase = phases[selPhaseIdx];
  const agents = selPhase ? agentsOf(selPhase.title) : [];

  // Narrow-terminal degrade: single pane (spec §7.1).
  if (width < LW_MIN + RW_MIN - 1) {
    return renderSinglePane(state, phases, selPhaseIdx, agents, width, theme, bodyCap, inAgents);
  }

  const leftW = computeLeftWidth(phases, width);
  const rightW = width - leftW + 1; // shared divider overlaps 1 cell
  const leftInner = leftW - 2;
  const rightInner = rightW - 2;

  // Vertical scroll so the active item stays visible (spec §7.2).
  const leftRows = scrollWindow(phases.length, inAgents ? selPhaseIdx : state.cursor, bodyCap);
  const rightRows = scrollWindow(agents.length, inAgents ? state.cursor : 0, bodyCap);
  const bodyRows = Math.max(1, Math.min(bodyCap, Math.max(leftRows.count, rightRows.count)));

  // Left column (Phases).
  const left: string[] = [];
  for (let k = 0; k < bodyRows; k++) {
    const idx = leftRows.start + k;
    if (idx >= phases.length) {
      left.push(" ".repeat(leftInner));
      continue;
    }
    const p = phases[idx];
    const selected = !inAgents && idx === state.cursor;
    const ag = agentsOf(p.title);
    let row = leftPhaseRow(p, idx, selected, ag, leftInner, theme);
    if (k === bodyRows - 1 && leftRows.more) {
      row = truncateToWidth(theme.fg("dim", `  ${ELLIPSIS}`), leftInner, "", true);
    }
    left.push(row);
  }

  // Right column (agents of selected phase).
  const modelColStart = computeModelColStart(agents, rightInner);
  const right: string[] = [];
  if (agents.length === 0) {
    const msg = truncateToWidth(theme.fg("dim", "no agents"), rightInner, "", true);
    for (let k = 0; k < bodyRows; k++) right.push(k === 0 ? msg : " ".repeat(rightInner));
  } else {
    for (let k = 0; k < bodyRows; k++) {
      const idx = rightRows.start + k;
      if (idx >= agents.length) {
        right.push(" ".repeat(rightInner));
        continue;
      }
      const selected = inAgents && idx === state.cursor;
      let row = rightAgentRow(agents[idx], selected, modelColStart, rightInner, theme);
      if (k === bodyRows - 1 && rightRows.more) {
        row = truncateToWidth(theme.fg("dim", `  ${ELLIPSIS}`), rightInner, "", true);
      }
      right.push(row);
    }
  }

  const n = agents.length;
  const rightTitle = `${selPhase ? selPhase.title : "(none)"} · ${n} ${pluralize("agent", n)}`;
  return renderTwoPaneFrame({
    width,
    bodyRows,
    left,
    right,
    leftTitle: "Phases",
    rightTitle,
    leftW,
    theme,
  });
}

/** Model column start aligned across agent rows (spec §4.3), clamped to field. */
function computeModelColStart(agents: AgentRow[], innerW: number): number {
  let maxName = 0;
  for (const a of agents) maxName = Math.max(maxName, visibleWidth(a.label));
  const start = 2 /*dot+sp*/ + maxName + GAP_NM;
  // Keep model column from colliding with the right edge; cap at ~55% of field.
  return Math.min(start, Math.max(2, Math.floor(innerW * 0.55)));
}

interface ScrollWin {
  start: number;
  count: number;
  more: boolean;
}
/** Compute a scroll window of up to `cap` rows keeping `active` visible. */
function scrollWindow(total: number, active: number, cap: number): ScrollWin {
  if (total <= cap) return { start: 0, count: total, more: false };
  let start = Math.max(0, Math.min(active - Math.floor(cap / 2), total - cap));
  if (active < start) start = active;
  if (active >= start + cap) start = active - cap + 1;
  return { start, count: cap, more: start + cap < total };
}

/** Narrow-terminal single pane (spec §7.1): show the active pane full width. */
function renderSinglePane(
  state: NavigatorState,
  phases: PhaseRow[],
  selPhaseIdx: number,
  agents: AgentRow[],
  width: number,
  theme: ThemeLike,
  bodyCap: number,
  inAgents: boolean,
): string[] {
  const innerW = Math.max(1, width - 2);
  const bc = (s: string) => theme.fg("muted", s);
  const out: string[] = [];
  if (inAgents) {
    const selPhase = phases[selPhaseIdx];
    const n = agents.length;
    const title = `${selPhase ? selPhase.title : "(none)"} · ${n} ${pluralize("agent", n)}`;
    out.push(bc(BX.tl) + topTitleSegment(title, innerW, false, theme) + bc(BX.tr));
    const win = scrollWindow(agents.length, state.cursor, bodyCap);
    const modelColStart = computeModelColStart(agents, innerW);
    const rows = Math.max(1, win.count);
    for (let k = 0; k < rows; k++) {
      const idx = win.start + k;
      if (idx >= agents.length) {
        out.push(bc(BX.v) + " ".repeat(innerW) + bc(BX.v));
        continue;
      }
      let row = rightAgentRow(agents[idx], idx === state.cursor, modelColStart, innerW, theme);
      if (k === rows - 1 && win.more) row = truncateToWidth(theme.fg("dim", `  ${ELLIPSIS}`), innerW, "", true);
      out.push(bc(BX.v) + row + bc(BX.v));
    }
  } else {
    out.push(bc(BX.tl) + topTitleSegment("Phases", innerW, false, theme) + bc(BX.tr));
    const win = scrollWindow(phases.length, state.cursor, bodyCap);
    const rows = Math.max(1, win.count);
    for (let k = 0; k < rows; k++) {
      const idx = win.start + k;
      if (idx >= phases.length) {
        out.push(bc(BX.v) + " ".repeat(innerW) + bc(BX.v));
        continue;
      }
      const p = phases[idx];
      let row = leftPhaseRow(p, idx, idx === state.cursor, [], innerW, theme);
      if (k === rows - 1 && win.more) row = truncateToWidth(theme.fg("dim", `  ${ELLIPSIS}`), innerW, "", true);
      out.push(bc(BX.v) + row + bc(BX.v));
    }
  }
  out.push(bc(BX.bl) + bc(BX.h.repeat(innerW)) + bc(BX.br));
  return out;
}

/** Build the lines for the current view. Pure: depends only on state + model + theme. */
export function renderNavigator(
  state: NavigatorState,
  model: NavigatorModel,
  width: number,
  theme: ThemeLike = PLAIN,
  viewportRows = 24,
  markdownTheme?: MarkdownTheme,
): string[] {
  return model.withRenderFrame(() =>
    renderNavigatorFrame(state, model, width, theme, viewportRows, markdownTheme, undefined),
  );
}

function renderNavigatorFrame(
  state: NavigatorState,
  model: NavigatorModel,
  width: number,
  theme: ThemeLike,
  viewportRows: number,
  markdownTheme: MarkdownTheme | undefined,
  renderCache: NavigatorTextRenderCache | undefined,
): string[] {
  const lines: string[] = [];
  state.setPageSize(Math.max(1, viewportRows - 5));
  const sel = (i: number, text: string) =>
    i === state.cursor ? theme.fg("accent", theme.bold(`❯ ${text}`)) : `  ${text}`;
  const dim = (t: string) => theme.fg("dim", t);

  // Render a detail body inside a FIXED-height viewport so j/k scrolls within a
  // stable box (clamping state.scroll) instead of slicing to the end — which
  // shrank the overlay and looked like it was collapsing.
  const pushScrollable = (body: string[]) => {
    const viewport = Math.max(1, viewportRows - 4); // reserve title + blank + footer + indicator
    state.setPageSize(viewport);
    const maxScroll = Math.max(0, body.length - viewport);
    if (state.kind === "detail" && state.tailing) state.scroll = maxScroll;
    state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
    lines.push(...body.slice(state.scroll, state.scroll + viewport));
    if (body.length > viewport) {
      const end = Math.min(state.scroll + viewport, body.length);
      const up = state.scroll > 0 ? "↑" : " ";
      const down = end < body.length ? "↓" : " ";
      const mode = state.kind === "detail" && state.tailing ? " TAIL" : "";
      lines.push(dim(`  [${state.scroll + 1}-${end} / ${body.length}] ${up}${down}${mode}`));
    }
  };

  // Compact agent details are deliberately not a pager: they show the useful
  // current snapshot and reserve scrolling for the explicit full-pager view.
  const pushCompact = (body: string[]) => {
    const viewport = Math.max(1, viewportRows - 3); // title + blank + footer
    if (body.length <= viewport) {
      lines.push(...body);
      return;
    }
    lines.push(...body.slice(0, Math.max(1, viewport - 1)));
    lines.push(dim("  … enter to open full pager"));
  };

  if (state.kind === "runs") {
    const runs = model.runs();
    const saved = model.saved();
    const total = runs.length + saved.length;
    state.clamp(total);

    // Keep the selected run visible when history exceeds the overlay height.
    const bodyCap = Math.max(1, viewportRows - 3); // title + blank + footer
    let win = scrollWindow(total, state.cursor, bodyCap);
    const windowEnd = () => win.start + win.count;
    const crossesSavedBoundary = () =>
      runs.length > 0 && saved.length > 0 && win.start < runs.length && windowEnd() > runs.length;
    if (crossesSavedBoundary() && bodyCap > 1) win = scrollWindow(total, state.cursor, bodyCap - 1);
    const up = win.start > 0 ? "↑" : " ";
    const down = windowEnd() < total ? "↓" : " ";
    const range =
      win.start > 0 || windowEnd() < total ? dim(`  [${up} ${win.start + 1}-${windowEnd()} / ${total} ${down}]`) : "";
    lines.push(theme.bold(`Workflows${range}`));

    if (total === 0) {
      lines.push(dim("  No runs yet. Start one with a background workflow."));
    }
    for (let i = win.start; i < windowEnd(); i++) {
      if (i === runs.length && runs.length > 0 && saved.length > 0) lines.push(dim("  ── saved ──"));
      if (i < runs.length) {
        const r = runs[i];
        if (!r) continue;
        const icon = STATUS_ICON[r.status] ?? "?";
        const tok = fmtTokenSegment(r, pad);
        const meta = [`${r.done}/${r.total}`, tok, r.cost > 0 ? fmtCost(r.cost) : ""].filter(Boolean).join(" · ");
        lines.push(sel(i, `${icon} ${r.name}  ${dim(`${r.runId} · ${r.status} · ${meta}`)}`));
      } else {
        const w = saved[i - runs.length];
        if (!w) continue;
        const loc = w.location === "user" ? "~" : ".";
        const desc = w.description ? dim(`  ${w.description}`) : "";
        lines.push(sel(i, `${w.name}${desc}  ${dim(loc)}`));
      }
    }
  } else if (state.kind === "phases" && state.runId) {
    const phases = model.phases(state.runId);
    state.clamp(phases.length);
    // Two-line header (name + description/status) then the combined frame.
    lines.push(...twoPaneHeader(model, state.runId, phases, width, theme));
    // Body cap: total height minus 2 header + 2 frame rules + blank + footer.
    const bodyCap = Math.max(1, viewportRows - 2 /*header*/ - 2 /*rules*/ - 2 /*blank+footer*/);
    lines.push(...renderPhasesAgents(state, model, state.runId, width, theme, bodyCap));
  } else if (state.kind === "agents" && state.runId && state.phase) {
    const agents = model.agents(state.runId, state.phase);
    state.clamp(agents.length);
    const phases = model.phases(state.runId);
    lines.push(...twoPaneHeader(model, state.runId, phases, width, theme));
    const bodyCap = Math.max(1, viewportRows - 2 - 2 - 2);
    lines.push(...renderPhasesAgents(state, model, state.runId, width, theme, bodyCap));
  } else if (state.kind === "detail" && state.runId && state.agentId != null) {
    const a = model.agentDetail(state.runId, state.agentId);
    lines.push(theme.bold(a ? asText(a.label) : "agent"));
    if (a) {
      // Coerce every dynamic value before wrap() (#110): a non-string prompt is
      // reachable even from a LIVE run — agent(42) in a model-written script is
      // never type-checked — and would crash wrap()'s text.split(). Persisted
      // error/status/history text can be non-string on a corrupt run too.
      const body: string[] = [];
      if (state.pagerOpen) {
        body.push(dim("Status: ") + asText(a.status ?? ""));
        if (a.model) body.push(dim("Model: ") + (shortModel(a.model) ?? ""));
        if (a.error) body.push(dim("Error: ") + asText(a.error));
        if (a.errorCode) {
          body.push(`${dim("Error code: ")}${asText(a.errorCode)}${a.recoverable ? " (recoverable)" : ""}`);
        }
        body.push("", theme.fg("accent", theme.bold("Prompt:")));
        body.push(...renderMarkdownLines(asText(a.prompt ?? ""), width, markdownTheme, renderCache));
        body.push("", theme.fg("accent", theme.bold("Result:")));
        body.push(...renderResultLines(a.result, a.resultPreview, width, markdownTheme, renderCache));
        if (Array.isArray(a.history) && a.history.length) {
          body.push("", theme.fg("accent", theme.bold("History:")));
          for (let i = 0; i < a.history.length; i++) {
            body.push(...renderHistoryEntryLines(a.history, i, width, markdownTheme, dim, renderCache));
          }
        }
        pushScrollable(body);
      } else if (a.status === "done") {
        // Completed agents default to their useful final output; prompt/history
        // remain one keypress away in the full pager.
        body.push(theme.fg("accent", theme.bold("Result:")));
        body.push(...renderResultLines(a.result, a.resultPreview, width, markdownTheme, renderCache));
        pushCompact(body);
      } else {
        // Active/failed agents default to context plus the latest two events.
        body.push(dim("Status: ") + asText(a.status ?? ""));
        if (a.model) body.push(dim("Model: ") + (shortModel(a.model) ?? ""));
        if (a.error) body.push(dim("Error: ") + asText(a.error));
        if (a.errorCode) {
          body.push(`${dim("Error code: ")}${asText(a.errorCode)}${a.recoverable ? " (recoverable)" : ""}`);
        }
        body.push("", theme.fg("accent", theme.bold("Prompt:")));
        const promptLines = renderMarkdownLines(asText(a.prompt ?? ""), width, markdownTheme, renderCache);
        body.push(...promptLines.slice(0, 5));
        if (promptLines.length > 5) body.push(dim("  … prompt continues in pager"));
        body.push("", theme.fg("accent", theme.bold("Recent activity:")));
        if (a.history?.length) {
          const start = Math.max(0, a.history.length - 2);
          for (let i = start; i < a.history.length; i++) {
            const eventLines = renderHistoryEntryLines(a.history, i, width, markdownTheme, dim, renderCache);
            body.push(...eventLines.slice(0, 4));
            if (eventLines.length > 4) body.push(dim("  … event continues in pager"));
          }
        } else {
          body.push(dim("  Waiting for the first agent event…"));
        }
        pushCompact(body);
      }
    }
  } else if (state.kind === "savedDetail" && state.savedName) {
    const saved = model.saved();
    const w = saved.find((s) => s.name === state.savedName);
    lines.push(theme.bold(w ? w.name : "saved workflow"));
    if (w) {
      const body: string[] = [];
      if (w.description) body.push(dim("Description: ") + asText(w.description));
      body.push(dim("Location: ") + (w.location === "user" ? "user (~/.pi)" : "project (.pi)"));
      body.push(dim("Saved at: ") + asText(w.savedAt));
      if (w.parameters) body.push(dim("Parameters: ") + JSON.stringify(w.parameters));
      body.push("", theme.fg("accent", theme.bold("Script:")));
      // Coerce (#110): corrupt saved-workflow JSON can carry a non-string script.
      body.push(...renderCodeLines(asText(w.script), "javascript", width, markdownTheme, renderCache));
      pushScrollable(body);
    }
  }

  lines.push("");
  lines.push(footerHint(state, model, theme));
  return lines;
}

/**
 * Two-line header above the Phases | agents frame (spec §1):
 *   line 0: <name>                          (ACCENT_BOLD)
 *   line 1: <status>            <done>/<total> agent[s] · <tokens>   (DIM)
 * Right segment is built first and never truncated; the left segment is
 * truncated to the remaining width with an ellipsis.
 */
function twoPaneHeader(
  model: NavigatorModel,
  runId: string,
  phases: PhaseRow[],
  width: number,
  theme: ThemeLike,
): string[] {
  const name = model.runName(runId);
  const status = model.runStatus(runId);
  let done = 0;
  let total = 0;
  let fresh = 0;
  let cacheRead = 0;
  for (const p of phases) {
    done += p.done;
    total += p.total;
    fresh += p.fresh;
    cacheRead += p.cacheRead;
  }
  // Line 0 — name (accent + bold), truncated to width if needed.
  const nameText = truncateToWidth(name, width, ELLIPSIS, false);
  const line0 = theme.fg("accent", theme.bold(nameText));

  // Line 1 — left status, right summary.
  const headerSegment = fmtTokenSegment({ fresh, cacheRead }, compactTokens);
  const rightRaw = `${done}/${total} ${pluralize("agent", total)}${headerSegment ? ` · ${headerSegment}` : ""}`;
  const rightW = visibleWidth(rightRaw);
  const gap = 2;
  let line1: string;
  if (rightW >= width) {
    // No room for left content: right-align (truncate from the right as last resort).
    line1 = theme.fg("dim", truncateToWidth(rightRaw, width, ELLIPSIS, false));
  } else {
    const availL = width - rightW - gap;
    const leftText = availL > 0 ? truncateToWidth(status, availL, ELLIPSIS, false) : "";
    const leftW = visibleWidth(leftText);
    const fill = " ".repeat(Math.max(gap, width - leftW - rightW));
    line1 = theme.fg("dim", leftText) + fill + theme.fg("dim", rightRaw);
  }
  return [line0, line1];
}

function historyLabel(entry: NonNullable<WorkflowAgentSnapshot["history"]>[number]): string {
  if (entry.kind === "toolCall") return entry.toolName ? `assistant tool ${asText(entry.toolName)}` : "assistant tool";
  if (entry.role === "tool") return entry.toolName ? `tool ${asText(entry.toolName)}` : "tool";
  if (entry.kind === "error") return `${asText(entry.role)} error`;
  return asText(entry.role);
}

function editCallPath(entry: NonNullable<WorkflowAgentSnapshot["history"]>[number]): string | undefined {
  if (entry.kind !== "toolCall" || entry.toolName !== "edit") return undefined;
  if (typeof entry.path === "string") return entry.path;
  // Backward compatibility for persisted histories from before edit paths were
  // stored separately from the JSON argument envelope.
  try {
    const args = JSON.parse(asText(entry.text)) as { path?: unknown };
    return typeof args.path === "string" ? args.path : undefined;
  } catch {
    return undefined;
  }
}

function writeCallSource(
  entry: NonNullable<WorkflowAgentSnapshot["history"]>[number],
): { path: string; content: string } | undefined {
  if (entry.kind !== "toolCall" || entry.toolName !== "write") return undefined;
  if (typeof entry.path === "string") return { path: entry.path, content: asText(entry.text) };
  // Backward compatibility for older persisted histories that stored the whole
  // write argument envelope as JSON.
  try {
    const args = JSON.parse(asText(entry.text)) as { path?: unknown; content?: unknown };
    return typeof args.path === "string" && typeof args.content === "string"
      ? { path: args.path, content: args.content }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Infer source language for history that pi stores as raw tool text rather than
 * Markdown. Tool-call arguments are JSON; file writes and read results inherit
 * their source language from the requested path. */
function historyEntryLanguage(
  history: NonNullable<WorkflowAgentSnapshot["history"]>,
  index: number,
): string | undefined {
  const entry = history[index];
  if (!entry) return undefined;
  if (entry.kind === "toolCall") {
    const write = writeCallSource(entry);
    return write ? (getLanguageFromPath(write.path) ?? "text") : "json";
  }
  if (entry.kind !== "toolResult" || entry.toolName !== "read") return undefined;

  for (let i = index - 1; i >= 0; i--) {
    const call = history[i];
    if (call?.kind !== "toolCall" || call.toolName !== "read") continue;
    try {
      const args = JSON.parse(asText(call.text)) as { path?: unknown };
      return typeof args.path === "string" ? getLanguageFromPath(args.path) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function renderHistoryEntryLines(
  history: NonNullable<WorkflowAgentSnapshot["history"]>,
  index: number,
  width: number,
  markdownTheme: MarkdownTheme | undefined,
  dim: (text: string) => string,
  renderCache?: NavigatorTextRenderCache,
): string[] {
  const entry = history[index];
  // Skip null/primitive elements from corrupt persisted histories (#110).
  if (!entry || typeof entry !== "object") return [];
  const write = writeCallSource(entry);
  const editPath = editCallPath(entry);
  const path = write?.path ?? editPath;
  const header = dim(`${historyLabel(entry)}:${path ? ` ${path}` : ""}`);

  // The edit result carries the same display-oriented diff used by Pi's built-in
  // edit renderer. Render it with Pi's native colors, line numbers, and
  // intra-line highlighting instead of showing the raw replacement JSON.
  if (entry.kind === "toolResult" && entry.toolName === "edit" && typeof entry.diff === "string") {
    return [header, ...renderDiffLines(entry.diff, width, renderCache)];
  }
  if (editPath) return [header];

  const language = historyEntryLanguage(history, index);
  const text = write?.content ?? asText(entry.text);
  return [
    header,
    ...(language
      ? renderCodeLines(text, language, width, markdownTheme, renderCache)
      : renderMarkdownLines(text, width, markdownTheme, renderCache)),
  ];
}

function footerHint(state: NavigatorState, model: NavigatorModel, theme: ThemeLike): string {
  const parts: string[] = [];
  switch (state.kind) {
    case "detail":
      if (state.pagerOpen) {
        parts.push(
          "↑/↓ line",
          "PgUp/PgDn page",
          "g/G ends",
          `t tail:${state.tailing ? "on" : "off"}`,
          "enter summary",
          "esc summary",
        );
      } else {
        parts.push("enter open pager", "t tail", "esc back");
      }
      break;
    case "savedDetail":
      parts.push("↑/↓ line", "PgUp/PgDn page", "g/G ends", "esc back", "x delete");
      break;
    case "runs": {
      const itemKind = model.saved().length > 0 ? state.itemKindAt(model, state.cursor) : "run";
      parts.push("↑/↓ select", "enter open", "esc back");
      if (itemKind === "run") {
        parts.push("p pause", "x stop", "r restart", "s save");
      } else {
        parts.push("x delete");
      }
      parts.push("q quit");
      break;
    }
    default:
      parts.push("↑/↓ select", "enter open", "esc back", "q quit");
  }
  return theme.fg("dim", parts.join(" · "));
}

function wrap(text: unknown, width: number): string[] {
  return wrapTextWithAnsi(asText(text), Math.max(1, width));
}

/** Render prose as Markdown when the host theme is available. Fenced code blocks
 * are syntax highlighted by pi's Markdown renderer. */
function renderMarkdownLines(
  text: unknown,
  width: number,
  markdownTheme?: MarkdownTheme,
  renderCache?: NavigatorTextRenderCache,
): string[] {
  const safeText = asText(text);
  if (!markdownTheme) return wrap(safeText, width);
  const renderWidth = Math.max(1, width);
  const key = `md:${renderWidth}:${safeText}`;
  const cached = renderCache?.get(key);
  if (cached) return cached;
  const lines = new Markdown(safeText, 0, 0, markdownTheme).render(renderWidth);
  return renderCache?.set(key, lines, key.length + lines.reduce((sum, line) => sum + line.length, 0)) ?? lines;
}

/** Render Pi's display-oriented edit diff inside the navigator's bounded
 * viewport while preserving its ANSI colors and intra-line highlights. */
function renderDiffLines(diff: string, width: number, renderCache?: NavigatorTextRenderCache): string[] {
  const renderWidth = Math.max(1, width);
  const key = `diff:${renderWidth}:${diff}`;
  const cached = renderCache?.get(key);
  if (cached) return cached;
  const lines = renderDiff(diff)
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(`  ${line}`, renderWidth));
  return renderCache?.set(key, lines, key.length + lines.reduce((sum, line) => sum + line.length, 0)) ?? lines;
}

/** Render a known-language source block without requiring Markdown fences (a
 * workflow script can itself contain backticks). */
function renderCodeLines(
  text: unknown,
  language: string,
  width: number,
  markdownTheme?: MarkdownTheme,
  renderCache?: NavigatorTextRenderCache,
): string[] {
  const safeText = asText(text);
  const renderWidth = Math.max(1, width);
  const key = `code:${language}:${renderWidth}:${safeText}`;
  const cached = renderCache?.get(key);
  if (cached) return cached;
  const sourceLines = markdownTheme?.highlightCode?.(safeText, language) ?? safeText.split("\n");
  const lines = sourceLines.flatMap((line) => wrapTextWithAnsi(`  ${line}`, renderWidth));
  return renderCache?.set(key, lines, key.length + lines.reduce((sum, line) => sum + line.length, 0)) ?? lines;
}

function renderResultLines(
  result: unknown,
  preview: string | undefined,
  width: number,
  markdownTheme?: MarkdownTheme,
  renderCache?: NavigatorTextRenderCache,
): string[] {
  if (result !== undefined && typeof result !== "string") {
    let json: string;
    if (renderCache && typeof result === "object" && result !== null) {
      json = renderCache.stringify(result);
    } else {
      try {
        json = JSON.stringify(result, null, 2) ?? String(result);
      } catch {
        json = String(result);
      }
    }
    return renderCodeLines(json, "json", width, markdownTheme, renderCache);
  }
  return renderMarkdownLines(
    typeof result === "string" ? result : (preview ?? "(none)"),
    width,
    markdownTheme,
    renderCache,
  );
}

/** What a key press should do. Pure mapping from a parsed key id to an action. */
export type NavAction =
  | { type: "move"; delta: number }
  | { type: "page"; direction: -1 | 1 }
  | { type: "jump"; edge: "start" | "end" }
  | { type: "toggleTail" }
  | { type: "togglePager" }
  | { type: "openPager" }
  | { type: "drill" }
  | { type: "back" }
  | { type: "close" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "save" }
  | { type: "deleteSaved" }
  | { type: "none" };

export function keyToAction(keyId: string | undefined, kind: ViewKind, itemKind?: "run" | "saved"): NavAction {
  switch (keyId) {
    case "up":
      return { type: "move", delta: -1 };
    case "down":
      return { type: "move", delta: 1 };
    case "k":
      return { type: "move", delta: -1 };
    case "j":
      return { type: "move", delta: 1 };
    case "pageUp":
    case "ctrl+u":
    case "ctrl+b":
      return { type: "page", direction: -1 };
    case "pageDown":
    case "ctrl+d":
    case "ctrl+f":
      return { type: "page", direction: 1 };
    case "space":
      return kind === "detail" || kind === "savedDetail" ? { type: "page", direction: 1 } : { type: "none" };
    case "home":
    case "g":
      return { type: "jump", edge: "start" };
    case "end":
    case "G":
    case "shift+g":
      return { type: "jump", edge: "end" };
    case "t":
      return kind === "detail" ? { type: "toggleTail" } : { type: "none" };
    case "enter":
    case "return":
      if (kind === "detail") return { type: "togglePager" };
      if (kind === "savedDetail") return { type: "none" };
      return { type: "drill" };
    case "right":
      if (kind === "detail") return { type: "openPager" };
      if (kind === "savedDetail") return { type: "none" };
      return { type: "drill" };
    case "escape":
    case "esc":
    case "left":
      return { type: "back" };
    case "q":
      return { type: "close" };
    case "p":
      return { type: "pause" };
    case "x":
      if (kind === "savedDetail" || itemKind === "saved") return { type: "deleteSaved" };
      return { type: "stop" };
    case "r":
      return { type: "restart" };
    case "s":
      if (itemKind === "saved") return { type: "none" };
      return { type: "save" };
    default:
      return { type: "none" };
  }
}

function currentCount(state: NavigatorState, model: NavigatorModel): number {
  if (state.kind === "runs") return model.runs().length + model.saved().length;
  if (state.kind === "phases" && state.runId) return model.phases(state.runId).length;
  if (state.kind === "agents" && state.runId && state.phase) return model.agents(state.runId, state.phase).length;
  return 0;
}

import type { OverlayAnchor } from "@earendil-works/pi-tui";

export interface NavigatorOptions {
  storage?: WorkflowStorage;
  cwd?: string;
  /** Overlay anchor position: "center" (default) or "right-center" for sidebar. */
  anchor?: OverlayAnchor;
}

/**
 * Open the interactive `/workflows` navigator as a focused overlay. Resolves when
 * the user closes it (esc at the top level, or `q`).
 */
export function openWorkflowNavigator(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: NavigatorOptions = {},
): Promise<void> {
  const model = new NavigatorModel(manager, opts.storage);
  const state = new NavigatorState();

  return ui.custom<void>(
    (tui: TUI, theme: Theme, _keybindings, done: (r: undefined) => void) => {
      const rerender = () => tui.requestRender();
      const markdownTheme = getMarkdownTheme();
      const renderCache = new NavigatorTextRenderCache();
      const events = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];
      const onEvent = () => rerender();
      for (const ev of events) manager.on(ev, onEvent);

      // Histories can update several times per second for every parallel agent.
      // Only agent detail consumes those updates, so ignore unrelated agents and
      // coalesce matching updates into a modest trailing redraw cadence.
      let historyRenderTimer: ReturnType<typeof setTimeout> | undefined;
      let historyRenderTarget: { runId: string; agentId: number } | undefined;
      const onAgentHistory = (event: { runId: string; agentId?: number }) => {
        if (
          state.kind !== "detail" ||
          event.runId !== state.runId ||
          event.agentId === undefined ||
          event.agentId !== state.agentId
        ) {
          return;
        }
        // Keep the newest matching target even while a redraw is already
        // scheduled. If navigation switches agents inside the coalescing window,
        // the pending redraw should follow the new agent rather than the event
        // that originally created the shared timer.
        historyRenderTarget = { runId: event.runId, agentId: event.agentId };
        if (historyRenderTimer) return;
        historyRenderTimer = setTimeout(() => {
          historyRenderTimer = undefined;
          const target = historyRenderTarget;
          historyRenderTarget = undefined;
          if (target && state.kind === "detail" && target.runId === state.runId && target.agentId === state.agentId) {
            rerender();
          }
        }, 125);
        (historyRenderTimer as { unref?: () => void }).unref?.();
      };
      manager.on("agentHistory", onAgentHistory);

      const cleanup = () => {
        for (const ev of events) manager.off(ev, onEvent);
        manager.off("agentHistory", onAgentHistory);
        if (historyRenderTimer) clearTimeout(historyRenderTimer);
        historyRenderTimer = undefined;
        historyRenderTarget = undefined;
      };

      const act = (data: string) => {
        const itemKind = state.kind === "runs" ? state.itemKindAt(model, state.cursor) : undefined;
        const action = keyToAction(parseKey(data), state.kind, itemKind);
        // Keep the whole dispatch behind one error boundary so corrupt on-disk
        // data or persistence failures cannot crash the overlay input handler.
        try {
          switch (action.type) {
            case "move":
              state.move(action.delta, currentCount(state, model));
              break;
            case "page":
              state.movePage(action.direction, currentCount(state, model));
              break;
            case "jump":
              state.jump(action.edge, currentCount(state, model));
              break;
            case "toggleTail":
              state.toggleTail();
              break;
            case "togglePager":
              state.togglePager();
              break;
            case "openPager":
              state.openPager();
              break;
            case "drill":
              state.drill(model);
              break;
            case "back":
              if (!state.back()) {
                cleanup();
                done(undefined);
              }
              break;
            case "close":
              cleanup();
              done(undefined);
              return;
            case "deleteSaved": {
              if (state.kind === "runs") {
                const saved = model.saved();
                const runCount = model.runs().length;
                const item = saved[state.cursor - runCount];
                if (item) {
                  model.deleteSaved(item.name);
                  ui.notify(`Deleted /${item.name}`, "info");
                }
              } else if (state.kind === "savedDetail" && state.savedName) {
                model.deleteSaved(state.savedName);
                ui.notify(`Deleted /${state.savedName}`, "info");
                state.back();
              }
              break;
            }
            case "pause": {
              const id = state.activeRunId(model);
              if (id) ui.notify(manager.pause(id) ? `Paused ${id}` : `Cannot pause ${id}`, "info");
              break;
            }
            case "stop": {
              const id = state.activeRunId(model);
              if (id) ui.notify(manager.stop(id) ? `Stopped ${id}` : `Cannot stop ${id}`, "info");
              break;
            }
            case "restart": {
              const id = state.activeRunId(model);
              const run = id ? manager.listRuns().find((r) => r.runId === id) : undefined;
              if (!run?.script) {
                ui.notify(id ? `Cannot restart ${id} (no script saved)` : "No run selected to restart", "warning");
                break;
              }
              try {
                const { runId: newId } = manager.startInBackground(run.script, run.args);
                ui.notify(`Restarted ${run.workflowName || "workflow"} as ${newId}`, "info");
              } catch (error) {
                ui.notify(
                  `Failed to restart ${run.workflowName || "workflow"}: ${error instanceof Error ? error.message : error}`,
                  "error",
                );
              }
              break;
            }
            case "save": {
              const id = state.activeRunId(model);
              const run = id ? manager.listRuns().find((r) => r.runId === id) : undefined;
              if (!run?.script) {
                ui.notify("No saved run script to save", "warning");
              } else if (!opts.storage) {
                ui.notify("Saving is not available (no storage)", "error");
              } else {
                const storage = opts.storage;
                const name = run.workflowName || "workflow";
                let saved: ReturnType<WorkflowStorage["save"]>;
                try {
                  saved = storage.save({
                    name,
                    description: run.workflowName,
                    script: run.script,
                    location: "project",
                  });
                } catch (error) {
                  ui.notify(error instanceof Error ? error.message : String(error), "error");
                  break;
                }
                registerSavedWorkflow(pi, opts.cwd ?? process.cwd(), saved, undefined, () =>
                  storage.list().some((w) => w.name === saved.name),
                );
                ui.notify(`Saved /${name}`, "info");
              }
              break;
            }
            default:
              return;
          }
        } catch (error) {
          ui.notify(
            `Workflow action "${action.type}" failed: ${error instanceof Error ? error.message : error}`,
            "error",
          );
        }
        rerender();
      };

      // Wrap the rendered content inside a visual box border for better
      // screen-boundary contrast. Follows the same pattern as pi-ask-user:
      //   top border ──╭───╮
      //   side borders │ … │
      //   bottom border╰───╯
      let _focused = false;
      const component: Component & Focusable & { dispose?(): void } = {
        get focused(): boolean {
          return _focused;
        },
        set focused(v: boolean) {
          _focused = v;
        },
        render: (width: number) => {
          // Brighter border when focused, muted when not
          const borderColor = (s: string) => (_focused ? theme.fg("accent", s) : theme.fg("borderMuted", s));
          const titleColor = (s: string) => (_focused ? theme.fg("dim", theme.bold(s)) : theme.fg("muted", s));
          const bgColor = (s: string) => theme.bg("customMessageBg", s);
          const innerWidth = Math.max(10, width - BOX_BORDER_OVERHEAD);
          // Match the navigator's own viewport to the overlay's 92% maxHeight;
          // otherwise the host truncates the footer and bottom border before the
          // pager gets a chance to scroll them into view.
          const terminalRows = tui.terminal?.rows ?? 24;
          const overlayRows = Math.max(8, Math.floor(terminalRows * 0.92));
          const contentRows = Math.max(6, overlayRows - 2); // top + bottom box borders
          const raw = model.withRenderFrame(() =>
            renderNavigatorFrame(state, model, innerWidth, theme, contentRows, markdownTheme, renderCache),
          );
          const title = titleColor(" workflows ");
          const topBorder =
            borderColor("╭─") + title + borderColor("─".repeat(Math.max(0, innerWidth - 10))) + borderColor("╮");
          const botBorder = borderColor(`╰${"─".repeat(Math.max(0, innerWidth + 2))}╯`);
          const wrapAndBg = (line: string) => {
            const padded = truncateToWidth(line, innerWidth, "", true);
            const fullLine = borderColor(BOX_BORDER_LEFT) + padded + borderColor(BOX_BORDER_RIGHT);
            // Fill trailing whitespace for consistent background across the width
            const trailingPad = width - visibleWidth(fullLine);
            return bgColor(fullLine + (trailingPad > 0 ? " ".repeat(trailingPad) : ""));
          };
          return [bgColor(topBorder), ...raw.map(wrapAndBg), bgColor(botBorder)];
        },
        handleInput: (data: string) => act(data),
        invalidate: () => {},
        dispose: () => cleanup(),
      };
      return component;
    },
    // A roomy overlay with visual margin so borders stand out from the terminal edge.
    // Supports sidebar mode via opts.anchor="right-center".
    {
      overlay: true,
      overlayOptions: {
        width: opts.anchor === "right-center" ? "60%" : "94%",
        maxHeight: "92%",
        anchor: opts.anchor ?? "center",
        margin: 1,
      },
    },
  );
}
