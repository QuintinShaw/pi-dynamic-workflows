import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager, WorkflowManagerRegistry } from "../src/workflow-manager.js";
import { workflowProjectKey } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const script = `export const meta = { name: 'control_runtime', description: 'runtime controls' }
const value = await agent('work', { label: 'worker' })
return { value, cwd, processCwd: process.cwd() }`;

function fakeAgent(result: unknown = "ok") {
  return {
    async run() {
      return result;
    },
  };
}

function deferredAgent() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return {
    resolve,
    runner: {
      async run() {
        return promise;
      },
    },
  };
}

function withTempProjects(fn: (first: string, second: string) => Promise<void>) {
  return async () => {
    const first = mkdtempSync(join(tmpdir(), "pi-dw-controls-a-"));
    const second = mkdtempSync(join(tmpdir(), "pi-dw-controls-b-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-controls-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(first, second));
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function persisted(runId: string, status: PersistedRunState["status"] = "paused"): PersistedRunState {
  return {
    runId,
    workflowName: "control_runtime",
    script,
    status,
    phases: ["Work"],
    agents: [],
    logs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test(
  "WorkflowManagerRegistry keys managers by canonical cwd and initializes each manager once",
  withTempProjects(async (cwd) => {
    const link = `${cwd}-link`;
    symlinkSync(cwd, link, "dir");
    const created: string[] = [];
    const initialized: string[] = [];
    const registry = new WorkflowManagerRegistry({
      createManager(canonicalCwd) {
        created.push(canonicalCwd);
        return new WorkflowManager({ cwd: canonicalCwd, agent: fakeAgent() });
      },
      onCreate(_manager, canonicalCwd) {
        initialized.push(canonicalCwd);
      },
    });

    try {
      const direct = registry.get(cwd);
      const throughLink = registry.get(link);
      assert.equal(direct, throughLink);
      assert.deepEqual(created, [cwd]);
      assert.deepEqual(initialized, [cwd], "delivery/listener initialization runs once per canonical manager");
      assert.equal(registry.size, 1);
    } finally {
      rmSync(link, { force: true });
    }
  }),
);

test(
  "manager uses canonical cwd without changing the host process cwd",
  withTempProjects(async (cwd) => {
    const hostCwd = process.cwd();
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const result = await manager.runSync(script);

    assert.equal(process.cwd(), hostCwd);
    const output = result.result as { value: string; cwd: string; processCwd: string };
    assert.equal(output.value, "ok");
    assert.equal(output.cwd, cwd);
    assert.equal(output.processCwd, cwd);
  }),
);

test(
  "new runs persist canonical project identity, exact effective options, provenance, and terminal evidence",
  withTempProjects(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      sessionId: "origin-session",
      concurrency: 7,
      defaultAgentRetries: 2,
      defaultAgentTimeoutMs: 1234,
      agent: fakeAgent({ report: "x".repeat(10_000) }),
    });

    const { runId, promise } = manager.startInBackground(
      script,
      { secret: "persisted-for-resume" },
      {
        maxAgents: 9,
        concurrency: 3,
        agentRetries: 1,
        agentTimeoutMs: 99,
        tokenBudget: 12345,
      },
    );
    await promise;

    const state = manager.getPersistence().load(runId);
    assert.equal(state?.cwd, cwd);
    assert.equal(state?.projectKey, workflowProjectKey(cwd));
    assert.deepEqual(state?.executionOptions, {
      maxAgents: 9,
      concurrency: 3,
      agentRetries: 1,
      agentTimeoutMs: 99,
      tokenBudget: 12345,
    });
    assert.equal(state?.sessionId, "origin-session");
    assert.equal(state?.originSessionId, "origin-session");
    assert.equal(state?.deliverySessionId, "origin-session");
    assert.equal(state?.terminalSnapshot?.outcome, "completed");
    assert.ok((state?.terminalSnapshot?.resultEvidence?.length ?? 0) <= 4096);
    assert.equal(state?.terminalSnapshot?.agents.total, 1);

    const firstSnapshot = state?.terminalSnapshot;
    assert.equal(manager.stop(runId), false);
    assert.deepEqual(manager.getPersistence().load(runId)?.terminalSnapshot, firstSnapshot);
  }),
);

test(
  "failed and explicitly stopped runs persist deterministic terminal snapshots",
  withTempProjects(async (cwd) => {
    const failing = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("private failure detail", WorkflowErrorCode.UNKNOWN, { recoverable: false });
        },
      },
    });
    failing.on("error", () => {});
    const failed = failing.startInBackground(script);
    await failed.promise.catch(() => {});
    const failedState = failing.getPersistence().load(failed.runId);
    assert.equal(failedState?.terminalSnapshot?.outcome, "failed");
    assert.equal(failedState?.terminalSnapshot?.error?.code, WorkflowErrorCode.UNKNOWN);

    const pausedId = "persisted-paused-stop";
    const coldPaused = persisted(pausedId);
    coldPaused.deliverySessionId = "session-a";
    failing.getPersistence().save(coldPaused);
    assert.equal(failing.stop(pausedId), true, "a cold persisted paused run can be stopped");
    const stopped = failing.getPersistence().load(pausedId);
    assert.equal(stopped?.status, "aborted");
    assert.equal(stopped?.deliverySessionId, "session-a", "cold stop must not retarget delivery");
    assert.equal(stopped?.terminalSnapshot?.outcome, "aborted");
    assert.equal(stopped?.terminalSnapshot?.reason, "stopped");
  }),
);

