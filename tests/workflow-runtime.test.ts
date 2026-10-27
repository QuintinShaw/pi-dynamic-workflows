import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunOptions, AgentUsage } from "../src/agent.js";
import type { AgentDefinition } from "../src/agent-registry.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, parseWorkflowScript, runWorkflow } from "../src/workflow.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("agent cwd is normalized before dispatch and invalid cwd does not reserve capacity", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-cwd-"));
  const linked = join(root, "linked");
  symlinkSync(root, linked);
  const seen: string[] = [];
  const runner = {
    async run(_prompt: string, options: AgentRunOptions) {
      seen.push(options.cwd ?? "");
      return "ok";
    },
  };
  try {
    const script = `export const meta = { name: 'cwd', description: 'cwd validation' }
return await agent('inspect', { cwd: ${JSON.stringify(linked)} })`;
    await runWorkflow(script, { agent: runner, persistLogs: false });
    assert.deepEqual(seen, [realpathSync(root)], "runner receives the canonical realpath");

    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'bad_cwd', description: 'bad cwd' }
await agent('never runs', { cwd: 'relative-path' })`,
          { agent: runner, persistLogs: false, maxAgents: 0 },
        ),
      /cwd must be an absolute directory/,
      "cwd validation precedes capacity reservation",
    );
    assert.equal(seen.length, 1, "invalid cwd never dispatches an agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("script agent cwd preserves a directory's significant trailing space", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-cwd-space-"));
  const target = join(root, "directory ");
  mkdirSync(join(root, "directory"));
  mkdirSync(target);
  try {
    let seen: string | undefined;
    await runWorkflow(
      `export const meta = { name: 'cwd_space', description: 'literal directory binding' }
return await agent('inspect', { cwd: ${JSON.stringify(target)} })`,
      {
        agent: {
          async run(_prompt, options) {
            seen = options?.cwd;
            return "ok";
          },
        },
        persistLogs: false,
      },
    );
    assert.equal(seen, realpathSync(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit cwd can opt out of agent-type isolation without claiming worktree ownership", async () => {
  const target = mkdtempSync(join(tmpdir(), "pi-agent-cwd-optout-"));
  const registry = new Map([
    [
      "isolated",
      {
        name: "isolated",
        prompt: "inspect",
        isolation: "worktree",
        source: "project",
      } as AgentDefinition,
    ],
  ]);
  const script = `export const meta = { name: 'cwd_optout', description: 'existing directory ownership' }
return await agent('inspect', { cwd: ${JSON.stringify(target)}, agentType: 'isolated', isolation: false })`;
  try {
    for (const fail of [false, true]) {
      const ended: Array<string | undefined> = [];
      const run = runWorkflow(script, {
        persistLogs: false,
        agentRegistry: registry,
        agent: {
          async run(_prompt, options) {
            assert.equal(options?.cwd, realpathSync(target));
            if (fail)
              throw new WorkflowError("test failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
            return "ok";
          },
        },
        onAgentEnd: (event) => ended.push(event.worktree),
      });
      if (fail) await assert.rejects(run, /test failure/);
      else await run;
      assert.deepEqual(ended, [undefined], "an existing directory is not an owned worktree");
      assert.ok(existsSync(target));
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("agent cwd cannot be combined with worktree isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-cwd-isolation-"));
  try {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'cwd_isolation', description: 'cwd and isolation' }
await agent('never runs', { cwd: ${JSON.stringify(root)}, isolation: 'worktree' })`,
          { agent: countingAgent().runner, persistLogs: false },
        ),
      /cwd cannot be combined with worktree isolation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent cwd participates in resume identity while omitted cwd preserves cache replay", async () => {
  const firstDir = mkdtempSync(join(tmpdir(), "pi-agent-cwd-first-"));
  const secondDir = mkdtempSync(join(tmpdir(), "pi-agent-cwd-second-"));
  const calls: string[] = [];
  const journal = new Map<string, JournalEntry>();
  const runner = {
    async run(_prompt: string, options: AgentRunOptions) {
      calls.push(options.cwd ?? "default");
      return `ran:${options.cwd ?? "default"}`;
    },
  };
  const script = (cwd?: string) => `export const meta = { name: 'cwd_resume', description: 'cwd resume identity' }
return await agent('inspect', { label: 'inspect'${cwd ? `, cwd: ${JSON.stringify(cwd)}` : ""} })`;
  try {
    await runWorkflow(script(), {
      agent: runner,
      persistLogs: false,
      runId: "cwd-resume",
      onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry),
    });
    await runWorkflow(script(), {
      agent: runner,
      persistLogs: false,
      runId: "cwd-resume",
      resumeJournal: journal,
    });
    assert.deepEqual(calls, ["default"], "omitted cwd retains the existing resume hash");

    await runWorkflow(script(firstDir), {
      agent: runner,
      persistLogs: false,
      runId: "cwd-resume",
      resumeJournal: journal,
    });
    await runWorkflow(script(secondDir), {
      agent: runner,
      persistLogs: false,
      runId: "cwd-resume",
      resumeJournal: journal,
    });
    assert.deepEqual(
      calls,
      ["default", realpathSync(firstDir), realpathSync(secondDir)],
      "each canonical cwd invalidates the prior journal entry",
    );
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});
function createGitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

test("runWorkflow concurrency caps parallel agents", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const started: Array<string> = [];
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(prompt);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'concurrency_cap', description: 'cap parallelism' }
const xs = await parallel(['a','b','c','d'].map((p) => () => agent(p, { label: p })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 2, "only the first two agents should start before the gate opens");
  release.resolve();
  const result = await run;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.result, ["ok:a", "ok:b", "ok:c", "ok:d"]);
  assert.equal(result.agentCount, 4);
});

test("named agent threads can be re-entered around a separate reviewer", async () => {
  const calls: Array<{ prompt: string; thread?: string }> = [];
  const result = await runWorkflow(
    `export const meta = { name: 'thread_reentry', description: 're-enter implementer' }
const first = await agent('implement', { thread: 'implementer' })
const review = await agent('review', { thread: 'reviewer' })
const second = await agent('address review', { thread: 'implementer' })
return { first, review, second }`,
    {
      agent: {
        async run(prompt, options) {
          calls.push({ prompt, thread: options?.thread });
          return `${options?.thread}:${prompt}`;
        },
      },
      persistLogs: false,
    },
  );

  assert.deepEqual(calls, [
    { prompt: "implement", thread: "implementer" },
    { prompt: "review", thread: "reviewer" },
    { prompt: "address review", thread: "implementer" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    first: "implementer:implement",
    review: "reviewer:review",
    second: "implementer:address review",
  });
});

test("concurrent calls on one named thread are rejected before a second agent starts", async () => {
  let starts = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'thread_concurrency', description: 'reject overlap' }
return await parallel([
  () => agent('first', { thread: 'implementer' }),
  () => agent('second', { thread: 'implementer' })
])`,
      {
        agent: {
          async run() {
            starts++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return "ok";
          },
        },
        persistLogs: false,
      },
    ),
    /same-thread calls must be sequential/,
  );
  assert.equal(starts, 1);
});

test("named threads reject worktree isolation", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'thread_worktree', description: 'reject worktree' }
return await agent('work', { thread: 'implementer', isolation: 'worktree' })`,
      { agent: countingAgent().runner, persistLogs: false },
    ),
    /cannot use worktree isolation/,
  );
});

test("threaded calls are live resume barriers and are not journaled", async () => {
  const firstJournal: JournalEntry[] = [];
  const first = countingAgent();
  await runWorkflow(
    `export const meta = { name: 'thread_resume', description: 'thread barrier' }
const before = await agent('before')
const threaded = await agent('threaded', { thread: 'implementer' })
const after = await agent('after')
return { before, threaded, after }`,
    {
      agent: first.runner,
      runId: "thread-run",
      persistLogs: false,
      onAgentJournal: (entry) => firstJournal.push(entry),
    },
  );
  assert.deepEqual(
    firstJournal.map((entry) => entry.index),
    [0, 2],
  );

  const resumed = countingAgent();
  await runWorkflow(
    `export const meta = { name: 'thread_resume', description: 'thread barrier' }
const before = await agent('before')
const threaded = await agent('threaded', { thread: 'implementer' })
const after = await agent('after')
return { before, threaded, after }`,
    {
      agent: resumed.runner,
      runId: "thread-run",
      persistLogs: false,
      resumeJournal: new Map(firstJournal.map((entry) => [`thread-run:${entry.index}`, entry])),
      resumeFromRunId: "thread-run",
    },
  );
  assert.equal(resumed.state.calls, 2, "the prefix replays, then the threaded call and all later calls run live");
});

test("a timed-out named turn fully settles before retrying the thread", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'thread_timeout_retry', description: 'safe retry' }
return await agent('work', { thread: 'implementer', timeoutMs: 5, retries: 1 })`,
    {
      agent: {
        async run(_prompt, options) {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          if (calls === 1) {
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }).finally(() => active--);
          } else {
            active--;
            return "ok";
          }
        },
      },
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(maxActive, 1);
});

test("runWorkflow retries recoverable empty output then succeeds", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_success', description: 'retry success' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1, "retries should not allocate extra logical agent slots");
  assert.equal(journal.length, 1, "only the final success is journaled");
});

test("runWorkflow reconciles timeout fallback with exact abort-teardown usage", { timeout: 2_500 }, async () => {
  const exactUsage: AgentUsage = {
    input: 900,
    output: 100,
    total: 1_000,
    cost: 0.5,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const result = await runWorkflow(
    `export const meta = { name: 'timeout_usage', description: 'timeout usage' }
return await agent('short prompt', { label: 'slow', timeoutMs: 5 })`,
    {
      agent: {
        async run(prompt: string, options?: AgentRunOptions) {
          void prompt;
          return new Promise((resolve, reject) => {
            void resolve;
            options?.signal?.addEventListener(
              "abort",
              () => {
                setTimeout(() => {
                  options.onUsage?.(exactUsage);
                  reject(new Error("aborted after exact usage"));
                }, 1_100);
              },
              { once: true },
            );
          });
        },
      },
      persistLogs: false,
    },
  );

  assert.equal(result.result, null);
  assert.deepEqual(result.tokenUsage, exactUsage);
});

test("runWorkflow waits for timed-out teardown before starting a retry", { timeout: 3_000 }, async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const releaseFirstAttempt = createDeferred<void>();
  const run = runWorkflow(
    `export const meta = { name: 'slow_teardown', description: 'slow timeout teardown' }
return await agent('stuck', { label: 'stuck', timeoutMs: 5, retries: 1 })`,
    {
      agent: {
        async run(prompt: string) {
          void prompt;
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            if (calls === 1) {
              await releaseFirstAttempt.promise;
              throw new Error("aborted after slow teardown");
            }
            return "retry-result";
          } finally {
            active--;
          }
        },
      },
      persistLogs: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(calls, 1, "a retry must not overlap a timed-out runner still tearing down");
  releaseFirstAttempt.resolve(undefined);
  const result = await run;

  assert.equal(result.result, "retry-result");
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test("runWorkflow returns null when recoverable retries are exhausted", async () => {
  let calls = 0;
  const logs: string[] = [];
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_exhausted', description: 'retry exhausted' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return "";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, null);
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1);
  assert.equal(journal.length, 0, "failed/null recoverable results are not journaled");
  assert.ok(
    logs.some((message) => /retrying/i.test(message)),
    "logs should mention retrying",
  );
  assert.ok(
    logs.some((message) => /exhausted/i.test(message)),
    "logs should mention exhaustion",
  );
});

test("runWorkflow does not retry nonrecoverable errors", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'no_retry_nonrecoverable', description: 'nonrecoverable' }
const a = await agent('work', { label: 'a' })
return a`,
      {
        agent: {
          async run() {
            calls++;
            throw new WorkflowError("hard stop", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
        agentRetries: 2,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(calls, 1);
});

test("per-agent retries override run-level retries", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'agent_retry_override', description: 'override' }
const a = await agent('work', { label: 'a', retries: 1 })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 0,
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
});

test("runWorkflow accumulates real per-agent usage (incl. cost + cache tokens)", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002, cacheRead: 50, cacheWrite: 10 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9, "should be within tolerance");
  assert.equal(result.tokenUsage?.cacheRead, 100, "cacheRead accumulates across agents");
  assert.equal(result.tokenUsage?.cacheWrite, 20, "cacheWrite accumulates across agents");
});

test("runWorkflow streams cumulative token usage before an agent returns", async () => {
  const release = createDeferred<void>();
  const usageEvents: number[] = [];
  const finalizedUsageEvents: number[] = [];
  let settled = false;
  const run = runWorkflow(
    `export const meta = { name: 'live_usage', description: 'live token usage' }
     return await agent('work', { label: 'worker' })`,
    {
      agent: {
        async run(prompt, options) {
          void prompt;
          options?.onUsageProgress?.({ input: 7, output: 3, total: 10, cost: 0.01, cacheRead: 0, cacheWrite: 0 });
          options?.onUsageProgress?.({ input: 17, output: 8, total: 25, cost: 0.02, cacheRead: 0, cacheWrite: 0 });
          await release.promise;
          options?.onUsage?.({ input: 12, output: 8, total: 20, cost: 0.02, cacheRead: 0, cacheWrite: 0 });
          return "done";
        },
      },
      persistLogs: false,
      onAgentUsage: (event) => usageEvents.push(event.tokenUsage.total),
      onTokenUsage: (usage) => finalizedUsageEvents.push(usage.total),
    },
  ).finally(() => {
    settled = true;
  });

  while (usageEvents.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(settled, false, "usage should be observable while the agent is still running");
  assert.deepEqual(usageEvents, [10, 25]);
  assert.deepEqual(finalizedUsageEvents, [], "progress estimates must not change finalized budget accounting");

  release.resolve();
  const result = await run;
  assert.equal(result.tokenUsage?.total, 20, "the exact terminal total must replace the progress estimate");
});

test("onAgentEnd reports cumulative settled usage across retries", async () => {
  let attempts = 0;
  let endedTokens: number | undefined;
  let endedUsage: AgentUsage | undefined;
  const result = await runWorkflow(
    `export const meta = { name: 'retry_usage', description: 'retry usage' }
     return await agent('work', { label: 'worker', retries: 1 })`,
    {
      agent: {
        async run(prompt, options) {
          void prompt;
          attempts++;
          const total = attempts === 1 ? 40 : 25;
          options?.onUsageProgress?.({ input: 0, output: 100, total: 100, cost: 0, cacheRead: 0, cacheWrite: 0 });
          options?.onUsage?.({ input: 0, output: total, total, cost: 0, cacheRead: 0, cacheWrite: 0 });
          return attempts === 1 ? "" : "done";
        },
      },
      persistLogs: false,
      onAgentEnd: (event) => {
        endedTokens = event.tokens;
        endedUsage = event.tokenUsage;
      },
    },
  );

  assert.equal(result.result, "done");
  assert.equal(attempts, 2);
  assert.equal(endedTokens, 65);
  assert.equal(endedUsage?.total, 65);
});

test("meta.model is parsed and routes as the default model for agents", async () => {
  let seenModel: string | undefined;
  const recorder = {
    async run(_p: string, o: { model?: string }) {
      seenModel = o.model;
      return "ok";
    },
  };
  const script = `export const meta = { name: 'm', description: 'd', model: 'meta/default-model' }
await agent('x', { label: 'x' })
return 1`;
  await runWorkflow(script, { agent: recorder, persistLogs: false });
  assert.equal(seenModel, "meta/default-model", "an agent with no model/tier/phase route uses meta.model");
});

test("runWorkflow preserves authoritative cost-only terminal usage", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'cost_only', description: 'cost-only provider usage' }
     return await agent('work', { label: 'worker' })`,
    {
      agent: fakeAgent({ input: 0, output: 0, total: 0, cost: 0.25, cacheRead: 0, cacheWrite: 0 }),
      persistLogs: false,
    },
  );

  assert.equal(result.tokenUsage?.total, 0);
  assert.equal(result.tokenUsage?.cost, 0.25);
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("agents default to the first declared phase when the script omits phase()", async () => {
  // Regression for the "(no phase) has agents, declared phase 0/0" bug: a script
  // that declares meta.phases but never calls phase() should still group its
  // agents under the first declared phase, not an orphan "(no phase)" bucket.
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Research' }, { title: 'Synthesize' }] }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["Research"]);
});

test("explicit phase() overrides the default first phase", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
     phase('B')
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["B"]);
});

test("no declared phases => agent phase stays undefined (no synthetic phase)", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd' }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, [undefined]);
});

test("runWorkflow routes models: explicit opts.model > phase model > default", async () => {
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; onUsage?: (u: AgentUsage) => void }) {
      seen.push(options.model);
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'routing', description: 'model routing',
    phases: [{ title: 'A', model: 'phase-a-model' }, { title: 'B' }]
  }
  phase('A')
  await agent('explicit wins', { label: 'e', model: 'explicit-model' })
  await agent('phase routed', { label: 'p' })
  phase('B')
  await agent('no model -> default', { label: 'n' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  assert.deepEqual(seen, ["explicit-model", "phase-a-model", undefined]);
});

test("runWorkflow plumbs opts.tier through to the agent with correct precedence", async () => {
  // Regression guard: tier must reach WorkflowAgent.run() (it was previously
  // dropped). Precedence: explicit model > tier > phase model.
  const seen: Array<{ model?: string; tier?: string }> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; tier?: string }) {
      seen.push({ model: options.model, tier: options.tier });
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'tier_routing', description: 'tier routing',
    phases: [{ title: 'A', model: 'phase-a-model' }]
  }
  phase('A')
  await agent('tier beats phase', { label: 't', tier: 'small' })
  await agent('explicit beats tier', { label: 'e', tier: 'small', model: 'explicit-model' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  // 1) tier set, no explicit model: model is left undefined so the tier (resolved
  //    inside run()) wins over the phase model; tier is forwarded.
  assert.deepEqual(seen[0], { model: undefined, tier: "small" });
  // 2) explicit model + tier: explicit model is forwarded and still wins.
  assert.deepEqual(seen[1], { model: "explicit-model", tier: "small" });
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "resume-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "resume-run",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("script thinking is forwarded, validates before dispatch, and changes journal identity", async () => {
  const journal: JournalEntry[] = [];
  const seen: Array<string | undefined> = [];
  const script = (thinking: string) => `export const meta = { name: 'thinking_identity', description: 'thinking' }
return await agent('work', { thinking: '${thinking}' })`;
  await runWorkflow(script("low"), {
    persistLogs: false,
    runId: "thinking-run",
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(_prompt, options) {
        seen.push(options.thinking);
        return "low";
      },
    },
  });
  await runWorkflow(script("high"), {
    persistLogs: false,
    runId: "thinking-run",
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    agent: {
      async run(_prompt, options) {
        seen.push(options.thinking);
        return "high";
      },
    },
  });
  assert.deepEqual(seen, ["low", "high"], "changed thinking must not replay the old journal result");

  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'bad_thinking', description: 'bad' }
return await agent('work', { thinking: 'ultra' })`,
      {
        persistLogs: false,
        agent: {
          async run() {
            calls++;
            return "unexpected";
          },
        },
      },
    ),
    /thinking/i,
  );
  assert.equal(calls, 0, "invalid script thinking rejects before agent dispatch");
});

test("requested worktree isolation fails closed before starting a non-git agent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-worktree-fail-closed-"));
  let runs = 0;
  let starts = 0;
  try {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'fail_closed', description: 'no shared fallback' }
