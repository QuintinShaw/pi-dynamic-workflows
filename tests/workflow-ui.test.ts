import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { WorkflowSnapshot } from "../src/display.js";
import { WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import { parseWorkflowScript } from "../src/workflow.js";
import type { ManagedRun, WorkflowManager } from "../src/workflow-manager.js";
import type { SavedWorkflow } from "../src/workflow-saved.js";
import {
  keyToAction,
  NavigatorModel,
  NavigatorState,
  openWorkflowNavigator,
  renderNavigator,
} from "../src/workflow-ui.js";

/** Fake manager exposing one running run with two phases. */
function fakeManager(): Pick<WorkflowManager, "listRuns" | "getRun"> {
  const snapshot: WorkflowSnapshot = {
    name: "audit",
    phases: ["Scan", "Report"],
    currentPhase: "Report",
    logs: [],
    agents: [
      {
        id: 1,
        label: "scan a",
        phase: "Scan",
        prompt: "scan the code",
        status: "done",
        resultPreview: "found 2",
        tokens: 100,
        model: "fast-llm/model",
      },
      {
        id: 2,
        label: "scan b",
        phase: "Scan",
        prompt: "scan more",
        status: "done",
        resultPreview: "found 1",
        tokens: 50,
        model: "fast-llm/model",
      },
      { id: 3, label: "write report", phase: "Report", prompt: "write it", status: "running", tokens: 0 },
    ],
    agentCount: 3,
    runningCount: 1,
    doneCount: 2,
    errorCount: 0,
    tokenUsage: { input: 100, output: 50, total: 1050, cost: 0, cacheRead: 900, cacheWrite: 0 },
  };
  return {
    listRuns: () => [
      {
        runId: "run-1",
        workflowName: "audit",
        status: "running",
        phases: ["Scan", "Report"],
        agents: snapshot.agents,
        logs: [],
        tokenUsage: snapshot.tokenUsage,
      } as unknown as PersistedRunState,
    ],
    getRun: (id: string) =>
      id === "run-1" ? ({ runId: "run-1", status: "running", snapshot } as unknown as ManagedRun) : undefined,
  };
}

function errorDetailManager(): Pick<WorkflowManager, "listRuns" | "getRun"> {
  const snapshot: WorkflowSnapshot = {
    name: "wf",
    phases: ["P"],
    currentPhase: "P",
    logs: [],
    agents: [
      {
        id: 1,
        label: "empty",
        phase: "P",
        prompt: "do it",
        status: "error",
        resultPreview: "(none)",
        error: "Subagent produced no assistant output",
        errorCode: WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
        recoverable: true,
        history: [
          { role: "assistant", kind: "toolCall", toolName: "read", text: '{"file":"README.md"}' },
          { role: "tool", kind: "toolResult", toolName: "read", text: "README content" },
        ],
      },
    ],
    agentCount: 1,
    runningCount: 0,
    doneCount: 0,
    errorCount: 1,
  };
  return {
    listRuns: () =>
      [
        { runId: "r-error", workflowName: "wf", status: "completed", phases: ["P"], agents: snapshot.agents, logs: [] },
      ] as unknown as PersistedRunState[],
    getRun: (id: string) =>
      id === "r-error" ? ({ runId: "r-error", status: "completed", snapshot } as unknown as ManagedRun) : undefined,
  };
}

function multiRunManager(): Pick<WorkflowManager, "listRuns" | "getRun"> {
  return {
    listRuns: () => [
      {
        runId: "r1",
        workflowName: "a-workflow",
        status: "running",
        phases: [],
        agents: [],
        logs: [],
      } as unknown as PersistedRunState,
      {
        runId: "r2",
        workflowName: "b-workflow",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
      } as unknown as PersistedRunState,
    ],
    getRun: () => undefined,
  };
}

function persistedRunManager(): Pick<WorkflowManager, "listRuns" | "getRun"> {
  return {
    listRuns: () => [
      {
        runId: "r-old",
        workflowName: "old-run",
        status: "completed",
        phases: ["Build"],
        agents: [{ id: 1, label: "builder", phase: "Build", status: "done", prompt: "build it", result: "ok" }],
        logs: ["done"],
        // Legacy persisted usage: total only, no fresh/cache breakdown.
        tokenUsage: { total: 500, cost: 0 },
      } as unknown as PersistedRunState,
    ],
    getRun: () => undefined,
  };
}

function savedStorage(): { list(): SavedWorkflow[]; delete(name: string, location?: string): boolean } {
  return {
    list: () => [
      {
        name: "deploy",
        description: "Deploy to prod",
        location: "project",
        path: "/x",
        savedAt: "2025-01-01",
        script: "export const meta = { name: 'deploy', description: 'Deploy to prod' }",
      } as SavedWorkflow,
      {
        name: "analyze",
        description: "Analyze deps",
        location: "user",
        path: "/y",
        savedAt: "2025-01-02",
        script: "export const meta = { name: 'analyze', description: 'Analyze deps' }",
      } as SavedWorkflow,
      {
        name: "backup",
        description: "Full backup",
        location: "user",
        path: "/z",
        savedAt: "2025-01-03",
        script: "export const meta = { name: 'backup', description: 'Full backup' };",
      },
    ],
    delete: () => true,
  };
}

function emptySavedStorage(): { list(): SavedWorkflow[]; delete(name: string, location?: string): boolean } {
  return { list: () => [], delete: () => true };
}

test("NavigatorModel reads runs, phases, agents, and detail", () => {
  const model = new NavigatorModel(fakeManager());
  const runs = model.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].done, 2);
  assert.equal(runs[0].total, 3);
  assert.equal(runs[0].fresh, 150);
  assert.equal(runs[0].cacheRead, 900);

  const phases = model.phases("run-1");
  assert.deepEqual(
    phases.map((p) => p.title),
    ["Scan", "Report"],
  );
  assert.equal(phases[0].total, 2);
  assert.equal(phases[0].fresh, 150);

  const agents = model.agents("run-1", "Scan");
  assert.deepEqual(
    agents.map((a) => a.label),
    ["scan a", "scan b"],
  );
  assert.equal(model.agentDetail("run-1", 3)?.label, "write report");
});