test(
  "host-loss reconciliation pauses with host_lost and never creates terminal evidence",
  withTempProjects(async (cwd) => {
    const persistence = createRunPersistence(cwd);
    persistence.save(persisted("host-lost", "running"));

    new WorkflowManager({ cwd });

    const recovered = persistence.load("host-lost");
    assert.equal(recovered?.status, "paused");
    assert.equal(recovered?.pauseReason, "host_lost");
    assert.equal(recovered?.terminalSnapshot, undefined);
  }),
);

test(
  "resume restores persisted options once and preserves origin while targeting the requesting session",
  withTempProjects(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, sessionId: "requesting-session", agent: da.runner });
    const run = persisted("resume-options");
    run.sessionId = "original-session";
    run.originSessionId = "original-session";
    run.deliverySessionId = "original-session";
    run.executionOptions = {
      maxAgents: 11,
      concurrency: 2,
      agentRetries: 3,
      agentTimeoutMs: 777,
      tokenBudget: 4567,
    };
    run.journal = [{ index: 99, hash: "not-replayed", result: "kept" }];
    manager.getPersistence().save(run);

    assert.equal(await manager.resume(run.runId), true);
    assert.equal(await manager.resume(run.runId), false, "the same live run cannot resume twice");
    assert.deepEqual(manager.getRun(run.runId)?.executionOptions, run.executionOptions);

    const running = manager.getPersistence().load(run.runId);
    assert.equal(running?.originSessionId, "original-session");
    assert.equal(running?.sessionId, "original-session");
    assert.equal(running?.deliverySessionId, "requesting-session");
    assert.deepEqual(running?.executionOptions, run.executionOptions);

    assert.equal(manager.stop(run.runId), true);
    da.resolve("done");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }),
);

