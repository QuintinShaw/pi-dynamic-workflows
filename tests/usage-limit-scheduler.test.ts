import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunPersistence } from "../src/run-persistence.js";
import {
  computeAutoResumeDelayMs,
  parseResetHintMs,
  type SchedulableWorkflowManager,
  UsageLimitScheduler,
} from "../src/usage-limit-scheduler.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

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

  recordAutoResumeAttempts(runId: string, attempts: number): void {
    // The fake has no live-run map: merge straight into persistence, matching
    // the real manager's non-live path.
    const persistence = this.persistence.asRunPersistence();
    const current = persistence.load(runId);
    if (!current) return;
    persistence.save({ ...current, autoResumeAttempts: attempts });
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

const TUNABLES = {
  maxAttempts: 3,
  minDelayMs: 60_000,
  fallbackDelayMs: 300_000,
  maxDelayMs: 6 * 3_600_000,
  jitterRatio: 0,
};

// ---- parseResetHintMs ---------------------------------------------------------

test("parseResetHintMs: hours", () => {
  assert.equal(parseResetHintMs("Resets in 3h"), 3 * 3_600_000);
});

test("parseResetHintMs: day and week units (audit2 #14)", () => {
  assert.equal(parseResetHintMs("Resets in 2d"), 2 * 86_400_000);
  assert.equal(parseResetHintMs("Resets in 1 week"), 7 * 86_400_000);
  assert.equal(parseResetHintMs("resets in 3 days"), 3 * 86_400_000);
});

test("parseResetHintMs: invalid clock hints do not normalize into a different reset time", () => {
  for (const hint of ["Try again at 13:20 PM", "Try again at 0:30 AM", "Reset at 3:99 PM; retry in 600 seconds"]) {
    assert.equal(parseResetHintMs(hint), undefined);
  }
});

test("parseResetHintMs: absolute ISO reset timestamp (audit2 #10)", () => {
  const now = Date.parse("2026-09-17T13:00:00+08:00");
  // The verbatim Ark/Codex quota message shape.
  assert.equal(
    parseResetHintMs("You have exceeded the 5-hour usage quota. It will reset at 2026-09-17 13:20:54 +0800 CST", now),
    1_254_000, // 20m54s
  );
  // A timestamp already in the past clamps to 0 rather than going negative.
  assert.equal(parseResetHintMs("It will reset at 2026-09-17 12:00:00 +0800", now), 0);
});

test("parseResetHintMs: absolute clock time rolls over to tomorrow (audit2 #10)", () => {
  const now = Date.parse("2026-09-17T15:00:00"); // 3:00 PM local
  const expected = new Date(now);
  expected.setHours(15, 20, 0, 0);
  assert.equal(parseResetHintMs("Try again at 3:20 PM", now), expected.getTime() - now);
  const rolled = new Date(now);
  rolled.setHours(9, 0, 0, 0);
  rolled.setDate(rolled.getDate() + 1);
  assert.equal(parseResetHintMs("Try again at 9:00 AM", now), rolled.getTime() - now);
});

test("parseResetHintMs: T-form with a space before the offset, and double-space forms", () => {
  const now = Date.parse("2026-09-17T13:00:00+08:00");
  assert.equal(parseResetHintMs("It will reset at 2026-09-17T13:20:54 +0800", now), 1_254_000);
  assert.equal(parseResetHintMs("It will reset at 2026-09-17 13:20:54  +0800", now), 1_254_000);
});

test("parseResetHintMs: 'resetting at' clock form", () => {
  const now = Date.parse("2026-09-17T15:00:00"); // 3:00 PM local
  const expected = new Date(now);
  expected.setHours(15, 20, 0, 0);
  assert.equal(parseResetHintMs("Quota resetting at 3:20 PM", now), expected.getTime() - now);
});

test("parseResetHintMs: Z-suffixed ISO timestamps parse as UTC, not local", () => {
  const now = Date.parse("2026-09-17T13:00:00Z");
  assert.equal(parseResetHintMs("It will reset at 2026-09-17T13:20:54Z", now), 1_254_000);
  assert.equal(parseResetHintMs("It will reset at 2026-09-17 13:20:54.123Z", now), 1_254_123);
});

test("parseResetHintMs: an unparseable absolute match does not fall through to unrelated units", () => {
  // The absolute regex matched but the timestamp is garbage: the "600 seconds"
  // elsewhere in the message must NOT be returned (callers fall back instead).
  assert.equal(parseResetHintMs("It will reset at 2026-13-45 99:99 +0800. Retry-After: 600 seconds", 0), undefined);
});

test("parseResetHintMs: an explicit date pins the clock branch's day", () => {
  const now = Date.parse("2026-09-17T15:00:00"); // 3:00 PM local
  const expected = new Date(now);
  expected.setFullYear(2026, 8, 20);
  expected.setHours(15, 20, 0, 0);
  assert.equal(parseResetHintMs("Try again at 3:20 PM on 2026-09-20", now), expected.getTime() - now);
  // A minute-truncated hint delivered within the same minute must not roll a day.
  const within = new Date(now);
  within.setHours(15, 20, 30, 500);
  assert.equal(parseResetHintMs("Try again at 3:20 PM", within.getTime()), 0);
});

test("jitter never breaches the maxDelayMs ceiling (and ceiling-hit delays spread downward)", () => {
  const armed = computeAutoResumeDelayMs({
    resetHint: "resets in 99h",
    attempts: 1,
    elapsedMs: 0,
    minDelayMs: 60_000,
    fallbackDelayMs: 300_000,
    maxDelayMs: 3_600_000,
    jitterRatio: 0.1,
    random: () => 0.999999,
  });
  assert.ok(armed <= 3_600_000, "the documented ceiling holds on the armed delay");
  assert.ok(armed < 3_600_000, "ceiling-hit delays spread downward so same-event runs decorrelate");
  assert.ok(armed >= 60_000, "the floor still holds");
});

test("cold start with an ABSOLUTE reset hint arms the true remaining, not the floor", async () => {
  // Paused at t=0 with a reset at t+20m54s; the process restarts 10m in.
  // The re-arm must be ~10.9m (reset - now), not the 60s floor from
  // double-subtracting elapsed (audit2 r1 B1).
  const manager = new FakeManager();
  const clock = createFakeClock(0);
  manager.persistence.seed(
    makeRun({
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "It will reset at 2026-09-17T13:20:54Z",
      autoResumeAttempts: 1,
      updatedAt: new Date(Date.parse("2026-09-17T13:00:00Z")).toISOString(),
    }),
  );
  clock.advance(10 * 60_000);
  const pausedNow = Date.parse("2026-09-17T13:00:00Z") + 10 * 60_000;
  const scheduler = new UsageLimitScheduler(manager, {
    now: () => pausedNow,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });
  await flush();
  assert.deepEqual(clock.pendingDelays(), [1_254_000 - 10 * 60_000], "true remaining (reset - now), not the floor");
  scheduler.dispose();
});

test("cold start with an absent counter WRITES the armed attempt through the non-live path (audit2 r1 m5)", async () => {
  const manager = new FakeManager();
  const clock = createFakeClock();
  manager.persistence.seed(
    makeRun({
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "resets in 10m",
      // autoResumeAttempts deliberately absent (pre-#207 record)
    }),
  );
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });
  await flush();
  assert.equal(
    manager.persistence.get("run-1")?.autoResumeAttempts,
    1,
    "arming attempt 1 over an absent counter is a changed value and must persist",
  );
  scheduler.dispose();
});

