import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { PersistedRunState, RunPersistence } from "../src/run-persistence.js";
import {
  computeAutoResumeDelayMs,
  parseResetHintMs,
  type SchedulableWorkflowManager,
  UsageLimitScheduler,
} from "../src/usage-limit-scheduler.js";

// ---- test doubles -----------------------------------------------------------

/** Deterministic, manually-advanced fake clock + synchronous fake timers. */
function createFakeClock(startMs = 0) {
  let current = startMs;
  const pending = new Map<number, { fn: () => void; ms: number; armedAt: number }>();
  let nextId = 1;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextId++;
      pending.set(id, { fn, ms, armedAt: current });
      return id;
    },
    clearTimer: (id: number): void => {
      pending.delete(id);
    },
    /** Fire every currently-armed timer, synchronously, in arm order. */
    fireAll(): void {
      const toFire = [...pending.entries()].sort((a, b) => a[0] - b[0]);
      pending.clear();
      for (const [, { fn }] of toFire) fn();
    },
    pendingCount: () => pending.size,
    pendingDelays: (): number[] => [...pending.values()].map((p) => p.ms),
  };
}

/** Flush the microtask queue a few times (covers queueMicrotask + resolved promises). */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

class FakePersistence {
  private runs = new Map<string, PersistedRunState>();

  seed(run: PersistedRunState): void {
    this.runs.set(run.runId, run);
  }

  get(runId: string): PersistedRunState | undefined {
    return this.runs.get(runId);
  }

  list(): PersistedRunState[] {
    return [...this.runs.values()];
  }

  asRunPersistence(): RunPersistence {
    return {
      save: (state: PersistedRunState) => {
        this.runs.set(state.runId, { ...state, updatedAt: new Date().toISOString() });
      },
      load: (runId: string) => this.runs.get(runId) ?? null,
      list: () => [...this.runs.values()],
      delete: (runId: string) => this.runs.delete(runId),
      acquireRunLease: () => null,
      releaseRunLease: () => {},
      getRunsDir: () => "/fake-runs",
    };
  }
}

class FakeManager extends EventEmitter implements SchedulableWorkflowManager {
  readonly persistence = new FakePersistence();
  resumeImpl: (runId: string) => Promise<boolean> = async () => false;

  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  resume(runId: string): Promise<boolean> {
    return this.resumeImpl(runId);
  }

  getPersistence(): RunPersistence {
    return this.persistence.asRunPersistence();
  }
}

