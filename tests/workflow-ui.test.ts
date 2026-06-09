import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowSnapshot } from "../src/display.js";
import { WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import type { ManagedRun, WorkflowManager } from "../src/workflow-manager.js";
import type { SavedWorkflow } from "../src/workflow-saved.js";
import { keyToAction, NavigatorModel, NavigatorState, renderNavigator } from "../src/workflow-ui.js";

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
    tokenUsage: { input: 100, output: 50, total: 150, cost: 0 },
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
  assert.equal(runs[0].tokens, 150);

  const phases = model.phases("run-1");
  assert.deepEqual(
    phases.map((p) => p.title),
    ["Scan", "Report"],
  );
  assert.equal(phases[0].total, 2);
  assert.equal(phases[0].tokens, 150);

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
  assert.deepEqual(keyToAction("enter", "detail"), { type: "none" });
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
  assert.match(text, /audit › Scan/);
  assert.match(text, /❯ ✓ scan a/);
  assert.match(text, /scan b/);
  assert.match(text, /enter open/);
});

test("renderNavigator shows agent detail view", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  state.drill(model);
  const lines = renderNavigator(state, model, 80);
  const text = lines.join("\n");
  assert.match(text, /Prompt:/);
  assert.match(text, /scan the code/);
  assert.match(text, /Result:/);
  assert.match(text, /found 2/);
  assert.match(text, /Status:/);
  assert.match(text, /Model:/);
  assert.match(text, /model/); // shortModel strips provider prefix
  assert.match(text, /j\/k scroll/); // detail view footer
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
  assert.match(text, /History:/);
  assert.match(text, /assistant tool read: \{"file":"README.md"\}/);
  assert.match(text, /tool read: README content/);
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
  const detailLines = renderNavigator(state, model, 80);
  assert.match(detailLines.join("\n"), /j\/k scroll/);
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
  assert.match(text, /j\/k scroll/);
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