test("NavigatorModel handles unknown runId gracefully", () => {
  const model = new NavigatorModel(fakeManager());
  assert.deepEqual(model.phases("unknown"), []);
  assert.deepEqual(model.agents("unknown", "Scan"), []);
  assert.equal(model.agentDetail("unknown", 1), undefined);
  assert.equal(model.runName("unknown"), "unknown");
  assert.equal(model.runStatus("unknown"), "unknown");
});

test("NavigatorModel works with multiple runs", () => {
  const model = new NavigatorModel(multiRunManager());
  const runs = model.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].runId, "r1");
  assert.equal(runs[1].runId, "r2");
});

test("NavigatorModel reads from persisted runs when no live snapshot", () => {
  const model = new NavigatorModel(persistedRunManager());
  const runs = model.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].name, "old-run");
  assert.equal(runs[0].done, 1);
  assert.equal(runs[0].total, 1);
  // Legacy total-only usage surfaces as fresh (tokenFigures fallback).
  assert.equal(runs[0].fresh, 500);
  assert.equal(runs[0].cacheRead, 0);

  // The runs list surfaces legacy total-only usage as a plain count.
  const lines = renderNavigator(new NavigatorState(), model, 80);
  assert.match(lines.join("\n"), /1\/1 · 500 tok/);

  const phases = model.phases("r-old");
  assert.equal(phases.length, 1);
  assert.equal(phases[0].title, "Build");

  const agents = model.agents("r-old", "Build");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].label, "builder");
});

test("NavigatorState drills runs -> phases -> agents -> detail and back", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  assert.equal(state.kind, "runs");

  assert.ok(state.drill(model), "drill() should succeed");
  assert.equal(state.kind, "phases");
  assert.equal(state.runId, "run-1");

  assert.ok(state.drill(model), "drill() should succeed");
  assert.equal(state.kind, "agents");
  assert.equal(state.phase, "Scan");

  assert.ok(state.drill(model), "drill() should succeed");
  assert.equal(state.kind, "detail");
  assert.equal(state.agentId, 1);

  assert.ok(state.back(), "back() should succeed");
  assert.equal(state.kind, "agents");
  assert.ok(state.back(), "back() should succeed");
  assert.ok(state.back(), "back() should succeed");
  assert.equal(state.kind, "runs");
  assert.equal(state.back(), false, "back at top returns false (caller closes)");
});