return await agent('must not run', { isolation: 'worktree' })`,
        {
          cwd,
          agent: {
            async run() {
              runs++;
              return "unexpected";
            },
          },
          persistLogs: false,
          onAgentStart: () => starts++,
        },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        error.recoverable === false,
    );
    assert.equal(runs, 0, "isolation failure must not invoke the shared-checkout agent");
    assert.equal(starts, 0, "the host must not observe an agent start before isolation succeeds");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a journal entry from isolation: false cannot replay after worktree isolation is requested", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-worktree-cache-mode-"));
  const journal: JournalEntry[] = [];
  let runs = 0;
  const script = (isolation: string) => `export const meta = { name: 'cache_mode', description: 'isolation identity' }
return await agent('same prompt', { label: 'same', isolation: ${isolation} })`;
  try {
    await runWorkflow(script("false"), {
      cwd,
      runId: "cache-mode",
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
      agent: {
        async run() {
          runs++;
          return "cached without isolation";
        },
      },
    });
    await assert.rejects(
      runWorkflow(script("'worktree'"), {
        cwd,
        runId: "cache-mode",
        persistLogs: false,
        resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
        agent: {
          async run() {
            runs++;
            return "must not run in a shared checkout";
          },
        },
      }),
      (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
    assert.equal(runs, 1, "the false-to-worktree cache miss must fail closed before agent.run");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("keepWorktree changes invalidate isolated journal entries while retained worktrees replay", async () => {
  const repo = createGitRepo("pi-worktree-cache-retention-");
  const journal: JournalEntry[] = [];
  const script = (
    keepWorktree: boolean,
  ) => `export const meta = { name: 'cache_retention', description: 'retention identity' }
return await agent('same prompt', { label: 'same', isolation: 'worktree', keepWorktree: ${keepWorktree} })`;
  let runs = 0;
  let liveCwd = "";
  const runner = {
    async run(_prompt: string, options: AgentRunOptions) {
      runs++;
      liveCwd = options.cwd ?? "";
      return `live-${runs}`;
    },
  };
  try {
    await runWorkflow(script(false), {
      cwd: repo,
      runId: "cache-retention",
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
      agent: runner,
    });
    assert.equal(existsSync(liveCwd), false, "the first keepWorktree: false tree was removed");

    await runWorkflow(script(true), {
      cwd: repo,
      runId: "cache-retention",
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
      onAgentJournal: (entry) => journal.push(entry),
      agent: runner,
    });
    assert.equal(runs, 2, "changing retention must not replay an entry whose tree was removed");
    assert.ok(existsSync(liveCwd), "the keepWorktree: true live retry retains its new tree");

    await runWorkflow(script(true), {
      cwd: repo,
      runId: "cache-retention",
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
      agent: runner,
    });
    assert.equal(runs, 2, "an unchanged valid keepWorktree: true entry replays without agent.run");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("onAgentStart failure still honors worktree retention cleanup", async () => {
  const repo = createGitRepo("pi-worktree-start-failure-");
  const script = (keepWorktree: boolean) => `export const meta = { name: 'start_failure', description: 'start cleanup' }
return await agent('same prompt', { label: 'same', isolation: 'worktree', keepWorktree: ${keepWorktree} })`;
  try {
    for (const keepWorktree of [false, true]) {
      const logs: string[] = [];
      let runs = 0;
      await assert.rejects(
        runWorkflow(script(keepWorktree), {
          cwd: repo,
          persistLogs: false,
          onLog: (message) => logs.push(message),
          onAgentStart: () => {
            throw new Error("start callback failed");
          },
          agent: {
            async run() {
              runs++;
              return "unexpected";
            },
          },
        }),
        /start callback failed/,
      );
      assert.equal(runs, 0, "a throwing start callback must prevent agent.run");
      const kept = logs.find((message) => message.startsWith("worktree kept: "));
      if (!keepWorktree) {
        assert.equal(kept, undefined, "keepWorktree: false cleans up after the callback failure");
      } else {
        assert.ok(kept, "keepWorktree: true still records the retained path through onLog");
        const cwd = kept?.slice("worktree kept: ".length).split(" (")[0] ?? "";
        assert.ok(existsSync(cwd), "the logged retained path remains inspectable");
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repeated live executions with the same run id and long slug retain independent worktrees", async () => {
  const repo = createGitRepo("pi-worktree-repeat-");
  const seen: string[] = [];
  const script = `export const meta = { name: 'repeat_tree', description: 'unique retained worktrees' }
return await agent('edit', { label: 'this-is-a-very-long-label-that-shares-the-entire-slug-prefix', isolation: 'worktree' })`;
  try {
    const runner = {
      async run(_prompt: string, options: AgentRunOptions) {
        const cwd = options.cwd ?? "";
        seen.push(cwd);
        if (seen.length === 1) writeFileSync(join(cwd, "first-only.txt"), "first\n");
        return "ok";
      },
    };
    await runWorkflow(script, { cwd: repo, runId: "same-run-id", agent: runner, persistLogs: false });
    await runWorkflow(script, { cwd: repo, runId: "same-run-id", agent: runner, persistLogs: false });

    assert.notEqual(seen[0], seen[1], "same run id and truncated slug must not reuse a retained tree");
    assert.equal(readFileSync(join(seen[0] ?? "", "first-only.txt"), "utf8"), "first\n");
    assert.equal(existsSync(join(seen[1] ?? "", "first-only.txt")), false);
    assert.equal(existsSync(join(repo, "first-only.txt")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree success, failure, and abort are retained by default; keepWorktree false cleans up", async () => {
  const repo = createGitRepo("pi-worktree-retention-");
  const script = (
    name: string,
    options = "",
  ) => `export const meta = { name: '${name}', description: 'worktree retention' }
return await agent('${name}', { isolation: 'worktree'${options} })`;
  try {
    let successCwd = "";
    await runWorkflow(script("success"), {
      cwd: repo,
      persistLogs: false,
      agent: {
        async run(_prompt, options) {
          successCwd = options.cwd ?? "";
          writeFileSync(join(successCwd, "success.txt"), "retained\n");
          return "ok";
        },
      },
    });
    assert.ok(existsSync(successCwd), "successful worktree is retained");

    let failureCwd = "";
    await assert.rejects(
      runWorkflow(script("failure"), {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(_prompt, options) {
            failureCwd = options.cwd ?? "";
            writeFileSync(join(failureCwd, "failure.txt"), "retained\n");
            throw new WorkflowError("intentional", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
      }),
      /intentional/,
    );
    assert.ok(existsSync(failureCwd), "failed worktree is retained for inspection");

    const abort = new AbortController();
    const started = createDeferred<void>();
    let abortedCwd = "";
    const abortedRun = runWorkflow(script("abort"), {
      cwd: repo,
      signal: abort.signal,
      persistLogs: false,
      agent: {
        async run(_prompt, options) {
          abortedCwd = options.cwd ?? "";
          started.resolve();
          return new Promise<string>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
    });
    await started.promise;
    abort.abort();
    await assert.rejects(abortedRun, /aborted/);
    assert.ok(existsSync(abortedCwd), "aborted worktree is retained for inspection");

    let ephemeralCwd = "";
    await runWorkflow(script("ephemeral", ", keepWorktree: false"), {
      cwd: repo,
      persistLogs: false,
      agent: {
        async run(_prompt, options) {
          ephemeralCwd = options.cwd ?? "";
          return "ok";
        },
      },
    });
    assert.equal(existsSync(ephemeralCwd), false, "explicit keepWorktree: false removes the worktree");
    for (const name of ["success.txt", "failure.txt"]) {
      assert.equal(existsSync(join(repo, name)), false, `${name} must not pollute the base checkout`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("replay does not create a worktree; a resume miss creates a fresh tree without base pollution", async () => {
  const repo = createGitRepo("pi-worktree-resume-");
  const journal: JournalEntry[] = [];
  const script = (prompt: string) => `export const meta = { name: 'resume_tree', description: 'retained trees' }
return await agent('${prompt}', { label: 'same-label', isolation: 'worktree' })`;
  try {
    let firstCwd = "";
    await runWorkflow(script("first"), {
      cwd: repo,
      runId: "same-run-id",
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
      agent: {
        async run(_prompt, options) {
          firstCwd = options.cwd ?? "";
          writeFileSync(join(firstCwd, "marker.txt"), "first\n");
          return "first";
        },
      },
    });

    let replayCalls = 0;
    await runWorkflow(script("first"), {
      cwd: repo,
      runId: "same-run-id",
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
      agent: {
        async run() {
          replayCalls++;
          return "unexpected";
        },
      },
    });
    assert.equal(replayCalls, 0, "a journal hit must not create or run an agent worktree");

    let missCwd = "";
    await runWorkflow(script("changed"), {
      cwd: repo,
      runId: "same-run-id",
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
      agent: {
        async run(_prompt, options) {
          missCwd = options.cwd ?? "";
          writeFileSync(join(missCwd, "marker.txt"), "miss\n");
          return "miss";
        },
      },
    });
    assert.notEqual(missCwd, firstCwd, "a resume miss owns a new worktree despite the same run id and label");
    assert.equal(readFileSync(join(firstCwd, "marker.txt"), "utf8"), "first\n", "replay history remains inspectable");
    assert.equal(readFileSync(join(missCwd, "marker.txt"), "utf8"), "miss\n");
    assert.equal(existsSync(join(repo, "marker.txt")), false, "neither live execution mutates the base checkout");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unthreaded agent journal hashes remain compatible with pre-thread runs", async () => {
  const journal: JournalEntry[] = [];
  await runWorkflow(
    `export const meta = { name: 'hash_compat', description: 'stable unthreaded hash' }
return await agent('work')`,
    {
      agent: countingAgent().runner,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  const oldIdentity = JSON.stringify({
    prompt: "work",
    model: null,
    tier: null,
    phase: null,
    agentType: null,
    agentDef: null,
    schema: null,
  });
  assert.equal(journal[0]?.hash, createHash("sha256").update(oldIdentity).digest("hex"));
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "resume-run-2",
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "resume-run-2",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

const threeCallScript = `export const meta = { name: 'prefix', description: 'prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent('B', { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;

test("resume re-runs the changed call AND everything after it (longest-unchanged-prefix)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "prefix-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  // Edit the MIDDLE call (index 1). Index 0 is an unchanged prefix → cache hit.
  // Index 1 changed → re-run; index 2 is unchanged but AFTER the first miss, so
  // it must re-run too (the bug was serving it stale from the journal).
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "prefix-run",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run; only the prefix (0) is cached");
});

test("resume in parallel(): editing one thunk re-runs that index and every later one", async () => {
  // Three identical-prompt thunks; editing the middle one must invalidate it and
  // the same-or-later index, not just the single changed call.
  const script = (mid: string) => `export const meta = { name: 'par_prefix', description: 'parallel prefix' }
  const xs = await parallel([
    () => agent('x', { label: 'p0' }),
    () => agent('${mid}', { label: 'p1' }),
    () => agent('x', { label: 'p2' }),
  ])
  return xs`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script("x"), {
    agent: first.runner,
    persistLogs: false,
    runId: "par-prefix-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  const second = countingAgent();
  await runWorkflow(script("x-edited"), {
    agent: second.runner,
    persistLogs: false,
    runId: "par-prefix-run",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.state.calls, 2, "changed thunk (index 1) + later index (2) re-run; index 0 cached");
});

/** Fake agent whose gapPrompt call fails every attempt with empty output, so
 * that call is never journaled — an organic never-completed gap (#231). */
function gappingAgent(gapPrompt: string) {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        if (prompt === gapPrompt) return "";
        return `ran:${prompt}`;
      },
    },
  };
}

function journalMap(journal: JournalEntry[]) {
  return new Map(journal.map((e) => [`${e.runId}:${e.index}`, e] as const));
}

const gapParallelScript = `export const meta = { name: 'gap_par', description: 'gap resume' }
const xs = await parallel([
  () => agent('gap-call', { label: 'p0' }),
  () => agent('b', { label: 'p1' }),
  () => agent('c', { label: 'p2' }),
])
return xs`;

test("replay-completed resume replays completed parallel siblings across a gap (#231)", async () => {
  // The #231 scenario: a parallel() fan-out where one call never journaled
  // (every attempt failed recoverably → organic gap at index 0) and both
  // siblings completed. Default prefix mode re-runs ALL THREE; replay-completed
  // re-runs only the gap.
  const first = gappingAgent("gap-call");
  const journal: JournalEntry[] = [];
  const initial = await runWorkflow<Array<string | null>>(gapParallelScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "gap-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [1, 2],
    "the empty-output call journals nothing — an organic gap at index 0",
  );
  assert.equal(initial.result?.[0], null, "the original run saw null where the gap's re-run will see a result");

  const resumeJournal = journalMap(journal);

  // Default (prefix) keeps the existing contract: the gap at index 0 ends the
  // replayable prefix, so all three calls run live.
  const prefixRun = countingAgent();
  await runWorkflow(gapParallelScript, {
    agent: prefixRun.runner,
    persistLogs: false,
    runId: "gap-run",
    resumeJournal,
  });
  assert.equal(prefixRun.state.calls, 3, "prefix mode: a gap at index 0 still re-runs the whole fan-out");

  // replay-completed: only the gap re-runs; completed siblings replay, and
  // their journaled results flow downstream in order.
  const replayRun = countingAgent();
  const resumed = await runWorkflow<string[]>(gapParallelScript, {
    agent: replayRun.runner,
    persistLogs: false,
    runId: "gap-run",
    resumeJournal,
    resumeMode: "replay-completed",
  });
  assert.equal(replayRun.state.calls, 1, "replay-completed: only the never-completed gap re-runs");
  assert.deepEqual(resumed.result, ["ran:gap-call", "ran:b", "ran:c"]);
});

test("replay-completed resume still re-runs an edited call and its whole suffix", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "edit-run",
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "edit-run",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
    resumeMode: "replay-completed",
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run even in replay-completed mode");
});

test("replay-completed resume replays between a gap and a later edit", async () => {
  const script = `export const meta = { name: 'gap_edit', description: 'gap+edit' }
const xs = await parallel([
  () => agent('gap-call', { label: 'p0' }),
  () => agent('B', { label: 'p1' }),
  () => agent('C', { label: 'p2' }),
])
return xs`;
  const first = gappingAgent("gap-call");
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: first.runner,
    persistLogs: false,
    runId: "gap-edit-run",
    onAgentJournal: (e) => journal.push(e),
  });

  // Organic gap at index 0 AND an edit at index 2: index 1 is a completed,
  // unchanged call in the gap's own fan-out batch — it must replay.
  const editedScript = script.replace("'C'", "'C-edited'");
  const second = countingAgent();
  const resumed = await runWorkflow<string[]>(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "gap-edit-run",
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(second.state.calls, 2, "gap (0) + edit (2) run live; the completed same-batch middle call (1) replays");
  assert.equal(resumed.result?.[1], "ran:B", "the replayed middle result comes from the journal");
});