test("scheduler-level: jitter never arms above maxDelayMs, and ceiling-hit delays still spread", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 99h" }));
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
    maxDelayMs: 3_600_000,
    jitterRatio: 0.1,
    random: () => 0.999999,
  });
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 99h" });
  const [armed] = clock.pendingDelays();
  assert.ok(armed <= 3_600_000, `armed delay ${armed} must not exceed the ceiling`);
  assert.ok(armed < 3_600_000, "a ceiling-hit delay still spreads downward (decorrelates the herd)");
  assert.ok(armed >= 60_000, "the floor still holds");
  scheduler.dispose();
});

test("jitter: a backoff exactly AT the cap still spreads (no point mass at maxDelayMs)", () => {
  const delays = new Set<number>();
  for (const sample of [0, 0.25, 0.5, 0.75, 0.999999]) {
    delays.add(
      computeAutoResumeDelayMs({
        resetHint: "resets in 1h",
        attempts: 1,
        elapsedMs: 0,
        minDelayMs: 60_000,
        fallbackDelayMs: 300_000,
        maxDelayMs: 3_600_000, // backoff == cap exactly
        jitterRatio: 0.1,
        random: () => sample,
      }),
    );
  }
  assert.ok(
    [...delays].every((d) => d <= 3_600_000),
    "ceiling holds in every sample",
  );
  assert.ok(delays.size > 1, "same-cap cohorts decorrelate instead of piling onto maxDelayMs");
  assert.ok(
    [...delays].every((d) => d < 3_600_000),
    "no sample piles exactly at the cap",
  );
});

