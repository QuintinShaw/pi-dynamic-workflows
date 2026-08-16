import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

type DeliveryCall = { content: string; customType?: string; triggerTurn?: boolean };
type StableSend = (
  msg: { customType?: string; content?: string; display?: boolean },
  opts?: { triggerTurn?: boolean; deliverAs?: string },
) => unknown;

type TaskPanelModule = {
  installResultDelivery: (pi: ExtensionAPI, manager: unknown, opts?: unknown) => void;
  bindSessionDelivery: (
    sessionId: string,
    pi: ExtensionAPI,
    opts?: {
      loadSettings?: () => unknown;
      manager?: unknown;
      stableSend?: StableSend;
      sessionManager?: {
        getSessionId?: () => string;
        appendCustomMessageEntry?: (
          customType: string,
          content: string | unknown[],
          display: boolean,
          details?: unknown,
        ) => string;
      };
    },
  ) => void;
  dropSessionDelivery: (sessionId: string | undefined) => void;
  suspendResultDelivery: (manager: unknown) => void;
  resumeResultDelivery: (manager: unknown) => void;
  suspendSessionDelivery: (sessionId: string | undefined) => void;
  resumeSessionDelivery: (sessionId: string | undefined, manager?: unknown) => void;
  installTaskPanel: (pi: ExtensionAPI | null, manager: unknown, ui: unknown) => void;
  _resetDeliveryRegistriesForTests: () => void;
  _registerBoundSessionSendForTests: (sessionId: string, send: StableSend) => void;
  _hasBoundSessionSendForTests: (sessionId: string) => boolean;
  _getSessionDeliveryEndpointForTests: (
    sessionId: string,
  ) => { suspended: boolean; generation: number; hasSend: boolean; hasAppend: boolean } | undefined;
};

// Loaded once before all tests
let mod: TaskPanelModule;

before(async () => {
  mod = (await import("../src/task-panel.js")) as TaskPanelModule;
});

// ─── Session-routed background result delivery ─────────────────────────────────

