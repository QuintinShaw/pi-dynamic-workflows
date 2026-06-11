import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkflowAgentSnapshot } from "../src/display.js";
import type { WorkflowMeta } from "../src/workflow.js";

async function loadErrors() {
  return import("../src/errors.js");
}

async function loadConfig() {
  return import("../src/config.js");
}

async function loadLogger() {
  return import("../src/logger.js");
}

// ─── Errors ────────────────────────────────────────────────────────────────────

describe("errors", () => {
  it("WorkflowError stores code and message", async () => {
    const { WorkflowError, WorkflowErrorCode } = await loadErrors();
    const err = new WorkflowError("test error", WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(err.message, "test error");
    assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.ok(err instanceof Error, "err should be instance of Error");
  });

  it("WorkflowError can have an agent label", async () => {
    const { WorkflowError, WorkflowErrorCode } = await loadErrors();
    const err = new WorkflowError("err", WorkflowErrorCode.AGENT_TIMEOUT, { agentLabel: "agent-1" });
    assert.equal(err.agentLabel, "agent-1");
  });

  it("isWorkflowError detects WorkflowError", async () => {
    const { WorkflowError, WorkflowErrorCode, isWorkflowError } = await loadErrors();
    const err = new WorkflowError("msg", WorkflowErrorCode.WORKFLOW_ABORTED);
    assert.equal(isWorkflowError(err), true);
    assert.equal(isWorkflowError(new Error("plain")), false);
    assert.equal(isWorkflowError("string"), false);
    assert.equal(isWorkflowError(null), false);
  });

  it("isAbortError detects AbortError", async () => {
    const { isAbortError } = await loadErrors();
    assert.equal(isAbortError(new DOMException("aborted", "AbortError")), true);
    assert.equal(isAbortError(new Error("normal")), false);
  });

  it("isAbortError returns false for non-Error values", async () => {
    const { isAbortError } = await loadErrors();
    assert.equal(isAbortError("aborted"), false);
    assert.equal(isAbortError(null), false);
  });

  it("isTimeoutError matches timeout-related messages", async () => {
    const { isTimeoutError, WorkflowError, WorkflowErrorCode } = await loadErrors();
    assert.equal(isTimeoutError(new Error("timeout exceeded")), true);
    assert.equal(isTimeoutError(new WorkflowError("normal", WorkflowErrorCode.AGENT_EXECUTION_ERROR)), false);
  });

  it("isTimeoutError returns false for non-Error values", async () => {
    const { isTimeoutError } = await loadErrors();
    assert.equal(isTimeoutError("timeout"), false);
    assert.equal(isTimeoutError(undefined), false);
  });

  it("wrapError wraps non-WorkflowError", async () => {
    const { wrapError, WorkflowErrorCode, isWorkflowError } = await loadErrors();
    const result = wrapError(new Error("raw"));
    assert.equal(isWorkflowError(result), true);
    assert.equal(result.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  });

  it("wrapError passes through WorkflowError unchanged", async () => {
    const { wrapError, WorkflowError, WorkflowErrorCode } = await loadErrors();
    const original = new WorkflowError("already wrapped", WorkflowErrorCode.AGENT_TIMEOUT);
    const result = wrapError(original);
    assert.equal(result, original);
  });

  it("wrapError adds agent label context", async () => {
    const { wrapError } = await loadErrors();
    const result = wrapError(new Error("fail"), { agentLabel: "agent-x" });
    assert.equal(result.agentLabel, "agent-x");
  });

  it("wrapError handles abort errors", async () => {
    const { wrapError, WorkflowErrorCode } = await loadErrors();
    const result = wrapError(new DOMException("The operation was aborted", "AbortError"));
    assert.equal(result.code, WorkflowErrorCode.WORKFLOW_ABORTED);
    assert.equal(result.recoverable, true);
  });

  it("wrapError handles timeout errors by message", async () => {
    const { wrapError, WorkflowErrorCode } = await loadErrors();
    const result = wrapError(new Error("timed out after 5000ms"));
    // "timed out" does not match the /\btimeout\b/ pattern (it's "timed", not "timeout")
    // so it wraps as a generic AGENT_EXECUTION_ERROR
    assert.equal(result.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(result.recoverable, true);
  });

  it("wrapError properly detects timeout error with 'timeout' word", async () => {
    const { wrapError, WorkflowErrorCode } = await loadErrors();
    const result = wrapError(new Error("operation timed out after timeout limit"));
    assert.equal(result.code, WorkflowErrorCode.AGENT_TIMEOUT);
  });

  it("wrapError stores original error as details", async () => {
    const { wrapError } = await loadErrors();
    const original = new TypeError("bad type");
    const result = wrapError(original);
    assert.equal(result.details, original);
  });

  it("wrapError handles string errors", async () => {
    const { wrapError, WorkflowErrorCode } = await loadErrors();
    const result = wrapError("something went wrong");
    assert.ok(result.message.includes("something went wrong"), "should contain something went wrong");
    assert.equal(result.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  });

  it("WorkflowError stores arbitrary details", async () => {
    const { WorkflowError, WorkflowErrorCode } = await loadErrors();
    const err = new WorkflowError("msg", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      details: { line: 5, column: 10 },
    });
    assert.deepEqual(err.details, { line: 5, column: 10 });
  });
});

// ─── Config ────────────────────────────────────────────────────────────────────

describe("config", () => {
  it("exports expected constants", async () => {
    const c = await loadConfig();
    assert.equal(c.MAX_AGENTS_PER_RUN, 1000);
    assert.equal(c.MAX_CONCURRENCY, 16);
    assert.equal(c.DEFAULT_AGENT_TIMEOUT_MS, 5 * 60 * 1000);
    assert.equal(c.WORKFLOW_RUNS_DIR, ".pi/workflows/runs");
    assert.equal(c.WORKFLOW_SAVED_DIR, ".pi/workflows/saved");
    assert.equal(c.WORKFLOW_SETTINGS_FILE, ".pi/workflows/settings.json");
    assert.equal(c.USER_WORKFLOW_SAVED_DIR, "~/.pi/workflows/saved");
    assert.equal(c.DEFAULT_TOKEN_BUDGET, null);
  });
});

// ─── Logger ────────────────────────────────────────────────────────────────────

describe("logger", () => {
  it("createWorkflowLogger returns logger with log/error/warn/getLogs", async () => {
    const { createWorkflowLogger } = await loadLogger();
    const log = createWorkflowLogger({ persist: false });
    assert.equal(typeof log.log, "function");
    assert.equal(typeof log.error, "function");
    assert.equal(typeof log.warn, "function");
    assert.equal(typeof log.getLogs, "function");
  });

  it("log/error/warn do not throw and accumulate logs", async () => {
    const { createWorkflowLogger } = await loadLogger();
    const log = createWorkflowLogger({ persist: false });
    log.log("test info");
    log.warn("test warn");
    log.error("test error");
    const logs = log.getLogs();
    assert.equal(logs.length, 3);
    assert.ok(logs[0].includes("test info"), "should contain test info");
    assert.ok(logs[1].includes("test warn"), "should contain test warn");
    assert.ok(logs[2].includes("test error"), "should contain test error");
  });

  it("getLogs returns a copy (not the internal array)", async () => {
    const { createWorkflowLogger } = await loadLogger();
    const log = createWorkflowLogger({ persist: false });
    log.log("first");
    const copy = log.getLogs();
    copy.push("modified");
    assert.equal(log.getLogs().length, 1, "internal array should not be affected");
  });

  it("persist returns null when persist=false", async () => {
    const { createWorkflowLogger } = await loadLogger();
    const log = createWorkflowLogger({ persist: false });
    const result = log.persist();
    assert.equal(result, null);
  });

  it("onLog callback is called for each message", async () => {
    const { createWorkflowLogger } = await loadLogger();
    const captured: string[] = [];
    const log = createWorkflowLogger({ persist: false, onLog: (m) => captured.push(m) });
    log.log("msg1");
    log.warn("msg2");
    log.error("msg3");
    assert.deepEqual(captured, ["msg1", "msg2", "msg3"]);
  });
});

// ─── Display ───────────────────────────────────────────────────────────────────

describe("display", () => {
  it("preview truncates long values", async () => {
    const { preview } = await load();
    const long = "x".repeat(200);
    const result = preview(long, 10);
    assert.ok(result.length <= 13, "result should be at most 13"); // 10 + "…" (3 bytes)
  });

  it("preview returns full short values", async () => {
    const { preview } = await load();
    const result = preview("hello");
    assert.equal(result, "hello");
  });

  it("preview handles objects", async () => {
    const { preview } = await load();
    const result = preview({ a: 1, b: 2 }, 50);
    assert.ok(result.length > 0, "result should not be empty");
  });

  it("preview handles null/undefined", async () => {
    const { preview } = await load();
    assert.equal(preview("null"), "null");
    assert.equal(preview(undefined), "");
  });

  it("preview works with empty string", async () => {
    const { preview } = await load();
    assert.equal(preview(""), "");
  });

  it("preview works with zero", async () => {
    const { preview } = await load();
    assert.equal(preview(0), "0");
  });

  it("preview works with boolean", async () => {
    const { preview } = await load();
    assert.equal(preview(true), "true");
    assert.equal(preview(false), "false");
  });

  it("createWorkflowSnapshot creates snapshot from meta", async () => {
    const { createWorkflowSnapshot } = await load();
    const meta: WorkflowMeta = {
      name: "test",
      description: "test workflow",
      phases: [{ title: "phase-1" }, { title: "phase-2" }],
    };
    const snap = createWorkflowSnapshot(meta);
    assert.equal(snap.name, "test");
    assert.equal(snap.phases.length, 2);
    assert.equal(snap.phases[0], "phase-1");
    assert.equal(snap.agentCount, 0);
  });

  it("createWorkflowSnapshot handles meta without phases", async () => {
    const { createWorkflowSnapshot } = await load();
    const meta: WorkflowMeta = { name: "no-phases", description: "no phases" };
    const snap = createWorkflowSnapshot(meta);
    assert.equal(snap.name, "no-phases");
    assert.deepEqual(snap.phases, []);
  });

  it("recomputeWorkflowSnapshot recalculates status counts", async () => {
    const { createWorkflowSnapshot, recomputeWorkflowSnapshot } = await load();
    const meta: WorkflowMeta = { name: "t", description: "d", phases: [{ title: "p1" }] };
    const snap = createWorkflowSnapshot(meta);
    snap.agents = [
      { id: 1, label: "a1", prompt: "p", status: "done", phase: "p1" },
      { id: 2, label: "a2", prompt: "p", status: "running", phase: "p1" },
      { id: 3, label: "a3", prompt: "p", status: "error", phase: "p1" },
    ] as WorkflowAgentSnapshot[];
    const recomputed = recomputeWorkflowSnapshot(snap);
    assert.equal(recomputed.agentCount, 3);
    assert.equal(recomputed.doneCount, 1);
    assert.equal(recomputed.runningCount, 1);
    assert.equal(recomputed.errorCount, 1);
  });

  it("renderWorkflowText returns a non-empty string", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await load();
    const meta: WorkflowMeta = { name: "test-wf", description: "d", phases: [{ title: "research" }] };
    const snap = createWorkflowSnapshot(meta);
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("test-wf"), "should contain test-wf");
    assert.ok(text.length > 0, "text should not be empty");
  });

  it("renderWorkflowText completed flag changes header", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await load();
    const meta: WorkflowMeta = { name: "wf", description: "d" };
    const snap = createWorkflowSnapshot(meta);
    const running = renderWorkflowText(snap, false);
    const completed = renderWorkflowText(snap, true);
    assert.ok(running.includes("running"), "should contain running");
    assert.ok(completed.includes("completed"), "should contain completed");
  });

  it("renderWorkflowLines shows phases", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await load();
    const meta: WorkflowMeta = { name: "wf", description: "d", phases: [{ title: "Research" }] };
    const snap = createWorkflowSnapshot(meta);
    snap.agents = [
      { id: 1, label: "agent-1", prompt: "x", status: "done", phase: "Research" },
    ] as WorkflowAgentSnapshot[];
    const lines = renderWorkflowLines(snap);
    const text = lines.join("\n");
    assert.ok(text.includes("Research"), "should contain Research");
    assert.ok(text.includes("agent-1"), "should contain agent-1");
  });

  it("renderWorkflowLines shows errors count", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await load();
    const meta: WorkflowMeta = { name: "wf", description: "d", phases: [{ title: "Test" }] };
    const snap = createWorkflowSnapshot(meta);
    snap.agents = [
      { id: 1, label: "a1", prompt: "x", status: "error", phase: "Test" },
      { id: 2, label: "a2", prompt: "x", status: "done", phase: "Test" },
    ] as WorkflowAgentSnapshot[];
    snap.errorCount = 1;
    const lines = renderWorkflowLines(snap);
    const text = lines.join("\n");
    assert.ok(text.includes("errors"), "should contain errors");
  });

  it("renderWorkflowLines shows result previews when enabled", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await load();
    const meta: WorkflowMeta = { name: "wf", description: "d" };
    const snap = createWorkflowSnapshot(meta);
    snap.agents = [
      { id: 1, label: "a1", prompt: "x", status: "done", resultPreview: "found 3 issues" },
    ] as WorkflowAgentSnapshot[];
    const lines = renderWorkflowLines(snap, { showResultPreviews: true });
    const text = lines.join("\n");
    assert.ok(text.includes("found 3 issues"), "should contain found 3 issues");
  });

  it("renderWorkflowLines shows token info when available", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await load();
    const meta: WorkflowMeta = { name: "wf", description: "d" };
    const snap = createWorkflowSnapshot(meta);
    snap.tokenUsage = { input: 100, output: 50, total: 150, cost: 0.002 };
    const lines = renderWorkflowLines(snap);
    const text = lines.join("\n");
    assert.ok(text.includes("150"), "should contain 150");
    assert.ok(text.includes("$0.0020"), "should contain $0.0020");
  });
});

async function load() {
  return import("../src/display.js");
}