test("jitter spreads identical arms deterministically with an injected random (audit2 #13)", () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
    jitterRatio: 0.1,
    random: () => 0.75, // fixed spread factor: 10m * (0.9 + 0.15) = 10.5m
  });
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.deepEqual(clock.pendingDelays(), [Math.round(10 * 60_000 * 1.05)]);
  scheduler.dispose();
});

test("refused-resume re-arms are capped instead of polling forever (audit2 #12)", async () => {
  const manager = new FakeManager();
  manager.resume = async () => false; // structurally refused (e.g. lease held elsewhere)
  manager.persistence.seed(makeRun({ status: "running", resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  const diagnostics: string[] = [];
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onDiagnostic: (m) => diagnostics.push(m),
    ...TUNABLES,
    maxRefusals: 2,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  // Fire the armed timer: refused → re-arm at minDelayMs (refusal 1).
  clock.fireAll();
  await flush();
  assert.equal(clock.pendingCount(), 1, "first refusal re-arms");
  clock.fireAll();
  await flush();
  assert.equal(clock.pendingCount(), 1, "second refusal re-arms");
  clock.fireAll();
  await flush();
  assert.equal(clock.pendingCount(), 0, "third refusal exceeds maxRefusals → gives up");
  assert.ok(
    diagnostics.some((m) => m.includes("giving up after 3 refused auto-resume poll(s)")),
    "give-up diagnostic names the ACTUAL refusal count (3 with maxRefusals 2)",
  );
  scheduler.dispose();
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

test("cold-start elapsed time is subtracted after backoff and the original delay ceiling", () => {
  const params = {
    resetHint: "resets in 10m",
    attempts: 2,
    elapsedMs: 5 * 60_000,
    minDelayMs: 1_000,
    maxDelayMs: 60 * 60_000,
    fallbackDelayMs: 300_000,
    jitterRatio: 0,
  };
  assert.equal(computeAutoResumeDelayMs(params), 15 * 60_000, "20m original delay minus 5m elapsed");
  assert.equal(
    computeAutoResumeDelayMs({ ...params, attempts: 10, elapsedMs: 30 * 60_000 }),
    30 * 60_000,
    "a capped one-hour arm has only 30m left after 30m elapsed",
  );
  assert.equal(
    computeAutoResumeDelayMs({ ...params, attempts: 10, elapsedMs: 61 * 60_000 }),
    1_000,
    "an overdue capped arm uses only the retry floor",
  );
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

test("cold start past the cap: no growth, no timer, no repeated give-up log (#106)", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(
    makeRun({
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "resets in 1m",
      autoResumeAttempts: 4, // already past the cap (maxAttempts 3 → sentinel 4)
    }),
  );
  const diagnostics: string[] = [];

  // Several Pi restarts, each a fresh scheduler (= a cold start). Before the fix,
  // coldStartRearm() did prior+1 and arm() persisted the raw overflow, so the
  // counter climbed (5, 6, 7…) and a give-up line printed on every boot.
  for (let restart = 0; restart < 3; restart++) {
    const clock = createFakeClock();
    const scheduler = new UsageLimitScheduler(manager, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onDiagnostic: (m) => diagnostics.push(m),
      ...TUNABLES,
    });
    await flush();
    assert.equal(clock.pendingCount(), 0, `restart ${restart}: no timer armed past the cap`);
    assert.equal(
      manager.persistence.get("run-1")?.autoResumeAttempts,
      4,
      `restart ${restart}: attempts frozen at the sentinel, never incremented`,
    );
    scheduler.dispose();
  }

  assert.equal(
    diagnostics.filter((m) => m.includes("giving up")).length,
    0,
    "an already-given-up run must not re-log the give-up diagnostic on every cold start",
  );
});

test("cold start crossing the cap logs give-up exactly once, then freezes (#106, audit2 #11)", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(
    makeRun({
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "resets in 1m",
      autoResumeAttempts: 3, // attempt 3 was ARMED but never fired — the restart re-arms it
    }),
  );
  const diagnostics: string[] = [];
  const boot = async () => {
    const clock = createFakeClock();
    const scheduler = new UsageLimitScheduler(manager, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onDiagnostic: (m) => diagnostics.push(m),
      ...TUNABLES,
    });
    await flush();
    return { clock, scheduler };
  };

  // The re-armed attempt is NOT a cap crossing (audit2 #11: the restart doesn't
  // consume a fresh attempt) — it arms a timer for the already-counted attempt.
  const first = await boot();
  assert.equal(first.clock.pendingCount(), 1, "re-arms the armed-but-unfired attempt, no give-up yet");
  assert.equal(manager.persistence.get("run-1")?.autoResumeAttempts, 3, "rearm does not burn a fresh attempt");

  // That attempt fires and the run hits the wall again → the NEXT pause crosses.
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 1m" });
  assert.equal(first.clock.pendingCount(), 0, "crossing the cap arms no timer");
  first.scheduler.dispose();
  const second = await boot();
  second.scheduler.dispose();

  assert.equal(
    manager.persistence.get("run-1")?.autoResumeAttempts,
    4,
    "counter freezes at the sentinel (maxAttempts + 1), not 5+",
  );
  assert.equal(
    diagnostics.filter((m) => m.includes("giving up")).length,
    1,
    "give-up logs once at the crossing, not again on the next cold start",
  );
});

test("a manual resume clears the given-up state and resets the counter", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(
    makeRun({
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "resets in 10m",
      autoResumeAttempts: 4, // already given up (cap 3)
    }),
  );
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });
  await flush();
  assert.equal(scheduler.hasArmedTimer("run-1"), false, "given-up run arms nothing on cold start");

  // User resumes via /workflows → the manager emits "resumed" (not our timer).
  manager.emit("resumed", { runId: "run-1" });
  await flush();
  assert.equal(scheduler.getAttemptCount("run-1"), undefined, "in-memory given-up state cleared");
  assert.equal(manager.persistence.get("run-1")?.autoResumeAttempts, 0, "persisted counter reset to 0");

  // A later pause now re-enters the normal backoff from attempt 1.
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.equal(scheduler.hasArmedTimer("run-1"), true, "a fresh attempt is armed after the manual resume");
  assert.equal(scheduler.getAttemptCount("run-1"), 1, "counter starts over at 1");
  scheduler.dispose();
});

