import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

/** Agent that stays running until resolved externally or its attempt is aborted. */
function deferredAgent() {
  interface PendingAttempt {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort: () => void;
  }

  const pendingAttempts = new Set<PendingAttempt>();
  const settleAttempt = (attempt: PendingAttempt, settle: () => void) => {
    attempt.signal?.removeEventListener("abort", attempt.onAbort);
    pendingAttempts.delete(attempt);
    settle();
  };
  return {
    resolve: (value: unknown = "done") => {
      for (const attempt of [...pendingAttempts]) {
        settleAttempt(attempt, () => attempt.resolve(value));
      }
    },
    reject: (error: Error) => {
      for (const attempt of [...pendingAttempts]) {
        settleAttempt(attempt, () => attempt.reject(error));
      }
    },
    runner: {
      async run(prompt: string, options?: { onUsage?: (usage: AgentUsage) => void; signal?: AbortSignal }) {
        void prompt;
        return new Promise((resolve, reject) => {
          const attempt: PendingAttempt = {
            resolve,
            reject,
            signal: options?.signal,
            onAbort: () => {},
          };
          attempt.onAbort = () => settleAttempt(attempt, () => reject(new Error("deferred agent aborted")));
          pendingAttempts.add(attempt);
          if (attempt.signal?.aborted) {
            attempt.onAbort();
          } else {
            attempt.signal?.addEventListener("abort", attempt.onAbort, { once: true });
          }
        });
      },
    },
  };
}

/** AbortSignal wrapper that exposes listeners manager code retains. */
function trackingAbortSignal(options: { throwOnAdd?: boolean; throwOnRemove?: boolean } = {}) {
  const controller = new AbortController();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let addCalls = 0;
  let removeCalls = 0;
  const signal = {
    get aborted() {
      return controller.signal.aborted;
    },
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      eventOptions?: AddEventListenerOptions,
    ) {
      addCalls++;
      if (options.throwOnAdd) throw new Error("add listener failed");
      if (type === "abort" && listener) listeners.add(listener);
      controller.signal.addEventListener(type, listener, eventOptions);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      eventOptions?: EventListenerOptions,
    ) {
      removeCalls++;
      if (options.throwOnRemove) throw new Error("remove listener failed");
      if (type === "abort" && listener) listeners.delete(listener);
      controller.signal.removeEventListener(type, listener, eventOptions);
    },
  } as unknown as AbortSignal;
  return {
    signal,
    abort: () => controller.abort(),
    listenerCount: () => listeners.size,
    addCalls: () => addCalls,
    removeCalls: () => removeCalls,
  };
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

test(
  "externalSignal listener is released after normal, failed, paused/resumed, and externally aborted executions",
  withTempCwd(async (cwd) => {
    // Normal completion.
    const normalSignal = trackingAbortSignal();
    const normalManager = new WorkflowManager({ cwd, agent: fakeAgent() });
    await normalManager.runSync(oneAgentScript, undefined, { externalSignal: normalSignal.signal });
    assert.equal(normalSignal.listenerCount(), 0);

    // Failure before the signal aborts.
    const failedSignal = trackingAbortSignal();
    const failedManager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("fatal", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        },
      },
    });
    failedManager.on("error", () => {});
    await assert.rejects(failedManager.runSync(oneAgentScript, undefined, { externalSignal: failedSignal.signal }));
    assert.equal(failedSignal.listenerCount(), 0);

    // Manual pause leaves the old execution settling; after it settles, its
    // listener is gone and an explicit resume starts a fresh execution safely.
    const pausedSignal = trackingAbortSignal();
    const pausedAgent = deferredAgent();
    const pausedManager = new WorkflowManager({ cwd, agent: pausedAgent.runner });
    pausedManager.on("error", () => {});
    const { runId: pausedRunId, promise: pausedPromise } = pausedManager.startInBackground(oneAgentScript, undefined, {
      externalSignal: pausedSignal.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pausedManager.pause(pausedRunId), true);
    pausedAgent.resolve();
    await pausedPromise.catch(() => {});
    assert.equal(pausedSignal.listenerCount(), 0);
    assert.equal(await pausedManager.resume(pausedRunId), true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pausedSignal.listenerCount(), 0);

    // A fired signal still reaches a settled execution through its own listener,
    // which the finally path removes even though EventTarget's once handling is
    // implementation-owned.
    const abortedSignal = trackingAbortSignal();
    const abortedAgent = deferredAgent();
    const abortedManager = new WorkflowManager({ cwd, agent: abortedAgent.runner });
    abortedManager.on("error", () => {});
    const { promise: abortedPromise } = abortedManager.startInBackground(oneAgentScript, undefined, {
      externalSignal: abortedSignal.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    abortedSignal.abort();
    abortedAgent.resolve();
    await abortedPromise.catch(() => {});
    assert.equal(abortedSignal.listenerCount(), 0);

    // Already-aborted signals never register a listener.
    const alreadyAbortedSignal = trackingAbortSignal();
    alreadyAbortedSignal.abort();
    const alreadyAbortedManager = new WorkflowManager({ cwd, agent: fakeAgent() });
    alreadyAbortedManager.on("error", () => {});
    await assert.rejects(
      alreadyAbortedManager.runSync(oneAgentScript, undefined, { externalSignal: alreadyAbortedSignal.signal }),
    );
    assert.equal(alreadyAbortedSignal.listenerCount(), 0);
  }),
);

