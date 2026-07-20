import assert from "node:assert/strict";
import test from "node:test";
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

test("verify(): options control lenses and successful votes form the denominator", async () => {
  const prompts: string[] = [];
  let call = 0;
  const reviewers = {
    async run(prompt: string) {
      prompts.push(prompt);
      call++;
      if (call === 3) {
        throw new Error("review unavailable");
      }
      return { real: call === 1, reason: `vote-${call}` };
    },
  };
  const script = `export const meta = { name: 'verify_contract', description: 'exact verify contract' }
return await verify('claim', { reviewers: 3, threshold: 0.5, lens: ['source', 'logic'] })`;
  const res = await runWorkflow<{
    real: boolean;
    realCount: number;
    total: number;
    votes: Array<{ real: boolean; reason: string }>;
  }>(script, { agent: reviewers, persistLogs: false });

  assert.equal(res.result.real, true, "one of two successful votes meets the inclusive 0.5 threshold");
  assert.equal(res.result.realCount, 1);
  assert.equal(res.result.total, 2, "failed reviewers are omitted from the denominator");
  assert.deepEqual(
    Array.from(res.result.votes, ({ real, reason }) => ({ real, reason })),
    [
      { real: true, reason: "vote-1" },
      { real: false, reason: "vote-2" },
    ],
  );
  assert.match(prompts[0] ?? "", /Focus lens: source/);
  assert.match(prompts[1] ?? "", /Focus lens: logic/);
  assert.match(prompts[2] ?? "", /Focus lens: source/);
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

test("judgePanel(): returns the exact winner shape, stable ties, and undefined for empty input", async () => {
  const prompts: string[] = [];
  const scorer = {
    async run(prompt: string) {
      prompts.push(prompt);
      return { score: 0.5, reason: "tie" };
    },
  };
  const script = `export const meta = { name: 'judge_contract', description: 'exact judge contract' }
const winner = await judgePanel(['first', 'second'], { judges: 2, rubric: 'source quality' })
const empty = await judgePanel([])
return { winner, empty: empty ?? null }`;
  const res = await runWorkflow<{
    winner: { index: number; attempt: string; score: number; judgments: Array<{ score: number }> };
    empty: null;
  }>(script, { agent: scorer, persistLogs: false });

  assert.equal(prompts.length, 4);
  assert.ok(prompts.every((prompt) => prompt.includes("source quality")));
  assert.equal(res.result.winner.index, 0);
  assert.equal(res.result.winner.attempt, "first");
  assert.equal(res.result.winner.score, 0.5);
  assert.equal(res.result.winner.judgments.length, 2);
  assert.equal(res.result.empty, null);
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

test("loopUntilDry(): returns indistinguishable partial data for capacity exhaustion", async () => {
  for (const code of ["TOKEN_BUDGET_EXHAUSTED", "AGENT_LIMIT_EXCEEDED"]) {
    const script = `export const meta = { name: 'loop_capacity', description: 'partial capacity result' }
return await loopUntilDry({
  round: (index) => {
    if (index === 0) return [{ id: 'alpha' }]
    throw { code: '${code}' }
  },
  maxRounds: 4,
})`;
    const res = await runWorkflow<Array<{ id: string }>>(script, { agent: yesAgent, persistLogs: false });
    assert.deepEqual(
      Array.from(res.result, ({ id }) => ({ id })),
      [{ id: "alpha" }],
    );
  }

  await assert.rejects(() =>
    runWorkflow(
      `export const meta = { name: 'loop_error', description: 'unrelated errors escape' }
return await loopUntilDry({ round: () => { throw new Error('author bug') } })`,
      { agent: yesAgent, persistLogs: false },
    ),
  );
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

test("completenessCheck(): truncates result evidence and can return null", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const critic = {
    async run(prompt: string) {
      prompts.push(prompt);
      calls++;
      if (calls === 2) {
        throw new Error("critic unavailable");
      }
      return { complete: true };
    },
  };
  const script = `export const meta = { name: 'critic_contract', description: 'exact critic contract' }
const first = await completenessCheck({ taskMarker: 'TASK-TAIL' }, { head: '${"x".repeat(4100)}', tail: 'RESULT-TAIL' })
const second = await completenessCheck({ taskMarker: 'TASK-TAIL' }, { small: true })
return { first, second }`;
  const res = await runWorkflow<{ first: { complete: boolean; missing?: string[] }; second: null }>(script, {
    agent: critic,
    persistLogs: false,
  });

  assert.equal(res.result.first.complete, true);
  assert.equal(res.result.first.missing, undefined);
  assert.equal(res.result.second, null);
  assert.match(prompts[0] ?? "", /TASK-TAIL/);
  assert.doesNotMatch(prompts[0] ?? "", /RESULT-TAIL/);
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

test("retry(): uses zero-based attempts, accepts immediately without until, and does not await until", async () => {
  const script = `export const meta = { name: 'retry_contract', description: 'exact retry contract' }
const omittedSeen = []
const omitted = await retry((attempt) => { omittedSeen.push(attempt); return attempt }, { attempts: 3 })
const syncSeen = []
const sync = await retry((attempt) => { syncSeen.push(attempt); return attempt }, { attempts: 3, until: value => value === 1 })
const asyncSeen = []
const asyncPredicate = await retry((attempt) => { asyncSeen.push(attempt); return attempt }, { attempts: 3, until: async () => false })
return { omitted, omittedSeen, sync, syncSeen, asyncPredicate, asyncSeen }`;
  const res = await runWorkflow<{
    omitted: number;
    omittedSeen: number[];
    sync: number;
    syncSeen: number[];
    asyncPredicate: number;
    asyncSeen: number[];
  }>(script, { agent: yesAgent, persistLogs: false });

  assert.equal(res.result.omitted, 0);
  assert.deepEqual([...res.result.omittedSeen], [0]);
  assert.equal(res.result.sync, 1);
  assert.deepEqual([...res.result.syncSeen], [0, 1]);
  assert.equal(res.result.asyncPredicate, 0, "a Promise is truthy because until is synchronous");
  assert.deepEqual([...res.result.asyncSeen], [0]);
});

test("gate(): passes the validator and feeds feedback into the next attempt", async () => {
  const script = `export const meta = { name: 'g', description: 'gate' }
const seen = []
const res = await gate(
  (feedback, i) => { seen.push(feedback ?? 'none'); return i },
  (r) => (r >= 1 ? { ok: true } : { ok: false, feedback: 'try higher' }),
  { attempts: 3 },
)
const legacyTruthy = await gate(() => 'legacy', () => ({ ok: 1 }), { attempts: 2 })
return { ok: res.ok, value: res.value, attempts: res.attempts, seen, legacyTruthy }`;
  const res = await runWorkflow<{
    ok: boolean;
    value: number;
    attempts: number;
    seen: string[];
    legacyTruthy: { ok: boolean; value: string; attempts: number };
  }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.value, 1);
  assert.equal(res.result.attempts, 2);
  assert.deepEqual([...res.result.seen], ["none", "try higher"], "validator feedback is fed into the next attempt");
  assert.deepEqual(
    { ...res.result.legacyTruthy },
    { ok: true, value: "legacy", attempts: 1 },
    "legacy truthy validator verdicts remain accepted",
  );
});