test("an auto-resume (our own timer firing) does NOT reset the backoff counter", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  // Our resume emits "resumed" the same way the real manager does.
  manager.resumeImpl = async (runId) => {
    manager.emit("resumed", { runId });
    return true;
  };
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  // Two live pauses climb the counter to 2.
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.equal(scheduler.getAttemptCount("run-1"), 2);

  // The timer fires → our resume() runs and emits "resumed". The counter must be
  // kept (this is the backoff working), not reset by handleResumed.
  clock.fireAll();
  await flush();
  assert.equal(scheduler.getAttemptCount("run-1"), 2, "auto-resume kept the backoff counter");
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

  const persisted = manager.persistence.get("run-1");
  assert.equal(persisted?.autoResumeAttempts, 1, "attempt count persisted synchronously");
  scheduler.dispose();
});

// ---- real WorkflowManager wiring (#207 regression) -----------------------------
//
// The fake manager above can't catch a scheduler that bypasses
// recordAutoResumeAttempts (the fake reimplements the same merge), and never
// exercises the real manager's non-live branch. These two tests wire a REAL
// WorkflowManager + UsageLimitScheduler over an isolated cwd/HOME.

const QUOTA_SCRIPT = `export const meta = { name: 'quota_demo', description: 'quota' }
const a = await agent('hit the wall', { label: 'a' })
return { a }`;

function quotaAgent() {
  return {
    async run(): Promise<never> {
      throw new WorkflowError(
        "Codex usage limit reached (plus plan). Resets in ~3h.",
        WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
        {
          recoverable: false,
          resetHint: "Resets in ~3h",
        },
      );
    },
  };
}

async function withRealManagerCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-sched-real-"));
  const home = mkdtempSync(join(tmpdir(), "pdw-sched-home-"));
  try {
    await withFakeHomeAsync(home, () => fn(cwd));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("real manager: scheduler-recorded attempts survive later manager persists (#207)", async () => {
  await withRealManagerCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: quotaAgent() });
    manager.on("error", () => {});
    const clock = createFakeClock();
    const scheduler = new UsageLimitScheduler(manager, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...TUNABLES,
    });

    const { runId, promise } = manager.startInBackground(QUOTA_SCRIPT);
    await promise.catch(() => {}); // rejects with PROVIDER_USAGE_LIMIT; run pauses
    assert.equal(manager.getRun(runId)?.status, "paused");
    assert.equal(
      manager.getPersistence().load(runId)?.autoResumeAttempts,
      1,
      "scheduler records attempt 1 through the manager",
    );
    assert.equal(clock.pendingCount(), 1, "auto-resume timer armed");

    // The #207 erasure: any later manager persist rebuilt the record from a
    // literal without the field. adoptLiveRunsToSession forces exactly such a
    // persist on the live run.
    manager.adoptLiveRunsToSession("some-other-session");
    assert.equal(
      manager.getPersistence().load(runId)?.autoResumeAttempts,
      1,
      "later manager persist keeps the counter",
    );
    scheduler.dispose();
  });
});