describe("installResultDelivery", () => {
  const SESSION = "sess-test";

  beforeEach(() => {
    mod._resetDeliveryRegistriesForTests();
  });

  function createMockManager(run?: Record<string, unknown>, runsDir?: string) {
    let sessionId: string | undefined = SESSION;
    const runs = new Map<string, Record<string, unknown>>();
    if (run) runs.set(String(run.runId ?? "test-run-1"), run);

    const disk = new Map<string, Record<string, unknown>>();

    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (id: string) => unknown;
      getPersistence?: () => {
        getRunsDir: () => string;
        load: (id: string) => Record<string, unknown> | null;
        save: (state: Record<string, unknown>) => void;
        list: () => Record<string, unknown>[];
      };
      getSessionId: () => string | undefined;
      setSessionId: (id: string | undefined) => void;
      adoptLiveRunsToSession: (newId: string | undefined, previousSessionId?: string) => number;
      listLiveRuns: () => unknown[];
      __deliveryInstalled?: boolean;
      listRuns?: () => unknown[];
    };
    manager.getRun = (id: string) => runs.get(id);
    manager.getSessionId = () => sessionId;
    manager.setSessionId = (id) => {
      sessionId = id;
    };
    manager.adoptLiveRunsToSession = (newId, previousSessionId) => {
      if (!newId) return 0;
      const prev = previousSessionId !== undefined ? previousSessionId : sessionId;
      let adopted = 0;
      for (const managed of runs.values()) {
        const status = managed.status as string | undefined;
        const active = status === "running" || status === "paused";
        const undelivered = managed.pendingDelivery != null;
        if (!active && !undelivered) continue;
        if (managed.sessionId === newId) continue;
        managed.sessionId = newId;
        const existing = disk.get(String(managed.runId));
        if (existing) disk.set(String(existing.runId), { ...existing, sessionId: newId });
        adopted++;
      }
      for (const state of [...disk.values()]) {
        if (!state.pendingDelivery) continue;
        if (runs.has(String(state.runId))) continue;
        if (state.sessionId === newId) continue;
        if (prev == null || state.sessionId !== prev) continue;
        disk.set(String(state.runId), { ...state, sessionId: newId });
        adopted++;
      }
      return adopted;
    };
    manager.listLiveRuns = () => [...runs.values()];
    manager.getPersistence = () => ({
      getRunsDir: () => runsDir ?? "/runs",
      load: (id: string) => disk.get(id) ?? null,
      save: (state: Record<string, unknown>) => {
        disk.set(String(state.runId), { ...state });
        const live = runs.get(String(state.runId));
        if (live && "pendingDelivery" in state) {
          live.pendingDelivery = state.pendingDelivery;
        }
      },
      list: () => [...disk.values()],
    });
    return manager;
  }

  function createMockPi(): ExtensionAPI & { _calls: DeliveryCall[] } {
    const calls: DeliveryCall[] = [];
    const obj = {
      sendMessage(msg: unknown, _opts?: unknown) {
        calls.push({
          content: (msg as { content?: string }).content ?? "",
          customType: (msg as { customType?: string }).customType,
        });
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
      _calls: calls,
    };
    return obj as unknown as ExtensionAPI & { _calls: DeliveryCall[] };
  }

  /** Session-stable thenable send that records like the old sendMessage spy. */
  function recordingStableSend(pi: { _calls: DeliveryCall[] }): StableSend {
    return (msg, opts) => {
      pi._calls.push({
        content: msg.content ?? "",
        customType: msg.customType,
        triggerTurn: opts?.triggerTurn,
      });
      return Promise.resolve();
    };
  }

  /** Drive the armed AgentSession._bindExtensionCore patch with a fake `this`. */
  function invokePatchedBindCore(session: object): void {
    const bind = (AgentSession.prototype as unknown as { _bindExtensionCore: (runner: unknown) => unknown })
      ._bindExtensionCore;
    bind.call(session, { bindCore() {} });
  }

  function piCalls(pi: ExtensionAPI): DeliveryCall[] {
    return (pi as unknown as { _calls: DeliveryCall[] })._calls;
  }

  function makeRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: "test-run-1",
      background: true,
      sessionId: SESSION,
      snapshot: {
        name: "test-workflow",
        agentCount: 3,
        agents: [
          { id: "a1", status: "done", step: "agent 1", phase: "phase-1" },
          { id: "a2", status: "done", step: "agent 2", phase: "phase-1" },
          { id: "a3", status: "done", step: "agent 3", phase: "phase-2" },
        ],
        phases: [{ title: "phase-1" }, { title: "phase-2" }],
        currentPhase: "phase-2",
        startedAt: new Date(),
        completedAt: new Date(),
      },
      result: {
        agentCount: 3,
        durationMs: 1500,
        tokenUsage: { total: 50000, input: 25000, output: 25000 },
        result: { verdict: "## All tests passed\n\nEverything looks good!" },
      },
      ...overrides,
    };
  }

  function setup(
    pi: ExtensionAPI,
    manager: ReturnType<typeof createMockManager>,
    sessionId = SESSION,
    bindOpts: { stableSend?: StableSend; loadSettings?: () => unknown } = {},
  ) {
    mod.installResultDelivery(pi, manager, bindOpts.loadSettings ? { loadSettings: bindOpts.loadSettings } : undefined);
    manager.setSessionId(sessionId);
    const stableSend = bindOpts.stableSend ?? recordingStableSend(pi as unknown as { _calls: DeliveryCall[] });
    mod.bindSessionDelivery(sessionId, pi, { manager, ...bindOpts, stableSend });
  }

  // ── deliverText: verdict path ──

  it("delivers verdict when result.result has verdict", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].customType, "workflow-result");
    assert.ok(calls[0].content.includes("All tests passed"), "should contain All tests passed");
    assert.ok(calls[0].content.includes("test-workflow"), "should contain test-workflow");
    assert.ok(calls[0].content.includes("3 agents"), "should contain 3 agents");
    // deliverText shows "N tok"; the cached segment is omitted with no cache reads.
    assert.ok(calls[0].content.includes("50.0K tok"), "should show the token count (input+output)");
    assert.ok(!calls[0].content.includes("cached"), "omits the cached segment when cacheRead is 0");
    assert.ok(calls[0].content.includes("1.5s"), "should contain 1.5s");
  });

  it("shows the fresh/cache split and cost in the delivery line", () => {
    const pi = createMockPi();
    // A caching model: little fresh input+output, most of the tokens are cheap cache reads.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 2,
          durationMs: 1000,
          tokenUsage: { input: 80000, output: 20000, total: 6100000, cacheRead: 6000000, cacheWrite: 0, cost: 6.7 },
          result: { verdict: "done" },
        },
      }),
    );

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(content.includes("100.0K tok"), `fresh (input+output) should read as tok; got: ${content}`);
    assert.ok(content.includes("6.0M cached"), `cacheRead should read as cached; got: ${content}`);
    assert.ok(content.includes("$6.70"), `cost should be shown; got: ${content}`);
  });

  it("falls back to the estimated total when the provider reported no usage (#57 regression)", () => {
    const pi = createMockPi();
    // Estimate-only run: onUsage never fired, so the breakdown is all-zero while
    // run-level `total` carries the scalar estimate.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 2,
          durationMs: 1000,
          tokenUsage: { input: 0, output: 0, total: 800, cacheRead: 0, cacheWrite: 0, cost: 0 },
          result: { verdict: "done" },
        },
      }),
    );

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(content.includes("800 tok"), `the estimate should survive as the token count; got: ${content}`);
    assert.ok(!/\b0 tok/.test(content), `must not render a zero breakdown; got: ${content}`);
  });

  it("suppresses the token segment when the run-level aggregate is all-zero (#57 regression)", () => {
    const pi = createMockPi();
    // e.g. a fully journal-replayed resume: every agent came from cache, nothing accrued.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 3,
          durationMs: 1500,
          tokenUsage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          result: { verdict: "done" },
        },
      }),
    );

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(!/\b0 tok/.test(content), `an all-zero aggregate must not render "0 tok"; got: ${content}`);
    assert.ok(content.includes("3 agents"), "the rest of the line is intact");
  });

  // ── deliverText: fallback chain ──

  it("falls back to report when verdict is absent", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { report: "Report body", verdict: "" } } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes("Report body"), "should contain Report body");
  });

  it("falls back to summary when verdict and report are absent", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { summary: "Short summary" } } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes("Short summary"), "should contain Short summary");
  });

  it("falls back to string result when result is a plain string", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: "Plain string result" } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes("Plain string result"), "should contain Plain string result");
  });

  it("falls back to synthesis when present", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { synthesis: "Synth body" } } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes("Synth body"), "should contain Synth body");
  });

  it("JSON-dumps object results without preferred fields", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { ok: true, n: 2 } } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes('"ok": true'), "should dump JSON");
  });

  it("truncates long JSON dumps and appends the result pointer", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { note: "z".repeat(500) } } });
    const manager = createMockManager(run, "/runs");

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(content.includes("truncated"), "long dump is truncated");
    assert.ok(content.includes(join("/runs", "test-run-1.json")), "pointer still appended");
  });

  it("honours deliveredResultMaxChars from settings", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { note: "z".repeat(200) } } });
    const manager = createMockManager(run, "/runs");

    setup(pi as unknown as ExtensionAPI, manager, SESSION, {
      loadSettings: () => ({ deliveredResultMaxChars: 40 }),
    });
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(content.includes("truncated"), "settings threshold is applied");
    assert.ok(!content.includes("z".repeat(200)), "the body is cut at the configured threshold");
    assert.ok(content.includes(join("/runs", "test-run-1.json")), "pointer still appended");
  });

  // ── installResultDelivery: guard / session routing ──

  it("installs delivery only once — second call skips listener registration", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    // Second call: should not add another listener
    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);

    manager.emit("complete", { runId: "test-run-1" });
    const calls = piCalls(pi);
    assert.equal(calls.length, 1); // exactly once, not twice
  });

  it("does not crash when sendMessage throws (stale ctx); queues and flushes on rebind", async () => {
    const stalePi = {
      sendMessage: (_msg: unknown, _opts?: unknown) => {
        throw new Error("This extension ctx is stale");
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const freshPi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(stalePi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, stalePi as unknown as ExtensionAPI, {
      manager,
      stableSend: () => {
        throw new Error("This extension ctx is stale");
      },
    });
    // Must not throw — the failed send leaves disk/memory pending.
    manager.emit("complete", { runId: "test-run-1" });
    // Sync throw still ACKs via a rejected/false thenable; wait out in-flight.
    await Promise.resolve();
    await Promise.resolve();

    // Factory-time install only refreshes; session_start rebinds + flushes.
    mod.installResultDelivery(freshPi as unknown as ExtensionAPI, manager);
    assert.equal(piCalls(freshPi).length, 0, "install alone must not flush — runtime may still be unbound");
    mod.bindSessionDelivery(SESSION, freshPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(freshPi),
    });
    const calls = piCalls(freshPi);
    assert.equal(calls.length, 1, "rebind must flush onto the fresh pi");
    assert.ok(calls[0].content.includes("test-workflow"));
  });

  it("suspends live sends and flushes the queue when the next generation binds", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi1, manager);
    mod.suspendResultDelivery(manager);
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(pi1).length, 0, "suspended delivery must not call the dying pi");

    mod.installResultDelivery(pi2 as unknown as ExtensionAPI, manager);
    assert.equal(piCalls(pi2).length, 0, "install alone must not flush before runtime bind");
    mod.bindSessionDelivery(SESSION, pi2 as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi2),
    });
    const calls = piCalls(pi2);
    assert.equal(calls.length, 1, "bind must deliver pending completion into the new session");
    assert.ok(calls[0].content.includes("All tests passed"));
  });

  it("re-queues an async sendMessage rejection and flushes it on the next bind", async () => {
    let rejectSend: ((err: Error) => void) | undefined;
    const failingPi = {
      sendMessage: (_msg: unknown, _opts?: unknown) =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const freshPi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(failingPi as unknown as ExtensionAPI, manager, SESSION, {
      stableSend: () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    });
    manager.emit("complete", { runId: "test-run-1" });
    assert.ok(rejectSend, "stableSend should have returned a pending promise");
    rejectSend?.(new Error("network blip"));
    // Let the rejection microtask run and re-queue.
    await Promise.resolve();
    await Promise.resolve();

    mod.bindSessionDelivery(SESSION, freshPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(freshPi),
    });
    const calls = piCalls(freshPi);
    assert.equal(calls.length, 1, "async failure must be retried on the fresh pi after rebind");
  });

  it("flushes immediately when an in-flight send rejects AFTER the next generation bound", async () => {
    // The real race: generation N's promise is still pending when generation
    // N+1 binds and flushes (empty queue). N's rejection must not leave the
    // content stranded until some later N+2 bind.
    let rejectSend: ((err: Error) => void) | undefined;
    const failingPi = {
      sendMessage: (_msg: unknown, _opts?: unknown) =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const freshPi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(failingPi as unknown as ExtensionAPI, manager, SESSION, {
      stableSend: () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    });
    manager.emit("complete", { runId: "test-run-1" });
    assert.ok(rejectSend);

    // Next generation binds BEFORE the rejection lands.
    mod.bindSessionDelivery(SESSION, freshPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(freshPi),
    });
    assert.equal(piCalls(freshPi).length, 0, "nothing queued yet — the in-flight send has not rejected");

    rejectSend?.(new Error("late network blip"));
    await Promise.resolve();
    await Promise.resolve();

    const calls = piCalls(freshPi);
    assert.equal(calls.length, 1, "late rejection must self-flush onto the already-bound generation");
    assert.ok(calls[0].content.includes("test-workflow"));
  });

  it("never silently drops pending deliveries when the queue grows past the soft cap", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    // Distinct run ids so each complete has its own pending marker.
    const runs = Array.from({ length: 40 }, (_, i) =>
      makeRun({ runId: `run-${i}`, result: { result: { verdict: `v-${i}` }, agentCount: 1, durationMs: 1 } }),
    );
    const manager = createMockManager(runs[0]);
    // Inject all runs into getRun/listLiveRuns
    const byId = new Map(runs.map((r) => [r.runId as string, r]));
    manager.getRun = (id: string) => byId.get(id);
    manager.listLiveRuns = () => [...byId.values()];

    setup(pi1, manager);
    mod.suspendResultDelivery(manager);
    for (const r of runs) {
      manager.emit("complete", { runId: r.runId });
    }

    mod.bindSessionDelivery(SESSION, pi2 as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi2),
    });
    const calls = piCalls(pi2);
    assert.equal(calls.length, 40, "soft-cap must warn, never shift() away a queued result");
  });

  it("keeps delivery suspended across factory install until bindSessionDelivery", () => {
    const unboundPi = {
      sendMessage: () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const boundPi = createMockPi();
    const manager = createMockManager(makeRun());

    // Simulate extension factory: install only (no endpoint yet — fail closed).
    mod.installResultDelivery(unboundPi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });
    // Re-install as a fresh factory would (still pre-bindCore).
    mod.installResultDelivery(unboundPi as unknown as ExtensionAPI, manager);
    assert.equal(piCalls(boundPi).length, 0, "must not attempt send while runtime unbound");

    // session_start: bind the session endpoint with the live pi.
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, boundPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(boundPi),
    });
    const calls = piCalls(boundPi);
    assert.equal(calls.length, 1, "session_start bind flushes the pre-bind disk pending");
  });

  // ── Only background runs are delivered ──

  it("skips delivery for foreground runs (background=false)", () => {
    const pi = createMockPi();
    const run = makeRun({ background: false });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.equal(calls.length, 0);
  });

  // ── Error event ──

  it("delivers error message on error event for background runs", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("error", { runId: "test-run-1", error: { message: "Something went wrong" } });

    const calls = piCalls(pi);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("failed"), "should contain failed");
    assert.ok(calls[0].content.includes("Something went wrong"), "should contain Something went wrong");
  });

  it("skips error delivery for foreground runs", () => {
    const pi = createMockPi();
    const run = makeRun({ background: false });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("error", { runId: "test-run-1", error: { message: "fail" } });

    const calls = piCalls(pi);
    assert.equal(calls.length, 0);
  });

  // ── Paused (usage-limit checkpoint) event ──

  it("delivers a resumable checkpoint message on a usage-limit paused event", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("paused", {
      runId: "test-run-1",
      reason: "usage_limit",
      error: { message: "Codex usage limit reached (plus plan)." },
      resetHint: "Resets in ~3h",
    });

    const calls = piCalls(pi);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("paused"), "should say paused");
    assert.ok(calls[0].content.includes("/workflows resume test-run-1"), "should name the resume command");
    assert.ok(calls[0].content.includes("Resets in ~3h"), "should include the reset hint");
    assert.ok(!calls[0].content.includes("failed"), "should not say failed");
  });

  it("ignores a manual pause (no reason) — no delivery", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("paused", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.equal(calls.length, 0);
  });

  it("skips usage-limit pause delivery for foreground runs", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ background: false }));

    setup(pi, manager);
    manager.emit("paused", { runId: "test-run-1", reason: "usage_limit", error: { message: "usage limit" } });

    const calls = piCalls(pi);
    assert.equal(calls.length, 0);
  });

  // ── Session routing (#147) ──

  it("session_start shape: steal map send without bind stableSend delivers + triggerTurn", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    // Production session_start never passes stableSend — only the steal map.
    mod._registerBoundSessionSendForTests(SESSION, recordingStableSend(pi));
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, { manager });

    manager.emit("complete", { runId: "test-run-1" });
    const calls = piCalls(pi);
    assert.equal(calls.length, 1, "stolen send is the production ACK path");
    assert.equal(calls[0].triggerTurn, true, "host sendCustomMessage must triggerTurn");
    assert.ok(calls[0].content.includes("All tests passed"));
  });

  it("parallel sessions: last bindCore must not steal the other session's send", () => {
    const piA = createMockPi();
    const piB = createMockPi();
    const managerA = createMockManager(makeRun({ sessionId: "sess-A", runId: "run-A" }));
    const managerB = createMockManager(
      makeRun({
        sessionId: "sess-B",
        runId: "run-B",
        result: { result: { verdict: "from-B" }, agentCount: 1, durationMs: 1 },
      }),
    );
    managerA.setSessionId("sess-A");
    managerB.setSessionId("sess-B");

    // Two host-shaped bindCores, B last — steal map must stay per-session.
    invokePatchedBindCore({
      sessionManager: {
        persist: true,
        getSessionId: () => "sess-A",
        getSessionName: () => "host-A",
      },
      _resourceLoader: { noExtensions: false },
      sendCustomMessage: recordingStableSend(piA),
    });
    invokePatchedBindCore({
      sessionManager: {
        persist: true,
        getSessionId: () => "sess-B",
        getSessionName: () => "host-B",
      },
      _resourceLoader: { noExtensions: false },
      sendCustomMessage: recordingStableSend(piB),
    });

    mod.installResultDelivery(piA as unknown as ExtensionAPI, managerA);
    // No stableSend — same as production session_start.
    mod.bindSessionDelivery("sess-A", piA as unknown as ExtensionAPI, { manager: managerA });
    mod.installResultDelivery(piB as unknown as ExtensionAPI, managerB);
    mod.bindSessionDelivery("sess-B", piB as unknown as ExtensionAPI, { manager: managerB });

    managerA.emit("complete", { runId: "run-A" });

    assert.equal(piCalls(piA).length, 1, "origin A receives");
    assert.equal(piCalls(piB).length, 0, "sibling B must not receive A's result");
    assert.ok(piCalls(piA)[0].content.includes("All tests passed"));

    managerB.emit("complete", { runId: "run-B" });
    assert.equal(piCalls(piA).length, 1, "A must not receive B's result");
    assert.equal(piCalls(piB).length, 1, "origin B receives its own result");
    assert.ok(piCalls(piB)[0].content.includes("from-B"));
  });

  it("steal map pins only the host session; drop releases the host closure", () => {
    invokePatchedBindCore({
      sessionManager: {
        persist: false,
        getSessionId: () => "child-mem",
        getSessionName: () => "",
      },
      sendCustomMessage: async () => {},
    });
    invokePatchedBindCore({
      sessionManager: {
        persist: true,
        getSessionId: () => "child-noext",
        getSessionName: () => "",
      },
      _resourceLoader: { noExtensions: true },
      sendCustomMessage: async () => {},
    });
    invokePatchedBindCore({
      sessionManager: {
        persist: true,
        getSessionId: () => "child-named",
        getSessionName: () => "workflow:run-1 agent",
      },
      sendCustomMessage: async () => {},
    });
    invokePatchedBindCore({
      sessionManager: {
        persist: true,
        getSessionId: () => "host-1",
        getSessionName: () => "chat",
      },
      _resourceLoader: { noExtensions: false },
      sendCustomMessage: async () => {},
    });

    assert.equal(mod._hasBoundSessionSendForTests("child-mem"), false, "in-memory child must not pin");
    assert.equal(mod._hasBoundSessionSendForTests("child-noext"), false, "noExtensions child must not pin");
    assert.equal(mod._hasBoundSessionSendForTests("child-named"), false, "workflow: child must not pin");
    assert.equal(mod._hasBoundSessionSendForTests("host-1"), true, "host session is stolen");

    mod.dropSessionDelivery("host-1");
    assert.equal(mod._hasBoundSessionSendForTests("host-1"), false, "drop releases the host send closure");
  });

  it("append-only is not an ACK; pending stays until a thenable send exists", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const appended: string[] = [];

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, {
      manager,
      sessionManager: {
        getSessionId: () => SESSION,
        appendCustomMessageEntry: (_customType, content) => {
          appended.push(typeof content === "string" ? content : JSON.stringify(content));
          return "entry";
        },
      },
    });
    manager.emit("complete", { runId: "test-run-1" });

    assert.equal(piCalls(pi).length, 0, "never fall back to pi.sendMessage");
    assert.equal(appended.length, 0, "append must not be treated as delivery");
    assert.ok(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, "pending stays on disk");
    assert.equal(mod._getSessionDeliveryEndpointForTests(SESSION)?.hasSend, false);
  });

  it("no endpoint → disk pending; later session_start bind flushes", async () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    // No bindSessionDelivery yet.
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(pi).length, 0, "fail closed without endpoint");

    const disk = manager.getPersistence?.().load("test-run-1");
    assert.ok(disk?.pendingDelivery, "pending marker persisted to disk");

    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi),
    });
    assert.equal(piCalls(pi).length, 1, "bind flushes disk pending");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, undefined, "cleared after flush");
  });

  it("bind without stableSend stays fail-closed and keeps pending", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    // Registered fail-closed: steal map empty, no stableSend (and append is not ACK).
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "test-run-1" });

    assert.equal(piCalls(pi).length, 0, "no stableSend → never fall back to pi.sendMessage");
    assert.ok(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, "pending stays on disk");
  });

  it("suspended endpoint never sends", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    setup(pi, manager);
    mod.suspendSessionDelivery(SESSION);
    assert.equal(mod._getSessionDeliveryEndpointForTests(SESSION)?.suspended, true);

    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(pi).length, 0);
  });

  it("sessionId mismatch never sends to the wrong endpoint", () => {
    const piA = createMockPi();
    const piB = createMockPi();
    // Run belongs to A, but only B is bound.
    const manager = createMockManager(makeRun({ sessionId: "sess-A" }));
    manager.setSessionId("sess-B");
    mod.installResultDelivery(piB as unknown as ExtensionAPI, manager);
    mod.bindSessionDelivery("sess-B", piB as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(piB),
    });

    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(piB).length, 0, "B must not get A's run");
    assert.equal(piCalls(piA).length, 0);

    // Later A binds and receives the pending delivery.
    mod.bindSessionDelivery("sess-A", piA as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(piA),
    });
    assert.equal(piCalls(piA).length, 1, "origin A flushes pending");
  });

  it("#143 suspend/resume still delivers after replacement bind", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi1, manager);
    // session_shutdown
    mod.suspendResultDelivery(manager);
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(pi1).length, 0);

    // New generation session_start: adopt then rebind (do not poke run.sessionId).
    const newSession = "sess-replaced";
    const previous = manager.getSessionId();
    if (typeof manager.adoptLiveRunsToSession === "function") {
      manager.adoptLiveRunsToSession(newSession, previous);
    }
    manager.setSessionId(newSession);
    mod.bindSessionDelivery(newSession, pi2 as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi2),
    });

    assert.equal(piCalls(pi2).length, 1, "replacement session receives pending");
    assert.equal(piCalls(pi1).length, 0, "old session stays silent");
  });

  // ── Holder refresh on re-call ──

  it("rebinds send on bindSessionDelivery for stale ctx recovery", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi1, manager);
    // Re-bind with second pi (fresh after reload)
    mod.bindSessionDelivery(SESSION, pi2 as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi2),
    });

    manager.emit("complete", { runId: "test-run-1" });

    assert.equal(piCalls(pi1).length, 0, "pi1 should not be used after rebind");
    assert.equal(piCalls(pi2).length, 1, "pi2 should receive the delivery");
  });

  it("refreshes the live delivery settings loader across reload generations", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun({ result: { result: { note: "z".repeat(200) } } }));

    mod.installResultDelivery(pi1 as unknown as ExtensionAPI, manager, {
      loadSettings: () => ({ deliveredResultMaxChars: 400 }),
    });
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi1 as unknown as ExtensionAPI, {
      manager,
      loadSettings: () => ({ deliveredResultMaxChars: 400 }),
      stableSend: recordingStableSend(pi1),
    });
    mod.bindSessionDelivery(SESSION, pi2 as unknown as ExtensionAPI, {
      manager,
      loadSettings: () => ({ deliveredResultMaxChars: 40 }),
      stableSend: recordingStableSend(pi2),
    });
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi2)[0]?.content ?? "";
    assert.match(content, /truncated/, "the reused listener reads settings from the fresh generation");
  });
});

