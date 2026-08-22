import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowErrorCode } from "../src/errors.js";
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

test("judgePanel(): sparse candidates use populated entries for capacity and retain original indexes", async () => {
  const labels: string[] = [];
  const scorer = {
    async run(prompt: string) {
      return { score: /WIN/.test(prompt) ? 0.9 : 0.1 };
    },
  };
  const script = `export const meta = { name: 'sparse_judges', description: 'sparse candidates retain original indexes' }
const attempts = []
attempts[1] = 'lose'
attempts[3] = 'WIN candidate'
return await judgePanel(attempts, { judges: 2 })`;
  const result = await runWorkflow<{ index: number; attempt: string }>(script, {
    agent: scorer,
    maxAgents: 4,
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
  });

  assert.equal(result.agentCount, 4, "two populated candidates × two judges fit exactly");
  assert.equal(result.result.index, 3, "winner keeps its original sparse-array index");
  assert.equal(result.result.attempt, "WIN candidate");
  assert.deepEqual(labels, ["judge 2.1", "judge 2.2", "judge 4.1", "judge 4.2"]);
});

test("verify and judgePanel reject invalid fan-out counts before starting agents", async () => {
  const invalidCounts = ["NaN", "Infinity", "1.5", "0", "-1", "null", "true", "'2'", "{}", "1n", "Symbol('count')"];
  for (const { helper, option, makeScript } of [
    {
      helper: "verify() reviewers",
      option: "reviewers",
      makeScript: (
        count: string,
      ) => `export const meta = { name: 'invalid_verify_count', description: 'reject invalid reviewers' }
return await verify('claim', { reviewers: ${count} })`,
    },
    {
      helper: "judgePanel() judges",
      option: "judges",
      makeScript: (
        count: string,
      ) => `export const meta = { name: 'invalid_judge_count', description: 'reject invalid judges' }
return await judgePanel(['candidate'], { judges: ${count} })`,
    },
  ]) {
    for (const count of invalidCounts) {
      let starts = 0;
      await assert.rejects(
        () =>
          runWorkflow(makeScript(count), {
            agent: {
              async run() {
                starts++;
                return { real: true, score: 1 };
              },
            },
            persistLogs: false,
          }),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.match(String(error), new RegExp(`${helper.replace(/[()]/g, "\\$&")} must be a finite integer`));
          return true;
        },
      );
      assert.equal(starts, 0, `${option}=${count} must not bypass quality work`);
    }
  }
});

test("quality helpers give external abort precedence over insufficient capacity", async () => {
  for (const { helper, script, maxAgents } of [
    {
      helper: "verify",
      script: `export const meta = { name: 'abort_verify_preflight', description: 'abort beats capacity' }
return await verify('claim', { reviewers: 2 })`,
      maxAgents: 1,
    },
    {
      helper: "judgePanel",
      script: `export const meta = { name: 'abort_judge_preflight', description: 'abort beats capacity' }
return await judgePanel(['candidate'], { judges: 2 })`,
      maxAgents: 1,
    },
    {
      helper: "completenessCheck",
      script: `export const meta = { name: 'abort_complete_preflight', description: 'abort beats capacity' }
return await completenessCheck({ task: true }, { result: true })`,
      maxAgents: 0,
    },
  ]) {
    const controller = new AbortController();
    controller.abort();
    let starts = 0;
    await assert.rejects(
      () =>
        runWorkflow(script, {
          agent: {
            async run() {
              starts++;
              return { real: true, score: 1, complete: true };
            },
          },
          maxAgents,
          signal: controller.signal,
          persistLogs: false,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, WorkflowErrorCode.WORKFLOW_ABORTED);
        return true;
      },
    );
    assert.equal(starts, 0, `${helper} must not start internal agents after abort`);
  }
});

test("external abort takes precedence over invalid quality fan-out options", async () => {
  for (const script of [
    `export const meta = { name: 'abort_invalid_verify', description: 'abort beats validation' }
return await verify('claim', { reviewers: null })`,
    `export const meta = { name: 'abort_invalid_judge', description: 'abort beats validation' }
return await judgePanel(['candidate'], { judges: null })`,
  ]) {
    const controller = new AbortController();
    controller.abort();
    let starts = 0;
    await assert.rejects(
      () =>
        runWorkflow(script, {
          agent: {
            async run() {
              starts++;
              return { real: true, score: 1 };
            },
          },
          maxAgents: 0,
          signal: controller.signal,
          persistLogs: false,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, WorkflowErrorCode.WORKFLOW_ABORTED);
        assert.doesNotMatch(String(error), /finite integer/i);
        return true;
      },
    );
    assert.equal(starts, 0, "abort must prevent invalid-option helper work");
  }
});

test("quality helpers preflight their full known capacity before any helper agent starts", async () => {
  const calls: string[] = [];
  const runner = {
    async run(prompt: string, options: { schema?: unknown }) {
      calls.push(prompt);
      if (options.schema && /Score this candidate/.test(prompt)) return { score: 0.5 };
      return "prefix";
    },
  };
  const script = `export const meta = { name: 'judge_preflight', description: 'preflight known helper capacity' }
await agent('prefix')
return await judgePanel(['a', 'b'], { judges: 2 })`;

  await assert.rejects(
    () => runWorkflow(script, { agent: runner, maxAgents: 4, persistLogs: false }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
      assert.match(String(error), /judgePanel\(\).*requires 4 logical agent slots.*only 3 remain/i);
      return true;
    },
  );
  assert.deepEqual(calls, ["prefix"], "no judge starts when the entire panel cannot fit");
});