test("real manager restart: cold-start rearm continues the backoff via the non-live path (#207)", async () => {
  await withRealManagerCwd(async (cwd) => {
    const managerA = new WorkflowManager({ cwd, agent: quotaAgent() });
    managerA.on("error", () => {});
    const clockA = createFakeClock();
    const schedulerA = new UsageLimitScheduler(managerA, {
      now: clockA.now,
      setTimer: clockA.setTimer,
      clearTimer: clockA.clearTimer,
      ...TUNABLES,
    });
    const { runId, promise } = managerA.startInBackground(QUOTA_SCRIPT);
    await promise.catch(() => {});
    assert.equal(managerA.getPersistence().load(runId)?.autoResumeAttempts, 1);
    schedulerA.dispose();

    // Simulate a process restart: a fresh manager + scheduler over the same
    // cwd. The paused run is disk-only for manager B, so coldStartRearm's
    // persist goes through recordAutoResumeAttempts's non-live branch.
    const managerB = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          return "ok";
        },
      },
    });
    managerB.on("error", () => {});
    const updatedAtBeforeRestart = managerB.getPersistence().load(runId)?.updatedAt;
    const clockB = createFakeClock();
    const schedulerB = new UsageLimitScheduler(managerB, {
      now: clockB.now,
      setTimer: clockB.setTimer,
      clearTimer: clockB.clearTimer,
      ...TUNABLES,
    });
    await flush();

    const persistedAfter = managerB.getPersistence().load(runId);
    assert.equal(
      persistedAfter?.autoResumeAttempts,
      1,
      "a restart re-arms the already-counted attempt — it does not burn the give-up budget (audit2 #11)",
    );
    assert.equal(
      persistedAfter?.updatedAt,
      updatedAtBeforeRestart,
      "the equal-value re-persist is skipped by the real manager's non-live guard (audit2 #15, r2 R5)",
    );
    assert.equal(clockB.pendingCount(), 1, "auto-resume re-armed after restart");
    schedulerB.dispose();
  });
});

test("recordAutoResumeAttempts skips equal-value writes (audit2 #15)", async () => {
  await withRealManagerCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: quotaAgent() });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(QUOTA_SCRIPT);
    await promise.catch(() => {});
    const persisted1 = manager.getPersistence().load(runId);
    assert.ok(persisted1, "paused run persisted");
    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure a restamp would differ
    manager.recordAutoResumeAttempts(runId, persisted1?.autoResumeAttempts ?? 0);
    assert.equal(
      manager.getPersistence().load(runId)?.updatedAt,
      persisted1?.updatedAt,
      "an equal-value write is skipped entirely (updatedAt not restamped)",
    );
    const next = (persisted1?.autoResumeAttempts ?? 0) + 1;
    manager.recordAutoResumeAttempts(runId, next);
    assert.equal(manager.getPersistence().load(runId)?.autoResumeAttempts, next, "a changed value persists");
  });
});

test("cold-start rearm sanitizes a corrupt persisted attempt counter (#207)", () => {
  const manager = new FakeManager();
  manager.persistence.seed(
    makeRun({
      runId: "run-corrupt",
      status: "paused",
      pauseReason: "usage_limit",
      autoResumeAttempts: "oops" as unknown as number,
      updatedAt: new Date().toISOString(),
    }),
  );
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  assert.equal(manager.persistence.get("run-corrupt")?.autoResumeAttempts, 1, "corrupt counter restarts at attempt 1");
  assert.ok(
    clock.pendingDelays().every((d) => Number.isFinite(d)),
    "no NaN delay from a corrupt counter",
  );
  scheduler.dispose();
});

test("a live pause sanitizes a corrupt disk counter (#207)", () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ runId: "run-1", autoResumeAttempts: -2 as unknown as number }));
  const clock = createFakeClock();
  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...TUNABLES,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });

  assert.equal(manager.persistence.get("run-1")?.autoResumeAttempts, 1);
  assert.ok(clock.pendingDelays().every((d) => Number.isFinite(d)));
  scheduler.dispose();
});