function makeRun(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  // Default status is "running", NOT "paused" — most tests seed a persisted
  // record only so handlePaused()'s autoResume-opt-out lookup has something to
  // read. A "paused" + pauseReason "usage_limit" run is picked up by cold-start
  // re-arm in the UsageLimitScheduler constructor, so tests that exercise a
  // *live* "paused" event opt in to that separately (see the cold-start tests).
  return {
    runId: "run-1",
    workflowName: "test_workflow",
    script: "export const meta = { name: 'test_workflow', description: 'd' }",
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const TUNABLES = { maxAttempts: 3, minDelayMs: 60_000, fallbackDelayMs: 300_000, maxDelayMs: 6 * 3_600_000 };

// ---- parseResetHintMs ---------------------------------------------------------

test("parseResetHintMs: hours", () => {
  assert.equal(parseResetHintMs("Resets in 3h"), 3 * 3_600_000);
});

test("parseResetHintMs: approx hours (~3h)", () => {
  assert.equal(parseResetHintMs("Resets in ~3h"), 3 * 3_600_000);
});

test("parseResetHintMs: minutes", () => {
  assert.equal(parseResetHintMs("resets in 5m"), 5 * 60_000);
});

test("parseResetHintMs: seconds", () => {
  assert.equal(parseResetHintMs("resets in 90s"), 90 * 1_000);
});

test("parseResetHintMs: combined hours+minutes", () => {
  assert.equal(parseResetHintMs("Resets in 1h30m"), 3_600_000 + 30 * 60_000);
});

test("parseResetHintMs: word units (5 minutes)", () => {
  assert.equal(parseResetHintMs("resets in 5 minutes"), 5 * 60_000);
});

test("parseResetHintMs: missing hint returns undefined", () => {
  assert.equal(parseResetHintMs(undefined), undefined);
});

test("parseResetHintMs: unparseable text returns undefined", () => {
  assert.equal(parseResetHintMs("try again later"), undefined);
});

// ---- computeAutoResumeDelayMs --------------------------------------------------

test("computeAutoResumeDelayMs: delay floor is enforced", () => {
  const delay = computeAutoResumeDelayMs({
    resetHint: "resets in 1s",
    attempts: 1,
    elapsedMs: 0,
    minDelayMs: 60_000,
    fallbackDelayMs: 300_000,
    maxDelayMs: 3_600_000,
  });
  assert.equal(delay, 60_000, "1s base is below the floor, floor wins");
});

test("computeAutoResumeDelayMs: backoff grows with attempts and is capped by maxDelayMs", () => {
  const base = { resetHint: "resets in 10m", elapsedMs: 0, minDelayMs: 1_000, fallbackDelayMs: 300_000 };
  const attempt1 = computeAutoResumeDelayMs({ ...base, attempts: 1, maxDelayMs: 3_600_000 });
  const attempt2 = computeAutoResumeDelayMs({ ...base, attempts: 2, maxDelayMs: 3_600_000 });
  const attempt10 = computeAutoResumeDelayMs({ ...base, attempts: 10, maxDelayMs: 3_600_000 });
  assert.equal(attempt1, 10 * 60_000);
  assert.equal(attempt2, 20 * 60_000, "attempt 2 doubles attempt 1");
  assert.equal(attempt10, 3_600_000, "clamped at maxDelayMs instead of overflowing");
});

// ---- scheduler behavior --------------------------------------------------------

test("live pause: arms a timer that calls manager.resume() on fire", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  const resumedRunIds: string[] = [];
  manager.resumeImpl = async (runId) => {
    resumedRunIds.push(runId);
    return true;
  };

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.equal(clock.pendingCount(), 1, "a timer was armed");
  assert.deepEqual(clock.pendingDelays(), [10 * 60_000]);

  clock.fireAll();
  await flush();

  assert.deepEqual(resumedRunIds, ["run-1"], "resume() was called when the timer fired");
  scheduler.dispose();
});

test("re-pause after a failed resume reschedules with a larger (backoff) delay", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.deepEqual(clock.pendingDelays(), [10 * 60_000], "attempt 1 delay");

  // Simulate: resume() launched, run hit the wall again and re-paused.
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.deepEqual(clock.pendingDelays(), [20 * 60_000], "attempt 2 backs off (2x attempt 1)");
  assert.equal(scheduler.getAttemptCount("run-1"), 2);

  scheduler.dispose();
});

test("attempt cap reached: gives up, arms no further timers", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 1m" }));
  const clock = createFakeClock();
  const diagnostics: string[] = [];
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onDiagnostic: (msg) => diagnostics.push(msg),
    ...TUNABLES, // maxAttempts: 3
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 1m" }); // attempt 1
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 1m" }); // attempt 2
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 1m" }); // attempt 3
  assert.equal(clock.pendingCount(), 1, "attempt 3 is still armed (3 <= maxAttempts 3)");

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 1m" }); // attempt 4 > cap
  assert.equal(clock.pendingCount(), 0, "no timer armed once the cap is exceeded");
  assert.ok(
    diagnostics.some((m) => m.includes("giving up")),
    "a give-up diagnostic was logged",
  );

  // Further pauses beyond the cap must not spam the log.
  const logCountBefore = diagnostics.filter((m) => m.includes("giving up")).length;
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 1m" });
  const logCountAfter = diagnostics.filter((m) => m.includes("giving up")).length;
  assert.equal(logCountAfter, logCountBefore, "give-up diagnostic doesn't repeat every time");

  scheduler.dispose();
});

test("cold-start re-arm uses REMAINING time, not the full base delay", async () => {
  const manager = new FakeManager();
  const pausedAt = new Date(0);
  manager.persistence.seed(
    makeRun({
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "resets in 1h",
      updatedAt: pausedAt.toISOString(),
    }),
  );
  // "now" is 55 minutes after the pause was persisted.
  const clock = createFakeClock(55 * 60_000);

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  assert.equal(clock.pendingCount(), 1, "cold start re-armed the already-paused run");
  assert.deepEqual(clock.pendingDelays(), [5 * 60_000], "remaining ~5m, not the full 60m base");
  scheduler.dispose();
});

