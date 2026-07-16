import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentThinkingLevel } from "../src/agent.js";

test("explicit effort wins over model suffix and inherited session thinking", () => {
  assert.equal(resolveAgentThinkingLevel("minimal", "xhigh", "high"), "minimal");
  assert.equal(resolveAgentThinkingLevel("off", "max", "high"), "off");
  assert.equal(resolveAgentThinkingLevel("max", undefined, "low"), "max");
});

test("model suffix wins over inherited session thinking when effort is omitted", () => {
  assert.equal(resolveAgentThinkingLevel(undefined, "xhigh", "low"), "xhigh");
  assert.equal(resolveAgentThinkingLevel(undefined, undefined, "medium"), "medium");
  assert.equal(resolveAgentThinkingLevel(undefined, undefined, undefined), undefined);
});