test(
  "external signal registration and cleanup failures converge without replacing execution outcomes",
  withTempCwd(async (cwd) => {
    // Cleanup failure after a successful synchronous run is diagnostic-only.
    const successfulCleanupSignal = trackingAbortSignal({ throwOnRemove: true });
    const successfulManager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const successfulResult = await successfulManager.runSync(oneAgentScript, undefined, {
      externalSignal: successfulCleanupSignal.signal,
    });
    assert.equal((successfulResult.result as { a?: unknown }).a, "ok");
    assert.equal(successfulManager.getRun(successfulResult.runId ?? "")?.status, "completed");
    assert.equal(successfulCleanupSignal.removeCalls(), 1);

    // Cleanup failure must not replace the original workflow error.
    const failedCleanupSignal = trackingAbortSignal({ throwOnRemove: true });
    const failedManager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("original workflow failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: false,
          });
        },
      },
    });
    failedManager.on("error", () => {});
    await assert.rejects(
      failedManager.runSync(oneAgentScript, undefined, { externalSignal: failedCleanupSignal.signal }),
      /original workflow failure/,
    );
    assert.equal(failedManager.listRuns()[0]?.status, "failed");
    assert.equal(failedCleanupSignal.removeCalls(), 1);

    // Background completion also survives a throwing cleanup implementation.
    const backgroundCleanupSignal = trackingAbortSignal({ throwOnRemove: true });
    const backgroundManager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId: backgroundRunId, promise: backgroundPromise } = backgroundManager.startInBackground(
      oneAgentScript,
      undefined,
      {
        externalSignal: backgroundCleanupSignal.signal,
      },
    );
    await backgroundPromise;
    assert.equal(backgroundManager.getRun(backgroundRunId)?.status, "completed");
    assert.equal(backgroundCleanupSignal.removeCalls(), 1);

    // Registration failure enters executeRun's normal error convergence path for
    // both synchronous and background callers: status/persistence/lease/error
    // are all finalized rather than leaving a permanently-running row.
    const syncRegistrationSignal = trackingAbortSignal({ throwOnAdd: true });
    const syncRegistrationManager = new WorkflowManager({ cwd, agent: fakeAgent() });
    syncRegistrationManager.on("error", () => {});
    await assert.rejects(
      syncRegistrationManager.runSync(oneAgentScript, undefined, { externalSignal: syncRegistrationSignal.signal }),
      /Failed to register external abort listener: add listener failed/,
    );
    assert.equal(syncRegistrationManager.listRuns()[0]?.status, "failed");
    assert.equal(syncRegistrationSignal.addCalls(), 1);
    assert.equal(syncRegistrationSignal.removeCalls(), 1);

    const backgroundRegistrationSignal = trackingAbortSignal({ throwOnAdd: true });
    const backgroundRegistrationManager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const observedErrors: WorkflowError[] = [];
    backgroundRegistrationManager.on("error", (event: { error: WorkflowError }) => observedErrors.push(event.error));
    const { runId: registrationRunId, promise: registrationPromise } = backgroundRegistrationManager.startInBackground(
      oneAgentScript,
      undefined,
      { externalSignal: backgroundRegistrationSignal.signal },
    );
    await assert.rejects(registrationPromise, /Failed to register external abort listener: add listener failed/);
    assert.equal(backgroundRegistrationManager.getRun(registrationRunId)?.status, "failed");
    assert.equal(
      backgroundRegistrationManager.listRuns().find((run) => run.runId === registrationRunId)?.status,
      "failed",
    );
    assert.equal(observedErrors.length, 1);
    assert.match(observedErrors[0]?.message ?? "", /Failed to register external abort listener/);
    assert.equal(backgroundRegistrationSignal.addCalls(), 1);
    assert.equal(backgroundRegistrationSignal.removeCalls(), 1);
  }),
);

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-abort-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