test("non-string phase titles are coerced, so the navigator never crashes on bad data (#110)", () => {
  // A corrupt persisted run (or a script that passed a non-string to phase())
  // could put a non-string into snapshot.phases. It used to reach the SDK's
  // truncateToWidth(), whose text.slice() threw and crashed the whole overlay.
  const snapshot: WorkflowSnapshot = {
    name: "wf",
    phases: [42 as unknown as string, "Real Phase"],
    currentPhase: "Real Phase",
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
  const manager: Pick<WorkflowManager, "listRuns" | "getRun"> = {
    listRuns: () => [
      {
        runId: "run-bad",
        workflowName: "wf",
        status: "running",
        phases: snapshot.phases,
        agents: [],
        logs: [],
      } as unknown as PersistedRunState,
    ],
    getRun: (id: string) =>
      id === "run-bad" ? ({ runId: "run-bad", status: "running", snapshot } as unknown as ManagedRun) : undefined,
  };
  const model = new NavigatorModel(manager as unknown as WorkflowManager);

  // Data boundary coerces the bad title to a string.
  const phases = model.phases("run-bad");
  assert.equal(phases[0].title, "42", "non-string title is coerced to a string");
  assert.equal(phases[1].title, "Real Phase");

  // Render the exact path that crashed: drilled into the run's phases view.
  const state = new NavigatorState();
  assert.ok(state.drill(model), "drill into the run's phases");
  assert.equal(state.kind, "phases");
  assert.doesNotThrow(() => renderNavigator(state, model, 80), "rendering must not throw on a non-string title");
});

test("non-string agent labels and run names are coerced too, not just phase titles (#110)", () => {
  // Same corrupt-data root cause reaches truncateToWidth() via the agent row
  // (a.label) and the two-pane header (run name), not only the phase title.
  const snapshot: WorkflowSnapshot = {
    name: 999 as unknown as string, // non-string run name → header truncateToWidth
    phases: ["Work"],
    currentPhase: "Work",
    logs: [],
    agents: [
      {
        id: 1,
        label: 42 as unknown as string, // non-string agent label → agent-row truncateToWidth
        phase: "Work",
        prompt: "do it",
        status: "running",
        tokens: 0,
      },
    ],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
  };
  const manager: Pick<WorkflowManager, "listRuns" | "getRun"> = {
    listRuns: () => [
      {
        runId: "run-corrupt",
        workflowName: 999 as unknown as string,
        status: "running",
        phases: ["Work"],
        agents: snapshot.agents,
        logs: [],
      } as unknown as PersistedRunState,
    ],
    getRun: (id: string) =>
      id === "run-corrupt"
        ? ({ runId: "run-corrupt", status: "running", snapshot } as unknown as ManagedRun)
        : undefined,
  };
  const model = new NavigatorModel(manager as unknown as WorkflowManager);

  assert.equal(model.runName("run-corrupt"), "999", "non-string run name coerced");
  assert.equal(model.runs()[0].name, "999", "non-string name coerced in the runs list too");
  assert.equal(model.agents("run-corrupt", "Work")[0].label, "42", "non-string agent label coerced");

  // The agent grouped under the coerced phase key stays reachable (no lookup drift).
  assert.equal(model.phases("run-corrupt")[0].total, 1, "agent stays grouped under its phase");

  // Render every view — runs list, phases, and the drilled agent row/header.
  const state = new NavigatorState();
  assert.doesNotThrow(() => renderNavigator(state, model, 80), "runs list must not throw");
  assert.ok(state.drill(model));
  assert.doesNotThrow(() => renderNavigator(state, model, 80), "phases + agent row + header must not throw");
});

test("structurally corrupt persisted runs never crash the navigator (#110)", () => {
  // A non-string status crashed twoPaneHeader (same text.slice signature as #110);
  // non-array agents/phases crashed the runs list itself so /workflows wouldn't
  // even open. getRun() returns undefined to force the persisted path.
  const manager: Pick<WorkflowManager, "listRuns" | "getRun"> = {
    listRuns: () => [
      {
        runId: "corrupt-1",
        workflowName: { bad: 1 } as unknown as string,
        status: { obj: true } as unknown as string,
        phases: null as unknown as string[],
        agents: null as unknown as [],
        logs: null as unknown as string[],
      } as unknown as PersistedRunState,
    ],
    getRun: () => undefined,
  };
  const model = new NavigatorModel(manager as unknown as WorkflowManager);

  assert.doesNotThrow(() => model.runs(), "runs() must not throw on non-array agents");
  assert.equal(typeof model.runStatus("corrupt-1"), "string", "non-string status coerced");
  assert.doesNotThrow(() => model.phases("corrupt-1"), "phases() must not throw on non-array phases");
  assert.doesNotThrow(() => model.agents("corrupt-1", "x"), "agents() must not throw");

  // The runs list must open, and drilling in must not crash either.
  assert.doesNotThrow(() => renderNavigator(new NavigatorState(), model, 80), "runs list must render");
  const state = new NavigatorState();
  assert.ok(state.drill(model));
  assert.doesNotThrow(() => renderNavigator(state, model, 80), "drilled view must render (non-string status header)");
});

test("non-string agent prompt in the detail view is coerced, reachable from a live run (#110)", () => {
  // agent(42) in a model-written script is never type-checked, so a non-string
  // prompt reaches the detail view's wrap() and used to crash text.split().
  const snapshot: WorkflowSnapshot = {
    name: "wf",
    phases: ["P"],
    currentPhase: "P",
    logs: [],
    agents: [{ id: 1, label: "a", phase: "P", prompt: 42 as unknown as string, status: "done", tokens: 0 }],
    agentCount: 1,
    runningCount: 0,
    doneCount: 1,
    errorCount: 0,
  };
  const manager: Pick<WorkflowManager, "listRuns" | "getRun"> = {
    listRuns: () => [
      {
        runId: "live-1",
        workflowName: "wf",
        status: "running",
        phases: ["P"],
        agents: snapshot.agents,
        logs: [],
      } as unknown as PersistedRunState,
    ],
    getRun: (id: string) =>
      id === "live-1" ? ({ runId: "live-1", status: "running", snapshot } as unknown as ManagedRun) : undefined,
  };
  const model = new NavigatorModel(manager as unknown as WorkflowManager);
  const state = new NavigatorState();
  assert.ok(state.drill(model)); // → phases
  assert.ok(state.drill(model)); // → agents
  assert.ok(state.drill(model)); // → detail
  assert.equal(state.kind, "detail");
  assert.doesNotThrow(() => renderNavigator(state, model, 80), "detail view must not throw on a non-string prompt");
});

test("a null/primitive element in a corrupt agent history doesn't crash the detail view (#110)", () => {
  // historyLabel(entry) reads entry.kind; a null element (valid JSON from a
  // corrupt persisted run) would throw. Live history never emits null entries.
  const snapshot: WorkflowSnapshot = {
    name: "wf",
    phases: ["P"],
    currentPhase: "P",
    logs: [],
    agents: [
      {
        id: 1,
        label: "a",
        phase: "P",
        prompt: "do it",
        status: "error",
        history: [
          null as unknown as { role: string; kind: string; text: string },
          { role: "tool", kind: "toolResult", toolName: "read", text: "ok" },
        ],
      },
    ],
    agentCount: 1,
    runningCount: 0,
    doneCount: 0,
    errorCount: 1,
  };
  const manager: Pick<WorkflowManager, "listRuns" | "getRun"> = {
    listRuns: () => [
      {
        runId: "hist-1",
        workflowName: "wf",
        status: "completed",
        phases: ["P"],
        agents: snapshot.agents,
        logs: [],
      } as unknown as PersistedRunState,
    ],
    getRun: (id: string) =>
      id === "hist-1" ? ({ runId: "hist-1", status: "completed", snapshot } as unknown as ManagedRun) : undefined,
  };
  const model = new NavigatorModel(manager as unknown as WorkflowManager);
  const state = new NavigatorState();
  assert.ok(state.drill(model));
  assert.ok(state.drill(model));
  assert.ok(state.drill(model));
  assert.equal(state.kind, "detail");
  assert.doesNotThrow(() => renderNavigator(state, model, 80), "null history entry must be skipped, not crash");
});

test("NavigatorState cursor wraps and detail scroll clamps at 0", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  state.move(-1, 1);
  assert.equal(state.cursor, 0);

  state.drill(model);
  state.drill(model);
  state.move(1, 2);
  assert.equal(state.cursor, 1);
  state.move(1, 2);
  assert.equal(state.cursor, 0);

  state.drill(model);
  state.move(-1, 0);
  assert.equal(state.scroll, 0);
  state.move(1, 0);
  assert.equal(state.scroll, 1);
});