test("replay-completed resume re-runs sequential calls after a fan-out gap (stale-replay guard, #231)", async () => {
  // The gap's re-run returns a REAL result the original run never had (the
  // original saw null), so every call that ran after it must re-run — a
  // cached downstream result was computed against the old partial state and
  // nothing hashes the difference. Siblings inside the gap's own fan-out
  // batch ran concurrently with it and replay safely; a SEQUENTIAL
  // downstream call does not.
  const script = `export const meta = { name: 'gap_seq', description: 'gap+sequential' }
const xs = await parallel([
  () => agent('gap-call', { label: 'p0' }),
  () => agent('b', { label: 'p1' }),
])
const s = await agent('summarize', { label: 'sum' })
return { xs, s }`;
  const first = gappingAgent("gap-call");
  const journal: JournalEntry[] = [];
  const initial = await runWorkflow<{ xs: Array<string | null>; s: string }>(script, {
    agent: first.runner,
    persistLogs: false,
    runId: "gap-seq-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(initial.result?.xs[0], null);
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [1, 2],
    "the gap journals nothing; the same-batch sibling and the sequential call do",
  );

  const second = countingAgent();
  const resumed = await runWorkflow<{ xs: string[]; s: string }>(script, {
    agent: second.runner,
    persistLogs: false,
    runId: "gap-seq-run",
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(second.state.calls, 2, "the gap re-runs AND the sequential downstream call re-runs with it");
  assert.deepEqual(resumed.result?.xs, ["ran:gap-call", "ran:b"], "the same-batch sibling still replays");
  assert.equal(resumed.result?.s, "ran:summarize", "the downstream call re-computed against the new state");
});

test("replay-completed resume: a top-level (sequential) gap shadows every later call", async () => {
  // A gap outside any fan-out batch has no concurrency relationship with
  // later calls — they ran strictly after it — so replay-completed gives
  // them no immunity: the whole suffix re-runs, exactly like prefix mode.
  const script = `export const meta = { name: 'seq_gap', description: 'sequential gap' }
const a = await agent('gap-call', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;
  const first = gappingAgent("gap-call");
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: first.runner,
    persistLogs: false,
    runId: "seq-gap-run",
    onAgentJournal: (e) => journal.push(e),
  });

  const second = countingAgent();
  await runWorkflow(script, {
    agent: second.runner,
    persistLogs: false,
    runId: "seq-gap-run",
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(second.state.calls, 2, "a sequential gap re-runs its whole suffix even in replay-completed mode");
});

test("replay-completed resume does not replay across a gap into a LATER fan-out batch", async () => {
  const script = `export const meta = { name: 'two_batches', description: 'two batches' }
const xs = await parallel([
  () => agent('gap-call', { label: 'p0' }),
  () => agent('a1', { label: 'p1' }),
])
const ys = await parallel([
  () => agent('b1', { label: 'p2' }),
  () => agent('b2', { label: 'p3' }),
])
return { xs, ys }`;
  const first = gappingAgent("gap-call");
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: first.runner,
    persistLogs: false,
    runId: "two-batch-run",
    onAgentJournal: (e) => journal.push(e),
  });

  const second = countingAgent();
  const resumed = await runWorkflow<{ xs: string[]; ys: string[] }>(script, {
    agent: second.runner,
    persistLogs: false,
    runId: "two-batch-run",
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(
    second.state.calls,
    3,
    "the gap (0) and both later-batch calls (2, 3) re-run; the same-batch sibling (1) replays",
  );
  assert.deepEqual(resumed.result?.xs, ["ran:gap-call", "ran:a1"]);
  assert.deepEqual(resumed.result?.ys, ["ran:b1", "ran:b2"]);
});

test("replay-completed resume keeps the nested journal for a workflow() sibling in the gap's batch", async () => {
  const child = `export const meta = { name: 'kid', description: 'k' }
return await agent('kid task', { label: 'kid' })`;
  const parent = `export const meta = { name: 'par', description: 'p' }
const [x, n] = await parallel([
  () => agent('gap-call', { label: 'g' }),
  () => workflow('kid'),
])
return { x, n }`;
  const first = gappingAgent("gap-call");
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: first.runner,
    persistLogs: false,
    runId: "nested-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2, "the gap attempt + the child's agent");
  assert.deepEqual(
    journal.map((e) => `${e.runId}:${e.index}`),
    ["nested-gap-run-nested1:0"],
    "only the nested child call journaled",
  );

  // The workflow() call shares the gap's fan-out batch: the child originally
  // ran concurrently with the gap call, so its cached result cannot be stale
  // with respect to the gap's re-run — it replays.
  const replayRun = countingAgent();
  const resumed = await runWorkflow<{ x: string; n: string }>(parent, {
    agent: replayRun.runner,
    persistLogs: false,
    runId: "nested-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(replayRun.state.calls, 1, "only the gap re-runs; the same-batch nested workflow replays its journal");
  assert.equal(resumed.result?.n, "ran:kid task", "the nested result replays from the child frame's journal entry");
});

test("replay-completed resume cuts a nested workflow off after a TOP-LEVEL parent gap", async () => {
  const child = `export const meta = { name: 'kid', description: 'k' }
return await agent('kid task', { label: 'kid' })`;
  const parent = `export const meta = { name: 'par', description: 'p' }
const x = await agent('gap-call', { label: 'g' })
const n = await workflow('kid')
return { x, n }`;
  const first = gappingAgent("gap-call");
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: first.runner,
    persistLogs: false,
    runId: "nested-seq-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  // The workflow() call is sequential top-level, after a top-level gap: it
  // originally ran after the gap call, so the child's cached result may have
  // observed the old partial state — the child re-executes live.
  const replayRun = countingAgent();
  await runWorkflow<{ x: string; n: string }>(parent, {
    agent: replayRun.runner,
    persistLogs: false,
    runId: "nested-seq-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(replayRun.state.calls, 2, "a top-level gap shadows the later workflow() call: the child re-executes");
});

test("replay-completed resume re-runs a nested child's sequential downstream of an internal gap (#231 R2)", async () => {
  // The fan-out batch object is inherited into a nested workflow()'s frame via
  // AsyncLocalStorage, but the child's internal calls are NOT concurrent with
  // the parent's fan-out — they run strictly after the child's own gap
  // settled. The gap must shadow the child's sequential downstream, or a
  // store-coordinated result replays stale (here: plan-for-undefined sitting
  // next to the fresh REAL). Emulates store_put/store_get: the successful
  // kid-gap seeds state kid-plan reads — a channel no call hash observes.
  const child = `export const meta = { name: 'kid', description: 'kid' }
let a = 'missing'
try { a = await agent('kid-gap', { label: 'kg' }) } catch {}
const b = await agent('kid-plan', { label: 'kp' })
return { a, b }`;
  const parent = `export const meta = { name: 'par', description: 'par' }
const [x, n] = await parallel([
  () => agent('parent-call', { label: 'pg' }),
  () => workflow('kid'),
])
return { x, n }`;
  const seeded = { value: undefined as string | undefined };
  const makeRunner = (gapFails: boolean, calls: { n: number }) => ({
    async run(prompt: string) {
      calls.n++;
      if (prompt === "kid-gap") {
        if (gapFails) return "";
        seeded.value = "REAL";
        return "REAL";
      }
      if (prompt === "kid-plan") return `plan-for-${seeded.value ?? "undefined"}`;
      return `ran:${prompt}`;
    },
  });
  const firstCalls = { n: 0 };
  const journal: JournalEntry[] = [];
  const initial = await runWorkflow<{ x: string; n: { a: string | null; b: string } }>(parent, {
    agent: makeRunner(true, firstCalls),
    persistLogs: false,
    runId: "nested-internal-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(initial.result?.n.b, "plan-for-undefined", "run 1: the gap produced nothing for kid-plan to see");

  seeded.value = undefined;
  const secondCalls = { n: 0 };
  const resumed = await runWorkflow<{ x: string; n: { a: string | null; b: string } }>(parent, {
    agent: makeRunner(false, secondCalls),
    persistLogs: false,
    runId: "nested-internal-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(secondCalls.n, 2, "only the child's gap + its sequential downstream re-run; the parent replays");
  assert.equal(resumed.result?.n.a, "REAL");
  assert.equal(resumed.result?.n.b, "plan-for-REAL", "the downstream call re-computed against the gap's new output");
  assert.equal(resumed.result?.x, "ran:parent-call");
});

test("replay-completed resume re-executes a workflow() launched after a same-thunk gap (#231 R2)", async () => {
  // The workflow() call here is dispatched AFTER the gap call settled (the
  // thunk awaits it first), so it is sequential downstream — the child must
  // re-execute live even though both calls carry the same inherited batch.
  const child = `export const meta = { name: 'kid1', description: 'k' }
return await agent('kid task', { label: 'kid' })`;
  const parent = `export const meta = { name: 'par', description: 'p' }
const xs = await parallel([
  async () => {
    try { await agent('gap-call', { label: 'g' }) } catch {}
    return await workflow('kid1')
  },
])
return xs`;
  const first = gappingAgent("gap-call");
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: first.runner,
    persistLogs: false,
    runId: "thunk-nested-gap-run",
    loadSavedWorkflow: (name) => (name === "kid1" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  const second = countingAgent();
  const resumed = await runWorkflow<string[]>(parent, {
    agent: second.runner,
    persistLogs: false,
    runId: "thunk-nested-gap-run",
    loadSavedWorkflow: (name) => (name === "kid1" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(second.state.calls, 2, "the gap re-runs AND the sequentially-launched child re-executes live");
  assert.deepEqual(resumed.result, ["ran:kid task"]);
});

test("replay-completed resume re-runs a same-thunk call dispatched after the gap settled (#231 R2)", async () => {
  // Same dispatch-window rule without nesting: plan-call runs strictly after
  // the gap call settled, so it is sequential downstream and must re-run —
  // only the genuinely concurrent sibling replays.
  const script = `export const meta = { name: 'thunk_seq', description: 'same-thunk sequential' }
const xs = await parallel([
  async () => {
    try { await agent('gap-call', { label: 'g' }) } catch {}
    return await agent('plan-call', { label: 'p' })
  },
  () => agent('sibling', { label: 's' }),
])
return xs`;
  const seeded = { value: undefined as string | undefined };
  const makeRunner = (gapFails: boolean, calls: { n: number }) => ({
    async run(prompt: string) {
      calls.n++;
      if (prompt === "gap-call") {
        if (gapFails) return "";
        seeded.value = "REAL";
        return "REAL";
      }
      if (prompt === "plan-call") return `plan-for-${seeded.value ?? "undefined"}`;
      return `ran:${prompt}`;
    },
  });
  const firstCalls = { n: 0 };
  const journal: JournalEntry[] = [];
  await runWorkflow<string[]>(script, {
    agent: makeRunner(true, firstCalls),
    persistLogs: false,
    runId: "thunk-seq-gap-run",
    onAgentJournal: (e) => journal.push(e),
  });

  seeded.value = undefined;
  const secondCalls = { n: 0 };
  const resumed = await runWorkflow<string[]>(script, {
    agent: makeRunner(false, secondCalls),
    persistLogs: false,
    runId: "thunk-seq-gap-run",
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(secondCalls.n, 2, "the gap + the same-thunk downstream re-run; the concurrent sibling replays");
  assert.deepEqual(resumed.result, ["plan-for-REAL", "ran:sibling"]);
});

test("replay-completed resume treats a nested frame's SYNC-PREFIX calls as sequential (#231 R3)", async () => {
  // R3 F1: the child frame's script executes synchronously inside the
  // ancestor fan-out's dispatch window (runWorkflow has no await before the
  // vm runs the script), so without frame scoping the child's synchronous
  // double-dispatch would capture the ANCESTOR batch as its generation and
  // replay PLAN across the child's own gap — stale. Generations are
  // frame-scoped: the child samples generation undefined, and its internal
  // gap shadows everything after it.
  const child = `export const meta = { name: 'kid', description: 'kid' }
const p1 = agent('GAP', { label: 'g' })
const p2 = agent('PLAN', { label: 'p' })
const [a, b] = await Promise.all([p1, p2])
return { a, b }`;
  const parent = `export const meta = { name: 'par', description: 'par' }
const [n] = await parallel([() => workflow('kid')])
return n`;
  const seeded = { value: undefined as string | undefined };
  const makeRunner = (gapFails: boolean, calls: { n: number }) => ({
    async run(prompt: string) {
      calls.n++;
      if (prompt === "GAP") {
        if (gapFails) return "";
        seeded.value = "REAL";
        return "REAL";
      }
      if (prompt === "PLAN") return `plan-for-${seeded.value ?? "undefined"}`;
      return `ran:${prompt}`;
    },
  });
  const firstCalls = { n: 0 };
  const journal: JournalEntry[] = [];
  const initial = await runWorkflow<{ a: string | null; b: string }>(parent, {
    agent: makeRunner(true, firstCalls),
    persistLogs: false,
    runId: "nested-sync-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(initial.result?.b, "plan-for-undefined", "run 1: PLAN saw no seed");

  seeded.value = undefined;
  const secondCalls = { n: 0 };
  const resumed = await runWorkflow<{ a: string | null; b: string }>(parent, {
    agent: makeRunner(false, secondCalls),
    persistLogs: false,
    runId: "nested-sync-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(secondCalls.n, 2, "the child's gap AND its sync-prefix sibling re-run: no cross-frame generation");
  assert.equal(resumed.result?.a, "REAL");
  assert.equal(resumed.result?.b, "plan-for-REAL", "PLAN re-computed against the gap's new output");
});

test("replay-completed resume still replays siblings inside a nested frame's OWN fan-out (#231 R3)", async () => {
  // Frame scoping must not over-shadow: the child's own parallel() creates a
  // batch tagged with the CHILD's frame, so genuine same-window siblings of
  // the child's internal gap still replay.
  const child = `export const meta = { name: 'kid', description: 'kid' }
const xs = await parallel([
  () => agent('GAP', { label: 'g' }),
  () => agent('sib', { label: 's' }),
])
return xs`;
  const parent = `export const meta = { name: 'par', description: 'par' }
const n = await workflow('kid')
return n`;
  const first = gappingAgent("GAP");
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: first.runner,
    persistLogs: false,
    runId: "nested-own-fanout-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  const second = countingAgent();
  const resumed = await runWorkflow<string[]>(parent, {
    agent: second.runner,
    persistLogs: false,
    runId: "nested-own-fanout-run",
    loadSavedWorkflow: (name) => (name === "kid" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(second.state.calls, 1, "only the child's internal gap re-runs; its own-fan-out sibling replays");
  assert.deepEqual(resumed.result, ["ran:GAP", "ran:sib"]);
});

// R4 scenario shape: parent call → workflow() → parent call, with the child's
// first call failing organically in run 1 and succeeding on resume; a seed
// channel (emulating store_put/store_get) makes staleness observable in
// results, not just call counts.
const r4Child = `export const meta = { name: 'kid', description: 'kid' }
const a = await agent('kid-gap', { label: 'kg' })
const b = await agent('kid-plan', { label: 'kp' })
return { a, b }`;
const r4Parent = `export const meta = { name: 'par', description: 'par' }
const x = await agent('parent-a', { label: 'pa' })
const n = await workflow('kid')
const c = await agent('parent-c', { label: 'pc' })
return { x, n, c }`;

function r4Runner(gapFails: boolean, seeded: { value?: string }, calls: { n: number }) {
  return {
    async run(prompt: string) {
      calls.n++;
      if (prompt === "kid-gap") {
        if (gapFails) return "";
        seeded.value = "REAL";
        return "REAL";
      }
      if (prompt === "kid-plan") return `plan-for-${seeded.value ?? "undefined"}`;
      if (prompt === "parent-c") return `c-for-${seeded.value ?? "undefined"}`;
      return `ran:${prompt}`;
    },
  };
}

test("replay-completed resume re-runs the parent's downstream after a child's internal gap (#231 R4)", async () => {
  // The child's gap is recorded in the CHILD frame's state; without outward
  // propagation the parent's later call (dispatched strictly after the child
  // returned) replays a result computed before the child re-ran — stale.
  const seeded: { value?: string } = {};
  const firstCalls = { n: 0 };
  const journal: JournalEntry[] = [];
  const initial = await runWorkflow<{ x: string; n: { a: string | null; b: string }; c: string }>(r4Parent, {
    agent: r4Runner(true, seeded, firstCalls),
    persistLogs: false,
    runId: "outward-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? r4Child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(initial.result?.c, "c-for-undefined", "run 1: parent-c journaled against the old child state");

  seeded.value = undefined;
  const secondCalls = { n: 0 };
  const resumed = await runWorkflow<{ x: string; n: { a: string | null; b: string }; c: string }>(r4Parent, {
    agent: r4Runner(false, seeded, secondCalls),
    persistLogs: false,
    runId: "outward-gap-run",
    loadSavedWorkflow: (name) => (name === "kid" ? r4Child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(secondCalls.n, 3, "the child's gap + its downstream + the PARENT's downstream re-run; parent-a replays");
  assert.equal(resumed.result?.x, "ran:parent-a");
  assert.equal(resumed.result?.n.b, "plan-for-REAL");
  assert.equal(resumed.result?.c, "c-for-REAL", "the parent's downstream re-computed against the new child state");
});

test("replay-completed resume re-runs the parent's downstream after an EDIT inside a child (#231 R4)", async () => {
  const childV1 = `export const meta = { name: 'kid', description: 'kid' }
const a = await agent('kid-x1', { label: 'kx' })
const b = await agent('kid-plan', { label: 'kp' })
return { a, b }`;
  const childV2 = childV1.replace("'kid-x1'", "'kid-x2'");
  const seeded: { value?: string } = {};
  const makeRunner = (calls: { n: number }) => ({
    async run(prompt: string) {
      calls.n++;
      if (prompt === "kid-x1") return "x1-result";
      if (prompt === "kid-x2") {
        seeded.value = "REAL";
        return "x2-result";
      }
      if (prompt === "kid-plan") return `plan-for-${seeded.value ?? "undefined"}`;
      if (prompt === "parent-c") return `c-for-${seeded.value ?? "undefined"}`;
      return `ran:${prompt}`;
    },
  });
  const firstCalls = { n: 0 };
  const journal: JournalEntry[] = [];
  await runWorkflow(r4Parent, {
    agent: makeRunner(firstCalls),
    persistLogs: false,
    runId: "outward-edit-run",
    loadSavedWorkflow: (name) => (name === "kid" ? childV1 : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  seeded.value = undefined;
  const secondCalls = { n: 0 };
  const resumed = await runWorkflow<{ x: string; n: { a: string | null; b: string }; c: string }>(r4Parent, {
    agent: makeRunner(secondCalls),
    persistLogs: false,
    runId: "outward-edit-run",
    loadSavedWorkflow: (name) => (name === "kid" ? childV2 : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(
    secondCalls.n,
    3,
    "the edited child call + its suffix + the PARENT's downstream re-run; parent-a replays",
  );
  assert.equal(resumed.result?.n.a, "x2-result");
  assert.equal(resumed.result?.c, "c-for-REAL", "the child's edit propagates outward to the parent's downstream");
});

test("prefix resume keeps the legacy one-way frame boundary unchanged (#231 R4 control)", async () => {
  // The outward propagation fix is scoped to replay-completed: prefix mode's
  // per-frame firstMiss has always been one-way (verified at base 3bea96c),
  // and the maintainer constraint is byte-for-byte unchanged prefix behavior.
  const seeded: { value?: string } = {};
  const firstCalls = { n: 0 };
  const journal: JournalEntry[] = [];
  await runWorkflow(r4Parent, {
    agent: r4Runner(true, seeded, firstCalls),
    persistLogs: false,
    runId: "outward-prefix-run",
    loadSavedWorkflow: (name) => (name === "kid" ? r4Child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  seeded.value = undefined;
  const secondCalls = { n: 0 };
  const resumed = await runWorkflow<{ x: string; n: { a: string | null; b: string }; c: string }>(r4Parent, {
    agent: r4Runner(false, seeded, secondCalls),
    persistLogs: false,
    runId: "outward-prefix-run",
    loadSavedWorkflow: (name) => (name === "kid" ? r4Child : undefined),
    resumeJournal: journalMap(journal),
  });
  assert.equal(secondCalls.n, 2, "prefix: the child re-runs its suffix; the parent's downstream still replays");
  assert.equal(resumed.result?.c, "c-for-undefined", "the legacy one-way boundary is deliberately preserved");
});

test("a sibling child's gap does not force a clean child's post-return calls live (#231 R5)", async () => {
  // The outward propagation signal must be scoped to the child's OWN frame:
  // kidA replays cleanly and settles first; PA is dispatched after kidA
  // returns while the gapping kidB is still in flight — the documented rule
  // (only calls dispatched after the MISSING child returns re-run) requires
  // PA to replay.
  const kids: Record<string, string> = {
    kidA: `export const meta = { name: 'kidA', description: 'clean' }
return await agent('A1', { label: 'a1' })`,
    kidB: `export const meta = { name: 'kidB', description: 'gaps' }
const g = await agent('BGAP', { label: 'bgap' })
const w = await agent('BWAIT', { label: 'bwait' })
return { g, w }`,
  };
  const parent = `export const meta = { name: 'p', description: 'p' }
const xs = await parallel([
  async () => { const a = await workflow('kidA'); return await agent('PA', { label: 'pa' }) },
  async () => { const b = await workflow('kidB'); return await agent('PB', { label: 'pb' }) },
])
return xs`;
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return prompt === "BGAP" ? "" : `ran:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r5-f1-run",
    loadSavedWorkflow: (name) => kids[name],
    onAgentJournal: (e) => journal.push(e),
  });

  let releaseB: () => void = () => {};
  const bGate = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  const calls: string[] = [];
  const resume = runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        calls.push(prompt);
        if (prompt === "BGAP") return "";
        if (prompt === "BWAIT") {
          await bGate;
          return "bwait";
        }
        return `ran:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r5-f1-run",
    loadSavedWorkflow: (name) => kids[name],
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseB();
  const resumed = await resume;

  assert.equal(calls.includes("PA"), false, `PA must replay after the clean child: calls=${JSON.stringify(calls)}`);
  assert.ok(calls.includes("PB"), "PB follows the gapping kidB's return and must re-run live");
  assert.ok(calls.includes("BWAIT"), "kidB's own gap shadow forces its downstream live");
  assert.equal((resumed.result as string[])[0], "ran:PA");
  assert.equal((resumed.result as string[])[1], "ran:PB");
});

test("a late-noted gap in an un-awaited child fan-out still forces the parent's post-child calls live (#231 R6)", async () => {
  // The child's fan-out promise is never awaited, so its 4th call (k-gap, the
  // gap) dispatches after the child frame's return statement. Without the
  // nested-frame quiescence drain, workflow() resolves while the fan-out is
  // still mid-flight; the miss is then noted after the parent's post-child
  // boundary advanced, and parent-c replays its stale entry.
  const child = `export const meta = { name: 'kidLateGap', description: 'kid' }
const p = parallel([
  async () => {
    await agent('r1')
    await agent('r2')
    await agent('r3')
    await agent('k-gap')
  },
])
return 'kid-done'`;
  const parent = `export const meta = { name: 'parLateGap', description: 'p' }
const n = await workflow('kidLateGap')
const c = await agent('parent-c')
return { n, c }`;

  const journal: JournalEntry[] = [];
  let sideEffect = "stale";
  const first = await runWorkflow<{ n: string; c: string }>(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "k-gap") return "";
        if (prompt === "parent-c") return `c-for-${sideEffect}`;
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r6-late-gap",
    loadSavedWorkflow: (name) => (name === "kidLateGap" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.result.c, "c-for-stale");

  const calls: string[] = [];
  const resumed = await runWorkflow<{ n: string; c: string }>(parent, {
    agent: {
      async run(prompt: string) {
        calls.push(prompt);
        if (prompt === "k-gap") {
          sideEffect = "REAL";
          return "gap-result";
        }
        if (prompt === "parent-c") return `c-for-${sideEffect}`;
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r6-late-gap",
    loadSavedWorkflow: (name) => (name === "kidLateGap" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.ok(calls.includes("k-gap"), "the gap itself re-runs live");
  assert.equal(calls.includes("r1"), false, "the child's completed prefix replays");
  assert.equal(resumed.result.n, "kid-done");
  assert.equal(
    resumed.result.c,
    "c-for-REAL",
    "parent-c was dispatched after the child returned; the late-noted gap must re-run it live",
  );
});

test("the quiescence drain waits out a long replayed-call chain before the late gap (#231 R15)", async () => {
  // The drain shape above with the gap deferred behind TWENTY replayed calls:
  // each replayed call's cache-hit settle costs microtask hops, so the gap's
  // dispatch lands dozens of hops after the child frame's return. This pins
  // why the drain polls on a macrotask — the event loop drains the microtask
  // queue completely before any timer fires, so a macrotask flush waits out a
  // replayed chain of ANY length; a bounded N-hop microtask flush passes the
  // 3-call test above while replaying the parent's post-child call stale
  // here (R15 MINOR-1).
  const chain = Array.from({ length: 20 }, (_, i) => `await agent('r${i + 1}')`).join("\n");
  const child = `export const meta = { name: 'kidLongGap', description: 'kid' }
const p = parallel([
  async () => {
    ${chain}
    await agent('k-gap')
  },
])
return 'kid-done'`;
  const parent = `export const meta = { name: 'parLongGap', description: 'p' }
const n = await workflow('kidLongGap')
const c = await agent('parent-c')
return { n, c }`;

  const journal: JournalEntry[] = [];
  let sideEffect = "stale";
  await runWorkflow<{ n: string; c: string }>(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "k-gap") return "";
        if (prompt === "parent-c") return `c-for-${sideEffect}`;
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r15-long-gap",
    loadSavedWorkflow: (name) => (name === "kidLongGap" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  const calls: string[] = [];
  const resumed = await runWorkflow<{ n: string; c: string }>(parent, {
    agent: {
      async run(prompt: string) {
        calls.push(prompt);
        if (prompt === "k-gap") {
          sideEffect = "REAL";
          return "gap-result";
        }
        if (prompt === "parent-c") return `c-for-${sideEffect}`;
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r15-long-gap",
    loadSavedWorkflow: (name) => (name === "kidLongGap" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.ok(calls.includes("k-gap"), "the gap itself re-runs live");
  assert.equal(calls.includes("r1"), false, "the child's completed prefix replays");
  assert.equal(
    resumed.result.c,
    "c-for-REAL",
    "the drain must still be waiting when the 20-call replay chain reaches the gap",
  );
});

test("a late-noted edit in an un-awaited child fan-out still forces the parent's post-child calls live (#231 R6)", async () => {
  // Same late-arrival shape as the gap test above, but the child's last call
  // holds an unusable cached entry (an edit): whole-suffix liveness is the
  // edit rule, and it must reach the parent even when the child frame has
  // already returned by the time the edit is discovered.
  const child = `export const meta = { name: 'kidLateEdit', description: 'kid' }
const p = parallel([
  async () => {
    await agent('r1')
    await agent('r2')
    await agent('r3')
    await agent('k-edit')
  },
])
return 'kid-done'`;
  const parent = `export const meta = { name: 'parLateEdit', description: 'p' }
const n = await workflow('kidLateEdit')
const c = await agent('parent-c')
return { n, c }`;

  const journal: JournalEntry[] = [];
  let sideEffect = "stale";
  const first = await runWorkflow<{ n: string; c: string }>(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "parent-c") return `c-for-${sideEffect}`;
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r6-late-edit",
    loadSavedWorkflow: (name) => (name === "kidLateEdit" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.result.c, "c-for-stale");
  // The child's k-edit entry becomes unusable on disk (legacy/hand-edited
  // journal); on resume it is an edit, not a gap.
  const tampered = journalMap(journal.map((e) => (e.result === "r:k-edit" ? { ...e, result: "" } : e)));

  const calls: string[] = [];
  const resumed = await runWorkflow<{ n: string; c: string }>(parent, {
    agent: {
      async run(prompt: string) {
        calls.push(prompt);
        if (prompt === "k-edit") {
          sideEffect = "NEW";
          return "edit-result";
        }
        if (prompt === "parent-c") return `c-for-${sideEffect}`;
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r6-late-edit",
    loadSavedWorkflow: (name) => (name === "kidLateEdit" ? child : undefined),
    resumeJournal: tampered,
    resumeMode: "replay-completed",
  });
  assert.ok(calls.includes("k-edit"), "the edited call itself re-runs live");
  assert.equal(calls.includes("r1"), false, "the child's clean prefix replays");
  assert.equal(resumed.result.n, "kid-done");
  assert.equal(
    resumed.result.c,
    "c-for-NEW",
    "parent-c was dispatched after the child returned; the late-noted edit must re-run it live",
  );
});

test("an aborted nested drain wakes instead of waiting out a signal-ignoring call (#231 R7)", async () => {
  // The child returns with an un-awaited, never-settling call in flight. Under
  // replay-completed the frame's quiescence drain awaits it — but allSettled
  // on a signal-ignoring call never resolves, and isAborted() is only re-read
  // between iterations, so without an abort wake the drain (and therefore
  // pause/stop, which route through the run's abort) wedges on the child
  // frame forever. The drain must race the abort like the top-level drain
  // does (audit2 #3) and let the run settle.
  //
  // The drain only engages on an actual replay with something to replay (a
  // fresh run has no journal — #231 R8; a frame with zero journaled entries
  // of its own engages nothing — #231 R9), so the scenario resumes a run
  // whose first execution left HANG unjournaled (empty results are never
  // journaled) next to a journaled seed call, making HANG a live gap call
  // inside the replayed child frame.
  const child = `export const meta = { name: 'kidHang', description: 'k' }
const p = agent('HANG')
const k = await agent('K-SEED')
return 'kid-done'`;
  const parent = `export const meta = { name: 'parHang', description: 'p' }
const n = await workflow('kidHang')
const c = await agent('parent-c')
return { n, c }`;

  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return prompt === "HANG" ? "" : `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r7-hang",
    loadSavedWorkflow: (name) => (name === "kidHang" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  const controller = new AbortController();
  let hangStarted = false;
  const logs: string[] = [];
  const run = runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "HANG") {
          hangStarted = true;
          return await new Promise((_resolve, _reject) => {});
        }
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r7-hang",
    loadSavedWorkflow: (name) => (name === "kidHang" ? child : undefined),
    resumeJournal: journalMap(journal),
    signal: controller.signal,
    // Well above the 50ms pre-abort wait so a scheduling stall cannot let the
    // grace win the race and trip the absence assertion below (#231 R10);
    // still far inside the 2s wedge watchdog for a drain with no abort wake.
    drainAbortGraceMs: 1_000,
    resumeMode: "replay-completed",
    onLog: (message) => logs.push(message),
  });

  for (let i = 0; i < 200 && !hangStarted; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(hangStarted, "the hung call is in flight before the abort");
  // Let the child frame reach its drain and block in it — aborting earlier
  // would skip the drain loop entirely and prove nothing about the wake.
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();

  const outcome = await Promise.race([
    // Rejection (aborted run) still means the run SETTLED.
    run.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve("wedged"), 2_000)),
  ]);
  assert.equal(outcome, "settled", "the aborted nested drain must wake; the run must settle near the abort grace");
  assert.equal(
    logs.some((message) => message.includes("nested frame drain abandoned")),
    false,
    "the abort, not the grace, must release the nested drain (#231 R9: the grace alone would settle within the watchdog)",
  );
});