test("verify and completenessCheck preflight their documented slot counts", async () => {
  for (const { script, maxAgents, helper, slots } of [
    {
      script: `export const meta = { name: 'verify_preflight', description: 'verify capacity' }
return await verify('claim', { reviewers: 2 })`,
      maxAgents: 1,
      helper: "verify()",
      slots: 2,
    },
    {
      script: `export const meta = { name: 'complete_preflight', description: 'critic capacity' }
return await completenessCheck({ task: true }, { result: true })`,
      maxAgents: 0,
      helper: "completenessCheck()",
      slots: 1,
    },
  ]) {
    let starts = 0;
    await assert.rejects(
      () =>
        runWorkflow(script, {
          agent: {
            async run() {
              starts++;
              return { real: true, complete: true };
            },
          },
          maxAgents,
          persistLogs: false,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
        assert.match(
          String(error),
          new RegExp(`${helper.replace(/[()]/g, "\\$&")}.*requires ${slots} logical agent slot`),
        );
        return true;
      },
    );
    assert.equal(starts, 0, `${helper} must fail before starting its agent`);
  }
});

test("quality helper capacity is exact at the boundary and shared with concurrent work", async () => {
  const prompts: string[] = [];
  const runner = {
    async run(prompt: string, options: { schema?: unknown }) {
      prompts.push(prompt);
      return options.schema ? { score: 0.5 } : "outside";
    },
  };
  const script = `export const meta = { name: 'judge_boundary', description: 'shared capacity boundary' }
const results = await parallel([
  () => agent('outside'),
  () => judgePanel(['a', 'b'], { judges: 2 }),
])
return results`;
  const result = await runWorkflow(script, { agent: runner, maxAgents: 5, concurrency: 1, persistLogs: false });

  assert.equal(result.agentCount, 5);
  assert.equal(prompts.length, 5);
  assert.equal(prompts.filter((prompt) => /Score this candidate/.test(prompt)).length, 4);
});

test("quality helper capacity shares the parent run tree with nested workflows", async () => {
  const prompts: string[] = [];
  const runner = {
    async run(prompt: string, options: { schema?: unknown }) {
      prompts.push(prompt);
      return options.schema ? { score: 0.5 } : "parent";
    },
  };
  const child = `export const meta = { name: 'quality_child', description: 'child panel' }
return await judgePanel(['a', 'b'], { judges: 2 })`;
  const parent = `export const meta = { name: 'quality_parent', description: 'parent capacity' }
await agent('parent')
return await workflow('quality_child')`;

  await assert.rejects(
    () =>
      runWorkflow(parent, {
        agent: runner,
        loadSavedWorkflow: (name) => (name === "quality_child" ? child : undefined),
        maxAgents: 4,
        persistLogs: false,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
      return true;
    },
  );
  assert.deepEqual(prompts, ["parent"], "the child panel sees the parent slot reservation");
});

test("quality helper capacity remains compatible with journal resume and agent retries", async () => {
  const journal = new Map();
  const livePrompts: string[] = [];
  const runner = {
    async run(prompt: string, options: { schema?: unknown }) {
      livePrompts.push(prompt);
      if (options.schema && /Score this candidate/.test(prompt)) return { score: 0.5 };
      return "prefix";
    },
  };
  const script = `export const meta = { name: 'judge_resume', description: 'resume panel after preflight' }
const prefix = await agent('prefix')
const winner = await judgePanel(['a', 'b'], { judges: 2 })
return { prefix, winner }`;
  const runId = "quality-resume";

  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: runner,
        maxAgents: 4,
        persistLogs: false,
        runId,
        onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry),
      }),
    /judgePanel\(\).*requires 4 logical agent slots/i,
  );
  assert.deepEqual(livePrompts, ["prefix"]);

  const resumed = await runWorkflow(script, {
    agent: runner,
    maxAgents: 5,
    persistLogs: false,
    runId,
    resumeJournal: journal,
  });
  assert.equal(resumed.agentCount, 5, "replayed prefix and live judges share the raised cap");
  assert.equal(livePrompts.length, 5, "only the four judges execute after the prefix replay");

  let attempts = 0;
  const retrying = {
    async run() {
      attempts++;
      throw new Error("temporary reviewer failure");
    },
  };
  const retryScript = `export const meta = { name: 'verify_retries', description: 'logical slots ignore execution retries' }
return await verify('claim', { reviewers: 2 })`;
  const retried = await runWorkflow<{ total: number }>(retryScript, {
    agent: retrying,
    agentRetries: 1,
    maxAgents: 2,
    persistLogs: false,
  });
  assert.equal(retried.agentCount, 2, "each reviewer keeps one logical slot across execution retries");
  assert.equal(attempts, 4, "both reviewers retry once");
  assert.equal(retried.result.total, 0);
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
