import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { WorkflowSnapshot } from "../src/display.js";
import type { PersistedRunState, RunStatus } from "../src/run-persistence.js";
import { createWorkflowControlTool } from "../src/workflow-control-tool.js";
import type { WorkflowManager } from "../src/workflow-manager.js";

function run(status: RunStatus = "running", runId = "audit-abc123"): PersistedRunState {
  return {
    runId,
    workflowName: "audit",
    script: "export const meta = { name: 'audit', description: 'audit' }; return await agent('x')",
    status,
    phases: ["Inspect"],
    currentPhase: "Inspect",
    agents: [
      { id: 1, label: "active scan", prompt: "scan", status: status === "running" ? "running" : "done", tokens: 30 },
      { id: 2, label: "queued check", prompt: "check", status: "queued" },
      { id: 3, label: "failed check", prompt: "fail", status: "error" },
      { id: 4, label: "optional check", prompt: "optional", status: "skipped" },
    ],
    logs: [],
    startedAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
    tokenUsage: { input: 20, output: 10, total: 30 },
  };
}

function fakeManager(initial: PersistedRunState[], liveSnapshots: Record<string, WorkflowSnapshot> = {}) {
  const runs = new Map(initial.map((item) => [item.runId, item]));
  const calls: Array<{ action: string; runId: string }> = [];
  const manager = {
    listRuns: () => [...runs.values()],
    getSnapshot: (runId: string) => liveSnapshots[runId] ?? null,
    pause(runId: string) {
      calls.push({ action: "pause", runId });
      const item = runs.get(runId);
      if (item?.status !== "running") return false;
      item.status = "paused";
      return true;
    },
    async resume(runId: string) {
      calls.push({ action: "resume", runId });
      const item = runs.get(runId);
      if (!item || (item.status !== "paused" && item.status !== "failed" && item.status !== "pending")) return false;
      item.status = "running";
      return true;
    },
    stop(runId: string) {
      calls.push({ action: "stop", runId });
      const item = runs.get(runId);
      if (!item || (item.status !== "running" && item.status !== "paused")) return false;
      item.status = "aborted";
      return true;
    },
  } as unknown as WorkflowManager;
  return { manager, calls };
}

async function execute(manager: WorkflowManager, params: Record<string, unknown>) {
  const tool = createWorkflowControlTool({ manager });
  return (tool.execute as any)("control-call", params, undefined, undefined, {});
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content[0].text;
}

test("workflow_control exposes only list, status, pause, resume, and stop in a strict schema", () => {
  const { manager } = fakeManager([]);
  const tool = createWorkflowControlTool({ manager });

  assert.equal(tool.name, "workflow_control");
  assert.equal(Check(tool.parameters, { action: "list" }), true);
  assert.equal(Check(tool.parameters, { action: "status", runId: "abc" }), true);
  assert.equal(Check(tool.parameters, { action: "pause", runId: "abc" }), true);
  assert.equal(Check(tool.parameters, { action: "resume", runId: "abc" }), true);
  assert.equal(Check(tool.parameters, { action: "stop", runId: "abc" }), true);
  assert.equal(Check(tool.parameters, { action: "restart", runId: "abc" }), false);
  assert.equal(Check(tool.parameters, { action: "remove", runId: "abc" }), false);
  assert.equal(Check(tool.parameters, { action: "set_concurrency", runId: "abc", concurrency: 2 }), false);
  assert.equal(Check(tool.parameters, { action: "status" }), false);
  assert.equal(Check(tool.parameters, { action: "list", runId: "abc" }), false);
  assert.equal(Check(tool.parameters, { action: "status", runId: "abc", extra: true }), false);

  const prepare = tool.prepareArguments as (value: unknown) => unknown;
  assert.throws(() => prepare({ action: "pause" }), /requires runId/);
  assert.throws(() => prepare({ action: "status", runId: "abc", extra: true }), /does not accept extra/);
  assert.throws(() => prepare({ action: "restart", runId: "abc" }), /requires action/);
});

test("list and status return stable lifecycle and observability fields", async () => {
  const { manager } = fakeManager([run()]);

  const listed = await execute(manager, { action: "list" });
  assert.match(text(listed), /^action=list result=ok runs=1\n/);
  assert.match(text(listed), /runId=audit-abc123 name="audit" status=running phase="Inspect"/);
  assert.match(text(listed), /total=4 done=0 running=1 queued=1 error=1 skipped=1/);
  assert.match(text(listed), /active="active scan" tokens=30/);
  assert.deepEqual(listed.details, {
    action: "list",
    result: "ok",
    runs: [
      {
        runId: "audit-abc123",
        workflowName: "audit",
        status: "running",
        phase: "Inspect",
        counts: { total: 4, done: 0, running: 1, queued: 1, error: 1, skipped: 1 },
        activeLabels: ["active scan"],
        tokenTotal: 30,
      },
    ],
  });

  const status = await execute(manager, { action: "status", runId: "audit-abc123" });
  assert.match(text(status), /^action=status result=ok /);
  assert.equal(status.details.action, "status");
  assert.equal((status.details.run as { runId: string }).runId, "audit-abc123");
  assert.doesNotMatch(text(status), /\/workflows/);
});