// ─── installTaskPanel ─────────────────────────────────────────────────────────

describe("installTaskPanel", () => {
  it("registers a widget named workflow-tasks with belowEditor placement", () => {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (...args: unknown[]) => unknown;
      listRuns: () => unknown[];
    };
    manager.getRun = () => null;
    manager.listRuns = () => [];

    let registeredName = "";
    let registeredPlacement = "";
    const ui = {
      setWidget: (name: string, _factory: unknown, opts: { placement?: string }) => {
        registeredName = name;
        registeredPlacement = opts.placement ?? "";
      },
    };

    mod.installTaskPanel(null, manager, ui);
    assert.equal(registeredName, "workflow-tasks");
    assert.equal(registeredPlacement, "belowEditor");
  });

  it("passes the render width through to the task panel", () => {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (...args: unknown[]) => unknown;
      listRuns: () => unknown[];
    };
    manager.getRun = () => undefined;
    manager.listRuns = () => [
      {
        runId: "a",
        workflowName: "handle_gh_issues_11_12_with_a_long_suffix",
        status: "running",
        agents: [{ status: "done" }, { status: "running" }],
        logs: [],
      },
    ];

    let factory:
      | ((
          tui: { requestRender(): void },
          theme: { fg(color: string, text: string): string; bold(text: string): string },
        ) => { render(width: number): string[] })
      | undefined;
    const ui = {
      setWidget: (_name: string, registeredFactory: typeof factory) => {
        factory = registeredFactory;
      },
    };
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

    mod.installTaskPanel(null, manager, ui);
    const component = factory?.({ requestRender: () => {} }, theme);
    const lines = component?.render(24) ?? [];

    assert.ok(lines.length > 0, "panel should render active runs");
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 24, `line exceeds width: ${visibleWidth(line)} > 24`);
    }
  });
});

