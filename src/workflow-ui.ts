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

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseKey } from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
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

/** Minimal theme surface so rendering is testable without the real Theme class. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const PLAIN: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

export type ViewKind = "runs" | "phases" | "agents" | "detail" | "savedDetail";

export type ItemKind = "run" | "saved";

interface RunRow {
  runId: string;
  name: string;
  status: string;
  done: number;
  total: number;
  tokens: number;
  cost: number;
}
interface PhaseRow {
  title: string;
  done: number;
  total: number;
  tokens: number;
}
interface AgentRow {
  id: number;
  label: string;
  status: string;
  phase?: string;
  tokens?: number;
  model?: string;
}

/** Short, human-friendly model label: drop the provider prefix for display. */
function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** Reads run/phase/agent data from the manager, preferring live snapshots. */
export class NavigatorModel {
  constructor(
    private readonly manager: Pick<WorkflowManager, "listRuns" | "getRun">,
    private readonly storage?: { list(): SavedWorkflow[]; delete(name: string, location?: string): boolean },
  ) {}

  private snapshot(runId: string): { snapshot: WorkflowSnapshot; status: string } | undefined {
    const live = this.manager.getRun(runId);
    if (live) return { snapshot: live.snapshot, status: live.status };
    const p = this.manager.listRuns().find((r) => r.runId === runId);
    if (!p) return undefined;
    return { snapshot: persistedToSnapshot(p), status: p.status };
  }