function longDetailManager(): Pick<WorkflowManager, "listRuns" | "getRun"> {
  const snapshot: WorkflowSnapshot = {
    name: "wf",
    phases: ["P"],
    currentPhase: "P",
    logs: [],
    // Long single-token result so wrap() produces ~50 lines at width 40.
    agents: [
      { id: 1, label: "big", phase: "P", prompt: "p", status: "done", resultPreview: "Z".repeat(2000), tokens: 1 },
    ],
    agentCount: 1,
    runningCount: 0,
    doneCount: 1,
    errorCount: 0,
  };
  return {
    listRuns: () =>
      [
        { runId: "r", workflowName: "wf", status: "running", phases: ["P"], agents: snapshot.agents, logs: [] },
      ] as unknown as PersistedRunState[],
    getRun: (id: string) =>
      id === "r" ? ({ runId: "r", status: "running", snapshot } as unknown as ManagedRun) : undefined,
  };
}

test("detail view scrolls within a fixed viewport and does not collapse", () => {
  const model = new NavigatorModel(longDetailManager());
  const state = new NavigatorState();
  state.drill(model); // runs -> phases
  state.drill(model); // phases -> agents
  state.drill(model); // agents -> detail
  assert.equal(state.kind, "detail");
  state.togglePager();

  const vp = 14;
  const top = renderNavigator(state, model, 40, undefined, vp);
  state.move(5, 0); // scroll down within detail
  const mid = renderNavigator(state, model, 40, undefined, vp);
  state.move(1000, 0); // scroll past the end (clamped)
  const end = renderNavigator(state, model, 40, undefined, vp);

  // The box height stays stable while scrolling — the old slice-to-end code shrank it.
  assert.equal(top.length, mid.length, "viewport height is stable while scrolling (no collapse)");
  assert.equal(top.length, end.length, "still a full viewport at the bottom (clamped, not collapsed)");
  // Scrolling actually changes the visible window.
  assert.notDeepEqual(top, mid, "scroll shifts the visible window");
  // A position indicator is shown when content overflows the viewport.
  assert.ok(
    end.some((l) => /\[\d+-\d+ \/ \d+\]/.test(l)),
    "shows a scroll position indicator",
  );
});

test("NavigatorState drill returns false when nothing to drill into", () => {
  const model = new NavigatorModel({
    listRuns: () => [] as PersistedRunState[],
    getRun: () => undefined,
  });
  const state = new NavigatorState();
  const drilled = state.drill(model);
  assert.equal(drilled, false);
});

test("NavigatorState activeRunId returns run at cursor on runs view", () => {
  const model = new NavigatorModel(multiRunManager());
  const state = new NavigatorState();
  assert.equal(state.activeRunId(model), "r1");
  state.move(1, 2);
  assert.equal(state.activeRunId(model), "r2");
});

