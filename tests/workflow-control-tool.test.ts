import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import type { PersistedRunState, RunStatus } from "../src/run-persistence.js";
import { createWorkflowControlTool } from "../src/workflow-control-tool.js";
import { type ExecOptions, WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function run(status: RunStatus = "running", runId = "audit-abc123"): PersistedRunState {
  return {
    version: 2,
    runId,
    workflowName: "audit",
    script: "export const meta = { name: 'audit', description: 'audit' }; return await agent('x')",
    status,
    phases: ["Inspect"],
    currentPhase: "Inspect",
    agents: [
      {
        id: 1,
        executionId: `${runId}:0`,
        callIndex: 0,
        label: "active scan",
        prompt: "scan",
        status: status === "running" ? "running" : "done",
        tokens: 30,
      },
      {
        id: 2,
        executionId: `${runId}:1`,
        callIndex: 1,
        label: "queued check",
        prompt: "check",
        status: "queued",
      },
      {
        id: 3,
        executionId: `${runId}:2`,
        callIndex: 2,
        label: "failed check",
        prompt: "fail",
        status: "error",
      },
    ],
    logs: [],
    startedAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
    requestedConcurrency: 4,
    effectiveConcurrency: 4,
    maxAgents: 20,
    agentRetries: 2,
    agentTimeoutMs: 5000,
    tokenBudget: 1000,
    tokenUsage: { input: 20, output: 10, total: 30 },
  };
}

function fakeManager(initial: PersistedRunState[]) {
  const runs = new Map(initial.map((item) => [item.runId, item]));
  const calls: Array<{ action: string; runId: string; exec?: ExecOptions }> = [];
  const manager = {
    listRuns: () => [...runs.values()],
    getSnapshot: () => null,
    setConcurrency(runId: string, concurrency: number) {
      calls.push({ action: "set_concurrency", runId });
      const item = runs.get(runId);
      if (!item || !["running", "paused", "failed", "pending"].includes(item.status)) return null;
      const previousConcurrency = item.effectiveConcurrency;
      item.requestedConcurrency = concurrency;
      item.effectiveConcurrency = concurrency;
      return { previousConcurrency, requestedConcurrency: concurrency, effectiveConcurrency: concurrency };
    },
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
      if (!item || (item.status !== "paused" && item.status !== "failed")) return false;
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
    restart(sourceRunId: string) {
      const source = runs.get(sourceRunId);
      if (!source || source.status === "running") return null;
      const runId = "audit-new456";
      const exec: ExecOptions = {
        concurrency: source.requestedConcurrency ?? source.effectiveConcurrency,
        maxAgents: source.maxAgents,
        agentRetries: source.agentRetries,
        agentTimeoutMs: source.agentTimeoutMs,
        tokenBudget: source.tokenBudget,
      };
      calls.push({ action: "restart", runId, exec });
      runs.set(runId, run("running", runId));
      return { runId, promise: Promise.resolve(undefined) };
    },
    deleteRun(runId: string) {
      calls.push({ action: "remove", runId });
      return runs.delete(runId);
    },
  } as unknown as WorkflowManager;
  return { manager, calls, runs };
}

async function execute(manager: WorkflowManager, params: Record<string, unknown>) {
  const tool = createWorkflowControlTool({ manager });
  return (tool.execute as any)("control-call", params, undefined, undefined, {});
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content[0].text;
}

test("workflow_control exposes a strict action schema and requires runId for run actions", () => {
  const { manager } = fakeManager([]);
  const tool = createWorkflowControlTool({ manager });

  assert.equal(tool.name, "workflow_control");
  assert.equal(Check(tool.parameters, { action: "list" }), true);
  assert.equal(Check(tool.parameters, { action: "status", runId: "abc" }), true);
  assert.equal(Check(tool.parameters, { action: "set_concurrency", runId: "abc", concurrency: 128 }), true);
  assert.equal(Check(tool.parameters, { action: "set_concurrency", runId: "abc", concurrency: 0 }), false);
  assert.equal(Check(tool.parameters, { action: "set_concurrency", runId: "abc" }), false);
  assert.equal(Check(tool.parameters, { action: "status" }), false);
  assert.equal(Check(tool.parameters, { action: "unknown", runId: "abc" }), false);
  assert.equal(Check(tool.parameters, { action: "list", runId: "abc" }), false);

  const prepare = tool.prepareArguments as (value: unknown) => unknown;
  assert.throws(() => prepare({ action: "pause" }), /requires runId/);
  assert.throws(
    () => prepare({ action: "set_concurrency", runId: "abc", concurrency: 1.5 }),
    /positive integer concurrency/,
  );
  assert.throws(() => prepare({ action: "unknown", runId: "abc" }), /requires action/);
});

test("list and status return compact run state with activity, concurrency, and usage", async () => {
  const { manager } = fakeManager([run()]);

  const listed = text(await execute(manager, { action: "list" }));
  assert.match(listed, /runId=audit-abc123 status=running phase="Inspect"/);
  assert.match(listed, /done=0 running=1 paused=0 queued=1 error=1/);
  assert.match(listed, /active="active scan" pausedAgents="-" concurrency=4 tokens=30/);

  const status = text(await execute(manager, { action: "status", runId: "audit-abc123" }));
  assert.match(status, /^action=status result=ok /);
  assert.doesNotMatch(status, /\/workflows/);
});

test("status identifies paused agents and whether their child session was saved", async () => {
  const paused = run("paused");
  paused.agents[0] = {
    ...paused.agents[0],
    status: "paused",
    sessionFile: "C:/sessions/resumable.jsonl",
  };
  const { manager } = fakeManager([paused]);

  const status = text(await execute(manager, { action: "status", runId: "audit-abc123" }));
  assert.match(status, /done=0 running=0 paused=1 queued=1 error=1/);
  assert.match(status, /pausedAgents="active scan \(session saved\)"/);
});

test("set_concurrency, pause, resume, and stop call the shared manager lifecycle methods", async () => {
  const fixture = fakeManager([run()]);

  const resized = text(
    await execute(fixture.manager, { action: "set_concurrency", runId: "audit-abc123", concurrency: 12 }),
  );
  assert.match(resized, /action=set_concurrency result=updated previous=4/);
  assert.match(resized, /concurrency=12/);
  assert.match(text(await execute(fixture.manager, { action: "pause", runId: "audit-abc123" })), /result=paused/);
  assert.match(text(await execute(fixture.manager, { action: "resume", runId: "audit-abc123" })), /result=resumed/);
  assert.match(text(await execute(fixture.manager, { action: "stop", runId: "audit-abc123" })), /result=stopped/);
  assert.deepEqual(
    fixture.calls.map((call) => call.action),
    ["set_concurrency", "pause", "resume", "stop"],
  );
});

test("restart creates a new run through the shared manager and retains execution controls", async () => {
  const fixture = fakeManager([run("completed")]);

  const response = await execute(fixture.manager, { action: "restart", runId: "audit-abc123" });

  assert.match(text(response), /action=restart result=restarted sourceRunId=audit-abc123 runId=audit-new456/);
  assert.equal(response.details.runId, "audit-new456");
  assert.deepEqual(fixture.calls[0].exec, {
    concurrency: 4,
    maxAgents: 20,
    agentRetries: 2,
    agentTimeoutMs: 5000,
    tokenBudget: 1000,
  });
});

test("remove deletes a non-running run through the shared manager", async () => {
  const fixture = fakeManager([run("completed")]);

  const response = await execute(fixture.manager, { action: "remove", runId: "audit-abc123" });

  assert.match(text(response), /action=remove result=removed runId=audit-abc123/);
  assert.equal(fixture.runs.has("audit-abc123"), false);
});

test("cold persisted paused run can be stopped under the manager then removed through workflow_control", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-control-cold-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const bootstrap = new WorkflowManager({ cwd });
      const runId = "cold-paused-control";
      bootstrap.getPersistence().save({
        runId,
        workflowName: "cold_control",
        script: "export const meta = { name: 'cold_control', description: 'cold' }; return true",
        status: "paused",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:01.000Z",
      });

      const manager = new WorkflowManager({ cwd });
      assert.equal(manager.getRun(runId), undefined, "fixture must remain persisted-only");
      assert.match(text(await execute(manager, { action: "stop", runId })), /result=stopped/);
      assert.equal(manager.getPersistence().load(runId)?.status, "aborted");
      assert.match(text(await execute(manager, { action: "remove", runId })), /result=removed/);
      assert.equal(manager.getPersistence().load(runId), null);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("unknown IDs and illegal transitions return explicit errors with allowed next actions", async () => {
  const fixture = fakeManager([run("completed"), run("running", "live-123"), run("paused", "paused-123")]);

  const unknown = text(await execute(fixture.manager, { action: "status", runId: "missing" }));
  assert.match(unknown, /result=error runId=missing error=run not found allowed=list/);

  const pauseCompleted = text(await execute(fixture.manager, { action: "pause", runId: "audit-abc123" }));
  assert.match(pauseCompleted, /cannot pause run with status completed/);
  assert.match(pauseCompleted, /allowed=status,restart,remove/);

  const restartRunning = text(await execute(fixture.manager, { action: "restart", runId: "live-123" }));
  assert.match(restartRunning, /cannot restart a running run/);
  assert.match(restartRunning, /allowed=status,set_concurrency,pause,stop/);

  const removeRunning = text(await execute(fixture.manager, { action: "remove", runId: "live-123" }));
  assert.match(removeRunning, /cannot remove a running run; stop it first/);
  assert.equal(fixture.runs.has("live-123"), true);

  const removePaused = text(await execute(fixture.manager, { action: "remove", runId: "paused-123" }));
  assert.match(removePaused, /cannot remove a paused run; stop it first/);
  assert.equal(fixture.runs.has("paused-123"), true);
});
