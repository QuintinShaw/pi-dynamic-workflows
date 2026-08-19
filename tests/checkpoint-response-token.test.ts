import assert from "node:assert/strict";
import test from "node:test";
import {
  registerCheckpointResponse,
  releaseCheckpointResponse,
  resolveCheckpointResponse,
} from "../src/checkpoint-response-token.js";

const binding = { runId: "run-1", checkpointId: "checkpoint-1" } as const;

test("checkpoint response tokens bind an immutable JSON response to one run and checkpoint", () => {
  const response = { nested: { value: "before" } };
  const token = registerCheckpointResponse(binding, response);
  response.nested.value = "after";

  assert.match(token, /^wfcr_[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(resolveCheckpointResponse(token, binding), { nested: { value: "before" } });
  assert.throws(
    () => resolveCheckpointResponse(token, { ...binding, runId: "run-2" }),
    /invalid for this run and checkpoint/,
  );
  assert.throws(
    () => resolveCheckpointResponse(token, { ...binding, checkpointId: "checkpoint-2" }),
    /invalid for this run and checkpoint/,
  );
});

test("checkpoint response tokens release only for their exact binding", () => {
  const token = registerCheckpointResponse(binding, { ok: true });

  assert.equal(releaseCheckpointResponse(token, { ...binding, runId: "run-2" }), false);
  assert.deepEqual(resolveCheckpointResponse(token, binding), { ok: true });
  assert.equal(releaseCheckpointResponse(token, binding), true);
  assert.throws(() => resolveCheckpointResponse(token, binding), /invalid for this run and checkpoint/);
});

test("checkpoint response registration rejects non-JSON responses", () => {
  assert.throws(() => registerCheckpointResponse(binding, undefined), /JSON-serializable/);
  assert.throws(() => registerCheckpointResponse(binding, 1n), /BigInt/);
});