test("NavigatorState activeRunId returns undefined with no runs", () => {
  const model = new NavigatorModel({
    listRuns: () => [] as PersistedRunState[],
    getRun: () => undefined,
  });
  const state = new NavigatorState();
  assert.equal(state.activeRunId(model), undefined);
});

test("NavigatorState clamp handles zero items", () => {
  const state = new NavigatorState();
  state.clamp(0);
  assert.equal(state.cursor, 0);
});

test("keyToAction maps keys per view and itemKind", () => {
  // Navigation keys (kind-independent)
  assert.deepEqual(keyToAction("up", "runs"), { type: "move", delta: -1 });
  assert.deepEqual(keyToAction("j", "agents"), { type: "move", delta: 1 });
  assert.deepEqual(keyToAction("enter", "runs"), { type: "drill" });
  assert.deepEqual(keyToAction("enter", "detail"), { type: "togglePager" });
  assert.deepEqual(keyToAction("right", "detail"), { type: "openPager" });
  assert.deepEqual(keyToAction("right", "runs"), { type: "drill" });
  assert.deepEqual(keyToAction("escape", "phases"), { type: "back" });
  assert.deepEqual(keyToAction("left", "agents"), { type: "back" });
  assert.deepEqual(keyToAction("q", "runs"), { type: "close" });
  assert.deepEqual(keyToAction("k", "runs"), { type: "move", delta: -1 });
  assert.deepEqual(keyToAction("unknown", "runs"), { type: "none" });
  assert.deepEqual(keyToAction(undefined, "runs"), { type: "none" });
  assert.deepEqual(keyToAction("return", "agents"), { type: "drill" });

  // 'x' = stop on runs, deleteSaved on saved items
  assert.deepEqual(keyToAction("x", "runs", "run"), { type: "stop" });
  assert.deepEqual(keyToAction("x", "runs", "saved"), { type: "deleteSaved" });
  assert.deepEqual(keyToAction("x", "savedDetail"), { type: "deleteSaved" });
  assert.deepEqual(keyToAction("x", "phases"), { type: "stop" }); // no itemKind = stop

  // 's' = save on runs, none on saved items
  assert.deepEqual(keyToAction("s", "runs", "run"), { type: "save" });
  assert.deepEqual(keyToAction("s", "runs", "saved"), { type: "none" });

  // 'p' and 'r' unchanged
  assert.deepEqual(keyToAction("p", "runs"), { type: "pause" });
  assert.deepEqual(keyToAction("r", "runs"), { type: "restart" });
});

test("renderNavigator shows runs view with selected row and footer hint", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");
  assert.match(text, /Workflows/);
  assert.match(text, /❯ ◆ audit/);
  assert.match(text, /2\/3 · 150 tok · 900 cached/);
  assert.match(text, /enter open/);
});

test("renderNavigator shows empty hint when no runs", () => {
  const model = new NavigatorModel({
    listRuns: () => [] as PersistedRunState[],
    getRun: () => undefined,
  });
  const state = new NavigatorState();
  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");
  assert.match(text, /No runs yet/);
});

test("renderNavigator shows phases view", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  state.drill(model);
  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");
  assert.match(text, /audit/);
  assert.match(text, /running/);
  assert.match(text, /Scan/);
  assert.match(text, /Report/);
});

test("renderNavigator shows agents view", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");
  assert.match(text, /Scan · 2 agents/);
  assert.match(text, /› ● scan a/);
  assert.match(text, /scan b/);
  assert.match(text, /enter open/);
});

test("completed agent detail defaults to result and can open the full pager", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  state.drill(model);

  const summary = renderNavigator(state, model, 80).join("\n");
  assert.match(summary, /Result:/);
  assert.match(summary, /found 2/);
  assert.doesNotMatch(summary, /scan the code/);
  assert.match(summary, /enter open pager/);

  state.togglePager();
  const pager = renderNavigator(state, model, 80).join("\n");
  assert.match(pager, /Prompt:/);
  assert.match(pager, /scan the code/);
  assert.match(pager, /Result:/);
  assert.match(pager, /Status:/);
  assert.match(pager, /Model:/);
  assert.match(pager, /model/);
  assert.match(pager, /PgUp\/PgDn page/);
});

test("renderNavigator shows agent error diagnostics in detail view", () => {
  const model = new NavigatorModel(errorDetailManager());
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  state.drill(model);

  const text = renderNavigator(state, model, 80).join("\n");
  assert.match(text, /Error:/);
  assert.match(text, /Subagent produced no assistant output/);
  assert.match(text, /Error code:/);
  assert.match(text, /AGENT_EMPTY_OUTPUT \(recoverable\)/);
  assert.match(text, /Recent activity:/);
  assert.match(text, /assistant tool read:\n\s+\{"file":"README.md"\}/);
  assert.match(text, /tool read:\nREADME content/);
});

test("renderNavigator shows model info in agent rows", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");
  assert.match(text, /model/);
});