test("a non-recoverable error settles a replay-completed resume despite a hung sibling in the child frame (#231 R8)", async () => {
  // The nested quiescence drain's only release besides the calls settling is
  // the run-fatal abort — which seals in the TOP-LEVEL catch, downstream of
  // whatever error the drain could be blocking. An unbounded drain would hold
  // that error path hostage forever: LIMIT's usage-limit failure can never
  // reach the catch that would abort HANG, so the run never settles. The
  // drain must abandon its wait after the abort grace, exactly like the
  // top-level drain.
  const child = `export const meta = { name: 'kidLimit', description: 'k' }
const p = agent('HANG')
const k = await agent('K-SEED')
const c = await agent('LIMIT')
return c`;
  const parent = `export const meta = { name: 'parLimit', description: 'p' }
const n = await workflow('kidLimit')
const after = await agent('AFTER')
return { n, after }`;

  // Run 1 leaves HANG and LIMIT unjournaled (empty results are never
  // journaled) next to a journaled seed call, so the resume re-runs both live
  // inside the replayed child frame (a frame with zero journaled entries of
  // its own would not engage the drain at all — #231 R9).
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "AFTER") return "after-done";
        if (prompt === "K-SEED") return "k-seed-done";
        return "";
      },
    },
    persistLogs: false,
    runId: "r8-drain-grace",
    loadSavedWorkflow: (name) => (name === "kidLimit" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  const run = runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "HANG") return await new Promise((_resolve, _reject) => {});
        if (prompt === "LIMIT") {
          throw new WorkflowError("upstream 429: usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
          });
        }
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r8-drain-grace",
    loadSavedWorkflow: (name) => (name === "kidLimit" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
    drainAbortGraceMs: 100,
  });

  const outcome = await Promise.race([
    run.then(
      () => "completed",
      (error: unknown) => `failed:${String((error as Error)?.message ?? error)}`,
    ),
    new Promise((resolve) => setTimeout(() => resolve("wedged"), 2_000)),
  ]);
  assert.match(
    String(outcome),
    /failed:.*usage limit/,
    "the grace-bound drain must abandon HANG and let the usage-limit error settle the run",
  );
});

test("a start-time resumeMode declaration does not change live nested-frame execution (#231 R8)", async () => {
  // resumeMode on a START is a policy declaration for the run's FUTURE
  // resumes — the start execution has no journal, so the nested quiescence
  // drain must stay disengaged. Engaging it would serialize the child's
  // un-awaited work before the parent's post-child calls — an observable
  // live-execution change a start-time declaration must not cause (and a
  // byte-for-byte prefix parity break).
  const child = `export const meta = { name: 'kidSide', description: 'k' }
const p = agent('SIDE')
return 'kid-done'`;
  const parent = `export const meta = { name: 'parSide', description: 'p' }
const n = await workflow('kidSide')
const c = await agent('C')
return { n, c }`;

  let side = "unset";
  const res = await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "SIDE") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          side = "set";
          return "side-done";
        }
        return `c-sees-${side}`;
      },
    },
    persistLogs: false,
    runId: "r8-fresh-declared",
    loadSavedWorkflow: (name) => (name === "kidSide" ? child : undefined),
    resumeMode: "replay-completed",
  });
  assert.equal(
    res.result.c,
    "c-sees-unset",
    "a fresh run has no journal: the drain must not delay the parent's post-child calls",
  );
});

test("a replay-completed resume does not serialize a nested fan-out when the child frame has nothing to replay (#231 R9)", async () => {
  // A frame with zero journaled entries of its own can replay nothing: every
  // call notes its gap at dispatch, so the frame's first dispatch already
  // advances the parent's post-child boundary. Engaging the quiescence drain
  // there would only serialize the fan-out — an observable live-execution
  // change with zero replay benefit. The resume must behave like a prefix
  // resume in this shape, whether the journal is empty or holds only
  // top-level entries.
  const child = `export const meta = { name: 'kidSide9', description: 'k' }
const p = agent('SIDE')
return 'kid-done'`;
  const parent = `export const meta = { name: 'parSide9', description: 'p' }
const n = await workflow('kidSide9')
const c = await agent('C')
return { n, c }`;

  // Journal variant holding ONLY a top-level entry (SIDE's empty result is
  // never journaled, so the child frame has no entries of its own).
  const topLevelOnly: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return prompt === "SIDE" ? "" : `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r9-empty-frame",
    loadSavedWorkflow: (name) => (name === "kidSide9" ? child : undefined),
    onAgentJournal: (e) => topLevelOnly.push(e),
  });
  assert.ok(topLevelOnly.length > 0 && topLevelOnly.every((e) => (e.runId ?? "r9-empty-frame") === "r9-empty-frame"));

  for (const resumeJournal of [new Map<string, JournalEntry>(), journalMap(topLevelOnly)]) {
    let side = "unset";
    const res = await runWorkflow(parent, {
      agent: {
        async run(prompt: string) {
          if (prompt === "SIDE") {
            await new Promise((resolve) => setTimeout(resolve, 30));
            side = "set";
            return "side-done";
          }
          return `c-sees-${side}`;
        },
      },
      persistLogs: false,
      runId: "r9-empty-frame",
      loadSavedWorkflow: (name) => (name === "kidSide9" ? child : undefined),
      resumeJournal,
      resumeMode: "replay-completed",
    });
    assert.equal(
      res.result.c,
      "c-sees-unset",
      "a child frame with nothing to replay must not delay the parent's post-child calls",
    );
  }
});

test("a deferred first dispatch in a zero-entry child frame still advances the parent's boundary (#231 R11)", async () => {
  // The per-frame gate disengages the full drain when the child frame has no
  // journaled entries — but the frame's FIRST dispatch can be deferred past
  // the frame's return by a microtask bootstrap (here a gate released by a
  // 100-hop promise chain). Without the one-macrotask sweep, nothing has noted
  // a miss when the parent's post-child finally reads the frame's count, and
  // the parent's call replays stale — the R6 defect. The chain's length also
  // pins WHY the sweep uses a macrotask: the event loop drains the microtask
  // queue completely before any timer fires, so a macrotask waits out a
  // deferred chain of ANY length — a bounded N-hop microtask flush (N < 100)
  // would pass a short-chain version of this test while replaying stale here
  // (#231 R15).
  const hops = Array.from({ length: 100 }, () => "c = c.then(() => {});").join("\n");
  const child = `export const meta = { name: 'kidLate11', description: 'k' }
let release;
const gate = new Promise((r) => { release = r; });
// The catch is load-bearing: in run 1 (no sweep) the 100-hop chain outlives
// the completed run, so the deferred dispatch throws WORKFLOW_ABORTED into
// this fire-and-forget promise — the base runtime's documented abandonment
// behavior. Run 2's sweep resolves long after a 100-hop chain, so the
// dispatch lands in time there and the catch stays unused.
const p = (async () => { await gate; const x = await agent('X'); return x; })().catch(() => {});
let c = Promise.resolve();
${hops}
c.then(() => { release(); });
return 'kid-done'`;
  const parent = `export const meta = { name: 'parLate11', description: 'p' }
const n = await workflow('kidLate11')
const c = await agent('C')
return { n, c }`;

  // X's empty result is never journaled, so the child frame ends run 1 with
  // zero entries of its own; only the parent's C is journaled.
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return prompt === "X" ? "" : `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r11-late",
    loadSavedWorkflow: (name) => (name === "kidLate11" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  let cCalls = 0;
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "C") cCalls++;
        return `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r11-late",
    loadSavedWorkflow: (name) => (name === "kidLate11" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(cCalls, 1, "the child's sweep-deferred gap must re-run the parent's post-child call live");
});

test("a deferred child dispatch never races ahead of the parent's post-child call outside a replay (#231 R12)", async () => {
  // Base-runtime ordering contract: awaiting a workflow() child resumes the
  // parent on the child's own settlement microtask — ANY wrapper on the child
  // promise (.then/.finally) adds a tick and lets a microtask-deferred
  // dispatch inside the child run FIRST, which is result-visible when the
  // parent's post-child call observes that dispatch's side effect (#231 R12
  // F1). The gate below releases X after two 1-job hops and one adoption hop —
  // calibrated by mutation so it lands exactly in the one-tick window between
  // the base-timing resume (C wins: "c-sees-unset") and a +1-tick resume (X
  // wins: "c-sees-set"); a shorter chain fires before even the base resume
  // and a longer one survives a +1 wrapper, so neither can discriminate (R13
  // F1). Promise job counts are spec-pinned, so the window is stable across
  // engines. Prefix fresh, a fresh start that merely DECLARES
  // replay-completed, a prefix resume, and a replay-completed resume with an
  // EMPTY journal (nothing anywhere can replay, so the zero-entry sweep's
  // macrotask hold would be pure, observable cost — #231 R16) must all
  // exhibit the base order. Replay-completed with entries takes its own
  // delay from the sweep, not from a wrapper, and is pinned by the R11 test.
  const child = `export const meta = { name: 'kidTick', description: 'k' }
let release;
const gate = new Promise((r) => { release = r; });
const p = (async () => { await gate; const x = await agent('X'); return x; })();
let c = Promise.resolve();
c = c.then(() => {});
c = c.then(() => {});
c = c.then(() => Promise.resolve());
c.then(() => { release(); });
return 'kid-done'`;
  const parent = `export const meta = { name: 'parTick', description: 'p' }
const n = await workflow('kidTick')
const c = await agent('C')
return { n, c }`;

  const scenario = async (extra: Record<string, unknown>, runId: string) => {
    let side = "unset";
    const events: string[] = [];
    const result = await runWorkflow(parent, {
      agent: {
        async run(prompt: string) {
          if (prompt === "X") {
            side = "set";
            events.push("X");
            return "x-done";
          }
          events.push("C");
          return `c-sees-${side}`;
        },
      },
      persistLogs: false,
      runId,
      loadSavedWorkflow: (name) => (name === "kidTick" ? child : undefined),
      ...extra,
    });
    return { c: result.result.c, events };
  };

  for (const [label, extra] of [
    ["prefix fresh", {}],
    ["declared fresh", { resumeMode: "replay-completed" }],
    ["prefix resume", { resumeJournal: journalMap([]), resumeMode: "prefix" }],
    ["replay resume, empty journal", { resumeJournal: journalMap([]), resumeMode: "replay-completed" }],
  ] as const) {
    const { c, events } = await scenario(extra, `r12-tick-${label}`);
    assert.equal(
      c,
      "c-sees-unset",
      `${label}: the parent's post-child call must run before the deferred child dispatch`,
    );
    assert.deepEqual(events.slice(0, 1), ["C"], `${label}: C must dispatch first`);
  }
});

test("a child that re-ran live and then threw still advances the parent's boundary on the error path (#231 R13)", async () => {
  // The boundary advance must run on BOTH settle paths: a child that re-ran a
  // call live across a gap and then THREW still invalidated the state this
  // frame's journaled downstream was computed against. Without the error-path
  // advance, the parent's post-child call replays that stale result.
  const child = `export const meta = { name: 'kidThrow', description: 'k' }
const k = await agent('K');
if (k === 'K-boom') throw new Error('child-boom');
return 'kid-ok'`;
  const parent = `export const meta = { name: 'parThrow', description: 'p' }
let n;
try { n = await workflow('kidThrow'); } catch (e) { n = 'caught:' + e.message; }
const c = await agent('C');
return { n, c }`;

  // Run 1: K completes normally; K (child frame) and C (parent) both journal.
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return `${prompt}-r`;
      },
    },
    persistLogs: false,
    runId: "r13-throw",
    loadSavedWorkflow: (name) => (name === "kidThrow" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  // Run 2: K's entry is dropped (a gap), so the child re-runs K live, gets
  // "K-boom", and throws; the parent catches. The child frame's miss must
  // reach the parent's boundary on the ERROR path too, so C runs live.
  const calls: string[] = [];
  const resumed = await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        calls.push(prompt);
        return prompt === "K" ? "K-boom" : `${prompt}-live`;
      },
    },
    persistLogs: false,
    runId: "r13-throw",
    loadSavedWorkflow: (name) => (name === "kidThrow" ? child : undefined),
    resumeJournal: journalMap(journal.filter((e) => e.result !== "K-r")),
    resumeMode: "replay-completed",
  });
  assert.equal(resumed.result.n, "caught:child-boom");
  assert.equal(resumed.result.c, "C-live", "the error-path advance must force the parent's post-child call live");
  assert.deepEqual(calls, ["K", "C"], "K re-ran across the gap and C must not replay its stale entry");
});