test(
  "automatic resume preserves session A while explicit resume retargets to requesting session B",
  withTempProjects(async (cwd) => {
    const automaticAgent = deferredAgent();
    const managerB = new WorkflowManager({ cwd, sessionId: "session-b", agent: automaticAgent.runner });
    const automaticRun = persisted("automatic-resume");
    automaticRun.sessionId = "session-a";
    automaticRun.originSessionId = "session-a";
    automaticRun.deliverySessionId = "session-a";
    managerB.getPersistence().save(automaticRun);

    assert.equal(await managerB.resume(automaticRun.runId, { intent: "automatic" }), true);
    assert.equal(managerB.getPersistence().load(automaticRun.runId)?.deliverySessionId, "session-a");
    assert.equal(managerB.stop(automaticRun.runId), true);
    automaticAgent.resolve("done");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const explicitAgent = deferredAgent();
    const explicitManagerB = new WorkflowManager({ cwd, sessionId: "session-b", agent: explicitAgent.runner });
    const explicitRun = persisted("explicit-resume");
    explicitRun.sessionId = "session-a";
    explicitRun.originSessionId = "session-a";
    explicitRun.deliverySessionId = "session-a";
    explicitManagerB.getPersistence().save(explicitRun);

    assert.equal(await explicitManagerB.resume(explicitRun.runId), true);
    assert.equal(explicitManagerB.getPersistence().load(explicitRun.runId)?.deliverySessionId, "session-b");
    assert.equal(explicitManagerB.stop(explicitRun.runId), true);
    explicitAgent.resolve("done");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }),
);

test(
  "a manager cannot stop a live run whose lease belongs to another manager",
  withTempProjects(async (cwd) => {
    const da = deferredAgent();
    const owner = new WorkflowManager({ cwd, agent: da.runner });
    owner.on("error", () => {});
    const active = owner.startInBackground(script);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const contender = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal(contender.stop(active.runId), false);
    assert.equal(owner.getRun(active.runId)?.status, "running");
    assert.equal(owner.stop(active.runId), true);

    da.resolve("done");
    await active.promise.catch(() => {});
  }),
);

test(
  "pause waits for the old generation to settle before resume starts a replacement",
  withTempProjects(async (cwd) => {
    const pending: Array<(value: unknown) => void> = [];
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          calls++;
          return new Promise((resolve) => pending.push(resolve));
        },
      },
    });
    const first = manager.startInBackground(script);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(manager.pause(first.runId), true);

    let resumed = false;
    const resume = manager.resume(first.runId).then((value) => {
      resumed = value;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, "the replacement cannot overlap the paused generation");
    assert.equal(resumed, false, "resume is still waiting for lease settlement");

    pending.shift()?.("old-finished");
    await first.promise.catch(() => {});
    assert.equal(await resume, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    pending.shift()?.("resumed-finished");
    await new Promise<void>((resolve) => manager.once("complete", () => resolve()));
    assert.equal(manager.getPersistence().load(first.runId)?.status, "completed");
  }),
);

test(
  "pause followed by stop stays aborted after the old generation settles and emits no failure",
  withTempProjects(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    let errors = 0;
    manager.on("error", () => errors++);
    const first = manager.startInBackground(script);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(manager.pause(first.runId), true);
    assert.equal(manager.stop(first.runId), true);
    da.resolve("late-result");
    await first.promise.catch(() => {});

    assert.equal(errors, 0);
    assert.equal(manager.getRun(first.runId)?.status, "aborted");
    assert.equal(manager.getPersistence().load(first.runId)?.status, "aborted");
    assert.equal(manager.getPersistence().load(first.runId)?.terminalSnapshot?.reason, "stopped");
  }),
);

test(
  "pause after onUsage persists spend before agent settlement without emitting failure",
  withTempProjects(async (cwd) => {
    let resolveUsageReported!: () => void;
    const usageReported = new Promise<void>((resolve) => {
      resolveUsageReported = resolve;
    });
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options?: { onUsage?: (value: AgentUsage) => void; signal?: AbortSignal }) {
          calls++;
          options?.onUsage?.({ input: 100, output: 0, total: 100, cacheRead: 0, cacheWrite: 0, cost: 0 });
          resolveUsageReported();
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return "unreachable";
        },
      },
    });
    let errors = 0;
    manager.on("error", () => errors++);
    manager.on("paused", () => {});

    const first = manager.startInBackground(script, undefined, { tokenBudget: 100 });
    await usageReported;
    assert.equal(manager.pause(first.runId), true);
    await first.promise.catch(() => {});

    const paused = manager.getPersistence().load(first.runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.tokenUsage?.total, 100);
    assert.equal(errors, 0);

    const failed = new Promise<void>((resolve) => manager.once("error", () => resolve()));
    assert.equal(await manager.resume(first.runId), true);
    await failed;
    assert.equal(calls, 1, "resume cannot start fresh work after the persisted spend exhausted the budget");
    assert.equal(manager.getPersistence().load(first.runId)?.tokenUsage?.total, 100);
  }),
);

