import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const script = `export const meta = { name: 'resume_42', description: 'durable restart fixture' }
phase('Work')
const results = await parallel(Array.from({ length: 42 }, (_, i) => () => agent('task-' + i, { label: 'worker' })))
return results`;

function usage(total: number): AgentUsage {
  return { input: total - 1, output: 1, cacheRead: 0, cacheWrite: 0, total, cost: total / 1000 };
}

function agentWithUsage(total: number, activity?: { active: number; maximum: number; calls: number }) {
  return {
    async run(prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
      if (activity) {
        activity.active++;
        activity.maximum = Math.max(activity.maximum, activity.active);
        activity.calls++;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      options.onUsage?.(usage(total));
      if (activity) activity.active--;
      return `result:${prompt}`;
    },
  };
}

async function waitForCompletion(manager: WorkflowManager, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (manager.getRun(runId)?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("resumed workflow did not complete");
}

test("cold resume preserves completed rows and execution controls without double charging", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-resume-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const first = new WorkflowManager({ cwd, agent: agentWithUsage(10) });
      await first.runSync(script, undefined, {
        concurrency: 1,
        maxAgents: 42,
        agentRetries: 1,
        agentTimeoutMs: null,
        tokenBudget: 10_000,
      });
      const seeded = first.listRuns()[0];
      assert.equal(seeded.agents.length, 42);
      assert.equal(seeded.journal?.length, 42);

      first.getPersistence().save({
        ...seeded,
        status: "paused",
        agents: seeded.agents.map((agent, index) =>
          index < 27
            ? agent
            : {
                ...agent,
                status: "queued",
                result: undefined,
                resultPreview: undefined,
                usage: undefined,
                tokens: undefined,
                endedAt: undefined,
              },
        ),
        journal: seeded.journal?.slice(0, 27),
        tokenUsage: { input: 243, output: 27, total: 270, cost: 0.27, cacheRead: 0, cacheWrite: 0 },
        result: undefined,
        completedAt: undefined,
        durationMs: undefined,
      });

      const activity = { active: 0, maximum: 0, calls: 0 };
      const resumed = new WorkflowManager({ cwd, concurrency: 8, agent: agentWithUsage(20, activity) });
      assert.equal(await resumed.resume(seeded.runId), true);
      await waitForCompletion(resumed, seeded.runId);

      const final = resumed.listRuns().find((run) => run.runId === seeded.runId);
      assert.ok(final);
      assert.equal(final.agents.length, 42);
      assert.equal(new Set(final.agents.map((agent) => agent.executionId)).size, 42);
      assert.deepEqual(
        final.agents.slice(0, 27).map((agent) => agent.status),
        Array(27).fill("done"),
      );
      assert.deepEqual(
        final.agents.slice(0, 27).map((agent) => agent.tokens),
        Array(27).fill(10),
      );
      assert.deepEqual(
        final.agents.slice(27).map((agent) => agent.tokens),
        Array(15).fill(20),
      );
      assert.equal(activity.calls, 15, "journaled prefix is replayed, not re-run");
      assert.equal(activity.maximum, 1, "cold resume restores the original concurrency instead of manager defaults");
      assert.equal(final.tokenUsage?.total, 570);
      assert.equal(final.concurrency, 1);
      assert.equal(final.maxAgents, 42);
      assert.equal(final.agentRetries, 1);
      assert.equal(final.agentTimeoutMs, null);
      assert.equal(final.tokenBudget, 10_000);
      assert.equal(new Date(final.startedAt).getTime(), new Date(seeded.startedAt).getTime());
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("exact message usage is debounced to disk while streaming estimates remain live-only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-exact-usage-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  let release: (() => void) | undefined;
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
            options.onUsage?.(usage(11));
            options.onUsage?.({ ...usage(20), estimated: true });
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return "done";
          },
        },
      });
      manager.on("error", () => {});
      const one = `export const meta = { name: 'usage', description: 'message usage' }
return await agent('one', { label: 'one' })`;
      const { runId, promise } = manager.startInBackground(one);
      while (!release) await new Promise((resolve) => setTimeout(resolve, 0));

      const live = manager.getSnapshot(runId)?.agents[0];
      const durable = manager.getPersistence().load(runId)?.agents[0];
      assert.equal(live?.tokens, 20);
      assert.equal(live?.tokensEstimated, true);
      assert.equal(durable?.usage?.total, 11);
      assert.equal(durable?.tokens, 11);
      assert.equal(manager.getPersistence().load(runId)?.tokenUsage?.total, 11);

      manager.pause(runId);
      release?.();
      await promise.catch(() => {});
    });
  } finally {
    release?.();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("resuming an incomplete invocation keeps its exact usage durable until replacement usage arrives", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-resume-baseline-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  let release: (() => void) | undefined;
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const one = `export const meta = { name: 'baseline', description: 'usage baseline' }
return await agent('one', { label: 'one' })`;
      const first = new WorkflowManager({ cwd, agent: agentWithUsage(5) });
      await first.runSync(one);
      const seeded = first.listRuns()[0];
      first.getPersistence().save({
        ...seeded,
        status: "paused",
        agents: seeded.agents.map((agent) => ({ ...agent, status: "paused", result: undefined, endedAt: undefined })),
        journal: [],
        result: undefined,
        completedAt: undefined,
      });

      const resumed = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return "replacement";
          },
        },
      });
      assert.equal(await resumed.resume(seeded.runId), true);
      while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(resumed.getSnapshot(seeded.runId)?.agents[0]?.usage?.total, 5);
      assert.equal(resumed.getPersistence().load(seeded.runId)?.agents[0]?.usage?.total, 5);
      resumed.pause(seeded.runId);
      release();
      await resumed.getRun(seeded.runId)?.executionPromise?.catch(() => {});
    });
  } finally {
    release?.();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("the first replay miss durably removes every unreplayed suffix entry", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-resume-suffix-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  let release: (() => void) | undefined;
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const two = `export const meta = { name: 'suffix', description: 'suffix invalidation' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;
      const first = new WorkflowManager({ cwd, agent: agentWithUsage(3) });
      await first.runSync(two);
      const seeded = first.listRuns()[0];
      first.getPersistence().save({
        ...seeded,
        status: "paused",
        journal: seeded.journal?.map((entry, index) => (index === 0 ? { ...entry, hash: "stale" } : entry)),
        result: undefined,
        completedAt: undefined,
      });

      const resumed = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return "replacement";
          },
        },
      });
      assert.equal(await resumed.resume(seeded.runId), true);
      while (!release) await new Promise((resolve) => setTimeout(resolve, 0));

      assert.deepEqual(resumed.getPersistence().load(seeded.runId)?.journal, []);
      resumed.pause(seeded.runId);
      release();
      await resumed.getRun(seeded.runId)?.executionPromise?.catch(() => {});
    });
  } finally {
    release?.();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("cold resume restores historical phase usage before admitting live work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-phase-budget-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const original = `export const meta = { name: 'phase_budget', description: 'phase budget' }
phase('Work', { budget: 100 })
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;
      const first = new WorkflowManager({ cwd, agent: agentWithUsage(10) });
      await first.runSync(original);
      const seeded = first.listRuns()[0];
      first.getPersistence().save({
        ...seeded,
        script: original.replace("budget: 100", "budget: 5"),
        status: "paused",
        agents: seeded.agents.map((agent, index) =>
          index === 0
            ? agent
            : {
                ...agent,
                status: "queued",
                result: undefined,
                resultPreview: undefined,
                usage: undefined,
                tokens: undefined,
                endedAt: undefined,
              },
        ),
        journal: seeded.journal?.slice(0, 1),
        tokenUsage: usage(10),
        result: undefined,
        completedAt: undefined,
      });

      let calls = 0;
      const resumed = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            calls++;
            return "unexpected";
          },
        },
      });
      resumed.on("error", () => {});
      assert.equal(await resumed.resume(seeded.runId), true);
      for (let attempt = 0; attempt < 100 && resumed.getRun(seeded.runId)?.status === "running"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(calls, 0);
      assert.equal(resumed.getRun(seeded.runId)?.status, "failed");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("agent completion persists its journal before the terminal-row callback", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-journal-boundary-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd, agent: agentWithUsage(7) });
      const persistence = manager.getPersistence();
      const save = persistence.save.bind(persistence);
      let journalWasDurableWhileRunning = false;
      persistence.save = (state) => {
        if (state.journal?.length === 1 && state.agents[0]?.status === "running") {
          journalWasDurableWhileRunning = true;
        }
        save(state);
      };
      const one = `export const meta = { name: 'journal_boundary', description: 'journal boundary' }
return await agent('one', { label: 'one' })`;

      await manager.runSync(one);
      assert.equal(journalWasDurableWhileRunning, true);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("agent completion persists journal, terminal row, result, and exact usage together", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-crash-window-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const one = `export const meta = { name: 'atomic', description: 'atomic completion' }
return await agent('one', { label: 'one' })`;
      const manager = new WorkflowManager({ cwd, agent: agentWithUsage(33) });
      let durableAtEvent = false;
      manager.on("agentEnd", ({ runId }: { runId: string }) => {
        const saved = manager.getPersistence().load(runId);
        durableAtEvent =
          saved?.journal?.[0]?.usage?.total === 33 &&
          saved.agents[0]?.status === "done" &&
          saved.agents[0]?.usage?.total === 33 &&
          saved.agents[0]?.result === "result:one";
      });

      await manager.runSync(one);
      assert.equal(durableAtEvent, true);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("nested cold resume replays scoped journal rows and preserves completed timestamps at zero remaining budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-nested-resume-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const child = `export const meta = { name: 'child', description: 'child' }
return await agent('child work', { label: 'child' })`;
      const parent = `export const meta = { name: 'parent', description: 'parent' }
const parentResult = await agent('parent work', { label: 'parent' })
const childResult = await workflow('child')
return { parentResult, childResult }`;
      const loadSavedWorkflow = (name: string) => (name === "child" ? child : undefined);
      const first = new WorkflowManager({ cwd, agent: agentWithUsage(10), loadSavedWorkflow });
      await first.runSync(parent, undefined, { tokenBudget: 20 });
      const seeded = first.listRuns()[0];
      assert.equal(seeded.journal?.length, 2);
      assert.equal(new Set(seeded.journal?.map((entry) => entry.executionId)).size, 2);
      const timestamps = new Map(seeded.agents.map((agent) => [agent.executionId, [agent.startedAt, agent.endedAt]]));
      first.getPersistence().save({
        ...seeded,
        status: "paused",
        result: undefined,
        completedAt: undefined,
        durationMs: undefined,
      });

      const activity = { active: 0, maximum: 0, calls: 0 };
      const resumed = new WorkflowManager({ cwd, agent: agentWithUsage(99, activity), loadSavedWorkflow });
      assert.equal(await resumed.resume(seeded.runId), true);
      await waitForCompletion(resumed, seeded.runId);

      const final = resumed.listRuns().find((run) => run.runId === seeded.runId);
      assert.ok(final);
      assert.equal(activity.calls, 0, "both scoped rows replay without live work");
      assert.equal(final.tokenUsage?.total, 20);
      assert.equal(new Set(final.agents.map((agent) => agent.executionId)).size, 2);
      for (const agent of final.agents) {
        assert.deepEqual([agent.startedAt, agent.endedAt], timestamps.get(agent.executionId));
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("tokens-only v1 completed rows survive cold replay and enter aggregate accounting once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-v1-resume-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const one = `export const meta = { name: 'legacy_tokens', description: 'legacy tokens' }
return await agent('work', { label: 'legacy' })`;
      const first = new WorkflowManager({ cwd, agent: agentWithUsage(10) });
      await first.runSync(one);
      const seeded = first.listRuns()[0];
      const runsDir = workflowProjectPaths(cwd).runsDir;
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(
        join(runsDir, `${seeded.runId}.json`),
        JSON.stringify({
          version: 1,
          runId: seeded.runId,
          workflowName: seeded.workflowName,
          script: seeded.script,
          status: "paused",
          phases: seeded.phases,
          agents: seeded.agents.map(
            ({ executionId: _executionId, callIndex: _callIndex, usage: _usage, ...agent }) => ({
              ...agent,
              tokens: 10,
            }),
          ),
          logs: seeded.logs,
          journal: seeded.journal?.map(({ executionId: _executionId, usage: _usage, ...entry }) => entry),
          startedAt: seeded.startedAt,
          updatedAt: seeded.updatedAt,
        }),
      );

      const activity = { active: 0, maximum: 0, calls: 0 };
      const resumed = new WorkflowManager({ cwd, agent: agentWithUsage(50, activity) });
      assert.equal(await resumed.resume(seeded.runId), true);
      await waitForCompletion(resumed, seeded.runId);

      const final = resumed.listRuns().find((run) => run.runId === seeded.runId);
      assert.ok(final);
      assert.equal(activity.calls, 0);
      assert.equal(final.agents[0].tokens, 10);
      assert.equal(final.agents[0].usage, undefined);
      assert.equal(final.tokenUsage?.total, 10);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("unfinished exact usage is a per-invocation resume baseline included exactly once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-usage-baseline-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const one = `export const meta = { name: 'usage_baseline', description: 'usage baseline' }
return await agent('work', { label: 'worker' })`;
      const first = new WorkflowManager({ cwd, agent: agentWithUsage(7) });
      await first.runSync(one);
      const seeded = first.listRuns()[0];
      first.getPersistence().save({
        ...seeded,
        status: "paused",
        agents: seeded.agents.map((agent) => ({
          ...agent,
          status: "queued",
          result: undefined,
          resultPreview: undefined,
          endedAt: undefined,
        })),
        journal: [],
        tokenUsage: { input: 6, output: 1, total: 7, cost: 0.007, cacheRead: 0, cacheWrite: 0 },
        result: undefined,
        completedAt: undefined,
        durationMs: undefined,
      });

      const resumed = new WorkflowManager({ cwd, agent: agentWithUsage(5) });
      assert.equal(await resumed.resume(seeded.runId), true);
      await waitForCompletion(resumed, seeded.runId);

      const final = resumed.listRuns().find((run) => run.runId === seeded.runId);
      assert.ok(final);
      assert.equal(final.agents[0].usage?.total, 12);
      assert.equal(final.agents[0].tokens, 12);
      assert.equal(final.journal?.[0].usage?.total, 12);
      assert.equal(final.tokenUsage?.total, 12);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
