import assert from "node:assert/strict";
import test from "node:test";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  pauseVersionMismatchWorkflowRuntime,
  takeWorkflowRuntime,
  WORKFLOW_EXTENSION_VERSION,
  type WorkflowReloadRuntime,
} from "../src/extension-reload.js";

function runtime(cwd: string): WorkflowReloadRuntime {
  return {
    cwd,
    extensionVersion: WORKFLOW_EXTENSION_VERSION,
    manager: { marker: cwd } as unknown as WorkflowReloadRuntime["manager"],
    effort: { level: "high" },
  };
}

test("reload handoff transfers the exact live runtime once", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-once`;
  const value = runtime(cwd);
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value);
  assert.equal(takeWorkflowRuntime(cwd), value);
  assert.equal(takeWorkflowRuntime(cwd), undefined, "a second extension generation cannot claim it twice");
});

test("a changed package version is rejected and its live runs are paused for recovery", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-version`;
  const paused: string[] = [];
  const value: WorkflowReloadRuntime = {
    ...runtime(cwd),
    extensionVersion: `${WORKFLOW_EXTENSION_VERSION}-next`,
    manager: {
      listRuns: () => [
        { runId: "running-1", status: "running" },
        { runId: "paused-1", status: "paused" },
        { runId: "done-1", status: "completed" },
      ],
      pause: (runId: string) => {
        paused.push(runId);
        return true;
      },
    } as unknown as WorkflowReloadRuntime["manager"],
  };
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value);
  const claim = claimWorkflowRuntime(cwd);

  assert.equal(claim.compatible, undefined);
  assert.ok(claim.versionMismatch);
  assert.equal(claim.versionMismatch, value);
  assert.equal(pauseVersionMismatchWorkflowRuntime(claim.versionMismatch), 1);
  assert.deepEqual(paused, ["running-1"]);
});

test("reload handoffs are isolated by cwd and identity-guarded on cleanup", () => {
  const cwdA = `/tmp/reload-handoff-${process.pid}-a`;
  const cwdB = `/tmp/reload-handoff-${process.pid}-b`;
  const first = runtime(cwdA);
  const replacement = runtime(cwdA);
  const other = runtime(cwdB);
  discardWorkflowRuntime(cwdA);
  discardWorkflowRuntime(cwdB);

  handoffWorkflowRuntime(first);
  handoffWorkflowRuntime(replacement);
  handoffWorkflowRuntime(other);
  discardWorkflowRuntime(cwdA, first);

  assert.equal(takeWorkflowRuntime(cwdA), replacement, "stale cleanup cannot delete a newer generation");
  assert.equal(takeWorkflowRuntime(cwdB), other);
});