test(
  "resumes preserve cumulative token usage and hard-budget spending without charging replay",
  withTempProjects(async (cwd) => {
    const budgetScript = `export const meta = { name: 'resume_budget', description: 'resume budget' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
const third = await agent('third', { label: 'third' })
return { first, second, third }`;
    const prompts: string[] = [];
    let secondAttempts = 0;
    const usage = (total: number): AgentUsage => ({
      input: total,
      output: 0,
      total,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string, options?: { onUsage?: (value: AgentUsage) => void }) {
          prompts.push(prompt);
          if (prompt === "first") {
            options?.onUsage?.(usage(70));
            return "first-result";
          }
          if (prompt === "second" && secondAttempts++ === 0) {
            options?.onUsage?.(usage(1));
            throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
              recoverable: false,
            });
          }
          if (prompt === "second") {
            options?.onUsage?.(usage(29));
            return "second-result";
          }
          throw new Error("third must be blocked by the cumulative budget");
        },
      },
    });
    manager.on("paused", () => {});
    manager.on("error", () => {});

    const first = manager.startInBackground(budgetScript, undefined, { tokenBudget: 100 });
    await first.promise.catch(() => {});
    assert.equal(manager.getPersistence().load(first.runId)?.status, "paused");
    assert.equal(manager.getPersistence().load(first.runId)?.tokenUsage?.total, 71);

    const failed = new Promise<void>((resolve) => manager.once("error", () => resolve()));
    assert.equal(await manager.resume(first.runId), true);
    await failed;
    assert.equal(manager.getPersistence().load(first.runId)?.status, "failed");
    assert.equal(manager.getPersistence().load(first.runId)?.tokenUsage?.total, 100);
    assert.deepEqual(prompts, ["first", "second", "second"], "the first call replays for zero tokens");

    const failedAgain = new Promise<void>((resolve) => manager.once("error", () => resolve()));
    assert.equal(await manager.resume(first.runId), true);
    await failedAgain;
    assert.equal(manager.getPersistence().load(first.runId)?.tokenUsage?.total, 100);
    assert.deepEqual(prompts, ["first", "second", "second"], "repeated replay cannot reset or add spending");
  }),
);

test(
  "persisted manager resume replays shared-store journal deltas before live agents",
  withTempProjects(async (cwd) => {
    const storeScript = `export const meta = { name: 'store_resume', description: 'store resume' }
await agent('put', { label: 'put' })
const value = await agent('read', { label: 'read' })
return { value }`;
    let quotaActive = true;
    const prompts: string[] = [];
    const agent = {
      async run(
        prompt: string,
        options?: {
          systemTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
        },
      ) {
        prompts.push(prompt);
        if (prompt === "put") {
          await options?.systemTools
            ?.find((tool) => tool.name === "store_put")
            ?.execute("", {
              key: "persisted-key",
              value: "persisted-value",
            });
          return "stored";
        }
        if (quotaActive) {
          quotaActive = false;
          throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
        }
        const result = (await options?.systemTools
          ?.find((tool) => tool.name === "store_get")
          ?.execute("", { key: "persisted-key" })) as { details?: { value?: unknown } };
        return result.details?.value;
      },
    };

    const original = new WorkflowManager({ cwd, sessionId: "origin", agent });
    original.on("paused", () => {});
    const first = original.startInBackground(storeScript);
    await first.promise.catch(() => {});
    const paused = original.getPersistence().load(first.runId);
    assert.equal(paused?.status, "paused");
    assert.deepEqual(paused?.journal?.[0]?.storeDelta, { "persisted-key": "persisted-value" });

    const resumed = new WorkflowManager({ cwd, sessionId: "requester", agent });
    const completed = new Promise<void>((resolve) => resumed.once("complete", () => resolve()));
    assert.equal(await resumed.resume(first.runId), true);
    await completed;
    assert.equal((resumed.getRun(first.runId)?.result?.result as { value?: unknown })?.value, "persisted-value");
    assert.deepEqual(prompts, ["put", "read", "read"], "the store-writing agent is replayed, not rerun");
  }),
);