describe("renderPanel", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  it("hints that finished runs are kept in /workflows history", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const manager = {
      listRuns: () => [
        { runId: "a", workflowName: "live", status: "running", agents: [{ status: "done" }], logs: [] },
        { runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] },
        { runId: "c", workflowName: "older", status: "aborted", agents: [], logs: [] },
      ],
      getRun: () => undefined,
    };
    const lines = renderPanel(manager as never, theme as never);
    assert.ok(
      lines.some((l) => /2 finished kept in history/.test(l)),
      "hint should report the finished-run count",
    );
    assert.ok(
      lines.some((l) => l.includes("/workflows")),
      "hint should point at /workflows",
    );
  });

  it("renders nothing when no run is active", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const manager = {
      listRuns: () => [{ runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] }],
      getRun: () => undefined,
    };
    assert.deepEqual(renderPanel(manager as never, theme as never), []);
  });

  it("truncates every rendered line to the requested visible width", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const ansiTheme = {
      fg: (_c: string, t: string) => `\x1b[2m${t}\x1b[22m`,
      bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
    };
    const manager = {
      listRuns: () => [
        {
          runId: "a",
          workflowName: "handle_gh_issues_11_12_中文_🙂_very_long_workflow_name",
          status: "running",
          agents: [{ status: "done" }, { status: "running" }],
          logs: [],
        },
        { runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] },
      ],
      getRun: () => ({
        snapshot: {
          currentPhase: "Issue implementation phase with a very long suffix",
          agents: [{ status: "done" }, { status: "running" }],
        },
      }),
    };

    const lines = renderPanel(manager as never, ansiTheme as never, 42);

    assert.ok(lines.length > 0, "panel should render active runs");
    assert.ok(
      lines.some((line) => line.includes("...")),
      "at least one line should be truncated",
    );
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds width: ${visibleWidth(line)} > 42`);
    }
  });
});

// ─── token/s rolling-window math ────────────────────────────────────────────────

describe("token rate", () => {
  it("returns 0 with fewer than two samples and after clearing", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("rate-a");
    assert.equal(tokensPerSecond("rate-a"), 0);
    sampleTokens("rate-a", 100, 1000);
    assert.equal(tokensPerSecond("rate-a"), 0);
    sampleTokens("rate-a", 1100, 2000);
    assert.equal(tokensPerSecond("rate-a"), 1000, "1000 tokens over 1s = 1000 tok/s");
    clearTokenSamples("rate-a");
    assert.equal(tokensPerSecond("rate-a"), 0, "cleared samples reset the rate");
  });

  it("computes the rate over the oldest-to-newest window", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("rate-b");
    sampleTokens("rate-b", 0, 1000);
    sampleTokens("rate-b", 1000, 2000);
    sampleTokens("rate-b", 1500, 3000);
    // (1500 - 0) tokens over (3000 - 1000) ms = 750 tok/s
    assert.equal(tokensPerSecond("rate-b"), 750);
  });

  it("decays to 0 when the total plateaus (stall detection)", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("rate-c");
    sampleTokens("rate-c", 0, 0);
    sampleTokens("rate-c", 1000, 1000);
    assert.equal(tokensPerSecond("rate-c"), 1000);
    // A stall: same total sampled > 10s later ages out the growth window → 0 tok/s.
    sampleTokens("rate-c", 1000, 12000);
    assert.equal(tokensPerSecond("rate-c"), 0, "stalled agent shows 0 tok/s");
  });
});

// ─── detailed progress panel ─────────────────────────────────────────────────────

describe("renderPanelDetailed", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  // `blueTokens` drives the first agent's live token count; the run aggregate and
  // token/s are summed from per-agent tokens (the run-level tokenUsage aggregate is
  // not live — see renderPanelDetailed), so growing blueTokens grows the rate.
  function detailedManager(blueTokens: number, status = "running") {
    const snapshot = {
      name: "auth_audit",
      phases: ["Scan", "Review"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 1,
          label: "discover_routes",
          status: "done",
          phase: "Scan",
          tokens: blueTokens,
          model: "anthropic/claude-haiku-4-5",
        },
        { id: 2, label: "audit_auth", status: "running", phase: "Scan", tokens: 1800 },
        { id: 3, label: "scan_middleware", status: "queued", phase: "Scan" },
        { id: 4, label: "cross_check", status: "queued", phase: "Review" },
      ],
      // Only `cost` is read from the run-level aggregate (it lands when the run ends).
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0.02 },
    };
    return {
      listRuns: () => [
        { runId: "r1", workflowName: "auth_audit", status, agents: snapshot.agents, tokenUsage: snapshot.tokenUsage },
      ],
      getRun: (id: string) => (id === "r1" ? { snapshot, status } : undefined),
    };
  }

  it("renders a per-agent fresh/cache split when tokenUsage is present", async () => {
    const { renderPanelDetailed } = await import("../src/task-panel.js");
    const snapshot = {
      name: "wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 1,
          label: "cached_agent",
          status: "done",
          phase: "Scan",
          tokens: 3100000,
          // Opus-style: little fresh input+output, most of it cheap cache reads.
          tokenUsage: { input: 80000, output: 20000, total: 3100000, cacheRead: 3000000, cacheWrite: 0, cost: 0.4 },
          model: "github-copilot/claude-opus-4.8",
        },
      ],
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const manager = {
      listRuns: () => [
        {
          runId: "r2",
          workflowName: "wf",
          status: "running",
          agents: snapshot.agents,
          tokenUsage: snapshot.tokenUsage,
        },
      ],
      getRun: (id: string) => (id === "r2" ? { snapshot, status: "running" } : undefined),
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ cached_agent") && /100\.0K tok/.test(l) && /3\.0M cached/.test(l)),
      `expected a per-agent tok/cached row, got:\n${lines.join("\n")}`,
    );
  });

  it("keeps the scalar estimate for cost-only agents instead of a zero breakdown (#57 regression)", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r3");
    const snapshot = {
      name: "wf3",
      phases: ["P"],
      currentPhase: "P",
      logs: [],
      agents: [
        {
          id: 1,
          label: "cost_only",
          status: "done",
          phase: "P",
          tokens: 384,
          // Provider billed cost but reported zero token counts.
          tokenUsage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
        },
      ],
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0.02 },
    };
    const manager = {
      listRuns: () => [
        {
          runId: "r3",
          workflowName: "wf3",
          status: "running",
          agents: snapshot.agents,
          tokenUsage: snapshot.tokenUsage,
        },
      ],
      getRun: (id: string) => (id === "r3" ? { snapshot, status: "running" } : undefined),
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ cost_only") && /384 tok/.test(l)),
      `cost-only agent should show its scalar estimate, got:\n${lines.join("\n")}`,
    );
    // The run header guard must agree with the value it gates (no "0 tok" beside a real cost).
    assert.ok(
      lines.some((l) => /wf3/.test(l) && /384 tok/.test(l) && /\$0\.02/.test(l)),
      `run header should show the estimate and the cost, got:\n${lines.join("\n")}`,
    );
    assert.ok(!lines.some((l) => /\b0 tok/.test(l)), `no zero breakdown anywhere:\n${lines.join("\n")}`);
  });

  it("renders aggregate tokens, cost, phases, and per-agent rows", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    // discover_routes 2100 + audit_auth 1800 = 3900 → "3.9K tok" aggregate.
    const lines = renderPanelDetailed(detailedManager(2100) as never, theme as never, undefined, 8, 1000);
    const text = lines.join("\n");

    assert.ok(/auth_audit/.test(text), "shows the run name");
    assert.ok(/1\/4 agents/.test(text), "shows done/total agents");
    assert.ok(/3\.9K tok/.test(text), "shows aggregate tokens summed from per-agent tokens");
    assert.ok(/\$0\.02/.test(text), "shows cost");
    // Phase headers
    assert.ok(
      lines.some((l) => l.includes("▶ Scan") && /1\/3 agents/.test(l) && /3\.9K tok/.test(l)),
      "Scan phase header with subtotal",
    );
    assert.ok(
      lines.some((l) => l.includes("Review") && /0\/1 agents/.test(l)),
      "Review phase header",
    );
    // Agent rows: status icons + label + tokens + model
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ discover_routes") && /2\.1K tok/.test(l) && /claude-haiku-4-5/.test(l)),
      "done agent row with model",
    );
    assert.ok(
      lines.some((l) => l.includes("[2] ● audit_auth") && /1\.8K tok/.test(l)),
      "running agent row",
    );
    assert.ok(
      lines.some((l) => l.includes("[3] ○ scan_middleware")),
      "queued agent row",
    );
  });

  it("shows a live token/s after two growing samples", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    // aggregate goes 3900 → 5900 over 1s = 2000 tok/s
    renderPanelDetailed(detailedManager(2100) as never, theme as never, undefined, 8, 1000);
    const lines = renderPanelDetailed(detailedManager(4100) as never, theme as never, undefined, 8, 2000);
    assert.ok(
      lines.some((l) => /2000 tok\/s/.test(l)),
      `expected a tok/s readout, got:\n${lines.join("\n")}`,
    );
  });

  it("caps agents per phase and reports the overflow", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    const lines = renderPanelDetailed(detailedManager(12400) as never, theme as never, undefined, 2, 1000);
    const text = lines.join("\n");
    // Scan has 3 agents, cap 2 → most recent 2 shown + "… 1 earlier agents"
    assert.ok(/… 1 earlier agents/.test(text), "overflow line present");
    assert.ok(!/discover_routes/.test(text), "oldest agent hidden when capped");
    assert.ok(/audit_auth/.test(text) && /scan_middleware/.test(text), "most recent agents shown");
  });

  it("suppresses tok/s for paused runs", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    renderPanelDetailed(detailedManager(1000, "paused") as never, theme as never, undefined, 8, 1000);
    const lines = renderPanelDetailed(detailedManager(3000, "paused") as never, theme as never, undefined, 8, 2000);
    assert.ok(!lines.some((l) => /tok\/s/.test(l)), "paused run shows no token rate");
  });
});

// ─── mode selection in installTaskPanel ───────────────────────────────────────────

describe("installTaskPanel mode selection", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  function activeManager() {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (id: string) => unknown;
      listRuns: () => unknown[];
    };
    const snapshot = {
      name: "wf",
      phases: ["P1"],
      currentPhase: "P1",
      logs: [],
      agents: [{ id: 1, label: "a", status: "running", phase: "P1", tokens: 500 }],
      tokenUsage: { total: 500, input: 250, output: 250 },
    };
    manager.listRuns = () => [
      { runId: "r1", workflowName: "wf", status: "running", agents: snapshot.agents, tokenUsage: snapshot.tokenUsage },
    ];
    manager.getRun = (id: string) => (id === "r1" ? { snapshot, status: "running" } : undefined);
    return manager;
  }

  function captureRender(loadSettings?: () => Record<string, unknown>) {
    const manager = activeManager();
    let factory:
      | ((tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[]; dispose?(): void })
      | undefined;
    const ui = {
      setWidget: (_n: string, f: typeof factory) => {
        factory = f;
      },
    };
    mod.installTaskPanel(null, manager as never, ui as never, { loadSettings } as never);
    const comp = factory?.({ requestRender: () => {} }, theme);
    const lines = comp?.render(120) ?? [];
    comp?.dispose?.();
    return lines;
  }

  it("uses compact rendering when no loadSettings is provided", () => {
    const lines = captureRender();
    assert.ok(
      lines.some((l) => /1 agents/.test(l)),
      "compact one-liner",
    );
    assert.ok(!lines.some((l) => /▶ P1/.test(l)), "no per-phase detail in compact");
  });

  it("uses compact rendering when the mode is compact", () => {
    const lines = captureRender(() => ({ progressPanelMode: "compact" }));
    assert.ok(!lines.some((l) => /▶ P1/.test(l)), "no per-phase detail in compact");
  });

  it("uses detailed rendering when the mode is detailed", () => {
    const lines = captureRender(() => ({ progressPanelMode: "detailed" }));
    assert.ok(
      lines.some((l) => /▶ P1/.test(l)),
      "per-phase detail in detailed mode",
    );
    assert.ok(
      lines.some((l) => /\[1\] ● a/.test(l)),
      "per-agent row in detailed mode",
    );
  });
});

// ─── deliverText: pointer + truncation threshold ─────────────────────────────────

describe("deliverText", () => {
  function makeResult(result: unknown) {
    return { snapshot: { name: "wf", agentCount: 1 }, result: { agentCount: 1, result } };
  }

  it("appends the Full result pointer to a verdict result without altering it", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    // A verdict longer than the default cap must still pass through in full: the
    // verdict branch is never subject to the JSON-dump truncation.
    const verdict = "V".repeat(600);
    const text = deliverText(makeResult({ verdict }) as never, { resultPath: "/r/x.json" });
    assert.ok(text.includes(verdict), "long verdict passed through in full");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer appended");
    assert.ok(!/truncated/.test(text), "verdict branch bypasses truncation");
  });

  it("does not append a pointer when no resultPath is given", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    const text = deliverText(makeResult("plain string") as never);
    assert.ok(text.includes("plain string"), "string result passed through");
    assert.ok(!text.includes("Full result:"), "no pointer without a resultPath");
  });

  it("leaves a small JSON dump untouched (no truncation marker)", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    const text = deliverText(makeResult({ ok: true, changed: 2 }) as never, { resultPath: "/r/x.json" });
    assert.ok(text.includes('"ok": true'), "full JSON shown");
    assert.ok(!/truncated/.test(text), "no truncation under the threshold");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer still appended");
  });

  it("truncates the JSON dump at maxChars and reports the dropped size", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    const text = deliverText(makeResult({ note: "x".repeat(500) }) as never, {
      resultPath: "/r/x.json",
      maxChars: 100,
    });
    assert.ok(/…\(truncated [\d.]+ (B|KB|MB)\)/.test(text), "size hint present");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer still appended");
    // Body is capped near maxChars, so the 500-char tail is not delivered in full.
    assert.ok(!text.includes("x".repeat(500)), "the full tail is not inlined");
  });

  it("defaults the JSON-dump threshold to 400 chars", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    // JSON length is note length + 16, so 380 → 396 (under 400) and 390 → 406 (over),
    // bracketing the default threshold tightly around 400.
    const under = deliverText(makeResult({ note: "y".repeat(380) }) as never);
    assert.ok(!/truncated/.test(under), "a 396-char dump is under the default 400");
    const over = deliverText(makeResult({ note: "y".repeat(390) }) as never);
    assert.ok(/…\(truncated/.test(over), "a 406-char dump exceeds the default 400");
  });
});