test("a journal-less child in a replay-completed resume adds no tick to the parent's resume (#231 R14)", async () => {
  // When the parent's prefix broke BEFORE the workflow() call (E's entry is
  // dropped), the child frame runs journal-less: no drain and no zero-entry
  // sweep engage, so a .then/.finally wrapper on the child promise would be
  // the ONLY delay on this frame's resume — and it is observable: on the
  // calibrated 2/1 gate it flips the race between the child's deferred
  // dispatch and this frame's post-child call (#231 R13 F3). Pin the
  // tick-free timing in this shape too; the R12 gated pair passes every
  // other test while getting this ordering wrong (R14 M1). The gate chain is
  // the same one the R12 test calibrates — see its comment for the window.
  const child = `export const meta = { name: 'kidJL', description: 'k' }
let release;
const gate = new Promise((r) => { release = r; });
const p = (async () => { await gate; const x = await agent('X'); return x; })();
let c = Promise.resolve();
c = c.then(() => {});
c = c.then(() => {});
c = c.then(() => Promise.resolve());
c.then(() => { release(); });
return 'kid-done'`;
  const parent = `export const meta = { name: 'parJL', description: 'p' }
await agent('E');
const n = await workflow('kidJL');
const c = await agent('C');
return { n, c }`;

  // Run 1: journal E and C (X's empty result is never journaled).
  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return prompt === "X" ? "" : `${prompt}-r`;
      },
    },
    persistLogs: false,
    runId: "r14-jl",
    loadSavedWorkflow: (name) => (name === "kidJL" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  // Run 2: drop E so the parent's prefix is already broken at the workflow()
  // call and the child inherits no journal. C is live in every timing (E's
  // gap shadows it), so the ONLY signal is ordering: with base timing C's
  // runner beats the deferred X; one added tick flips it.
  const events: string[] = [];
  let side = "unset";
  const resumed = await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        events.push(prompt);
        if (prompt === "X") {
          side = "set";
          return "x-done";
        }
        return prompt === "C" ? `c-sees-${side}` : `${prompt}-live`;
      },
    },
    persistLogs: false,
    runId: "r14-jl",
    loadSavedWorkflow: (name) => (name === "kidJL" ? child : undefined),
    resumeJournal: journalMap(journal.filter((e) => e.result !== "E-r")),
    resumeMode: "replay-completed",
  });
  assert.equal(
    resumed.result.c,
    "c-sees-unset",
    "no wrapper may delay the parent's resume behind the journal-less child",
  );
  assert.deepEqual(
    events,
    ["E", "C", "X"],
    "the parent's post-child call must run before the child's deferred dispatch",
  );
});

test("a child whose misses cannot change any downstream replay adds no sweep hold (#231 R17)", async () => {
  // The R16 gate skipped the zero-entry sweep only for an EMPTY journal. The
  // hold is just as pure-cost when the journal's entries cannot replay
  // downstream of the child: here E (index 0) is kept and C (index 1) is
  // dropped, so the parent prefix is intact at the workflow() call (the
  // child inherits the journal, unlike the R14 shape) but no entry sits
  // downstream of it — and a foreign key (no entry for this run tree at
  // all) is the same root cause. The sweep would change no replay decision
  // in either case, so its one macrotask must not flip the calibrated race
  // vs a prefix resume of the same journal. The load-bearing direction
  // (entries downstream) is pinned by the R11 test.
  const child = `export const meta = { name: 'kidUp', description: 'k' }
let release;
const gate = new Promise((r) => { release = r; });
const p = (async () => { await gate; const x = await agent('X'); return x; })().catch(() => {});
let c = Promise.resolve();
c = c.then(() => {});
c = c.then(() => {});
c = c.then(() => Promise.resolve());
c.then(() => { release(); });
return 'kid-done'`;
  const parent = `export const meta = { name: 'parUp', description: 'p' }
await agent('E');
const n = await workflow('kidUp');
const c = await agent('C');
return { n, c }`;

  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return prompt === "X" ? "" : `${prompt}-r`;
      },
    },
    persistLogs: false,
    runId: "r17-up",
    loadSavedWorkflow: (name) => (name === "kidUp" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  const scenario = async (label: string, entries: JournalEntry[], expected: string[]) => {
    const events: string[] = [];
    let side = "unset";
    const resumed = await runWorkflow(parent, {
      agent: {
        async run(prompt: string) {
          events.push(prompt);
          if (prompt === "X") {
            side = "set";
            return "x-done";
          }
          return prompt === "C" ? `c-sees-${side}` : `${prompt}-live`;
        },
      },
      persistLogs: false,
      runId: "r17-up",
      loadSavedWorkflow: (name) => (name === "kidUp" ? child : undefined),
      resumeJournal: journalMap(entries),
      resumeMode: "replay-completed",
    });
    assert.equal(resumed.result.c, "c-sees-unset", `${label}: a non-load-bearing sweep must not delay the parent`);
    assert.deepEqual(events, expected, `${label}: the parent's live calls must keep base dispatch order`);
  };

  // Upstream-only: E's entry stays (index 0) and replays, C's is dropped.
  await scenario(
    "upstream-only journal",
    journal.filter((e) => e.result !== "C-r"),
    ["C", "X"],
  );
  // Foreign: no key of this run tree at all, so E re-runs live too.
  await scenario(
    "foreign journal",
    [{ runId: "foreign-run", index: 0, hash: "x", result: "y" } as JournalEntry],
    ["E", "C", "X"],
  );

  // Foreign keys against a NO-preamble parent: nothing anywhere belongs to
  // this run tree, yet the R16 size>0 gate engaged the sweep here (the
  // preamble variant can't discriminate — E's own gap already disengages
  // the child's journal inheritance, so both gates skip).
  const bareParent = `export const meta = { name: 'parUpBare', description: 'p' }
const n = await workflow('kidUp');
const c = await agent('C');
return { n, c }`;
  const events: string[] = [];
  let side = "unset";
  const bare = await runWorkflow(bareParent, {
    agent: {
      async run(prompt: string) {
        events.push(prompt);
        if (prompt === "X") {
          side = "set";
          return "x-done";
        }
        return `c-sees-${side}`;
      },
    },
    persistLogs: false,
    runId: "r17-up-bare",
    loadSavedWorkflow: (name) => (name === "kidUp" ? child : undefined),
    resumeJournal: journalMap([{ runId: "foreign-run", index: 0, hash: "x", result: "y" } as JournalEntry]),
    resumeMode: "replay-completed",
  });
  assert.equal(bare.result.c, "c-sees-unset", "a foreign journal must not engage the sweep's hold");
  assert.deepEqual(events, ["C", "X"], "the parent's post-child call must beat the deferred dispatch");
});

test("a same-window pre-call gap fixes every downstream replay decision, so the sweep stays out (#231 R18)", async () => {
  // G (a recoverable failure, never journaled) and the workflow() call share
  // one parallel() dispatch window, so the parent prefix is "intact" at the
  // call and the child inherits the journal — but every downstream replay
  // decision is already fixed: in-window calls decided synchronously at
  // dispatch, and C (dispatched after the window) is shadowed by G's gap no
  // matter what the child's deferred misses do. C has an entry at a later
  // index, so the unguarded reachability predicate engaged the sweep and
  // its macrotask flipped the calibrated race (R18 MINOR-1).
  const child = `export const meta = { name: 'kidSG', description: 'k' }
let release;
const gate = new Promise((r) => { release = r; });
const p = (async () => { await gate; const x = await agent('X'); return x; })();
let c = Promise.resolve();
c = c.then(() => {});
c = c.then(() => {});
c = c.then(() => Promise.resolve());
c.then(() => { release(); });
return 'kid-done'`;
  const parent = `export const meta = { name: 'parSG', description: 'p' }
let wp;
parallel([
  () => agent('G'),
  () => { wp = workflow('kidSG'); return 'w-started'; },
]);
const w = await wp;
const c = await agent('C');
return { w, c }`;

  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return prompt === "C" ? "C-r" : "";
      },
    },
    persistLogs: false,
    runId: "r18-sg",
    loadSavedWorkflow: (name) => (name === "kidSG" ? child : undefined),
    onAgentJournal: (e) => journal.push(e),
  });

  const events: string[] = [];
  let side = "unset";
  let cLive = 0;
  const resumed = await runWorkflow<{ w: string; c: string }>(parent, {
    agent: {
      async run(prompt: string) {
        events.push(prompt);
        if (prompt === "X") {
          side = "set";
          return "x-done";
        }
        if (prompt === "C") {
          cLive++;
          return `c-sees-${side}`;
        }
        return ""; // G fails recoverably again — a gap in the shared window.
      },
    },
    persistLogs: false,
    runId: "r18-sg",
    loadSavedWorkflow: (name) => (name === "kidSG" ? child : undefined),
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(cLive, 1, "C is shadowed by the same-window gap and runs live");
  assert.equal(
    resumed.result.c,
    "c-sees-unset",
    "with every downstream decision fixed, no sweep hold may delay the parent",
  );
  assert.deepEqual(events, ["G", "C", "X"], "the parent's post-child call must beat the deferred dispatch");
});

test("the sweep's relevance is evaluated when the child settles, not at the workflow() call (#231 R19)", async () => {
  // The predicate reads the parent frame's firstEdit, gaps and callSeq, and
  // all three keep changing between the workflow() call and the child's
  // settlement. An eager call-site snapshot engages the one-macrotask hold in
  // shapes where nothing downstream can still change, flipping the parent's
  // post-child ordering vs a prefix resume. Four instances, one root cause;
  // each scenario below asserts replay-completed matches prefix exactly. The
  // event list doubles as the liveness check: a call replays from cache iff
  // its prompt never reaches the runner.
  const child = `export const meta = { name: 'kidR19', description: 'k' }
let release;
const gate = new Promise((r) => { release = r; });
const p = (async () => { await gate; const x = await agent('X'); return x; })().catch(() => {});
let c = Promise.resolve();
c = c.then(() => {});
c = c.then(() => {});
c = c.then(() => Promise.resolve());
c.then(() => { release(); });
return 'kid-done'`;

  const capture = async (runId: string, parent: string, run1Agent: (prompt: string) => string) => {
    const journal: JournalEntry[] = [];
    await runWorkflow(parent, {
      agent: {
        async run(prompt: string) {
          return run1Agent(prompt);
        },
      },
      persistLogs: false,
      runId,
      loadSavedWorkflow: (name) => (name === "kidR19" ? child : undefined),
      onAgentJournal: (e) => journal.push(e),
    });
    return journal;
  };
  // Runs prefix then replay-completed against the captured journal; the agent
  // handles X (the deferred child dispatch) and C (the parent's post-child
  // call) itself and delegates any other prompt to scenarioAgent.
  const runPair = async (
    runId: string,
    parent: string,
    scenarioAgent: (prompt: string) => string,
    journal: JournalEntry[],
  ) => {
    const observe = async (mode: "prefix" | "replay-completed") => {
      const events: string[] = [];
      let side = "unset";
      const out = await runWorkflow<{ w: string; c: string }>(parent, {
        agent: {
          async run(prompt: string) {
            events.push(prompt);
            if (prompt === "X") {
              side = "set";
              return "x-done";
            }
            if (prompt === "C") return `c-sees-${side}`;
            return scenarioAgent(prompt);
          },
        },
        persistLogs: false,
        runId,
        loadSavedWorkflow: (name) => (name === "kidR19" ? child : undefined),
        resumeJournal: journalMap(journal),
        resumeMode: mode,
      });
      return { c: out.result.c, events };
    };
    return { prefix: await observe("prefix"), replay: await observe("replay-completed") };
  };
  const keys = (journal: JournalEntry[]) => journal.map((e) => `${e.runId}:${e.index}`);
  // The shared fan-out parent for scenarios (a), (b) and (d): the workflow()
  // call and one sibling agent() share a single dispatch window.
  const mkParallelParent = (name: string, sibling: string) => `export const meta = { name: '${name}', description: 'p' }
let wp;
parallel([
  () => { wp = workflow('kidR19'); return 'w-started'; },
  () => agent('${sibling}'),
]);
const w = await wp;
const c = await agent('C');
return { w, c }`;

  // (a) A gap dispatched in the same window AFTER the workflow() call: no gap
  // exists at the call site, but G's gap is present when the child settles and
  // shadows every post-window call, so the hold can change nothing.
  {
    const parent = mkParallelParent("parR19A", "G");
    const journal = await capture("r19-a", parent, (prompt) => (prompt === "C" ? "C-r" : ""));
    assert.deepEqual(keys(journal), ["r19-a:1"], "only C journals; G's run-1 failure leaves a gap");
    const { prefix, replay } = await runPair("r19-a", parent, () => "", journal);
    assert.deepEqual(prefix, { c: "c-sees-unset", events: ["G", "C", "X"] }, "prefix: C beats the deferred X");
    assert.deepEqual(replay, prefix, "a post-call same-window gap must not engage the sweep");
  }

  // (b) No gap at all: the only journal entry at an index >= the call-site
  // callSeq belongs to S, dispatched later in the SAME window — a decision
  // already made synchronously, wrongly counted as "downstream" by an eager
  // snapshot. Lazily, callSeq has advanced past S's index and the probe is
  // false. S absent from the event lists = S replays from its entry.
  {
    const parent = mkParallelParent("parR19B", "S");
    const journal = await capture("r19-b", parent, (prompt) => (prompt === "S" ? "S-r" : ""));
    assert.deepEqual(keys(journal), ["r19-b:0"], "only the in-window sibling S journals");
    const { prefix, replay } = await runPair("r19-b", parent, () => "", journal);
    assert.deepEqual(prefix, { c: "c-sees-unset", events: ["C", "X"] }, "prefix: C beats the deferred X");
    assert.deepEqual(replay, prefix, "an in-window sibling entry must not engage the sweep");
  }

  // (c) A gap dispatched POST-window by a concurrent thunk (B, after A's
  // replay settles), with real entries on both sides (A and C journal): the
  // reachability conjunct is genuinely satisfied, so only the gap conjunct
  // can keep the sweep out — and only its exact form (B's gap is
  // generation-undefined, which a same-window-gen check cannot see). C
  // present in both event lists = C runs live, shadowed by B's gap.
  {
    const parent = `export const meta = { name: 'parR19C', description: 'p' }
let wp;
parallel([
  () => agent('A').then(() => agent('B')),
  () => { wp = workflow('kidR19'); return 'w-started'; },
]);
const w = await wp;
const c = await agent('C');
return { w, c }`;
    const aOrC = (prompt: string) => (prompt === "A" ? "A-r" : prompt === "C" ? "C-r" : "");
    const journal = await capture("r19-c", parent, aOrC);
    assert.deepEqual(keys(journal), ["r19-c:0", "r19-c:2"], "A and C journal; B's post-window failure leaves a gap");
    const { prefix, replay } = await runPair("r19-c", parent, aOrC, journal);
    assert.deepEqual(prefix, { c: "c-sees-unset", events: ["B", "C", "X"] }, "prefix: C beats the deferred X");
    assert.deepEqual(replay, prefix, "a post-window gap from a concurrent thunk must not engage the sweep");
  }

  // (d) An EDIT dispatched after the workflow() call: run 2's script prompts
  // G2 where run 1 prompted G — same index, new hash — so firstEdit advances
  // but no gap is pushed, invisible to the gaps conjunct. Every future call
  // is already blocked (index >= firstEdit), so only a live firstEdit read
  // keeps the sweep out (#231 R20).
  {
    const gOrC = (prompt: string) => (prompt === "G" ? "G-r" : prompt === "C" ? "C-r" : "");
    const journal = await capture("r19-d", mkParallelParent("parR19D", "G"), gOrC);
    assert.deepEqual(keys(journal), ["r19-d:0", "r19-d:1"], "G and C journal in run 1");
    const { prefix, replay } = await runPair("r19-d", mkParallelParent("parR19D", "G2"), () => "", journal);
    assert.deepEqual(prefix, { c: "c-sees-unset", events: ["G2", "C", "X"] }, "prefix: C beats the deferred X");
    assert.deepEqual(replay, prefix, "a post-call edit must not engage the sweep");
  }
});

test("a later sibling frame's journal entries keep the zero-entry sweep engaged (#231 R18/R21)", async () => {
  // kidA is zero-entry with a deferred first dispatch; kidB has a journaled
  // call. kidA's sweep relevance comes ONLY from the nestedFrames disjunct
  // (the parent frame has no journaled call of its own). The hold lets kidA's
  // deferred gap land before its settle, the advance breaks kidB's prefix at
  // ITS dispatch, and kidB's Y re-runs live. Without the disjunct, Y replays
  // STALE — an invariant-2 defect, not an ordering residue (#231 R21 F3).
  const childA = `export const meta = { name: 'kidA', description: 'a' }
let release;
const gate = new Promise((r) => { release = r; });
const p = (async () => { await gate; const x = await agent('X'); return x; })().catch(() => {});
let c = Promise.resolve();
c = c.then(() => {});
c = c.then(() => {});
c = c.then(() => Promise.resolve());
c.then(() => { release(); });
return 'a-done'`;
  const childB = `export const meta = { name: 'kidB', description: 'b' }
const y = await agent('Y');
return y`;
  const parent = `export const meta = { name: 'parSib', description: 'p' }
const a = await workflow('kidA');
const b = await workflow('kidB');
return { a, b }`;
  const load = (name: string) => (name === "kidA" ? childA : name === "kidB" ? childB : undefined);

  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        return prompt === "X" ? "" : `r:${prompt}`;
      },
    },
    persistLogs: false,
    runId: "r21-sib",
    loadSavedWorkflow: load,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => `${e.runId}:${e.index}`),
    ["r21-sib-nested2:0"],
    "only kidB's Y journals; kidA stays zero-entry",
  );

  const resume = async (mode: "prefix" | "replay-completed") => {
    const events: string[] = [];
    let side = "unset";
    const out = await runWorkflow<{ b: string }>(parent, {
      agent: {
        async run(prompt: string) {
          events.push(prompt);
          if (prompt === "X") {
            side = "set";
            return "x-done";
          }
          return `Y-sees-${side}`;
        },
      },
      persistLogs: false,
      runId: "r21-sib",
      loadSavedWorkflow: load,
      resumeJournal: journalMap(journal),
      resumeMode: mode,
    });
    return { b: out.result.b, events };
  };
  const prefix = await resume("prefix");
  assert.deepEqual(prefix, { b: "r:Y", events: ["X"] }, "prefix: kidB replays Y from its entry");
  const replay = await resume("replay-completed");
  assert.deepEqual(
    replay,
    { b: "Y-sees-set", events: ["X", "Y"] },
    "kidA's sweep must hold so kidB's inheritance goes live instead of replaying stale",
  );
});