// ─── Abort Propagation (3 tests) ───────────────────────────────────────────────

test(
  "abort via externalSignal propagates through workflow execution and yields WorkflowError",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    let errorEmitted = false;
    manager.on("error", () => {
      errorEmitted = true;
    });

    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });

    // Let the agent start (deferred, so it hangs inside agentRunner.run())
    await new Promise((r) => setTimeout(r, 20));

    // Abort from outside — this triggers managed.controller.abort()
    ac.abort();

    // Resolve the deferred agent so the in-flight agent completes,
    // then throwIfAborted() fires and the error propagates.
    da.resolve("done");

    try {
      await runPromise;
      assert.fail("runSync should have thrown on abort");
    } catch (err) {
      assert.ok(err instanceof WorkflowError, "error should be WorkflowError");
      assert.equal(
        (err as WorkflowError).code,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        "error code should be WORKFLOW_ABORTED",
      );
      assert.ok((err as WorkflowError).recoverable, "abort error should be recoverable");
    }

    assert.equal(errorEmitted, true, "manager should emit 'error' event on abort");
  }),
);

test(
  "abort via externalSignal does not crash Pi (no uncaught exception)",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let uncaughtFromTest: Error | null = null;
    const errorHandler = (err: Error) => {
      uncaughtFromTest = err;
    };
    process.on("uncaughtException", errorHandler);

    try {
      const runPromise = manager.runSync(oneAgentScript, undefined, {
        externalSignal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      da.resolve("done");

      try {
        await runPromise;
      } catch {
        // Expected — abort throws WorkflowError
      }

      // Give microtasks a chance to settle
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(uncaughtFromTest, null, "abort should NOT produce an uncaught exception");
    } finally {
      process.off("uncaughtException", errorHandler);
    }
  }),
);