test("renderNavigator shows correct footer hint per view", () => {
  const model = new NavigatorModel(fakeManager());

  // Runs view footer
  const runsLines = renderNavigator(new NavigatorState(), model, 80);
  assert.match(runsLines.join("\n"), /enter open.*esc back/);

  // Detail view footer
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  state.drill(model);
  const summaryLines = renderNavigator(state, model, 80);
  assert.match(summaryLines.join("\n"), /enter open pager/);
  state.togglePager();
  const pagerLines = renderNavigator(state, model, 80);
  assert.match(pagerLines.join("\n"), /PgUp\/PgDn page/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Saved workflows in unified runs view
// ═══════════════════════════════════════════════════════════════════════════

test("NavigatorModel.saved returns sorted saved workflows from storage", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const saved = model.saved();
  assert.equal(saved.length, 3);
  assert.equal(saved[0].name, "analyze");
  assert.equal(saved[1].name, "backup");
  assert.equal(saved[2].name, "deploy");
});

test("NavigatorModel.saved returns empty array when no storage", () => {
  const model = new NavigatorModel(fakeManager());
  assert.deepEqual(model.saved(), []);
});

test("NavigatorModel.saved returns empty when storage is empty", () => {
  const model = new NavigatorModel(fakeManager(), emptySavedStorage());
  assert.deepEqual(model.saved(), []);
});

test("renderNavigator shows saved workflows in runs view with separator", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();
  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");

  assert.match(text, /Workflows/);
  assert.match(text, /◆ audit/); // runs section
  assert.match(text, /saved/); // separator or section header
  assert.match(text, /analyze/); // saved item
  assert.match(text, /backup/);
  assert.match(text, /deploy/);
  assert.match(text, /~/); // user location
  assert.match(text, /\./); // project location
});

test("renderNavigator cursor tracks across runs and saved items", () => {
  const _model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();

  // Total items = 1 run + 3 saved = 4
  // Cursor at 0 = first run
  state.move(1, 4);
  assert.equal(state.cursor, 1); // first saved item
  state.move(1, 4);
  assert.equal(state.cursor, 2); // second saved item
});

test("NavigatorState drill on saved item opens savedDetail", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();

  // Total = 1 run + 3 saved = 4. Move cursor to position 1 = first saved item.
  // set cursor directly to avoid wrapping from move()
  state.cursor = 1;

  const drilled = state.drill(model);
  assert.ok(drilled, "should have drilled into model");
  assert.equal(state.kind, "savedDetail");
  assert.equal(state.savedName, "analyze");
});

test("NavigatorState drill on saved item goes to savedDetail then back to runs", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();

  // Move cursor to first saved item and drill
  state.move(1, 4);
  assert.ok(state.drill(model), "drill() should succeed");
  assert.equal(state.kind, "savedDetail");

  // Back to runs
  assert.ok(state.back(), "back() should succeed");
  assert.equal(state.kind, "runs");
});

test("renderNavigator shows saved detail view", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();

  state.cursor = 1; // first saved item
  state.drill(model);
  assert.equal(state.kind, "savedDetail");

  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");
  assert.match(text, /analyze/);
  assert.match(text, /Analyze deps/);
  assert.match(text, /Location:/);
  assert.match(text, /Script:/);
  assert.match(text, /Saved at:/);
  assert.match(text, /PgUp\/PgDn page/);
  assert.match(text, /esc back/);
});

test("renderNavigator saved detail shows 'x delete' in footer", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();

  state.cursor = 1; // first saved item
  state.drill(model);

  const text = renderNavigator(state, model, 80).join("\n");
  assert.match(text, /x delete/);
});

test("NavigatorState activeRunId returns undefined for saved items", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();

  // Move cursor to first saved item
  state.cursor = 1;
  assert.equal(state.activeRunId(model), undefined);
});

test("itemKindAt returns 'run' for run items and 'saved' for saved items", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();

  assert.equal(state.itemKindAt(model, 0), "run");
  assert.equal(state.itemKindAt(model, 1), "saved");
  assert.equal(state.itemKindAt(model, 3), "saved");
});

test("itemKindAt returns 'run' when no storage configured", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();

  assert.equal(state.itemKindAt(model, 0), "run");
});

test("renderNavigator shows empty saved hint when no saved workflows", () => {
  const model = new NavigatorModel(fakeManager(), emptySavedStorage());
  const state = new NavigatorState();
  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");
  // Should show runs section but no saved section
  assert.match(text, /Workflows/);
  assert.match(text, /◆ audit/);
  // Should not mention saved at all
  assert.ok(!text.includes("saved"), "should not show saved section when empty");
});

test("renderNavigator footer hint changes based on item under cursor", () => {
  const model = new NavigatorModel(fakeManager(), savedStorage());
  const state = new NavigatorState();

  // Cursor on a run (position 0)
  state.cursor = 0;
  const runText = renderNavigator(state, model, 80).join("\n");
  assert.notEqual(runText.indexOf("x stop"), -1, "run item should show x stop");

  // Cursor on a saved item (position 1)
  state.cursor = 1;
  const savedText = renderNavigator(state, model, 80).join("\n");
  assert.notEqual(savedText.indexOf("x delete"), -1, "saved item should show x delete");
  assert.equal(savedText.indexOf("x stop"), -1, "saved item should NOT show x stop");
});