test(
  "recoverable retry spend is persisted before a later usage-limit resume",
  withTempProjects(async (cwd) => {
    const retryScript = `export const meta = { name: 'retry_budget', description: 'retry budget' }
const first = await agent('retry', { label: 'retry' })
const second = await agent('pause', { label: 'pause' })
const third = await agent('fresh', { label: 'fresh' })
return { first, second, third }`;
    const prompts: string[] = [];
    let retryAttempts = 0;
    let pauseAttempts = 0;
    const usage = (total: number): AgentUsage => ({
      input: total,
      output: 0,
      total,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string, options?: { onUsage?: (value: AgentUsage) => void }) {
          prompts.push(prompt);
          if (prompt === "retry" && retryAttempts++ === 0) {
            options?.onUsage?.(usage(40));
            throw new Error("transient failure");
          }
          if (prompt === "retry") {
            options?.onUsage?.(usage(30));
            return "retry-result";
          }
          if (prompt === "pause" && pauseAttempts++ === 0) {
            options?.onUsage?.(usage(1));
            throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          }
          if (prompt === "pause") {
            options?.onUsage?.(usage(29));
            return "pause-result";
          }
          throw new Error("fresh work must be blocked by cumulative spend");
        },
      },
    });
    manager.on("paused", () => {});
    manager.on("error", () => {});

    const first = manager.startInBackground(retryScript, undefined, { tokenBudget: 100, agentRetries: 1 });
    await first.promise.catch(() => {});
    assert.equal(manager.getPersistence().load(first.runId)?.status, "paused");
    assert.equal(manager.getPersistence().load(first.runId)?.tokenUsage?.total, 71);

    const failed = new Promise<void>((resolve) => manager.once("error", () => resolve()));
    assert.equal(await manager.resume(first.runId), true);
    await failed;
    assert.equal(manager.getPersistence().load(first.runId)?.status, "failed");
    assert.equal(manager.getPersistence().load(first.runId)?.tokenUsage?.total, 100);
    assert.deepEqual(prompts, ["retry", "retry", "pause", "pause"]);
  }),
);

test(
  "status metadata is cross-session, bounded, and excludes persisted scripts, args, prompts, logs, and results",
  withTempProjects(async (cwd) => {
    const manager = new WorkflowManager({ cwd, sessionId: "current" });
    for (let i = 0; i < 25; i++) {
      const run = persisted(`run-${i}`, "completed");
      run.sessionId = i % 2 ? "other" : "current";
      run.script = "TOP_SECRET_SCRIPT";
      run.args = { secret: "TOP_SECRET_ARGS" };
      run.logs = ["TOP_SECRET_LOG"];
      run.result = { secret: "TOP_SECRET_RESULT" };
      run.agents = [{ id: 1, label: "worker", prompt: "TOP_SECRET_PROMPT", status: "done" }];
      manager.getPersistence().save(run);
    }

    const metadata = manager.listRunMetadata(10);
    assert.equal(metadata.length, 10);
    assert.ok(
      metadata.some((run) => Number(run.runId.split("-")[1]) % 2 === 1),
      "cross-session recovery runs are included",
    );
    const serialized = JSON.stringify(metadata);
    for (const secret of [
      "TOP_SECRET_SCRIPT",
      "TOP_SECRET_ARGS",
      "TOP_SECRET_LOG",
      "TOP_SECRET_RESULT",
      "TOP_SECRET_PROMPT",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret));
    }
    assert.equal(manager.getRunMetadata("run-1")?.runId, "run-1");
  }),
);
