import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentUsage,
  agentUsageEquals,
  createAgentCallUsageTracker,
  createEmptyAgentUsage,
  sumAgentUsage,
} from "../src/agent-usage.js";

const FIRST_USAGE = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18, cost: 0.1 };
const SECOND_USAGE = { input: 4, output: 3, cacheRead: 1, cacheWrite: 0, total: 8, cost: 0.04 };

test("agent usage arithmetic sums complete records without mutating inputs", () => {
  assert.deepEqual(sumAgentUsage(FIRST_USAGE, SECOND_USAGE), {
    input: 14,
    output: 8,
    cacheRead: 3,
    cacheWrite: 1,
    total: 26,
    cost: 0.14,
  });
  assert.deepEqual(FIRST_USAGE, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18, cost: 0.1 });
});

test("agent call usage tracker reconciles provisional estimates to exact terminal usage", () => {
  const updates: Array<{ tokenUsage: AgentUsage; committedUsage?: AgentUsage }> = [];
  const tracker = createAgentCallUsageTracker((update) => updates.push(update));
  const attempt = tracker.startAttempt();

  attempt.reportProgress({ ...createEmptyAgentUsage(), output: 10, total: 10 });
  const exactUsage = { ...createEmptyAgentUsage(), input: 4, output: 3, total: 7, cost: 0.2 };
  attempt.reportTerminal(exactUsage);
  assert.deepEqual(attempt.commitWithFallback(99), { tokens: 7, tokenUsage: exactUsage });
  attempt.reportProgress({ ...createEmptyAgentUsage(), output: 100, total: 100 });

  assert.deepEqual(updates, [
    { tokenUsage: { ...createEmptyAgentUsage(), output: 10, total: 10 } },
    { tokenUsage: { ...createEmptyAgentUsage(), input: 4, output: 3, total: 7, cost: 0.2 } },
    {
      tokenUsage: { ...createEmptyAgentUsage(), input: 4, output: 3, total: 7, cost: 0.2 },
      committedUsage: { ...createEmptyAgentUsage(), input: 4, output: 3, total: 7, cost: 0.2 },
    },
  ]);
});

test("agent call usage tracker accumulates retries and exposes each committed delta", () => {
  const updates: Array<{ tokenUsage: AgentUsage; committedUsage?: AgentUsage }> = [];
  const tracker = createAgentCallUsageTracker((update) => updates.push(update));

  const firstAttempt = tracker.startAttempt();
  const firstTerminal = { ...createEmptyAgentUsage(), output: 40, total: 40 };
  firstAttempt.reportTerminal(firstTerminal);
  assert.deepEqual(firstAttempt.commitWithFallback(1), { tokens: 40, tokenUsage: firstTerminal });

  const secondAttempt = tracker.startAttempt();
  secondAttempt.reportProgress({ ...createEmptyAgentUsage(), output: 30, total: 30 });
  const secondTerminal = { ...createEmptyAgentUsage(), output: 25, total: 25 };
  secondAttempt.reportTerminal(secondTerminal);
  assert.deepEqual(secondAttempt.commitWithFallback(1), {
    tokens: 65,
    tokenUsage: { ...createEmptyAgentUsage(), output: 65, total: 65 },
  });

  assert.deepEqual(
    updates.filter((update) => update.committedUsage).map((update) => update.committedUsage?.total),
    [40, 25],
  );
  assert.equal(updates.at(-1)?.tokenUsage.total, 65);
});

test("agent call usage tracker aborts estimates but commits cost-only terminal usage", () => {
  const updates: Array<{ tokenUsage: AgentUsage; committedUsage?: AgentUsage }> = [];
  const tracker = createAgentCallUsageTracker((update) => updates.push(update));

  const estimatedAttempt = tracker.startAttempt();
  estimatedAttempt.reportProgress({ ...createEmptyAgentUsage(), output: 10, total: 10 });
  assert.deepEqual(estimatedAttempt.commitTerminalUsage(), { tokens: 0 });
  estimatedAttempt.reportTerminal({ ...createEmptyAgentUsage(), output: 20, total: 20 });

  const costOnlyAttempt = tracker.startAttempt();
  costOnlyAttempt.reportTerminal({ ...createEmptyAgentUsage(), cost: 0.5 });
  assert.deepEqual(costOnlyAttempt.commitTerminalUsage(), {
    tokens: 0,
    tokenUsage: { ...createEmptyAgentUsage(), cost: 0.5 },
  });

  assert.deepEqual(
    updates.filter((update) => update.committedUsage).map((update) => update.committedUsage),
    [{ ...createEmptyAgentUsage(), cost: 0.5 }],
  );
  assert.deepEqual(updates.at(-1)?.tokenUsage, { ...createEmptyAgentUsage(), cost: 0.5 });
});

test("agent usage equality compares every accounting field", () => {
  assert.equal(agentUsageEquals(FIRST_USAGE, { ...FIRST_USAGE }), true);
  assert.equal(agentUsageEquals(FIRST_USAGE, { ...FIRST_USAGE, cacheRead: 3 }), false);
});