test("the sweep probe's firstEdit boundary is strict: a sibling advance to exactly callSeq keeps it out (#231 R21)", async () => {
  // kidFull has an entry (F1) and a gap (F2), so its settle advances the
  // parent's firstEdit to the parent's callSeq (0 — the parent has dispatched
  // nothing when kidFull settles). kidSlow is zero-entry; its deferred X's
  // gate chain starts only after SLOW settles, so the child's settle and the
  // parent's C race at ~equal jobs. At firstEdit === callSeq the hold buys
  // nothing (journalReplayAllowed forces index === firstEdit live), so the
  // probe must be false with a STRICT >; a >= form engages it and flips C
  // past X (#231 R21 F2).
  const kidFull = `export const meta = { name: 'kidFull', description: 'k' }
const a = await agent('F1');
const b = await agent('F2-' + a);
return { a, b }`;
  const kidSlow = `export const meta = { name: 'kidSlow', description: 'k' }
await agent('SLOW');
let release;
const gate = new Promise((r) => { release = r; });
const p = (async () => { await gate; const x = await agent('X'); return x; })().catch(() => {});
let c = Promise.resolve();
c = c.then(() => Promise.resolve());
c = c.then(() => Promise.resolve());
c.then(() => { release(); });
return 'kid-done'`;
  const parent = `export const meta = { name: 'parBound', description: 'p' }
let w1p, w2p;
parallel([
  () => { w1p = workflow('kidFull'); return 'a'; },
  () => { w2p = workflow('kidSlow'); return 'b'; },
]);
const w1 = await w1p;
const w2 = await w2p;
const c = await agent('C');
return { w1, w2, c }`;
  const load = (name: string) => (name === "kidFull" ? kidFull : name === "kidSlow" ? kidSlow : undefined);

  const journal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        if (prompt === "F1") return "F1-r";
        if (prompt === "C") return "C-r";
        if (prompt === "SLOW") await new Promise((r) => setTimeout(r, 30));
        return ""; // F2, SLOW and X leave no entries
      },
    },
    persistLogs: false,
    runId: "r21-bound",
    loadSavedWorkflow: load,
    onAgentJournal: (e) => journal.push(e),
  });

  const events: string[] = [];
  let side = "unset";
  let cLive = 0;
  const resumed = await runWorkflow<{ c: string }>(parent, {
    agent: {
      async run(prompt: string) {
        events.push(prompt);
        if (prompt === "X") {
          side = "set";
          return "x-done";
        }
        if (prompt === "C") {
          cLive++;
          return `c-sees-${side}`;
        }
        if (prompt === "F1") return "F1-r";
        if (prompt === "SLOW") await new Promise((r) => setTimeout(r, 30));
        return "";
      },
    },
    persistLogs: false,
    runId: "r21-bound",
    loadSavedWorkflow: load,
    resumeJournal: journalMap(journal),
    resumeMode: "replay-completed",
  });
  assert.equal(cLive, 1, "C at index === firstEdit runs live by design");
  assert.equal(resumed.result.c, "c-sees-unset", "no hold may delay the parent behind kidSlow's deferred X");
  assert.deepEqual(events, ["SLOW", "F2-F1-r", "C", "X"]);
});

test("an unusable cached entry (empty output) is an edit, not a gap, in replay-completed mode", async () => {
  // Defensive branch: organic empty output is never journaled, but a legacy or
  // hand-edited journal CAN hold an unusable entry. It must pin firstEdit
  // (whole suffix live) rather than degrade to a batch-shadowed gap.
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "empty-cached-run",
    onAgentJournal: (e) => journal.push(e),
  });
  const tampered = journalMap(journal.map((e) => (e.index === 1 ? { ...e, result: "" } : e)));

  const second = countingAgent();
  await runWorkflow(threeCallScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "empty-cached-run",
    resumeJournal: tampered,
    resumeMode: "replay-completed",
  });
  assert.equal(second.state.calls, 2, "the unusable entry (1) and its whole suffix (2) re-run; only 0 replays");
});

test("an invalid resumeMode value falls back to prefix with a warning", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "bad-mode-run",
    onAgentJournal: (e) => journal.push(e),
  });

  const logs: string[] = [];
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "bad-mode-run",
    resumeJournal: journalMap(journal),
    resumeMode: "bogus" as unknown as "prefix",
    onLog: (message) => logs.push(message),
  });
  assert.equal(second.state.calls, 2, "invalid mode falls back to prefix: the edit and its suffix re-run");
  assert.ok(
    logs.some((message) => message.includes("ignoring invalid resumeMode")),
    "the fallback is logged",
  );
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("workflow() runs a nested saved workflow and shares the global agent counter", async () => {
  const child = `export const meta = { name: 'child', description: 'c' }
const r = await agent('child task', { label: 'c' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await agent('parent task', { label: 'p' })
const nested = await workflow('child', { foo: 1 })
return { a, nested }`;

  const result = await runWorkflow<{ a: string; nested: { child: string } }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.result.nested.child, "ran:child task");
});

test("nested workflows share named agent threads with their parent", async () => {
  const turns = new Map<string, string[]>();
  const runner = {
    async run(prompt: string, options?: { thread?: string }) {
      const thread = options?.thread ?? "one-shot";
      const prior = turns.get(thread) ?? [];
      prior.push(prompt);
      turns.set(thread, prior);
      return prior.join(" -> ");
    },
  };
  const child = `export const meta = { name: 'child_thread', description: 'continue parent thread' }
return await agent('child', { thread: 'implementer' })`;
  const parent = `export const meta = { name: 'parent_thread', description: 'share thread with child' }
const first = await agent('parent-before', { thread: 'implementer' })
const nested = await workflow('child')
const last = await agent('parent-after', { thread: 'implementer' })
return { first, nested, last }`;

  const result = await runWorkflow<{ first: string; nested: string; last: string }>(parent, {
    agent: runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });

  assert.deepEqual(turns.get("implementer"), ["parent-before", "child", "parent-after"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    first: "parent-before",
    nested: "parent-before -> child",
    last: "parent-before -> child -> parent-after",
  });
});

test("a nested threaded call invalidates later parent journal entries", async () => {
  const script = `export const meta = { name: 'parent_resume_barrier', description: 'propagate child barrier' }
const before = await agent('before')
await workflow('child')
const after = await agent('after')
const confirmed = await checkpoint('confirm', { default: false })
return { before, after, confirmed }`;
  const child = `export const meta = { name: 'child_resume_barrier', description: 'thread barrier' }
return await agent('threaded child', { thread: 'implementer' })`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    runId: "nested-thread-barrier",
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
    confirm: async () => true,
    onAgentJournal: (entry) => journal.push(entry),
  });

  const resumed = countingAgent();
  let confirmations = 0;
  const result = await runWorkflow<{ before: string; after: string; confirmed: boolean }>(script, {
    agent: resumed.runner,
    runId: "nested-thread-barrier",
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    resumeFromRunId: "nested-thread-barrier",
    confirm: async () => {
      confirmations++;
      return false;
    },
  });

  assert.equal(resumed.state.calls, 2, "the child thread and later parent agent both run live");
  assert.equal(confirmations, 1, "the later parent checkpoint also runs live");
  assert.equal(result.result.confirmed, false);
});

test("sequential nested workflows assign distinct opaque agent identities", async () => {
  const agentIds: string[] = [];
  const childScript = `export const meta = { name: 'child', description: 'one child agent' }
return await agent('child work', { label: 'worker' })`;
  await runWorkflow(
    `export const meta = { name: 'parent', description: 'two sequential child workflows' }
const first = await workflow('child')
const second = await workflow('child')
return [first, second]`,
    {
      agent: fakeAgent(),
      loadSavedWorkflow: (name) => (name === "child" ? childScript : undefined),
      onAgentStart: (event) => agentIds.push(event.id),
      persistLogs: false,
    },
  );

  assert.equal(agentIds.length, 2);
  assert.equal(new Set(agentIds).size, 2);
});

test("parallel sibling workflows can each use the one allowed nesting level", async () => {
  const agentIds: string[] = [];
  const childScript = `export const meta = { name: 'child', description: 'parallel child' }
return await agent('child work', { label: 'worker' })`;
  const result = await runWorkflow<string[]>(
    `export const meta = { name: 'parent', description: 'parallel child workflows' }
return await parallel([
  () => workflow('child'),
  () => workflow('child'),
])`,
    {
      agent: fakeAgent({}, "child-result"),
      loadSavedWorkflow: (name) => (name === "child" ? childScript : undefined),
      onAgentStart: (event) => agentIds.push(event.id),
      persistLogs: false,
    },
  );

  assert.deepEqual(result.result, ["child-result", "child-result"]);
  assert.equal(new Set(agentIds).size, 2);
});

test("workflow() nesting is one level deep (second level throws)", async () => {
  const map: Record<string, string> = {
    gc: `export const meta = { name: 'gc', description: 'g' }
await agent('gc', { label: 'g' })
return 1`,
    child: `export const meta = { name: 'child', description: 'c' }
await workflow('gc')
return 2`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
let err = null
try { await workflow('child') } catch (e) { err = String(e && e.message || e) }
return { err }`;

  const result = await runWorkflow<{ err: string }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => map[name],
  });
  assert.match(result.result.err, /one level deep/);
});

test("sequential nested workflow() calls at the same depth get distinct child run ids (no cross-child id/deltaKey collision)", async () => {
  // `shared.depth` alone would give BOTH of these sequential children the
  // same `${runId}-nested1` suffix (depth returns to 0 between them, since
  // only one level of nesting is ever live at a time) — and each child's own
  // callSeq restarts at 0, so their first agent() calls would then compute
  // the identical deltaKey (also used as the onAgentStart/onAgentEnd event
  // id — see item 2's identity model), corrupting SharedStore deltas and
  // misattributing events. child1's agent() call is deliberately left
  // un-awaited — realistically, that's exactly when the collision bites:
  // the stray can still be in SharedRuntime.inFlight (only the top-level
  // frame drains, not each nested frame) when child2 starts and mints an id.
  const seenIds = new Set<string>();
  let duplicateId: string | undefined;
  const runner = {
    async run(prompt: string) {
      if (prompt === "child1-stray") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "child1-stray-done";
      }
      return `ran:${prompt}`;
    },
  };
  const scripts: Record<string, string> = {
    child1: `export const meta = { name: 'child1', description: 'c1' }
// Deliberately NOT awaited.
agent('child1-stray', { label: 'stray' })
return 'child1-done'`,
    child2: `export const meta = { name: 'child2', description: 'c2' }
const r = await agent('child2-live', { label: 'live' })
return r`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await workflow('child1')
const b = await workflow('child2')
return { a, b }`;

  const result = await runWorkflow<{ a: string; b: string }>(parent, {
    agent: runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => scripts[name],
    onAgentStart: (event) => {
      if (seenIds.has(event.id)) duplicateId = event.id;
      seenIds.add(event.id);
    },
  });
  assert.equal(result.result.a, "child1-done");
  assert.equal(result.result.b, "ran:child2-live");
  assert.equal(
    duplicateId,
    undefined,
    "child1's un-awaited stray and child2's live call must never share an id/deltaKey",
  );
});

test("runWorkflow budget gates on accumulated tokens", async () => {
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
const a = await agent('first', { label: 'a' })
let second = null
try { second = await agent('second', { label: 'b' }) } catch (e) { second = 'blocked' }
return { a, second }`;

  const result = await runWorkflow<{ a: unknown; second: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    tokenBudget: 100,
    persistLogs: false,
  });

  assert.equal(result.result.second, "blocked");
});

test("runWorkflow initialTokenUsage seeds the run-wide budget so it holds cumulatively across resume (#A2)", async () => {
  // Simulates what WorkflowManager.resume() passes: a prior execution already
  // spent 60 (persisted). This fresh execution's own SharedRuntime must start
  // counting from there — 'a' (allowed: seeded 60 + budget 100 leaves 40
  // headroom) then spends 60 more, landing at 120; 'b' must then be blocked,
  // even though neither the seed alone (60) nor 'a' alone (60) would trip it.
  const script = `export const meta = { name: 'seeded_budget', description: 'seed' }
const a = await agent('a', { label: 'a' })
let blocked = false
try { await agent('b', { label: 'b' }) } catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
return { a, blocked }`;

  const result = await runWorkflow<{ a: unknown; blocked: boolean }>(script, {
    agent: fakeAgent({ input: 60, output: 0, total: 60, cost: 0 }),
    tokenBudget: 100,
    initialTokenUsage: { input: 60, output: 0, total: 60, cost: 0, cacheRead: 0, cacheWrite: 0 },
    persistLogs: false,
  });

  assert.equal(result.result.a, "ok", "'a' itself is allowed to run (remaining was 40 > 0 before it)");
  assert.equal(
    result.result.blocked,
    true,
    "'b' must be blocked once the seeded + this-run spend sums past the budget",
  );
  assert.equal(result.tokenUsage?.total, 120, "final total reflects the seed (60) plus 'a's spend (60); 'b' never ran");
});

test("runWorkflow initialTokenUsage integrates correctly with phase() sub-budgets (seeded baseline isn't corrupted)", async () => {
  // phase()'s sub-budget bases itself on shared.spent AT the first
  // declaration (first-declaration-wins; a persisted baseline is adopted on
  // resume), so a seed doesn't make the phase's OWN ceiling trip any sooner
  // than usual — it only shifts the visible baseline. This mirrors the
  // existing "phase sub-budget throws..." test's budget/spend shape exactly,
  // plus a seed, to confirm seeding doesn't corrupt that mechanism.
  const script = `export const meta = { name: 'seeded_phase_budget', description: 'seed' }
const spentAtStart = budget.spent()
phase('noisy', { budget: 100 })
let blocked = false
await agent('a', { label: '1' })
try { await agent('b', { label: '2' }) } catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
return { spentAtStart, blocked }`;

  const result = await runWorkflow<{ spentAtStart: number; blocked: boolean }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    initialTokenUsage: { input: 40, output: 0, total: 40, cost: 0, cacheRead: 0, cacheWrite: 0 },
    persistLogs: false,
  });

  assert.equal(
    result.result.spentAtStart,
    40,
    "budget.spent() reflects the seed before any agent in this execution runs",
  );
  assert.equal(
    result.result.blocked,
    true,
    "the phase sub-budget still gates normally on top of a seeded run-wide total",
  );
});

test("token budget exhaustion inside parallel() halts (non-recoverable, not swallowed)", async () => {
  // A warm-up agent spends the whole budget (soft gate: spent accrues after it
  // finishes); the agent() inside parallel() then hits the gate and must
  // propagate the non-recoverable error, not become a null in the result array.
  const script = `export const meta = { name: 'pb', description: 'budget in parallel' }
await agent('warmup', { label: 'w' })
const xs = await parallel([() => agent('x', { label: '1' })])
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
        tokenBudget: 100,
        persistLogs: false,
      }),
    /budget/i,
    "exhausted budget must reject the run, not become a null in the result array",
  );
});