  runs(): RunRow[] {
    return this.manager.listRuns().map((p) => {
      const live = this.manager.getRun(p.runId);
      const agents = (live?.snapshot.agents ?? p.agents) as WorkflowAgentSnapshot[];
      return {
        runId: p.runId,
        name: live?.snapshot.name ?? p.workflowName,
        status: live?.status ?? p.status,
        done: agents.filter((a) => a.status === "done").length,
        total: agents.length,
        tokens: (live?.snapshot.tokenUsage ?? p.tokenUsage)?.total ?? 0,
        cost: (live?.snapshot.tokenUsage ?? p.tokenUsage)?.cost ?? 0,
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
    return this.snapshot(runId)?.snapshot.name ?? runId;
  }

  runStatus(runId: string): string {
    return this.snapshot(runId)?.status ?? "unknown";
  }

  phases(runId: string): PhaseRow[] {
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap) return [];
    const order = snap.phases.length ? [...snap.phases] : [];
    const byPhase = new Map<string, AgentRow[]>();
    for (const a of snap.agents) {
      const key = a.phase ?? "(no phase)";
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key)?.push(a);
      if (!order.includes(key)) order.push(key);
    }
    return order.map((title) => {
      const agents = byPhase.get(title) ?? [];
      return {
        title,
        done: agents.filter((a) => a.status === "done").length,
        total: agents.length,
        tokens: agents.reduce((n, a) => n + (a.tokens ?? 0), 0),
      };
    });
  }

  agents(runId: string, phase: string): AgentRow[] {
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap) return [];
    return snap.agents
      .filter((a) => (a.phase ?? "(no phase)") === phase)
      .map((a) => ({ id: a.id, label: a.label, status: a.status, phase: a.phase, tokens: a.tokens, model: a.model }));
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
  return {
    name: p.workflowName,
    phases: p.phases,
    currentPhase: p.currentPhase,
    logs: p.logs,
    agents: p.agents.map((a) => ({
      id: a.id,
      label: a.label,
      phase: a.phase,
      prompt: a.prompt,
      status: a.status,
      resultPreview:
        a.result == null ? undefined : String(typeof a.result === "string" ? a.result : JSON.stringify(a.result)),
      error: a.error,
      errorCode: a.errorCode,
      recoverable: a.recoverable,
      history: a.history,
      model: a.model,
    })),
    agentCount: p.agents.length,
    runningCount: p.agents.filter((a) => a.status === "running").length,
    doneCount: p.agents.filter((a) => a.status === "done").length,
    errorCount: p.agents.filter((a) => a.status === "error").length,
    tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
    runId: p.runId,
  };
}

/** Navigation state machine: a stack of (view, cursor) frames plus detail scroll. */
export class NavigatorState {
  private stack: StackFrame[] = [{ kind: "runs", cursor: 0 }];
  scroll = 0;

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
      this.scroll = Math.max(0, this.scroll + delta);
      return;
    }
    if (count <= 0) return;
    const t = this.top();
    t.cursor = (t.cursor + delta + count) % count;
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
      this.stack.push({ kind: "detail", cursor: 0, runId: t.runId, phase: t.phase, agentId: ag.id });
      return true;
    }
    return false;
  }

  /** Pop one level. Returns false when already at the top (caller should close). */
  back(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.scroll = 0;
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

function fmtTokens(t: number): string {
  return t > 0 ? `${pad(t)} tok` : "";
}

/** Build the lines for the current view. Pure: depends only on state + model + theme. */
export function renderNavigator(
  state: NavigatorState,
  model: NavigatorModel,
  width: number,
  theme: ThemeLike = PLAIN,
  viewportRows = 24,
): string[] {
  const lines: string[] = [];
  const sel = (i: number, text: string) =>
    i === state.cursor ? theme.fg("accent", theme.bold(`❯ ${text}`)) : `  ${text}`;
  const dim = (t: string) => theme.fg("dim", t);

  // Render a detail body inside a FIXED-height viewport so j/k scrolls within a
  // stable box (clamping state.scroll) instead of slicing to the end — which
  // shrank the overlay and looked like it was collapsing.
  const pushScrollable = (body: string[]) => {
    const viewport = Math.max(5, viewportRows - 4); // reserve title + blank + footer + indicator
    const maxScroll = Math.max(0, body.length - viewport);
    state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
    lines.push(...body.slice(state.scroll, state.scroll + viewport));
    if (body.length > viewport) {
      const end = Math.min(state.scroll + viewport, body.length);
      lines.push(dim(`  [${state.scroll + 1}-${end} / ${body.length}]`));
    }
  };

  if (state.kind === "runs") {
    const runs = model.runs();
    const saved = model.saved();
    const total = runs.length + saved.length;
    state.clamp(total);
    lines.push(theme.bold("Workflows"));
    if (total === 0) {
      lines.push(dim("  No runs yet. Start one with a background workflow."));
    }
    // Render runs
    runs.forEach((r, i) => {
      const icon = STATUS_ICON[r.status] ?? "?";
      const meta = [`${r.done}/${r.total}`, fmtTokens(r.tokens), r.cost > 0 ? `$${r.cost.toFixed(4)}` : ""]
        .filter(Boolean)
        .join(" · ");
      lines.push(sel(i, `${icon} ${r.name}  ${dim(`${r.runId} · ${r.status} · ${meta}`)}`));
    });
    // Render saved workflows after a separator
    if (saved.length > 0) {
      const sepOffset = runs.length;
      if (runs.length > 0) lines.push(dim("  ── saved ──"));
      saved.forEach((w, i) => {
        const loc = w.location === "user" ? "~" : ".";
        const desc = w.description ? dim(`  ${w.description}`) : "";
        lines.push(sel(sepOffset + i, `${w.name}${desc}  ${dim(loc)}`));
      });
    }
  } else if (state.kind === "phases" && state.runId) {
    const phases = model.phases(state.runId);
    state.clamp(phases.length);
    lines.push(theme.bold(model.runName(state.runId)) + dim(`  (${model.runStatus(state.runId)})`));
    phases.forEach((p, i) => {
      const meta = [`${p.done}/${p.total} agents`, fmtTokens(p.tokens)].filter(Boolean).join(" · ");
      lines.push(sel(i, `${p.title}  ${dim(meta)}`));
    });
  } else if (state.kind === "agents" && state.runId && state.phase) {
    const agents = model.agents(state.runId, state.phase);
    state.clamp(agents.length);
    lines.push(theme.bold(`${model.runName(state.runId)} › ${state.phase}`));
    agents.forEach((a, i) => {
      const icon = STATUS_ICON[a.status] ?? "?";
      const mdl = shortModel(a.model);
      const meta = [mdl, a.tokens ? fmtTokens(a.tokens) : undefined].filter(Boolean).join(" · ");
      lines.push(sel(i, `${icon} ${a.label}${meta ? dim(`  ${meta}`) : ""}`));
    });
  } else if (state.kind === "detail" && state.runId && state.agentId != null) {
    const a = model.agentDetail(state.runId, state.agentId);
    lines.push(theme.bold(a ? a.label : "agent"));
    if (a) {
      const body: string[] = [];
      body.push(dim("Status: ") + (a.status ?? ""));
      if (a.model) body.push(dim("Model: ") + (shortModel(a.model) ?? ""));
      if (a.error) body.push(dim("Error: ") + a.error);
      if (a.errorCode) body.push(`${dim("Error code: ")}${a.errorCode}${a.recoverable ? " (recoverable)" : ""}`);
      body.push("", dim("Prompt:"));
      body.push(...wrap(a.prompt ?? "", width));
      body.push("", dim("Result:"));
      body.push(...wrap(a.resultPreview ?? "(none)", width));
      if (a.history?.length) {
        body.push("", dim("History:"));
        for (const entry of a.history) {
          body.push(...wrap(`${historyLabel(entry)}: ${entry.text}`, width));
        }
      }
      pushScrollable(body);
    }
  } else if (state.kind === "savedDetail" && state.savedName) {
    const saved = model.saved();
    const w = saved.find((s) => s.name === state.savedName);
    lines.push(theme.bold(w ? w.name : "saved workflow"));
    if (w) {
      const body: string[] = [];
      if (w.description) body.push(dim("Description: ") + w.description);
      body.push(dim("Location: ") + (w.location === "user" ? "user (~/.pi)" : "project (.pi)"));
      body.push(dim("Saved at: ") + w.savedAt);
      if (w.parameters) body.push(dim("Parameters: ") + JSON.stringify(w.parameters));
      body.push("", dim("Script:"));
      body.push(...wrap(w.script, width));
      pushScrollable(body);
    }
  }

  lines.push("");
  lines.push(footerHint(state, model, theme));
  return lines;
}

function historyLabel(entry: NonNullable<WorkflowAgentSnapshot["history"]>[number]): string {
  if (entry.kind === "toolCall") return entry.toolName ? `assistant tool ${entry.toolName}` : "assistant tool";
  if (entry.role === "tool") return entry.toolName ? `tool ${entry.toolName}` : "tool";
  if (entry.kind === "error") return `${entry.role} error`;
  return entry.role;
}

function footerHint(state: NavigatorState, model: NavigatorModel, theme: ThemeLike): string {
  const parts: string[] = [];
  switch (state.kind) {
    case "detail":
      parts.push("j/k scroll", "esc back");
      break;
    case "savedDetail":
      parts.push("j/k scroll", "esc back", "x delete");
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

function wrap(text: string, width: number): string[] {
  const w = Math.max(20, width - 2);
  const out: string[] = [];
  for (const para of String(text).split("\n")) {
    if (para.length <= w) {
      out.push(para);
      continue;
    }
    let rest = para;
    while (rest.length > w) {
      out.push(rest.slice(0, w));
      rest = rest.slice(w);
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** What a key press should do. Pure mapping from a parsed key id to an action. */
export type NavAction =
  | { type: "move"; delta: number }
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
    case "enter":
    case "return":
    case "right":
      if (kind === "detail" || kind === "savedDetail") return { type: "none" };
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

export interface NavigatorOptions {
  storage?: WorkflowStorage;
  cwd?: string;
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
      const events = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];
      const onEvent = () => rerender();
      for (const ev of events) manager.on(ev, onEvent);
      const cleanup = () => {
        for (const ev of events) manager.off(ev, onEvent);
      };

      const act = (data: string) => {
        const itemKind = state.kind === "runs" ? state.itemKindAt(model, state.cursor) : undefined;
        const action = keyToAction(parseKey(data), state.kind, itemKind);
        switch (action.type) {
          case "move":
            state.move(action.delta, currentCount(state, model));
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
            const { runId: newId } = manager.startInBackground(run.script, run.args);
            ui.notify(`Restarted ${run.workflowName || "workflow"} as ${newId}`, "info");
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
              const saved = storage.save({
                name,
                description: run.workflowName,
                script: run.script,
                location: "project",
              });
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
        rerender();
      };

      const component: Component & { dispose?(): void } = {
        render: (width: number) => renderNavigator(state, model, width, theme, tui.terminal?.rows ?? 24),
        handleInput: (data: string) => act(data),
        invalidate: () => {},
        dispose: () => cleanup(),
      };
      return component;
    },
    // A roomy overlay: ~94% of the terminal so the navigator gets real width/height.
    { overlay: true, overlayOptions: { width: "94%", maxHeight: "92%", anchor: "center" } },
  );
}