test("status uses agent usage when the live run aggregate is lagging", async () => {
  const live: WorkflowSnapshot = {
    name: "audit",
    phases: ["Inspect"],
    currentPhase: "Inspect",
    logs: [],
    agents: [
      { id: 1, label: "estimated", prompt: "scan", status: "running", tokens: 80 },
      {
        id: 2,
        label: "reported",
        prompt: "check",
        status: "done",
        tokens: 40,
        tokenUsage: { input: 15, output: 5, total: 40, cacheRead: 20, cacheWrite: 0, cost: 0 },
      },
    ],
    agentCount: 2,
    runningCount: 1,
    doneCount: 1,
    errorCount: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
  };
  const { manager } = fakeManager([run()], { "audit-abc123": live });

  const status = await execute(manager, { action: "status", runId: "audit-abc123" });

  assert.match(text(status), /tokens=120$/);
  assert.equal((status.details.run as { tokenTotal: number }).tokenTotal, 120);
});

test("list reports an explicit empty result", async () => {
  const { manager } = fakeManager([]);
  const response = await execute(manager, { action: "list" });
  assert.equal(text(response), "action=list result=ok runs=0");
  assert.deepEqual(response.details, { action: "list", result: "ok", runs: [] });
});

test("pause, resume, and stop call the shared manager lifecycle methods", async () => {
  const fixture = fakeManager([run()]);

  assert.match(text(await execute(fixture.manager, { action: "pause", runId: "audit-abc123" })), /result=paused/);
  assert.match(text(await execute(fixture.manager, { action: "resume", runId: "audit-abc123" })), /result=resumed/);
  assert.match(text(await execute(fixture.manager, { action: "stop", runId: "audit-abc123" })), /result=stopped/);
  assert.deepEqual(
    fixture.calls.map((call) => call.action),
    ["pause", "resume", "stop"],
  );
});

test("stop succeeds via the tool for a run resolved from disk but not tracked in memory (cold pi restart)", async () => {
  // Regression guard for the workflow_control "stop" bug: findRun() resolves
  // candidates from manager.listRuns() (disk-backed), so a run persisted as
  // "paused" by a prior pi session — never loaded into the manager's
  // in-memory map — is still advertised with "stop" as an allowed action.
  // Before the fix, manager.stop() only checked its in-memory map and
  // returned false for such a run, so the tool reported invalidTransition
  // even though "stop" was just advertised as allowed.
  const coldRun = run("paused", "cold-restart-1");
  const runs = new Map([[coldRun.runId, coldRun]]);
  const manager = {
    listRuns: () => [...runs.values()],
    getSnapshot: () => null,
    pause: () => false,
    async resume() {
      return false;
    },
    stop(runId: string) {
      // Mirrors the real WorkflowManager.stop() persisted fallback: not in
      // memory, but persisted status is stoppable, so it succeeds.
      const item = runs.get(runId);
      if (!item || (item.status !== "running" && item.status !== "paused")) return false;
      item.status = "aborted";
      return true;
    },
  } as unknown as WorkflowManager;

  const response = await execute(manager, { action: "stop", runId: "cold-restart-1" });
  assert.match(text(response), /^action=stop result=stopped /);
  assert.equal(response.details.result, "stopped");
  assert.doesNotMatch(text(response), /invalidTransition|cannot stop/);
});

test("a thrown error from the manager during an action is reported as a structured error, not a raw throw", async () => {
  const throwingRun = run("paused", "throws-1");
  const manager = {
    listRuns: () => [throwingRun],
    getSnapshot: () => null,
    pause: () => false,
    async resume() {
      return false;
    },
    stop() {
      throw new Error("disk I/O failed");
    },
  } as unknown as WorkflowManager;

  const response = await execute(manager, { action: "stop", runId: "throws-1" });
  assert.match(text(response), /^action=stop result=error runId=throws-1 error=disk I\/O failed/);
  assert.equal(response.details.result, "error");
  assert.equal(response.details.error, "disk I/O failed");
});

test("unknown IDs and illegal transitions return explicit errors with allowed actions", async () => {
  const fixture = fakeManager([run("completed"), run("running", "live-123")]);

  const unknown = text(await execute(fixture.manager, { action: "status", runId: "missing" }));
  assert.match(unknown, /result=error runId=missing error=run not found allowed=list/);

  const pauseCompleted = text(await execute(fixture.manager, { action: "pause", runId: "audit-abc123" }));
  assert.match(pauseCompleted, /cannot pause run with status completed/);
  assert.match(pauseCompleted, /allowed=status/);

  await execute(fixture.manager, { action: "stop", runId: "live-123" });
  const stopAborted = text(await execute(fixture.manager, { action: "stop", runId: "live-123" }));
  assert.match(stopAborted, /cannot stop run with status aborted/);
  assert.match(stopAborted, /allowed=status/);
});