test("navigator shares one persisted run read across a render frame", () => {
  let listCalls = 0;
  const manager = {
    listRuns: () => {
      listCalls++;
      return [
        {
          runId: "frame-cache",
          workflowName: "cached",
          status: "completed",
          phases: ["Build"],
          agents: [{ id: 1, label: "builder", phase: "Build", prompt: "build", status: "done" }],
          logs: [],
        } as unknown as PersistedRunState,
      ];
    },
    getRun: () => undefined,
  };
  const model = new NavigatorModel(manager);
  const state = new NavigatorState();
  state.drill(model);
  listCalls = 0;

  renderNavigator(state, model, 100);
  assert.equal(listCalls, 1, "header, phases, agents, and footer reuse the same persisted snapshot");
});

// ═══════════════════════════════════════════════════════════════════════════
// #57 regressions — the split must survive persistence, and mixed or
// estimate-only runs must never under-report vs the pre-split scalar.
// ═══════════════════════════════════════════════════════════════════════════

test("persisted runs keep the per-agent split across sessions (#57 regression)", () => {
  const model = new NavigatorModel({
    listRuns: () => [
      {
        runId: "r-split",
        workflowName: "old-split",
        status: "completed",
        phases: ["Build"],
        agents: [
          {
            id: 1,
            label: "builder",
            phase: "Build",
            status: "done",
            prompt: "build it",
            result: "ok",
            tokens: 1080,
            tokenUsage: { input: 60, output: 20, total: 1080, cost: 0.01, cacheRead: 900, cacheWrite: 100 },
          },
        ],
        logs: [],
        tokenUsage: { input: 60, output: 20, total: 1080, cost: 0.01, cacheRead: 900, cacheWrite: 100 },
      } as unknown as PersistedRunState,
    ],
    getRun: () => undefined,
  });

  // persistedToSnapshot must carry tokens/tokenUsage through to every view.
  const agents = model.agents("r-split", "Build");
  assert.equal(agents[0].tokenUsage?.cacheRead, 900);
  const phases = model.phases("r-split");
  // fresh = input+output+cacheWrite (cache writes are billed first-time ingestion).
  assert.equal(phases[0].fresh, 180);
  assert.equal(phases[0].cacheRead, 900);
  const runs = model.runs();
  assert.equal(runs[0].fresh, 180);
  assert.equal(runs[0].cacheRead, 900);
});

test("runs list never under-reports mixed runs (reported + estimate-only agents) (#57 regression)", () => {
  const model = new NavigatorModel({
    listRuns: () => [
      {
        runId: "r-mixed",
        workflowName: "mixed",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        // One agent reported input+output=100; the rest only estimated into total.
        tokenUsage: { input: 70, output: 30, total: 900, cost: 0, cacheRead: 0, cacheWrite: 0 },
      } as unknown as PersistedRunState,
    ],
    getRun: () => undefined,
  });
  assert.equal(model.runs()[0].fresh, 900);
  const lines = renderNavigator(new NavigatorState(), model, 80);
  assert.match(lines.join("\n"), /900 tok/);
});

test("runs list aggregates per-agent figures for live runs whose run-level usage has not landed (#57 regression)", () => {
  const snapshot = {
    name: "live-run",
    phases: ["P"],
    currentPhase: "P",
    logs: [],
    agents: [
      { id: 1, label: "a", phase: "P", prompt: "x", status: "done", tokens: 1200 },
      { id: 2, label: "b", phase: "P", prompt: "y", status: "running", tokens: 0 },
    ],
    agentCount: 2,
    runningCount: 1,
    doneCount: 1,
    errorCount: 0,
    // Run-level aggregate only lands at completion — absent while live.
  } as unknown as WorkflowSnapshot;
  const model = new NavigatorModel({
    listRuns: () => [
      {
        runId: "r-live",
        workflowName: "live-run",
        status: "running",
        phases: ["P"],
        agents: snapshot.agents,
        logs: [],
      } as unknown as PersistedRunState,
    ],
    getRun: (id: string) =>
      id === "r-live" ? ({ runId: "r-live", status: "running", snapshot } as unknown as ManagedRun) : undefined,
  });
  // The list must agree with the phase view (both aggregate per-agent figures).
  assert.equal(model.runs()[0].fresh, 1200);
  const lines = renderNavigator(new NavigatorState(), model, 80);
  assert.match(lines.join("\n"), /1,200 tok|1[ .\u00a0]200 tok/);
});

