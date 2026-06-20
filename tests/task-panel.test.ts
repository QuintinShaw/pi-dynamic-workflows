import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

type TaskPanelModule = {
  installResultDelivery: (pi: ExtensionAPI, manager: unknown) => void;
  installTaskPanel: (pi: ExtensionAPI | null, manager: unknown, ui: unknown) => void;
};

// Loaded once before all tests
let mod: TaskPanelModule;

before(async () => {
  mod = (await import("../src/task-panel.js")) as TaskPanelModule;
});

// ─── Pure-function tests (tested indirectly via installResultDelivery) ─────────

describe("installResultDelivery", () => {
  function createMockManager(run?: unknown) {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (...args: unknown[]) => unknown;
      __deliveryInstalled?: boolean;
      listRuns?: () => unknown[];
    };
    manager.getRun = () => run;
    return manager;
  }

  function createMockPi(): ExtensionAPI & { _calls: { content: string; customType?: string }[] } {
    const calls: { content: string; customType?: string }[] = [];
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
    return obj as unknown as ExtensionAPI & { _calls: { content: string; customType?: string }[] };
  }

  function makeRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: "test-run-1",
      background: true,
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

  // ── deliverText: verdict path ──

  it("delivers verdict when result.result has verdict", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].customType, "workflow-result");
    assert.ok(calls[0].content.includes("All tests passed"), "should contain All tests passed");
    assert.ok(calls[0].content.includes("test-workflow"), "should contain test-workflow");
    assert.ok(calls[0].content.includes("3 agents"), "should contain 3 agents");
    // locale may format the group separator as ',' / '.' / ' ' / none
    assert.ok(/50[\s,.]?000/.test(calls[0].content), "should contain 50000 tokens formatted");
    assert.ok(calls[0].content.includes("1.5s"), "should contain 1.5s");
  });

  // ── deliverText: fallback chain ──

  it("falls back to report when verdict is absent", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { report: "Report body", verdict: "" } } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.ok(calls[0].content.includes("Report body"), "should contain Report body");
  });

  it("falls back to summary when verdict and report are absent", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { summary: "Short summary" } } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.ok(calls[0].content.includes("Short summary"), "should contain Short summary");
  });

  it("falls back to string result when result is a plain string", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: "Plain string result" } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.ok(calls[0].content.includes("Plain string result"), "should contain Plain string result");
  });

  it("falls back to truncated JSON when result is an object with no known key", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { foo: "x".repeat(500), bar: "y".repeat(500) } } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.ok(calls[0].content.includes("foo"), "should contain foo");
    assert.ok(calls[0].content.includes("…(truncated)"), "should contain …(truncated)");
  });

  it("falls back gracefully when result is nullish", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: undefined } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    // Should not crash; should still deliver a message
    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("null"), "should contain null for undefined result");
  });

  // ── installResultDelivery: guard / stale ctx ──

  it("installs delivery only once — second call skips listener registration", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    // Second call: should only refresh holder.pi, not add another listener
    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);

    manager.emit("complete", { runId: "test-run-1" });
    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1); // exactly once, not twice
  });

  it("does not crash when sendMessage throws (stale ctx after reload)", () => {
    const pi = {
      sendMessage: (_msg: unknown, _opts?: unknown) => {
        throw new Error("This extension ctx is stale");
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    // Should not throw — stale ctx is silently swallowed
    manager.emit("complete", { runId: "test-run-1" });
    assert.ok(true, "should not throw"); // reached without crash
  });

  // ── Only background runs are delivered ──

  it("skips delivery for foreground runs (background=false)", () => {
    const pi = createMockPi();
    const run = makeRun({ background: false });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0);
  });

  // ── Error event ──

  it("delivers error message on error event for background runs", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("error", { runId: "test-run-1", error: { message: "Something went wrong" } });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("failed"), "should contain failed");
    assert.ok(calls[0].content.includes("Something went wrong"), "should contain Something went wrong");
  });

  it("skips error delivery for foreground runs", () => {
    const pi = createMockPi();
    const run = makeRun({ background: false });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("error", { runId: "test-run-1", error: { message: "fail" } });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0);
  });

  // ── Paused (usage-limit checkpoint) event ──

  it("delivers a resumable checkpoint message on a usage-limit paused event", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("paused", {
      runId: "test-run-1",
      reason: "usage_limit",
      error: { message: "Codex usage limit reached (plus plan)." },
      resetHint: "Resets in ~3h",
    });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("paused"), "should say paused");
    assert.ok(calls[0].content.includes("/workflows resume test-run-1"), "should name the resume command");
    assert.ok(calls[0].content.includes("Resets in ~3h"), "should include the reset hint");
    assert.ok(!calls[0].content.includes("failed"), "should not say failed");
  });

  it("ignores a manual pause (no reason) — no delivery", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("paused", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0);
  });

  it("skips usage-limit pause delivery for foreground runs", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ background: false }));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("paused", { runId: "test-run-1", reason: "usage_limit", error: { message: "usage limit" } });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0);
  });

  // ── Holder refresh on re-call ──

  it("refreshes holder.pi on second call for stale ctx recovery", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun());

    // Install with first pi
    mod.installResultDelivery(pi1 as unknown as ExtensionAPI, manager);
    // Re-call with second pi (fresh after reload)
    mod.installResultDelivery(pi2 as unknown as ExtensionAPI, manager);

    manager.emit("complete", { runId: "test-run-1" });

    const calls1 = (pi1 as unknown as { _calls: { content: string }[] })._calls;
    const calls2 = (pi2 as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls1.length, 0, "pi1 should not be used after refresh");
    assert.equal(calls2.length, 1, "pi2 should receive the delivery");
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
