import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRegistry } from "../src/agent-registry.js";
import { runWorkflow } from "../src/workflow.js";

// Fake agents return a schema-shaped object when a schema is requested.
const yesAgent = {
  async run(_p: string, o: { schema?: unknown }) {
    return o?.schema ? { real: true } : "ok";
  },
};

test("verify(): parallel reviewers + threshold → real", async () => {
  const script = `export const meta = { name: 'v', description: 'verify' }
const r = await verify('the sky is blue', { reviewers: 3 })
return r`;
  const res = await runWorkflow<{ real: boolean; total: number }>(script, { agent: yesAgent, persistLogs: false });
  assert.equal(res.result.real, true);
  assert.equal(res.result.total, 3, "all three reviewers voted");
});

test("verify(): below threshold → not real", async () => {
  // 1 yes / 2 no with threshold 0.75 → not real.
  let n = 0;
  const mixed = {
    async run(_p: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      n++;
      return { real: n === 1 };
    },
  };
  const script = `export const meta = { name: 'v', description: 'verify' }
return await verify('claim', { reviewers: 3, threshold: 0.75 })`;
  const res = await runWorkflow<{ real: boolean; realCount: number }>(script, { agent: mixed, persistLogs: false });
  assert.equal(res.result.realCount, 1);
  assert.equal(res.result.real, false);
});

test("judgePanel(): picks the highest-mean-score attempt", async () => {
  const scorer = {
    async run(p: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      return { score: /WIN/.test(p) ? 0.9 : 0.1 };
    },
  };
  const script = `export const meta = { name: 'j', description: 'judge' }
const r = await judgePanel(['lose one', 'WIN candidate', 'lose two'], { judges: 2 })
return { index: r.index, score: r.score }`;
  const res = await runWorkflow<{ index: number; score: number }>(script, { agent: scorer, persistLogs: false });
  assert.equal(res.result.index, 1, "the WIN candidate wins");
});

test("quality helpers forward tier/model/agentType routing to every created agent", async () => {
  const calls: Array<{
    model?: string;
    tier?: string;
    toolNames?: string[];
    instructions?: string;
  }> = [];
  const recorder = {
    async run(_prompt: string, options: any) {
      calls.push({
        model: options.model,
        tier: options.tier,
        toolNames: options.toolNames,
        instructions: options.instructions,
      });
      const properties = options.schema?.properties ?? {};
      if ("real" in properties) return { real: true, reason: "ok" };
      if ("score" in properties) return { score: 0.8, reason: "ok" };
      return { complete: true, missing: [] };
    },
  };
  const registry: AgentRegistry = new Map([
    [
      "safe-verifier",
      {
        name: "safe-verifier",
        tools: ["read", "ext:pi-web-access/web_search"],
        prompt: "Use the safe verifier policy.",
        source: "project",
      },
    ],
  ]);
  const script = `export const meta = { name: 'quality_routing', description: 'route helper agents' }
const verified = await verify('claim', { reviewers: 2, tier: 'medium', model: 'vendor/verifier', agentType: 'safe-verifier' })
const judged = await judgePanel(['candidate'], { judges: 1, tier: 'big', model: 'vendor/judge', agentType: 'safe-verifier' })
const complete = await completenessCheck({ task: 1 }, [verified, judged], { tier: 'medium', model: 'vendor/critic', agentType: 'safe-verifier' })
return { verified, judged, complete }`;

  await runWorkflow(script, { agent: recorder, agentRegistry: registry, persistLogs: false });

  assert.equal(calls.length, 4, "two reviewers, one judge, and one completeness critic");
  assert.deepEqual(
    calls.map((call) => call.model),
    ["vendor/verifier", "vendor/verifier", "vendor/judge", "vendor/critic"],
  );
  assert.deepEqual(
    calls.map((call) => call.tier),
    ["medium", "medium", "big", "medium"],
  );
  for (const call of calls) {
    assert.deepEqual(call.toolNames, ["read", "ext:pi-web-access/web_search"]);
    assert.match(call.instructions ?? "", /safe verifier policy/i, "agentType role prompt should be bound");
  }
});

test("loopUntilDry(): dedupes by key and stops after K empty rounds", async () => {
  const script = `export const meta = { name: 'l', description: 'loop' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [1, 2]
    if (r === 1) return [2, 3]
    return []
  },
  consecutiveEmpty: 2,
})
return out`;
  const res = await runWorkflow<number[]>(script, { agent: yesAgent, persistLogs: false });
  assert.deepEqual([...res.result], [1, 2, 3], "deduped union across rounds");
});

test("loopUntilDry(): returns partial results when a round hits the budget", async () => {
  const script = `export const meta = { name: 'lp', description: 'loop partial' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [1]
    throw { code: 'TOKEN_BUDGET_EXHAUSTED' }
  },
})
return out`;
  const res = await runWorkflow<number[]>(script, { agent: yesAgent, persistLogs: false });
  assert.deepEqual([...res.result], [1], "partial result returned, not an abort");
});

test("completenessCheck(): returns the critic's structured verdict", async () => {
  const critic = {
    async run(_p: string, o: { schema?: unknown }) {
      return o?.schema ? { complete: false, missing: ["x"] } : "ok";
    },
  };
  const script = `export const meta = { name: 'c', description: 'critic' }
return await completenessCheck({ task: 1 }, [{ done: true }])`;
  const res = await runWorkflow<{ complete: boolean; missing: string[] }>(script, {
    agent: critic,
    persistLogs: false,
  });
  assert.equal(res.result.complete, false);
  assert.deepEqual([...res.result.missing], ["x"]);
});

test("retry(): stops when until() is satisfied, else returns the last after exhausting", async () => {
  const script = `export const meta = { name: 'r', description: 'retry' }
let n = 0
const ok = await retry(() => { n++; return n }, { until: (r) => r >= 2, attempts: 5 })
let m = 0
const ex = await retry(() => { m++; return m }, { until: (r) => r > 99, attempts: 3 })
return { ok, n, ex, m }`;
  const res = await runWorkflow<{ ok: number; n: number; ex: number; m: number }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.equal(res.result.ok, 2, "stopped as soon as until() held");
  assert.equal(res.result.n, 2);
  assert.equal(res.result.ex, 3, "returned the last result after exhausting attempts");
  assert.equal(res.result.m, 3);
});

test("gate(): passes the validator and feeds feedback into the next attempt", async () => {
  const script = `export const meta = { name: 'g', description: 'gate' }
const seen = []
const res = await gate(
  (feedback, i) => { seen.push(feedback ?? 'none'); return i },
  (r) => (r >= 1 ? { ok: true } : { ok: false, feedback: 'try higher' }),
  { attempts: 3 },
)
return { ok: res.ok, value: res.value, attempts: res.attempts, seen }`;
  const res = await runWorkflow<{ ok: boolean; value: number; attempts: number; seen: string[] }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.value, 1);
  assert.equal(res.result.attempts, 2);
  assert.deepEqual([...res.result.seen], ["none", "try higher"], "validator feedback is fed into the next attempt");
});