test("restarting a run with a corrupt persisted script notifies an error instead of crashing the overlay (#330 audit)", async () => {
  const notifications: { message: string; type?: string }[] = [];
  const fakeUi = {
    notify: (message: string, type?: string) => {
      notifications.push({ message, type });
    },
    custom: <T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    ) => {
      const tui = { requestRender: () => {}, terminal: { rows: 24 } };
      const theme = {
        fg: (_name: string, s: string) => s,
        bg: (_name: string, s: string) => s,
        bold: (s: string) => s,
      };
      const component = factory(tui, theme, {}, () => {});
      return Promise.resolve(component).then((c) => {
        capturedComponent = c;
        return undefined as unknown as T;
      });
    },
  };
  let capturedComponent: (Component & { dispose?(): void }) | undefined;

  // A run whose persisted script is missing the required `export const meta`
  // block \u2014 exactly the kind of corrupt on-disk run-persistence data #330
  // found no schema validation guards against.
  const corruptScript = "console.log('not a workflow script')";
  const fakeManager = {
    on: () => {},
    off: () => {},
    listRuns: () => [
      {
        runId: "run-corrupt",
        workflowName: "corrupt-run",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        script: corruptScript,
        args: undefined,
      } as unknown as PersistedRunState,
    ],
    getRun: () => undefined,
    startInBackground: (script: string) => {
      // Mirrors the real WorkflowManager.startInBackground, which parses the
      // script synchronously before doing anything else.
      parseWorkflowScript(script);
      return { runId: "should-not-be-reached" };
    },
  } as unknown as WorkflowManager;

  openWorkflowNavigator({} as ExtensionAPI, fakeManager, fakeUi as unknown as ExtensionUIContext).catch(() => {});

  // Let the custom()'s factory promise resolve before driving input.
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(capturedComponent, "openWorkflowNavigator should have produced a component");
  assert.doesNotThrow(() => capturedComponent?.handleInput("r"), "restart must not throw/crash the overlay");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Failed to restart corrupt-run/);
});

function fakeUiCapturingComponent(): {
  ui: ExtensionUIContext;
  notifications: { message: string; type?: string }[];
  getComponent: () => (Component & { dispose?(): void }) | undefined;
} {
  const notifications: { message: string; type?: string }[] = [];
  let capturedComponent: (Component & { dispose?(): void }) | undefined;
  const ui = {
    notify: (message: string, type?: string) => {
      notifications.push({ message, type });
    },
    custom: <T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    ) => {
      const tui = { requestRender: () => {}, terminal: { rows: 24 } };
      const theme = {
        fg: (_name: string, s: string) => s,
        bg: (_name: string, s: string) => s,
        bold: (s: string) => s,
      };
      const component = factory(tui, theme, {}, () => {});
      return Promise.resolve(component).then((c) => {
        capturedComponent = c;
        return undefined as unknown as T;
      });
    },
  } as unknown as ExtensionUIContext;
  return { ui, notifications, getComponent: () => capturedComponent };
}

test("deleting a saved workflow whose storage.delete throws (e.g. EACCES) notifies an error instead of crashing the overlay (#330 audit follow-up)", async () => {
  const { ui, notifications, getComponent } = fakeUiCapturingComponent();

  // No runs, one saved workflow — cursor 0 lands on the saved item (itemKind "saved").
  const fakeManager = {
    on: () => {},
    off: () => {},
    listRuns: () => [] as PersistedRunState[],
    getRun: () => undefined,
  } as unknown as WorkflowManager;
  const storage = {
    list: () => [{ name: "flaky", description: "", location: "project", path: "/x", savedAt: "2025-01-01" }],
    delete: () => {
      throw new Error("EACCES: permission denied, unlink '/x'");
    },
  };

  openWorkflowNavigator({} as ExtensionAPI, fakeManager, ui, { storage }).catch(() => {});
  await Promise.resolve();
  await Promise.resolve();

  const component = getComponent();
  assert.ok(component, "openWorkflowNavigator should have produced a component");
  assert.doesNotThrow(() => component?.handleInput("x"), "deleteSaved must not throw/crash the overlay");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /deleteSaved.*failed/);
  assert.match(notifications[0].message, /EACCES/);
});

test("stopping a run whose manager.stop throws (cold-run lease/persistence failure) notifies an error instead of crashing the overlay (#330 audit follow-up)", async () => {
  const { ui, notifications, getComponent } = fakeUiCapturingComponent();

  const fakeManager = {
    on: () => {},
    off: () => {},
    listRuns: () =>
      [
        { runId: "run-cold", workflowName: "cold-run", status: "running", phases: [], agents: [], logs: [] },
      ] as unknown as PersistedRunState[],
    getRun: () => undefined,
    stop: () => {
      throw new Error("ENOSPC: no space left on device");
    },
  } as unknown as WorkflowManager;

  openWorkflowNavigator({} as ExtensionAPI, fakeManager, ui).catch(() => {});
  await Promise.resolve();
  await Promise.resolve();

  const component = getComponent();
  assert.ok(component, "openWorkflowNavigator should have produced a component");
  assert.doesNotThrow(() => component?.handleInput("x"), "stop must not throw/crash the overlay");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /stop.*failed/);
  assert.match(notifications[0].message, /ENOSPC/);
});