test("cold-start re-arm skips runs with autoResume: false", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(
    makeRun({
      runId: "opted-out",
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "resets in 10m",
      autoResume: false,
    }),
  );
  const clock = createFakeClock();

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  assert.equal(clock.pendingCount(), 0, "no timer armed for an opted-out run");
  assert.equal(scheduler.getAttemptCount("opted-out"), undefined);
  scheduler.dispose();
});

test("live pause skips arming when autoResume: false is already persisted", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ autoResume: false }));
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.equal(clock.pendingCount(), 0);
  scheduler.dispose();
});

test("manual pause (no usage_limit reason) is ignored", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun());
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1" }); // manager.pause() emits no `reason`
  assert.equal(clock.pendingCount(), 0);
  scheduler.dispose();
});

test("resume() returning false does NOT consume an attempt and re-arms at minDelayMs", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m", status: "paused" }));
  const clock = createFakeClock();
  let resumeCalls = 0;
  manager.resumeImpl = async () => {
    resumeCalls++;
    return false; // e.g. lease busy / transient
  };

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.equal(scheduler.getAttemptCount("run-1"), 1);

  clock.fireAll();
  await flush();

  assert.equal(resumeCalls, 1);
  assert.equal(scheduler.getAttemptCount("run-1"), 1, "attempt count unchanged by a false resume()");
  assert.deepEqual(clock.pendingDelays(), [TUNABLES.minDelayMs], "re-armed at the short floor delay");

  clock.fireAll();
  await flush();
  assert.equal(resumeCalls, 2, "retried again on the next fire");
  assert.equal(scheduler.getAttemptCount("run-1"), 1, "still hasn't consumed an attempt");

  scheduler.dispose();
});

test("resume() returning false and run now completed/aborted stops retrying", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  manager.resumeImpl = async (runId) => {
    // Simulate: something else completed the run out from under us.
    const run = manager.persistence.get(runId);
    if (run) manager.persistence.seed({ ...run, status: "completed" });
    return false;
  };

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  clock.fireAll();
  await flush();

  assert.equal(clock.pendingCount(), 0, "no retry armed once the run is terminal");
  assert.equal(scheduler.getAttemptCount("run-1"), undefined, "state cleaned up");
  scheduler.dispose();
});

test("resume() returning true stops this cycle; the existing 'paused' subscription re-arms on re-pause", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  manager.resumeImpl = async () => true;

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  clock.fireAll();
  await flush();

  assert.equal(clock.pendingCount(), 0, "no further timer armed after a successful resume()");
  assert.equal(scheduler.hasArmedTimer("run-1"), false);
  scheduler.dispose();
});

for (const terminalEvent of ["complete", "error", "stopped"] as const) {
  test(`"${terminalEvent}" event clears the armed timer and forgets the run`, async () => {
    const manager = new FakeManager();
    manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
    const clock = createFakeClock();
    const scheduler = new UsageLimitScheduler(manager, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...TUNABLES,
    });

    manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
    assert.equal(clock.pendingCount(), 1);

    manager.emit(terminalEvent, { runId: "run-1" });
    assert.equal(clock.pendingCount(), 0, "timer cleared on terminal event");
    assert.equal(scheduler.getAttemptCount("run-1"), undefined);
    scheduler.dispose();
  });
}

test("dispose() clears all armed timers and unsubscribes from further events", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.equal(clock.pendingCount(), 1);

  scheduler.dispose();
  assert.equal(clock.pendingCount(), 0, "dispose cleared the armed timer");

  // Further events must not resurrect a timer post-dispose.
  manager.emit("paused", { runId: "run-2", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.equal(clock.pendingCount(), 0);
});

test("scheduler never throws out of a manager event even when a listener's work fails", async () => {
  const manager = new FakeManager();
  // No seeded run: persistence.load() returns null/undefined inside the handler.
  const clock = createFakeClock();
  const diagnostics: string[] = [];
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onDiagnostic: (msg) => diagnostics.push(msg),
    ...TUNABLES,
  });

  assert.doesNotThrow(() => {
    manager.emit("paused", { runId: "ghost-run", reason: "usage_limit", resetHint: "resets in 10m" });
  });
  assert.equal(clock.pendingCount(), 1, "still arms even though persistence had nothing for this run");
  scheduler.dispose();
});

test("attempts and opt-out are persisted (best-effort) for a future cold start", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m", autoResume: true }));
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  await flush();

  const persisted = manager.persistence.get("run-1");
  assert.equal(persisted?.autoResumeAttempts, 1, "attempt count persisted after the microtask flush");
  scheduler.dispose();
});