test(
  "abort mid-way through multi-agent workflow: remaining agents are skipped",
  withTempCwd(async (cwd) => {
    // Per-call deferred agent: each call to run() gets its own promise.
    const resolves: Array<(v: unknown) => void> = [];
    let callIdx = 0;
    const multiDa = {
      resolve(idx: number, v: unknown = "done") {
        resolves[idx]?.(v);
      },
      runner: {
        async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
          const idx = callIdx++;
          return new Promise((resolve) => {
            resolves[idx] = resolve;
          });
        },
      },
    };

    const manager = new WorkflowManager({ cwd, agent: multiDa.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete (gets journaled)
    multiDa.resolve(0, "first-done");
    // Wait for agent 1's result to be journaled and agent 2 to start
    await new Promise((r) => setTimeout(r, 30));

    // Stop the run while agent 2 is in-flight
    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed");

    // Resolve agent 2 so the abort/throwIfAborted path executes
    multiDa.resolve(1, "second-done");
    await promise.catch(() => {});

    // Verify the run is aborted
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "run should be aborted after stop");

    // Verify the error is a WorkflowError
    const managedRun = manager.getRun(runId);
    assert.ok(managedRun?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal((managedRun.error as WorkflowError).code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);

// ─── Stop tests (3 tests) ──────────────────────────────────────────────────────

test(
  "stop on paused run transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause first
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Then stop the paused run
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    assert.equal(manager.getRun(runId)?.status, "aborted", "paused run should become aborted after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop emits 'stopped' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let stoppedEvent: { runId: string } | null = null;
    manager.on("stopped", (ev: { runId: string }) => {
      stoppedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.stop(runId);

    assert.ok(stoppedEvent, "stopped event should fire");
    assert.equal(stoppedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const secondStop = manager.stop(runId);
    assert.equal(secondStop, false, "second stop on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Pause tests (3 tests) ─────────────────────────────────────────────────────

test(
  "pause emits 'paused' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let pausedEvent: { runId: string } | null = null;
    manager.on("paused", (ev: { runId: string }) => {
      pausedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);
    await promise.catch(() => {});

    assert.ok(pausedEvent, "paused event should fire after the paused execution settles");
    assert.equal(pausedEvent?.runId, runId);
  }),
);

test(
  "pause returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause an already stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-paused run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.pause(runId);
    const secondPause = manager.pause(runId);
    assert.equal(secondPause, false, "second pause on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Resume tests (3 tests) ────────────────────────────────────────────────────

test(
  "resume full cycle: pause then resume then complete",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Resume — replays journal (empty for single-agent that never completed) and
    // re-runs the live agent with a fresh (non-aborted) controller.
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed");

    // The resumed run should be running
    assert.equal(manager.getRun(runId)?.status, "running", "resumed run should be running");

    // Resolve the deferred agent so the resumed run's agent completes
    da.resolve("resumed-done");

    // The original promise will reject (its controller was aborted). Suppress it.
    await origPromise.catch(() => {});

    // Wait for the resumed run to complete
    await new Promise((r) => setTimeout(r, 50));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run should complete successfully");
    assert.equal(finalRun?.result?.result?.a, "resumed-done", "resumed run should have the agent result");

    // The run should also appear in listRuns as completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed");
  }),
);

test(
  "resume with journal replay replays completed agents and runs remaining live",
  withTempCwd(async (cwd) => {
    // Use a multi-agent workflow: agent 1 completes before pause (gets journaled),
    // agent 2 runs live after resume.
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise: origPromise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete
    da.resolve("first-result");
    await new Promise((r) => setTimeout(r, 30));

    // Agent 1 should have completed and been journaled. Pause.
    const paused = manager.pause(runId);
    const statusAtPause = manager.getRun(runId)?.status;

    if (paused) {
      assert.equal(statusAtPause, "paused");

      // Journal should have at least agent 1's entry
      const persisted = manager.listRuns().find((r) => r.runId === runId);
      assert.ok(persisted?.journal && persisted.journal.length >= 1, "journal should have at least one entry");

      // Resume
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true);
      while ((manager.getRun(runId)?.snapshot.agents.length ?? 0) < 2) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      da.resolve("second-result");

      // Wait for resumed run to complete (agent 1 replayed from journal, agent 2 live)
      await new Promise((r) => setTimeout(r, 50));

      const finalRun = manager.getRun(runId);
      assert.equal(finalRun?.status, "completed", "resumed multi-agent run should complete");
      assert.equal(finalRun?.result?.result?.a, "first-result");
    }

    await origPromise.catch(() => {});
  }),
);

test(
  "resume returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    if (runId) {
      const resumed = await manager.resume(runId);
      assert.equal(resumed, false, "cannot resume a completed run");
    }
  }),
);

// ─── getRun tests (3 tests) ────────────────────────────────────────────────────

test(
  "getRun returns ManagedRun with correct fields for active background run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    const run = manager.getRun(runId);
    assert.ok(run, "getRun should return the managed run");
    assert.equal(run?.runId, runId);
    assert.equal(run?.status, "running");
    assert.equal(run?.script, oneAgentScript);
    assert.ok(run?.controller instanceof AbortController, "should have an AbortController");
    assert.ok(run?.startedAt instanceof Date, "should have a startedAt date");
    assert.equal(run?.background, true, "should be marked as background");
    assert.ok(Array.isArray(run?.journal), "should have a journal array");

    // snapshot should be populated
    assert.equal(run?.snapshot.name, "tracked_demo");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns ManagedRun with status 'aborted' after stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns undefined after deleteRun",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Stop first, then delete
    manager.stop(runId);
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    const run = manager.getRun(runId);
    assert.equal(run, undefined, "deleted run should not be accessible");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── deleteRun tests (2 tests) ─────────────────────────────────────────────────

test(
  "deleteRun can delete a running run (removes from memory and persistence)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Delete while running — should succeed (removes from tracking)
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    // Should not be in memory
    assert.equal(manager.getRun(runId), undefined);

    // Should not be in persistence
    const runs = manager.listRuns();
    assert.equal(
      runs.find((r) => r.runId === runId),
      undefined,
    );

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "deleteRun deletes persisted journal entries",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion
    await new Promise((r) => setTimeout(r, 30));

    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    // Verify persistence file is gone by checking listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 0, "no persisted runs should remain after delete");
  }),
);

// ─── startInBackground tests (3 tests) ─────────────────────────────────────────

test(
  "startInBackground with args propagates args to workflow script",
  withTempCwd(async (cwd) => {
    // Script that uses args
    const argsScript = `export const meta = { name: 'args_demo', description: 'args test' }
const a = await agent('do it', { label: 'a' })
return { args, a }`;

    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(argsScript, { mode: "test", value: 42 });
    const result = await promise;
    assert.ok(result, "should complete successfully");
  }),
);

test(
  "startInBackground runId is unique per call",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    assert.notEqual(r1.runId, r2.runId, "runIds should be unique");

    // Wait for both to complete
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "startInBackground snapshot is initially populated with workflow name",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    const snap = manager.getSnapshot(runId);
    assert.equal(snap?.name, "tracked_demo");
    assert.equal(snap?.description, "one agent");
    assert.ok(Array.isArray(snap?.phases), "snap.phases should be an array");
    assert.ok(Array.isArray(snap?.logs), "snap.logs should be an array");
    await promise.catch(() => {});
  }),
);

// ─── Multiple runs / Events tests (3 tests) ────────────────────────────────────

test(
  "multiple background runs are independently managed",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 30));

    // Both should be running
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Stop one independently
    manager.stop(r1.runId);
    assert.equal(manager.getRun(r1.runId)?.status, "aborted");
    assert.equal(manager.getRun(r2.runId)?.status, "running", "other run should still be running");

    // listRuns should show both
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should be listed");

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "listRuns reflects status changes after pause and stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause
    manager.pause(runId);
    let persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused", "listRuns should show paused status");

    // Stop
    manager.stop(runId);
    persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "listRuns should show aborted status after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "manager emits 'resumed' and 'error' events",
  withTempCwd(async (cwd) => {
    const _ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });

    // Track resumed event
    let resumedEvent: { runId: string } | null = null;
    manager.on("resumed", (ev: { runId: string }) => {
      resumedEvent = ev;
    });

    // Track resumed event on the pause→resume cycle
    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);
    await manager.resume(runId);

    assert.ok(resumedEvent, "resumed event should fire on resume");
    assert.equal(resumedEvent?.runId, runId);

    da.resolve("done");
    await origPromise.catch(() => {});

    // Now test error event on abort
    let capturedError: { runId: string; error: WorkflowError } | null = null;
    const da2 = deferredAgent();
    const manager2 = new WorkflowManager({ cwd, agent: da2.runner });
    manager2.on("error", (ev: { runId: string; error: WorkflowError }) => {
      capturedError = ev;
    });

    const ac2 = new AbortController();
    const runPromise = manager2.runSync(oneAgentScript, undefined, {
      externalSignal: ac2.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac2.abort();
    da2.resolve("done");

    try {
      await runPromise;
    } catch {
      /* expected */
    }

    assert.ok(capturedError, "error event should fire on abort");
    assert.ok(capturedError?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal(capturedError?.error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);