test("non-recoverable agent-limit propagates out of pipeline() too", async () => {
  const script = `export const meta = { name: 'mp', description: 'agent limit pipeline' }
const xs = await pipeline([0, 1, 2, 3], (n) => agent('x' + n, { label: 'p' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("phase sub-budget throws when a phase exceeds its ceiling (run total untouched)", async () => {
  const script = `export const meta = { name: 'pb', description: 'phase budget' }
phase('noisy', { budget: 100 })
let blocked = false
try {
  await agent('a', { label: '1' })
  await agent('b', { label: '2' })
} catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
phase('calm')
const after = await agent('c', { label: '3' })
return { blocked, after }`;
  const res = await runWorkflow<{ blocked: boolean; after: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    persistLogs: false,
  });
  assert.equal(res.result.blocked, true, "the 2nd agent in the phase hit the sub-budget");
  assert.ok(res.result.after !== null, "a later phase still proceeds");
});

test("maxAgents is enforced under a parallel() fan-out (atomic slot reservation)", async () => {
  // Four agents fan out with maxAgents=2. With the synchronous slot reservation,
  // the 3rd agent() throws AGENT_LIMIT instead of all four passing the gate.
  const script = `export const meta = { name: 'ma', description: 'agent limit' }
const xs = await parallel([0, 1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("a fan-out past maxAgents cancels queued agents instead of draining the reserved queue", async () => {
  // A parallel() overshoot reserves and queues up to maxAgents agents behind the
  // limiter. Before the fix, every reserved agent ran its real API call (spending)
  // even though the fan-out had already rejected; now the breach short-circuits the
  // still-queued agents so at most ~concurrency of them execute.
  const fanout = 100;
  const maxAgents = 50;
  const concurrency = 4;
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const runner = {
    async run(prompt: string) {
      calls.count++;
      await gate; // stay in-flight/queued while the limit breach propagates
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'c4', description: 'fanout cancel' }
const xs = await parallel(Array.from({ length: ${fanout} }, (_, i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  const run = runWorkflow(script, { agent: runner, maxAgents, concurrency, persistLogs: false });
  // The run now drains every in-flight agent() call (including these
  // gate-blocked ones) before its own promise settles — see the run-fatal
  // drain in runWorkflow's finally — so `run` will NOT reject until `gate`
  // resolves. Release it concurrently instead of after awaiting the
  // rejection (which would deadlock: nothing else ever calls release()).
  const releaseSoon = new Promise<void>((r) => setTimeout(r, 20)).then(() => release());
  await assert.rejects(run, /limit/i);
  await releaseSoon;
  // Deterministically exactly `concurrency`: the limiter runs the first
  // `concurrency` submissions' bodies synchronously during the reservation
  // pass (each immediately calls runner.run() and then suspends on `gate`);
  // every submission after that suspends on the limiter's internal queue
  // before it ever reaches runner.run(), and the batch is cancelled (via
  // fanoutScope) before any of them get their turn.
  assert.equal(calls.count, concurrency);
});

test("sibling parallel() batches are isolated: one breaching maxAgents does not cancel the other", async () => {
  // Two independent parallel() fan-outs run CONCURRENTLY inside the same run
  // (sharing one shared.agentCount / maxAgents), each isolated via its own
  // .then(ok, err). Batch A (3 agents) never breaches; batch B (40 agents)
  // does. Before batch-scoped cancellation, a run-global "limitReached" flag
  // would wrongly cancel A's still-queued agents too, purely because B (an
  // unrelated fan-out) breached the shared cap — that's the regression this
  // guards against.
  const maxAgents = 10;
  const concurrency = 2;
  const runner = {
    async run(prompt: string) {
      await new Promise((r) => setTimeout(r, 5));
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'sib', description: 'sibling isolation' }
const batchA = parallel(Array.from({ length: 3 }, (_, i) => () => agent('a' + i, { label: 'a' + i })))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e && e.code }))
const batchB = parallel(Array.from({ length: 40 }, (_, i) => () => agent('b' + i, { label: 'b' + i })))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e && e.code }))
const [a, b] = await Promise.all([batchA, batchB])
return { a, b }`;
  const res = await runWorkflow<{
    a: { ok: boolean; r?: unknown[] };
    b: { ok: boolean; code?: string };
  }>(script, { agent: runner, maxAgents, concurrency, persistLogs: false });

  assert.equal(res.result.a.ok, true, "batch A (never breaches) must resolve, not be cancelled by sibling B");
  assert.equal(res.result.a.r?.length, 3);
  assert.ok((res.result.a.r as unknown[]).every((r) => typeof r === "string" && r.startsWith("ran:")));

  assert.equal(res.result.b.ok, false, "batch B (breaches maxAgents) must reject");
  assert.equal(res.result.b.code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
});

test("a breach in a nested parallel() doesn't corrupt the outer batch's state", async () => {
  // Outer parallel() of two thunks; one thunk runs an inner parallel() that
  // breaches a low maxAgents. The breach should propagate as a rejection of
  // the whole run (agent limit is non-recoverable) without throwing anything
  // unexpected (e.g. an ALS/ordering bug corrupting shared.agentCount).
  const runner = {
    async run(prompt: string) {
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'nest', description: 'nested fanout' }
const xs = await parallel([
  () => agent('outer-1', { label: 'outer-1' }),
  () => parallel(Array.from({ length: 5 }, (_, i) => () => agent('inner' + i, { label: 'inner' + i }))),
])
return xs`;
  await assert.rejects(
    () => runWorkflow(script, { agent: runner, maxAgents: 2, concurrency: 2, persistLogs: false }),
    /limit/i,
  );
});

// ─── Additional edge case tests ─────────────────────────────────────────────────

test("runWorkflow returns meta, logs, phases, and duration", async () => {
  const ONE_AGENT = `export const meta = { name: 'meta_test', description: 'check metadata' }
const a = await agent('test', { label: 'a' })
return a`;

  const result = await runWorkflow(ONE_AGENT, {
    agent: fakeAgent({ total: 50 }),
    persistLogs: false,
  });

  assert.equal(result.meta.name, "meta_test");
  assert.equal(result.meta.description, "check metadata");
  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
  assert.ok(Array.isArray(result.phases), "result.phases should be an array");
  assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId should be a non-empty string");
});

test("runWorkflow handles empty script without phases gracefully", async () => {
  const SIMPLE = `export const meta = { name: 'simple', description: 'simple' }
const a = await agent('hello', { label: 'greeter' })
return a`;

  const result = await runWorkflow(SIMPLE, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.equal(result.result, "done");
  assert.equal(result.agentCount, 1);
});

test("runWorkflow parallel returns results in input order", async () => {
  const script = `export const meta = { name: 'parallel_order', description: 'check order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n, { label: 't' + n })))
return results`;

  let callIndex = 0;
  const agent = {
    async run(prompt: string) {
      return `result-${++callIndex}:${prompt}`;
    },
  };

  const result = await runWorkflow<unknown[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 3);
});

test("runWorkflow pipeline stages in order", async () => {
  const script = `export const meta = { name: 'pipeline_test', description: 'test pipeline' }
const results = await pipeline(['a','b'], item => agent('stage1 ' + item), result => agent('stage2 ' + result))
return results`;

  const log: string[] = [];
  const agent = {
    async run(prompt: string) {
      log.push(prompt);
      return prompt.replace("stage1", "stage1-done").replace("stage2", "stage2-done");
    },
  };

  const result = await runWorkflow<string[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 2);
});

test("pipeline forwards a recoverable null to the next stage with original item and index", async () => {
  const script = `export const meta = { name: 'pipeline_null', description: 'null forwarding' }
const results = await pipeline(
  ['alpha'],
  (item) => agent('first ' + item, { label: 'first' }),
  (previousValue, originalItem, index) => ({ previousValue, originalItem, index }),
)
return results`;
  const agent = {
    async run() {
      throw new Error("recoverable first-stage failure");
    },
  };

  const result = await runWorkflow<Array<{ previousValue: null; originalItem: string; index: number }>>(script, {
    agent,
    persistLogs: false,
  });

  assert.deepEqual(
    Array.from(result.result, ({ previousValue, originalItem, index }) => ({ previousValue, originalItem, index })),
    [{ previousValue: null, originalItem: "alpha", index: 0 }],
  );
});

test("runWorkflow agent with different labels", async () => {
  const script = `export const meta = { name: 'label_test', description: 'labels' }
const a = await agent('task1', { label: 'worker-1' })
const b = await agent('task2', { label: 'worker-2' })
return { a, b }`;

  const seenLabels: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentStart: (e) => seenLabels.push(e.label),
  });

  assert.deepEqual(seenLabels, ["worker-1", "worker-2"]);
});

test("runWorkflow with phases assignment to agents", async () => {
  const script = `export const meta = { name: 'phase_test', description: 'phases', phases: [{ title: 'Phase1' }, { title: 'Phase2' }] }
phase('Phase1')
const a = await agent('phase1 work', { label: 'p1' })
phase('Phase2')
const b = await agent('phase2 work', { label: 'p2' })
return { a, b }`;

  const phases: string[] = [];
  const agentPhases: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onAgentStart: (e) => {
      if (e.phase) agentPhases.push(e.phase);
    },
  });

  assert.ok(phases.includes("Phase1"), "should contain Phase1");
  assert.ok(phases.includes("Phase2"), "should contain Phase2");
});

test("runWorkflow can send args to the script", async () => {
  const script = `export const meta = { name: 'args_test', description: 'test args' }
return { received: args && args.value }`;

  const result = await runWorkflow<{ received: unknown }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    args: { value: 42 },
  });

  // No agent calls means 0 agents
  assert.equal(result.result.received, 42);
});

test("runWorkflow log function works inside script", async () => {
  const script = `export const meta = { name: 'log_test', description: 'logging' }
log('hello from script')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("hello from script")),
    "should contain hello from script",
  );
});

test("runWorkflow console.log works inside script", async () => {
  const script = `export const meta = { name: 'console_test', description: 'console' }
console.log('console log')
console.warn('console warn')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("console log")),
    "should contain console log",
  );
  assert.ok(
    result.logs.some((l) => l.includes("console warn")),
    "should contain console warn",
  );
});

test("runWorkflow process.cwd() works inside script", async () => {
  const script = `export const meta = { name: 'cwd_test', description: 'cwd' }
return { cwd: process.cwd() }`;

  const result = await runWorkflow<{ cwd: string }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.equal(typeof result.result.cwd, "string");
  assert.ok(result.result.cwd.length > 0, "result.cwd should not be empty");
});

test("runWorkflow budget object exposes spent() and remaining()", async () => {
  const script = `export const meta = { name: 'budget_api', description: 'budget API' }
try { const s = budget.spent(); const r = budget.remaining(); return { spent: s, remaining: typeof r } }
catch(e) { return { error: String(e) } }`;

  const result = await runWorkflow<{ spent: number; remaining: string }>(script, {
    agent: fakeAgent({ total: 100 }),
    persistLogs: false,
  });

  assert.equal(result.result.spent, 0); // before first agent
  assert.equal(result.result.remaining, "number");
});

test("runWorkflow returns empty logs array when nothing logged", async () => {
  const script = `export const meta = { name: 'no_log', description: 'no logs' }
await agent('silent', { label: 's' })
return 1`;

  const result = await runWorkflow(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
});

// ─── Runtime determinism hardening (P0-5) ───────────────────────────────────────

const noopAgent = {
  async run() {
    return "ok";
  },
};

function probe(expr: string): Promise<{ result: { err: string | null; val: unknown } }> {
  const script = `export const meta = { name: 'det', description: 'determinism' }
let err = null, val = null
try { val = ${expr} } catch (e) { err = String((e && e.message) || e) }
await agent('noop', { label: 'x' })
return { err, val }`;
  return runWorkflow(script, { agent: noopAgent, persistLogs: false });
}

test("parse-time guard rejects literal Date.now / Math.random / new Date()", async () => {
  for (const expr of ["Math.random()", "Date.now()", "new Date()"]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'lit', description: 'd' }\nconst v = ${expr}\nawait agent('x', { label: 'x' })\nreturn v`,
          { agent: noopAgent, persistLogs: false },
        ),
      /deterministic|unavailable/i,
      `${expr} literal should be rejected at parse time`,
    );
  }
});

test("parse-time guard preserves the source blocklist used by existing workflows", () => {
  for (const forbidden of ["Date.now()", "Math.random()", "new Date()"]) {
    const script = `export const meta = { name: 'blocked-prose', description: 'fixture' }
// ${forbidden} is unavailable here.
const warning = ${JSON.stringify(`Do not call ${forbidden}`)}
return { warning }`;

    assert.throws(() => parseWorkflowScript(script), /deterministic|unavailable/i);
  }
});

test("runtime guard neuters computed-access bypasses the parse regex misses", async () => {
  const r1 = await probe('Math["random"]()');
  assert.match(r1.result.err ?? "", /unavailable|resume/i, 'Math["random"]() should throw at runtime');
  const r2 = await probe('Date["now"]()');
  assert.match(r2.result.err ?? "", /unavailable|resume/i, 'Date["now"]() should throw at runtime');
  const r3 = await probe("(() => { const D = Date; return new D(); })()");
  assert.match(r3.result.err ?? "", /unavailable|resume/i, "aliased no-arg Date should throw at runtime");
});

test("runtime determinism: new Date(arg) and Math.max still work", async () => {
  const d = await probe("new Date(0).getTime()");
  assert.equal(d.result.err, null, "new Date(0) should construct");
  assert.equal(d.result.val, 0, "new Date(0).getTime() === 0");
  const m = await probe("Math.max(1, 2, 3)");
  assert.equal(m.result.err, null);
  assert.equal(m.result.val, 3);
});

test("vm-realm builtins work and the constructor escape hits the neutered Date.now", async () => {
  // The escape string is split so the parse-time regex doesn't flag it; at runtime
  // the vm Function runs in the vm realm where Date.now is neutered.
  const script = `export const meta = { name: 'vm', description: 'vm realm' }
let escaped = null
try { escaped = ({}).constructor.constructor('return Da' + 'te.now()')() } catch (e) { escaped = 'blocked:' + String((e && e.message) || e) }
const arr = [1, 2, 3].map((x) => x * 2)
const j = JSON.stringify({ a: 1 })
const s = [...new Set([1, 1, 2])]
await agent('noop', { label: 'x' })
return { escaped, arr, j, s }`;
  const r = await runWorkflow<{ escaped: string; arr: number[]; j: string; s: number[] }>(script, {
    agent: noopAgent,
    persistLogs: false,
  });
  // Spread to a host array: vm-realm arrays don't deepStrictEqual host literals.
  assert.deepEqual([...r.result.arr], [2, 4, 6], "vm Array.map works");
  assert.equal(r.result.j, '{"a":1}', "vm JSON works");
  assert.deepEqual([...r.result.s], [1, 2], "vm Set works");
  // ({}).constructor.constructor is the vm Function; its code runs in the vm realm
  // where Date.now is neutered -> blocked (the old host-object escape is closed).
  assert.match(r.result.escaped, /blocked/, "constructor escape via vm objects is closed");
});

// ── Run-fatal abort: a non-recoverable error that will fail the whole run
// must stop in-flight siblings from continuing to spend, while preserving
// parallel()'s null-on-recoverable-error contract and a script's own
// try/catch around agent()/parallel(). ──

/** An agent runner whose in-flight calls actually respect an abort signal. */
function abortAwareAgent(delayMs: number) {
  const state = { started: 0, completed: 0, aborted: 0 };
  return {
    state,
    runner: {
      async run(prompt: string, options: { signal?: AbortSignal } = {}) {
        state.started++;
        if (prompt === "failer") {
          throw new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        }
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            state.completed++;
            resolve(`done:${prompt}`);
          }, delayMs);
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              state.aborted++;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    },
  };
}

test("onRunFatal consumes an asynchronous observer rejection without masking the workflow error", async () => {
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  const script = `export const meta = { name: 'fatal_observer', description: 'fatal observer' }
await agent('failer')`;
  const runner = {
    async run() {
      throw new WorkflowError("primary workflow failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
        recoverable: false,
      });
    },
  };

  try {
    await assert.rejects(
      runWorkflow(script, {
        agent: runner,
        persistLogs: false,
        onRunFatal: async () => {
          throw new Error("observer rejection");
        },
      }),
      /primary workflow failure/,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(unhandled, undefined, "observer rejection must be consumed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a run-fatal error aborts in-flight parallel() siblings instead of letting them run to completion", async () => {
  const { state, runner } = abortAwareAgent(200);
  const script = `export const meta = { name: 'fatal_abort', description: 'sibling abort' }
const xs = await parallel([
  () => agent('failer', { label: 'failer' }),
  () => agent('sib1', { label: 'sib1' }),
  () => agent('sib2', { label: 'sib2' }),
])
return xs`;
  await assert.rejects(runWorkflow(script, { agent: runner, persistLogs: false }), /boom/);
  // Both in-flight siblings must have been aborted before their (200ms)
  // delay would otherwise have let them complete and return a result.
  assert.equal(state.started, 3, "all three agent() calls actually started");
  assert.equal(state.aborted, 2, "both siblings were aborted once the run's fate was sealed");
  assert.equal(state.completed, 0, "no sibling ran to completion on a run that's already failing");
});

test("a script's own try/catch around parallel() preserves in-flight siblings — no run-fatal abort", async () => {
  const { state, runner } = abortAwareAgent(20);
  const script = `export const meta = { name: 'fatal_abort_caught', description: 'sibling survives caught failure' }
let caught = false
try {
  await parallel([
    () => agent('failer', { label: 'failer' }),
    () => agent('sib1', { label: 'sib1' }),
  ])
} catch (e) {
  caught = true
}
// A later agent() call must still work normally — the run's fate was never
// sealed because the script caught parallel()'s escaping error.
const after = await agent('after', { label: 'after' })
return { caught, after }`;
  const result = await runWorkflow<{ caught: boolean; after: string }>(script, {
    agent: runner,
    persistLogs: false,
  });
  assert.equal(result.result.caught, true, "the script's own try/catch saw parallel()'s escaping error");
  assert.equal(result.result.after, "done:after", "a later agent() call still runs normally, unaborted");
  assert.equal(state.aborted, 0, "the caught sibling was never aborted — the run's fate was never sealed");
  assert.equal(state.completed, 2, "the caught sibling and the later agent() both ran to completion");
});

test("parallel()'s recoverable-error-to-null contract does not seal the run's fate (siblings unaffected)", async () => {
  const { state, runner } = abortAwareAgent(20);
  // A plain (non-WorkflowError) throw from a thunk is classified recoverable by
  // wrapError()'s default — parallel() must swallow it to null, not rethrow,
  // and must NOT abort the sibling still in flight.
  const script = `export const meta = { name: 'recoverable_null', description: 'recoverable swallowed' }
const xs = await parallel([
  () => { throw new Error('plain failure') },
  () => agent('sib', { label: 'sib' }),
])
return xs`;
  const result = await runWorkflow<Array<unknown>>(script, { agent: runner, persistLogs: false });
  assert.deepEqual(result.result, [null, "done:sib"], "the thrown thunk resolves to null; the sibling still succeeds");
  assert.equal(state.aborted, 0, "a recoverable, swallowed-to-null error must never trigger a run-fatal abort");
  assert.equal(state.completed, 1);
});

test("a parent script that catches a nested workflow()'s uncaught child error can still run agents afterward (isTopLevelRun gate)", async () => {
  // Only the TOP-level frame is allowed to seal shared.runFatalController (see
  // isTopLevelRun in runWorkflow's catch) — a NESTED frame reaching its own
  // catch must never seal it, because the error hasn't finished propagating
  // yet: the parent script may still catch workflow()'s rejection and
  // continue normally. If a nested frame sealed it too (the mutation this
  // test targets — dropping the isTopLevelRun guard), the shared runtime
  // (shared between parent and child via sharedRuntime) would already be
  // aborted by the time control returns to the parent's catch block, so the
  // parent's own SUBSEQUENT agent() call would be aborted before it could
  // even start — even though the parent legitimately handled the failure.
  const { state, runner } = abortAwareAgent(20);
  const child = `export const meta = { name: 'child', description: 'c' }
await agent('failer', { label: 'child-failer' })
return 1`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
let caught = false
try {
  await workflow('child')
} catch (e) {
  caught = true
}
const after = await agent('after', { label: 'after' })
return { caught, after }`;

  const result = await runWorkflow<{ caught: boolean; after: string }>(parent, {
    agent: runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });
  assert.equal(result.result.caught, true, "the parent's own try/catch saw the child workflow's escaping error");
  assert.equal(result.result.after, "done:after", "a later agent() call must still run normally after the catch");
  assert.equal(state.aborted, 0, "sealing at the child (nested) level must never abort the parent's own later agent");
});

// ── Un-awaited agent() calls must not outlive the run: the run drains every
// spawned agent() call (awaited or not) before it is allowed to complete. ──

test("an un-awaited agent() call is drained before the run completes", async () => {
  let strayCompleted = false;
  const runner = {
    async run(prompt: string) {
      if (prompt === "stray") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        strayCompleted = true;
        return "stray-done";
      }
      return "main-done";
    },
  };
  const script = `export const meta = { name: 'stray_demo', description: 'un-awaited agent' }
// Deliberately NOT awaited — a script bug the run must tolerate without
// letting this call outlive the run's completion.
agent('stray', { label: 'stray' })
const main = await agent('main', { label: 'main' })
return main`;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(result.result, "main-done");
  assert.equal(strayCompleted, true, "the run must not complete until the un-awaited agent has settled");
  assert.ok(
    journal.some((e) => e.result === "stray-done"),
    "the stray agent's completion must be journaled before the run ends",
  );
});

test("an un-awaited agent() call replays deterministically from the journal on resume", async () => {
  const calls = { stray: 0, main: 0 };
  const runner = {
    async run(prompt: string) {
      if (prompt === "stray") {
        calls.stray++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "stray-done";
      }
      calls.main++;
      return "main-done";
    },
  };
  const script = `export const meta = { name: 'stray_resume_demo', description: 'un-awaited agent replay' }
agent('stray', { label: 'stray' })
const main = await agent('main', { label: 'main' })
return main`;
  const journalEntries = new Map<string, JournalEntry>();
  const first = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    runId: "prior-run",
    onAgentJournal: (entry) => journalEntries.set(`${entry.runId}:${entry.index}`, entry),
  });
  assert.equal(first.result, "main-done");
  assert.equal(calls.stray, 1);
  assert.equal(calls.main, 1);

  const second = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    runId: "prior-run",
    resumeJournal: journalEntries,
    resumeFromRunId: "prior-run",
  });
  assert.equal(second.result, "main-done");
  // Resume replays BOTH cached calls (including the un-awaited 'stray') from
  // the journal — neither runner.run() is invoked again.
  assert.equal(calls.stray, 1, "the un-awaited agent's cached result must replay, not re-run, on resume");
  assert.equal(calls.main, 1, "the awaited agent's cached result must replay, not re-run, on resume");
});

