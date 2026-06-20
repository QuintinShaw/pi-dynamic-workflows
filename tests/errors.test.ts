import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyProviderLimit,
  isProviderUsageLimit,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "../src/errors.js";

describe("classifyProviderLimit", () => {
  it("matches the documented provider usage/quota/rate-limit wordings", () => {
    const cases = [
      "You have hit your ChatGPT usage limit (plus plan).",
      "Codex usage limit reached (plus plan). Resets in ~3h. Current premium: 5h 100%, weekly 42%.",
      "insufficient_quota",
      "You exceeded your current quota, please check your plan and billing details.",
      "Error 429: too many requests",
      "rate limit exceeded",
      "GoUsageLimitError",
    ];
    for (const text of cases) {
      assert.equal(classifyProviderLimit(text).matched, true, `should match: ${text}`);
    }
  });

  it("does NOT match benign text or unrelated errors", () => {
    for (const text of [
      "file not found",
      "TypeError: x is not a function",
      "agent exploded",
      "overloaded_error",
      undefined,
    ]) {
      assert.equal(classifyProviderLimit(text).matched, false, `should not match: ${text}`);
    }
  });

  it("extracts the verbatim reset hint when present, undefined otherwise", () => {
    assert.equal(classifyProviderLimit("Codex usage limit reached. Resets in ~3h.").resetHint, "Resets in ~3h");
    assert.equal(
      classifyProviderLimit("usage limit reached, resets at 2026-06-20T06:00:00Z.").resetHint,
      "resets at 2026-06-20T06:00:00Z",
    );
    assert.equal(classifyProviderLimit("insufficient_quota").resetHint, undefined);
  });
});

describe("wrapError provider-limit classification", () => {
  it("classifies a thrown usage-limit Error as non-recoverable PROVIDER_USAGE_LIMIT (defense for a throwing SDK)", () => {
    const e = wrapError(new Error("Codex usage limit reached (plus plan). Resets in ~3h."), { agentLabel: "a" });
    assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal(e.recoverable, false);
    assert.equal(e.resetHint, "Resets in ~3h");
    assert.equal(e.agentLabel, "a");
  });

  it("keeps transient overloaded/5xx errors as recoverable AGENT_EXECUTION_ERROR (not a quota pause)", () => {
    const e = wrapError(new Error("overloaded_error: server is busy"));
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.recoverable, true);
  });

  it("passes an existing WorkflowError through unchanged", () => {
    const orig = new WorkflowError("nope", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
    assert.equal(wrapError(orig), orig);
  });
});

describe("isProviderUsageLimit", () => {
  it("is true only for a PROVIDER_USAGE_LIMIT WorkflowError", () => {
    assert.equal(
      isProviderUsageLimit(new WorkflowError("x", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false })),
      true,
    );
    assert.equal(isProviderUsageLimit(new WorkflowError("x", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE)), false);
    assert.equal(isProviderUsageLimit(new Error("usage limit")), false);
  });
});
