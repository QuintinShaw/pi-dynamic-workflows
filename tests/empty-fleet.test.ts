import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyFleetSummary, type WorkflowAgentSnapshot } from "../src/display.js";
import { WorkflowErrorCode } from "../src/errors.js";

function agent(overrides: Partial<WorkflowAgentSnapshot>): WorkflowAgentSnapshot {
  return { id: 1, label: "a", prompt: "p", status: "done", ...overrides };
}

describe("emptyFleetSummary", () => {
  it("flags a run where every agent errored (recoverable null) as an empty fleet", () => {
    const summary = emptyFleetSummary([
      agent({ id: 1, label: "ch2", status: "error", errorCode: WorkflowErrorCode.AGENT_EMPTY_OUTPUT }),
      agent({ id: 2, label: "ch3", status: "error", errorCode: WorkflowErrorCode.AGENT_EMPTY_OUTPUT }),
    ]);
    assert.equal(summary.allEmpty, true);
    assert.equal(summary.emptyCount, 2);
    assert.equal(summary.doneCount, 0);
    assert.deepEqual(summary.emptyLabels, ["ch2", "ch3"]);
  });

  it("does NOT flag when at least one agent produced a result", () => {
    const summary = emptyFleetSummary([
      agent({ id: 1, label: "ch2", status: "error" }),
      agent({ id: 2, label: "ch3", status: "done", result: "real output" }),
    ]);
    assert.equal(summary.allEmpty, false);
    assert.equal(summary.emptyCount, 1);
    assert.equal(summary.doneCount, 1);
  });

  it("does NOT flag a run that launched no agents (nothing was attempted)", () => {
    const summary = emptyFleetSummary([]);
    assert.equal(summary.allEmpty, false);
    assert.equal(summary.emptyCount, 0);
    assert.equal(summary.doneCount, 0);
  });

  it("ignores agents that are still queued or running when deciding", () => {
    const summary = emptyFleetSummary([
      agent({ id: 1, label: "running", status: "running" }),
      agent({ id: 2, label: "queued", status: "queued" }),
    ]);
    // No terminal agents yet: nothing has succeeded or failed, so don't cry wolf.
    assert.equal(summary.allEmpty, false);
    assert.equal(summary.emptyCount, 0);
  });

  it("does NOT flag a run whose agents were only skipped (nothing executed or failed)", () => {
    const summary = emptyFleetSummary([
      agent({ id: 1, label: "skipped-a", status: "skipped" }),
      agent({ id: 2, label: "skipped-b", status: "skipped" }),
    ]);
    assert.equal(summary.allEmpty, false);
    assert.equal(summary.emptyCount, 0);
    assert.equal(summary.doneCount, 0);
  });

  it("caps the returned labels and falls back to an id for an unlabeled agent", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      agent({ id: i + 1, label: i === 3 ? "" : `a${i + 1}`, status: "error" }),
    );
    const summary = emptyFleetSummary(agents, 5);
    assert.equal(summary.allEmpty, true);
    assert.equal(summary.emptyCount, 8);
    assert.equal(summary.emptyLabels.length, 5);
    // Agent #4 had an empty label; fall back to its id.
    assert.ok(summary.emptyLabels.includes("agent #4"));
  });
});