test("nested workflow() frames use the run's registry snapshot (audit2 #6)", async () => {
  // REAL scenario: no injected registry — the registry is loaded from
  // <cwd>/.pi/agents at run start. The fake runner DELETES the .md mid-run
  // (during the parent's first call); the nested frame must still resolve the
  // sentinel definition from the forwarded snapshot, not re-load from disk.
  const cwd = mkdtempSync(join(tmpdir(), "pdw-registry-"));
  const agentsDir = join(cwd, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const defPath = join(agentsDir, "sentinel.md");
  writeFileSync(defPath, "---\nname: sentinel\ndescription: temp\n---\nSENTINEL-INSTRUCTIONS\n");
  const child = `export const meta = { name: 'child', description: 'c' }
const r = await agent('child task', { agentType: 'sentinel' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
await agent('parent task')
const nested = await workflow('child')
return { nested }`;
  const seenInstructions: (string | undefined)[] = [];
  let calls = 0;
  try {
    const result = await runWorkflow<{ nested: { child: string } }>(parent, {
      cwd,
      agent: {
        async run(_prompt: string, options: { instructions?: string }) {
          calls++;
          seenInstructions.push(options.instructions);
          if (calls === 1) rmSync(defPath); // mid-run registry edit
          return "ok";
        },
      },
      loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
      persistLogs: false,
    });
    assert.equal(result.result.nested.child, "ok");
    const childInstructions = seenInstructions[1];
    assert.ok(
      childInstructions?.includes("SENTINEL-INSTRUCTIONS"),
      `nested frame resolved the run-start registry snapshot, got: ${childInstructions?.slice(0, 120)}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agent() retries back off between attempts (audit2 #7)", async () => {
  const script = `export const meta = { name: 'retry_bo', description: 'retry backoff' }
const r = await agent('flaky', { label: 'flaky' })
return r`;
  const backoffs: number[] = [];
  let attempts = 0;
  const started = Date.now();
  const result = await runWorkflow<string>(script, {
    agent: {
      async run() {
        attempts++;
        if (attempts < 3) {
          throw new WorkflowError("empty", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
        }
        return "recovered";
      },
    },
    agentRetries: 3,
    agentRetryBackoffMs: (failedAttempt) => {
      backoffs.push(failedAttempt);
      return 40;
    },
    persistLogs: false,
  });
  assert.equal(result.result, "recovered");
  assert.deepEqual(backoffs, [1, 2], "backoff consulted per failed attempt");
  assert.ok(Date.now() - started >= 75, "the waits actually elapsed (2 × 40ms)");
});

test("agent() uses the default 250ms backoff for the first retry when no callback is injected", async () => {
  const script = `export const meta = { name: 'retry_default', description: 'default backoff' }
return await agent('flaky')`;
  let attempts = 0;
  const started = Date.now();
  const result = await runWorkflow<string>(script, {
    agent: {
      async run() {
        attempts++;
        if (attempts === 1) {
          throw new WorkflowError("empty", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
        }
        return "recovered";
      },
    },
    agentRetries: 1,
    persistLogs: false,
  });
  assert.equal(result.result, "recovered");
  assert.ok(
    Date.now() - started >= 240,
    `default first-retry backoff (~250ms) elapsed (took ${Date.now() - started}ms)`,
  );
});

test("agent() rejects timeoutMs <= 0 instead of spawn-aborting sessions (audit2 #8)", async () => {
  const script = `export const meta = { name: 'bad_timeout', description: 'bad timeout' }
return await agent('x', { timeoutMs: 0 })`;
  await assert.rejects(
    () => runWorkflow(script, { agent: fakeAgent({}), persistLogs: false }),
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  // Call-level NaN/Infinity/sub-1/overflow are rejected too (all spawn-then-instant-abort).
  for (const bad of ["NaN", "Infinity", "0.5", "2 ** 32"]) {
    const badScript = `export const meta = { name: 'bt', description: 'bt' }
return await agent('x', { timeoutMs: ${bad} })`;
    await assert.rejects(
      () => runWorkflow(badScript, { agent: fakeAgent({}), persistLogs: false }),
      (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      `timeoutMs ${bad} rejected`,
    );
  }
});

test("a run-level invalid agentTimeoutMs coerces to the default (legacy resume compatibility)", async () => {
  // A persisted legacy 0 must not make an old run unresumable; coerce + log.
  const script = `export const meta = { name: 't3', description: 't3' }
return await agent('x')`;
  const logs: string[] = [];
  const result = await runWorkflow<string>(script, {
    agent: fakeAgent({}),
    agentTimeoutMs: 0,
    persistLogs: false,
    onLog: (m) => logs.push(m),
  });
  assert.equal(result.result, "ok");
  assert.ok(
    logs.some((l) => l.includes("ignoring invalid agentTimeoutMs")),
    "the coercion is logged",
  );
});

test("the usage fallback estimate is LAZY when the provider reported terminal usage (audit2 #9)", async () => {
  // A result whose JSON.stringify throws: if the fallback estimate were
  // computed eagerly, the run would crash even though real usage exists.
  const script = `export const meta = { name: 'lazy_est', description: 'lazy estimate' }
return await agent('x')`;
  const poisoned = {
    toJSON() {
      throw new Error("stringify must not run");
    },
  };
  const result = await runWorkflow(script, {
    agent: {
      async run(_p: string, o: { onUsage?: (u: AgentUsage) => void }) {
        o.onUsage?.({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0 });
        return poisoned;
      },
    },
    persistLogs: false,
  });
  assert.equal(result.result, poisoned, "the agent call itself succeeded — an eager stringify would have failed it");
  assert.equal(result.tokenUsage?.total, 10, "real usage committed without ever stringifying the result");
});

test("agentRetryBackoffMs guard: 0 disables, Infinity/throwing fall back to the default", async () => {
  const script = `export const meta = { name: 'bo_guard', description: 'bo guard' }
return await agent('flaky')`;
  const flaky = () => {
    let attempts = 0;
    return {
      state: { attempts: 0 },
      async run() {
        attempts++;
        this.state.attempts = attempts;
        if (attempts === 1) {
          throw new WorkflowError("empty", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
        }
        return "recovered";
      },
    };
  };
  // 0 disables: no wait at all.
  {
    const started = Date.now();
    const result = await runWorkflow<string>(script, {
      agent: flaky(),
      agentRetries: 1,
      agentRetryBackoffMs: () => 0,
      persistLogs: false,
    });
    assert.equal(result.result, "recovered");
    assert.ok(Date.now() - started < 100, "0 disables the backoff");
  }
  // Infinity falls back to the default (a 2^31-1 clamp would park ~24.8 days).
  for (const injected of [
    () => Number.POSITIVE_INFINITY,
    () => {
      throw new Error("boom");
    },
    () => 1e12, // finite but huge: clamped to the 2000ms cap, NOT a ~1ms overflow storm
  ]) {
    const started = Date.now();
    const result = await runWorkflow<string>(script, {
      agent: flaky(),
      agentRetries: 1,
      agentRetryBackoffMs: injected as () => number,
      persistLogs: false,
    });
    assert.equal(result.result, "recovered");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 240 && elapsed < 5_000, `default backoff used (${elapsed}ms)`);
  }
});

test("the timeoutMs validation throws SYNCHRONOUSLY (no leaked rejection for void agent())", async () => {
  // Regression pin for the sync-throw property: a Promise.reject would surface
  // as an unhandled rejection for fire-and-forget calls and the run would
  // RESOLVE instead of rejecting.
  const script = `export const meta = { name: 'sync_throw', description: 'sync throw' }
void agent('x', { timeoutMs: 0 })
return 'frame-returned'`;
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      () => runWorkflow(script, { agent: fakeAgent({}), persistLogs: false }),
      (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      "the run rejects (a Promise.reject would let it resolve 'frame-returned')",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled, 0, "no unhandled rejection leaked");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an aborted run's drain abandons signal-ignoring agents after drainAbortGraceMs (audit2 #3)", async () => {
  // Un-awaited agent whose runner NEVER settles and ignores its abort signal:
  // without the grace the drain (and the run) would wedge forever.
  const script = `export const meta = { name: 'hung_drain', description: 'hung drain' }
void agent('wedged', { label: 'wedged' })
return 'script-done'`;
  for (const abortTiming of ["during-drain", "before-drain"] as const) {
    const controller = new AbortController();
    const logs: string[] = [];
    const started = Date.now();
    let agentStarted!: () => void;
    const agentGate = new Promise<void>((resolve) => (agentStarted = resolve));
    const pending = runWorkflow<string>(script, {
      agent: {
        async run() {
          agentStarted();
          return new Promise<string>(() => {}); // never settles, ignores signal
        },
      },
      signal: controller.signal,
      drainAbortGraceMs: 50,
      persistLogs: false,
      onLog: (m) => logs.push(m),
    });
    await agentGate; // the hung agent is in-flight
    if (abortTiming === "before-drain") {
      // Abort immediately: the script may not have returned yet — the drain
      // starts already-aborted.
      controller.abort();
    } else {
      // Wait for the drain to start (its log line), then abort mid-drain.
      for (let i = 0; i < 2000 && !logs.some((l) => l.includes("outstanding agent()")); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.abort();
    }
    await pending.catch(() => {});
    assert.ok(
      Date.now() - started < 5_000,
      `${abortTiming}: the run settles promptly after the grace instead of wedging`,
    );
    assert.ok(
      logs.some((l) => l.includes("abandoning 1 outstanding agent()")),
      `${abortTiming}: the abandonment is logged`,
    );
  }
});

test("drainAbortGraceMs: Infinity restores unbounded waiting (no busy-spin) (audit2 #3)", async () => {
  const script = `export const meta = { name: 'hung_inf', description: 'hung inf' }
void agent('wedged', { label: 'wedged' })
return 'script-done'`;
  const controller = new AbortController();
  const logs: string[] = [];
  let agentStarted!: () => void;
  const agentGate = new Promise<void>((resolve) => (agentStarted = resolve));
  const pending = runWorkflow<string>(script, {
    agent: {
      async run() {
        agentStarted();
        return new Promise<string>(() => {});
      },
    },
    signal: controller.signal,
    drainAbortGraceMs: Number.POSITIVE_INFINITY,
    persistLogs: false,
    onLog: (m) => logs.push(m),
  });
  await agentGate;
  controller.abort();
  // With Infinity the drain must NOT abandon: it keeps waiting. Give it ample
  // time to (wrongly) abandon or (wrongly) busy-spin, then confirm neither.
  const settled = await Promise.race([
    pending.then(
      () => true,
      () => true,
    ),
    new Promise((r) => setTimeout(() => r(false), 300)),
  ]);
  assert.equal(settled, false, "Infinity grace: the drain must not abandon the hung agent");
  assert.ok(!logs.some((l) => l.includes("abandoning")), "no abandonment logged");
  // Cleanup: not observable further (the run stays wedged by design) — the
  // process exits because nothing else holds the loop (agent promise is not a
  // handle).
});

test("a NON-abort (success) drain still waits without a bound for a slow un-awaited agent (audit2 #3)", async () => {
  // The success-path drain must not be grace-limited: the slow sibling's
  // result is still wanted (it journals when it completes).
  const script = `export const meta = { name: 'slow_drain', description: 'slow drain' }
const pending = agent('slow', { label: 'slow' })
return 'script-done'`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = Date.now();
  const result = await runWorkflow<string>(script, {
    agent: {
      async run() {
        setTimeout(release, 150);
        await gate;
        return "slow-done";
      },
    },
    drainAbortGraceMs: 10, // even with a tiny grace, the success drain waits
    persistLogs: false,
  });
  assert.equal(result.result, "script-done");
  assert.ok(Date.now() - started >= 140, "the success drain waited out the slow sibling");
});

test("aborted drain finalizes reported terminal usage before flushing the returned totals", async () => {
  const controller = new AbortController();
  const totals: number[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'abandon_usage', description: 'usage' }
void agent('reported but hung')
return 'script-done'`,
    {
      agent: {
        async run(_prompt, options) {
          options?.onUsage?.({ input: 40, output: 2, total: 42, cost: 0, cacheRead: 0, cacheWrite: 0 });
          return new Promise(() => {});
        },
      },
      signal: controller.signal,
      drainAbortGraceMs: 5,
      persistLogs: false,
      onLog: (message) => {
        if (message.includes("outstanding agent()")) controller.abort();
      },
      onTokenUsage: (usage) => totals.push(usage.total),
    },
  );
  assert.equal(result.tokenUsage?.total, 42);
  assert.deepEqual(totals, [42]);
});

test("runWorkflow's final onTokenUsage flush includes agents that settle during the drain (audit2 #5)", async () => {
  // The script returns while an un-awaited sibling is still running; the drain
  // waits it out, and the final flush must carry the sibling's spend.
  const script = `export const meta = { name: 'drain_flush', description: 'drain flush' }
const pending = agent('slow-sibling', { label: 'sibling' })
return 'script-done'`;
  const flushes: number[] = [];
  let releaseSibling!: () => void;
  const siblingGate = new Promise<void>((resolve) => (releaseSibling = resolve));
  let calls = 0;
  const result = await runWorkflow<string>(script, {
    agent: {
      async run(prompt: string) {
        calls++;
        if (prompt === "slow-sibling") {
          setTimeout(releaseSibling, 30);
          await siblingGate;
        }
        return "done";
      },
    },
    onAgentUsage: () => {},
    onTokenUsage: (usage) => flushes.push(usage.total),
    persistLogs: false,
  });
  assert.equal(result.result, "script-done");
  assert.equal(calls, 1, "the sibling ran exactly once");
  assert.equal(flushes.length, 1, "exactly one final flush");
  assert.ok(flushes[0] > 0, "the drain-settled sibling's usage is in the final flush");
  assert.equal(flushes[0], result.tokenUsage?.total, "the flush IS the final total (no partial/double accounting)");
});

test("runWorkflow initialPhaseBudgets adopts the persisted baseline instead of re-basing (audit2 #4)", async () => {
  // Simulates resume(): the prior execution declared phase 'p' with budget 100
  // at baseline 0 and already spent 60. The resumed script re-runs
  // phase('p', {budget: 100}) — with re-basing the phase would get a FRESH 100
  // allowance (120 total), with adoption the ceiling holds at 100 cumulatively.
  const script = `export const meta = { name: 'phase_seed', description: 'phase seed' }
phase('p', { budget: 100 })
const a = await agent('a', { label: 'a' })
let blocked = false
try { await agent('b', { label: 'b' }) } catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
return { a, blocked }`;
  const phaseBudgetEvents: Array<Record<string, { budget: number; startSpent: number }>> = [];
  const result = await runWorkflow<{ a: unknown; blocked: boolean }>(script, {
    agent: fakeAgent({ input: 60, output: 0, total: 60, cost: 0 }),
    initialTokenUsage: { input: 60, output: 0, total: 60, cost: 0, cacheRead: 0, cacheWrite: 0 },
    runId: "seeded-run",
    initialPhaseBudgets: { "seeded-run:p": { budget: 100, startSpent: 0 } },
    onPhaseBudgets: (budgets) => phaseBudgetEvents.push(budgets),
    persistLogs: false,
  });
  // 'a' runs (phase spent 60 < 100 → gate passes), spends 60 → phase spent 120.
  assert.equal(result.result.a, "ok");
  assert.equal(
    result.result.blocked,
    true,
    "'b' must be blocked: the phase ceiling is cumulative across resume (60 + 60 ≥ 100 from the ORIGINAL baseline)",
  );
  assert.equal(
    phaseBudgetEvents.length,
    0,
    "re-declaring an already-budgeted phase does not re-declare (first declaration wins)",
  );
});

test("runWorkflow phase() first-declaration-wins and notifies once per new budget", async () => {
  const script = `export const meta = { name: 'phase_decl', description: 'phase decl' }
phase('p', { budget: 60 })
const a = await agent('a', { label: 'a' })
phase('p', { budget: 999999 })
let blocked = false
try { await agent('b', { label: 'b' }) } catch (e) { blocked = true }
return { a, blocked }`;
  const events: Array<Record<string, { budget: number }>> = [];
  const result = await runWorkflow<{ a: unknown; blocked: boolean }>(script, {
    agent: fakeAgent({ input: 60, output: 0, total: 60, cost: 0 }),
    runId: "decl-run",
    onPhaseBudgets: (budgets) => events.push(budgets),
    persistLogs: false,
  });
  assert.equal(result.result.blocked, true, "the 999999 re-declaration must NOT re-base the budget away");
  assert.equal(events.length, 1, "exactly one budget notification (the first declaration)");
  assert.equal(events[0]?.["decl-run:p"]?.budget, 60, "emitted keys are frame-namespaced");
});

test("a nested frame ADOPTS its own persisted phase-budget slice across resume (audit2 r2 MAJOR)", async () => {
  // The child's phase budget was persisted from the prior execution with
  // baseline 0 and budget 60; the child already spent 60 (seeded via
  // initialTokenUsage). On resume the child re-declares its phase — it must
  // adopt the persisted baseline, so the ceiling is already exhausted.
  const child = `export const meta = { name: 'child', description: 'c' }
phase('childphase', { budget: 60 })
let blocked = false
try { await agent('child task', { label: 'c' }) } catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
return { blocked }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
const nested = await workflow('child')
return { nested }`;
  const result = await runWorkflow<{ nested: { blocked: boolean } }>(parent, {
    agent: fakeAgent({ input: 60, output: 0, total: 60, cost: 0 }),
    persistLogs: false,
    runId: "parent-run",
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
    initialTokenUsage: { input: 60, output: 0, total: 60, cost: 0, cacheRead: 0, cacheWrite: 0 },
    initialPhaseBudgets: { "parent-run-nested1:childphase": { budget: 60, startSpent: 0 } },
  });
  assert.equal(
    result.result.nested.blocked,
    true,
    "the nested frame adopted its persisted baseline: 60 already spent against a 60 ceiling blocks the call",
  );
});

test("same-title phases in parent and child frames keep independent baselines (frame-namespaced)", async () => {
  const child = `export const meta = { name: 'child', description: 'c' }
phase('shared-title', { budget: 1000 })
const r = await agent('child task', { label: 'c' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
phase('shared-title', { budget: 60 })
const a = await agent('parent task', { label: 'p' })
const nested = await workflow('child')
let blocked = false
try { await agent('parent tail', { label: 't' }) } catch (e) { blocked = true }
return { a, nested, blocked }`;
  const events: Array<Record<string, { budget: number; startSpent: number }>> = [];
  const result = await runWorkflow<{ blocked: boolean }>(parent, {
    agent: fakeAgent({ input: 10, output: 0, total: 10, cost: 0 }),
    persistLogs: false,
    runId: "parent-run",
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
    onPhaseBudgets: (budgets) => events.push(budgets),
  });
  // Parent spent 10 in 'shared-title' (budget 60); the child's 1000-budget
  // same-title phase must not lift the parent's ceiling for the tail call...
  // parent tail: phaseSpent 10 (parent frame) < 60 → runs. The REAL assertion
  // is the event table: two independent entries, never merged.
  const merged = Object.assign({}, ...events);
  assert.equal(merged["parent-run:shared-title"]?.budget, 60, "parent entry under the parent frame key");
  assert.equal(merged["parent-run-nested1:shared-title"]?.budget, 1000, "child entry under the child frame key");
  assert.equal(result.result.blocked, false, "parent tail call proceeds under its own ceiling (10 < 60)");
});

test("the phase runtime event advertises the EFFECTIVE (first-declared) budget", async () => {
  const script = `export const meta = { name: 'phase_evt', description: 'phase evt' }
phase('p', { budget: 60 })
phase('p', { budget: 999999 })
return 'done'`;
  const budgets: Array<number | null> = [];
  await runWorkflow(script, {
    agent: fakeAgent(),
    persistLogs: false,
    onRuntimeEvent: (event) => {
      if (event.type === "phase") budgets.push(event.budget);
    },
  });
  assert.deepEqual(budgets, [60, 60], "re-declaration reports the effective budget, not the ignored value");
});
