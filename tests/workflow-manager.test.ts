import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { NavigatorModel, NavigatorState, renderNavigator } from "../src/workflow-ui.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
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

/** Agent that stays running until a deferred resolve is called externally. */
function deferredAgent() {
  let deferredResolve: ((value: unknown) => void) | null = null;
  let deferredReject: ((err: Error) => void) | null = null;
  const promise = new Promise((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  return {
    resolve: (value: unknown = "done") => deferredResolve?.(value),
    reject: (err: Error) => deferredReject?.(err),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        return promise;
      },
    },
  };
}

function delayedAgent(delayMs: number, result: unknown = "slow") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      options?.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
      });
      return result;
    },
  };
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

/** Two sequential agents: 'a' finishes, then 'b' starts. */
const twoAgentScript = `export const meta = { name: 'two_agent_demo', description: 'two sequential agents' }
phase('Work')
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

/** Six agents fired in parallel, all resolving instantly — used to exercise a burst of persist ticks. */
const burstAgentScript = `export const meta = { name: 'burst_demo', description: 'six agents in parallel' }
const xs = await parallel(['a','b','c','d','e','f'].map((label) => () => agent(label, { label })))
return xs`;

/**
 * Agent runner for twoAgentScript: 'a' resolves immediately, 'b' hangs forever
 * (until the run is aborted by pause()/stop()). Lets a test observe a run with
 * one done agent and one genuinely still-running agent at the same time.
 */
function firstThenHangAgent() {
  return {
    async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      if (prompt === "first") {
        // A tiny real delay so 'a' and 'b' get distinguishable (not same-millisecond)
        // start times — proving persisted timestamps are real wall-clock captures,
        // not both stamped with one fabricated value.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "a-done";
      }
      return new Promise(() => {}); // 'second' never resolves on its own
    },
  };
}

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-mgr-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test(
  "runSync registers the run so /workflows (listRuns) can see it",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ input: 100, output: 40, total: 140 }) });
    const events: string[] = [];
    for (const ev of ["agentStart", "agentEnd", "phase", "complete"]) {
      manager.on(ev, () => events.push(ev));
    }
    let progressCalls = 0;
    const result = await manager.runSync(oneAgentScript, undefined, {
      onProgress: () => {
        progressCalls++;
      },
    });

    assert.equal(result.agentCount, 1);
    assert.ok(progressCalls > 0, "onProgress should fire while the run executes");
    assert.ok(events.includes("agentStart") && events.includes("complete"), "manager emits live events");

    const runs = manager.listRuns();
    assert.equal(runs.length, 1, "the sync run is persisted and listable");
    assert.equal(runs[0].workflowName, "tracked_demo");
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].tokenUsage?.total, 140, "token usage is persisted for the navigator");
  }),
);

test(
  "manager defaultAgentTimeoutMs applies when run options omit agentTimeoutMs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: unknown }).a, null);
    const agent = manager.listRuns()[0]?.agents[0];
    assert.equal(agent?.status, "error");
    assert.match(agent?.error ?? "", /timed out after 5ms/);
    assert.match(agent?.error ?? "", /raise or omit timeoutMs\/agentTimeoutMs/);
  }),
);

test(
  "run option agentTimeoutMs overrides manager defaultAgentTimeoutMs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    const result = await manager.runSync(oneAgentScript, undefined, { agentTimeoutMs: null });

    assert.equal((result.result as { a: unknown }).a, "slow");
    const agent = manager.listRuns()[0]?.agents[0];
    assert.equal(agent?.status, "done");
  }),
);

test(
  "an agent timeout aborts the subagent so its session can be released (#109)",
  withTempCwd(async (cwd) => {
    // A subagent whose run() never resolves on its own — only an abort ends it.
    // Before the fix, a timeout rejected the race but left this running in the
    // background with its session (and full messages) retained.
    let sawAbort = false;
    const hangingUntilAborted = {
      async run(_prompt: string, options?: { signal?: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            sawAbort = true;
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    };
    const manager = new WorkflowManager({ cwd, agent: hangingUntilAborted, defaultAgentTimeoutMs: 20 });

    const result = await manager.runSync(oneAgentScript);

    // Timed out → recoverable, no retry configured, so the agent result is null.
    assert.equal((result.result as { a: unknown }).a, null);
    const agent = manager.listRuns()[0]?.agents[0];
    assert.equal(agent?.status, "error");
    assert.match(agent?.error ?? "", /timed out/);
    // The key #109 property: the timeout aborted the subagent, so run()'s finally
    // disposes its session instead of leaking it while it streams on.
    assert.equal(sawAbort, true, "the timing-out subagent must receive an abort");
  }),
);

test(
  "manager defaultTokenBudget applies when run options omit tokenBudget (#68)",
  withTempCwd(async (cwd) => {
    // Each agent reports 100 tokens against a default budget of 50: the first
    // agent completes (budget checked before start), the second throws.
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 100 }), defaultTokenBudget: 50 });
    // Deliberately NO "error" listener: an unlistened EventEmitter "error" emit
    // throws, which used to abort the catch block mid-way — surfacing as
    // ERR_UNHANDLED_ERROR instead of the real error and leaking the run lease.
    await assert.rejects(manager.runSync(twoAgentScript), (err: unknown) => {
      assert.ok(err instanceof WorkflowError, `expected WorkflowError, got ${(err as Error)?.constructor?.name}`);
      assert.equal(err.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
      return true;
    });
    // The failure was persisted and the lease released (a fresh save succeeds).
    const run = manager.listRuns()[0];
    assert.equal(run?.status, "failed");
  }),
);

test(
  "run option tokenBudget overrides manager defaultTokenBudget",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 100 }), defaultTokenBudget: 50 });
    // Explicit null = "no budget" beats the configured default.
    const result = await manager.runSync(twoAgentScript, undefined, { tokenBudget: null });
    assert.equal(result.agentCount, 2);
  }),
);

test(
  "resume re-resolves the run's toolset tag and keeps its start-time tokenBudget",
  withTempCwd(async (cwd) => {
    // Agent where 'first' completes (journaling it) and 'second' hangs on its
    // first attempt — so the run can be paused mid-'second' and resumed, at
    // which point attempt 2 resolves immediately.
    let secondAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 100, cost: 0 });
        if (prompt === "second" && ++secondAttempts === 1) return new Promise(() => {});
        return "ok";
      },
    };
    let toolsetResolutions = 0;
    const manager = new WorkflowManager({
      cwd,
      agent,
      defaultTokenBudget: 50,
      toolsets: {
        webby: () => {
          toolsetResolutions++;
          return [];
        },
      },
    });

    // Explicit no-budget + a named toolset. (With the 100-token usage above, the
    // 50-token default would exhaust this two-agent run — so mere completion
    // already proves the explicit null won.)
    const { runId, promise } = manager.startInBackground(twoAgentScript, undefined, {
      tokenBudget: null,
      toolset: "webby",
    });
    promise.catch(() => {}); // pause aborts the in-flight execution — expected
    // Wait until 'second' is in flight, then pause the run.
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);
    assert.equal(toolsetResolutions, 1, "toolset resolves for the initial execution");

    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.tokenBudget, null, "explicit null budget persists (not the 50 default)");
    assert.equal(persisted?.toolset, "webby", "toolset tag persists with the run");

    // Resume: the run must keep its start-time context — no budget (not the
    // manager's current default) and the same re-resolved toolset.
    assert.equal(await manager.resume(runId), true);
    // resume() executes detached — poll until the run leaves "running".
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(toolsetResolutions, 2, "resume re-resolves the toolset tag");
    const resumed = manager.getPersistence().load(runId);
    assert.equal(resumed?.status, "completed", "resume completes without TOKEN_BUDGET_EXHAUSTED");
    assert.equal(resumed?.tokenBudget, null, "resume keeps the start-time budget, not the current default");
    assert.equal(resumed?.toolset, "webby");
  }),
);

test(
  "resume re-resolves the run's maxAgents/agentTimeoutMs and keeps its start-time values (#A1)",
  withTempCwd(async (cwd) => {
    // 'a' hangs on its first invocation (pause point), then on its second
    // invocation (post-resume) resolves slower than the run's OWN frozen
    // agentTimeoutMs (30ms) but well under the manager's defaultAgentTimeoutMs
    // (5000ms) — it only times out if agentTimeoutMs survived resume.
    let aAttempts = 0;
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "a") {
          aAttempts++;
          if (aAttempts === 1) return new Promise(() => {}); // hang until paused
          await new Promise((resolve) => setTimeout(resolve, 60));
          options?.onUsage?.(zeroUsage);
          return "a-result";
        }
        options?.onUsage?.(zeroUsage);
        return `${prompt}-result`;
      },
    };
    const manager = new WorkflowManager({ cwd, agent, defaultAgentTimeoutMs: 5000 });
    manager.on("error", () => {});

    // Three agents fanned out via parallel() with maxAgents: 3 so the cap is
    // fully consumed by the fan-out itself (each reserves a slot atomically,
    // in call order, before any of them actually run) — a 4th call ('after')
    // then only succeeds if the cap has silently reverted to the ~1000 default.
    const script = `export const meta = { name: 'cap_demo', description: 'agent cap across resume' }
const xs = await parallel(['a','b','c'].map((label) => () => agent(label, { label })))
const after = await agent('after', { label: 'after' })
return { xs, after }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { maxAgents: 3, agentTimeoutMs: 30 });
    promise.catch(() => {});
    // Pause well before 'a's own 30ms agentTimeoutMs would fire on the ORIGINAL
    // execution too (it's frozen for the whole run, not just post-resume) — 5ms
    // is enough for 'b'/'c' (no artificial delay) to complete and journal.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(aAttempts, 1, "'a' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.maxAgents, 3, "maxAgents persists with the run");
    assert.equal(paused?.agentTimeoutMs, 30, "agentTimeoutMs persists with the run");
    assert.ok((paused?.journal?.length ?? 0) >= 2, "'b' and 'c' should be journaled before pause");

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const resumed = manager.getPersistence().load(runId);
    const aAgent = resumed?.agents.find((ag) => ag.label === "a");
    assert.match(
      aAgent?.error ?? "",
      /timed out after 30ms/,
      "agentTimeoutMs must survive resume, not reset to the manager default",
    );
    // The resumed run must still enforce maxAgents: 3 — the 4th call ('after',
    // after a/b/c already reserved a slot each in the fan-out) must throw
    // AGENT_LIMIT_EXCEEDED, failing the run, not silently pass under a
    // reverted-to-default cap of ~1000.
    assert.equal(resumed?.status, "failed", "maxAgents must survive resume, not reset to the 1000 default");
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.error?.code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
  }),
);

test(
  "resuming a legacy persisted run (no agentTimeoutMs field) falls back to the manager's CURRENT default, not null",
  withTempCwd(async (cwd) => {
    // A run persisted before this fix existed never had an agentTimeoutMs
    // field at all — and its only real timeout, both at its original start
    // AND under pre-fix resume(), was always the manager's default (pre-fix
    // resume never threaded agentTimeoutMs through, so it fell straight to
    // this.defaultAgentTimeoutMs via executeRun's fallback chain). Falling
    // back to null here would silently grant such a run an unbounded timeout
    // it never had. Use a slow agent so only a real 20ms enforcement times it
    // out — an unbounded (null) fallback would let it complete instead.
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(60), defaultAgentTimeoutMs: 20 });
    const pers = manager.getPersistence();
    const runId = "legacy-no-agent-timeout-1";
    pers.save({
      runId,
      workflowName: "legacy",
      script: oneAgentScript,
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Deliberately no maxAgents/agentTimeoutMs/concurrency/agentRetries —
      // simulates a run persisted by pre-A1 code.
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const persisted = manager.getPersistence().load(runId);
    assert.equal(
      persisted?.agentTimeoutMs,
      20,
      "resume must apply the manager's current defaultAgentTimeoutMs for a legacy run, not leave it unbounded",
    );
    const agent = persisted?.agents.find((a) => a.label === "a");
    assert.match(agent?.error ?? "", /timed out after 20ms/, "the legacy run's agent must actually time out at 20ms");
  }),
);

test(
  "resume seeds the token-spend counter from the persisted total, so the budget holds cumulatively (#A2)",
  withTempCwd(async (cwd) => {
    // 'first' completes normally (spends 100). 'second' hangs on its first
    // attempt (pause point), then on its second attempt (post-resume) spends
    // 60 more — 100 + 60 = 160, over the 150 budget, but neither half alone
    // would trip it. 'third' only runs if the budget wrongly reset to 0 at
    // resume; it must instead be blocked before it even starts.
    let secondAttempts = 0;
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "first") {
          options?.onUsage?.({ ...zeroUsage, total: 100 });
          return "first-result";
        }
        if (prompt === "second") {
          if (++secondAttempts === 1) return new Promise(() => {}); // hang until paused
          options?.onUsage?.({ ...zeroUsage, total: 60 });
          return "second-result";
        }
        options?.onUsage?.({ ...zeroUsage, total: 1 });
        return "third-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'seed_demo', description: 'three sequential agents' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
const c = await agent('third', { label: 'third' })
return { a, b, c }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { tokenBudget: 150 });
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.tokenUsage?.total, 100, "pre-pause spend (agent 1) is persisted, not lost mid-run");

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const resumed = manager.getPersistence().load(runId);
    // The cumulative spend (100 + 60 = 160) must be reflected...
    assert.equal(resumed?.tokenUsage?.total, 160, "final tokenUsage reflects both the pre-pause and post-resume spend");
    // ...and must have tripped the budget once the SUM exceeded it — the run
    // fails with TOKEN_BUDGET_EXHAUSTED on 'third', not a reset-to-zero pass.
    assert.equal(resumed?.status, "failed", "the tokenBudget must hold cumulatively across resume");
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.error?.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
  }),
);

test(
  "a retried (failed-then-succeeded) attempt's spend is not lost from the persisted total when the run pauses before completing",
  withTempCwd(async (cwd) => {
    // 'a's first attempt spends 40 tokens then fails with an empty output
    // (recoverable -> retried); its second attempt spends 25 more and
    // succeeds. onAgentEnd only ever reports the FINAL attempt's tokens (25)
    // — the first attempt's 40 would be invisible to a persisted total built
    // purely from onAgentEnd. 'b' then hangs so we can pause() and inspect
    // the persisted state BEFORE the run fully completes (a full completion
    // would paper over the gap via workflow.ts's own final onTokenUsage,
    // which always includes every attempt's spend regardless of this fix).
    let aAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "a") {
          aAttempts++;
          if (aAttempts === 1) {
            options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 40, cost: 0 });
            return ""; // empty output -> recoverable AGENT_EMPTY_OUTPUT -> retried
          }
          options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 25, cost: 0 });
          return "a-result";
        }
        return new Promise(() => {}); // 'b' hangs until paused
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'retry_spend_demo', description: 'retry spend' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { agentRetries: 1 });
    promise.catch(() => {});
    for (let i = 0; i < 200 && aAttempts < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(aAttempts, 2, "'a' should have failed once and be retrying by now");
    // Let 'b' actually start (and begin hanging) before pausing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal(
      paused?.tokenUsage?.total,
      65,
      "the persisted total must include the failed-then-retried attempt's 40 tokens, not just the final attempt's 25",
    );
  }),
);

test(
  "manager forwards exec concurrency and agentRetries to runtime",
  withTempCwd(async (cwd) => {
    let active = 0;
    let maxActive = 0;
    const callsByPrompt = new Map<string, number>();
    const manager = new WorkflowManager({
      cwd,
      concurrency: 8,
      defaultAgentRetries: 0,
      agent: {
        async run(prompt: string) {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          const calls = (callsByPrompt.get(prompt) ?? 0) + 1;
          callsByPrompt.set(prompt, calls);
          return calls === 1 ? "" : `ok:${prompt}`;
        },
      },
    });
    const script = `export const meta = { name: 'forwarding', description: 'manager controls' }
const xs = await parallel(['a','b'].map((p) => () => agent(p, { label: p })))
return xs`;

    const result = await manager.runSync(script, undefined, { concurrency: 1, agentRetries: 1 });

    assert.deepEqual(result.result, ["ok:a", "ok:b"]);
    assert.equal(maxActive, 1, "exec concurrency should override the manager default");
    assert.deepEqual([...callsByPrompt.values()], [2, 2], "exec agentRetries should be forwarded");
  }),
);

test(
  "manager defaultAgentRetries applies when run options omit agentRetries",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      defaultAgentRetries: 1,
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
    });

    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: unknown }).a, "ok");
    assert.equal(calls, 2);
  }),
);

test(
  "runSync persists the run immediately (visible while still running)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let listedWhileRunning = 0;
    manager.on("agentStart", () => {
      listedWhileRunning = manager.listRuns().filter((r) => r.status === "running").length;
    });
    await manager.runSync(oneAgentScript);
    assert.equal(listedWhileRunning, 1, "the run shows as running in listRuns mid-flight");
  }),
);

test(
  "each agent's model is recorded for /workflows: explicit opts.model, else the main model",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), mainModel: "anthropic/claude-opus-4-8" });
    const script = `export const meta = { name: 'model_demo', description: 'per-agent models' }
const a = await agent('explore', { label: 'scan', model: 'openai/gpt-5-mini' })
const b = await agent('reason', { label: 'judge' })
return { a, b }`;
    await manager.runSync(script);

    const run = manager.listRuns().find((r) => r.workflowName === "model_demo");
    const byLabel = Object.fromEntries((run?.agents ?? []).map((a) => [a.label, a.model]));
    assert.equal(byLabel.scan, "openai/gpt-5-mini", "explicit per-agent model is recorded");
    assert.equal(byLabel.judge, "anthropic/claude-opus-4-8", "default agent shows the main model");
  }),
);

test(
  "runSync persists recoverable agent error details for /workflows",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new Error("agent exploded");
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const run = manager.listRuns().find((r) => r.workflowName === "tracked_demo");
    const agent = run?.agents[0];
    assert.equal(agent?.status, "error");
    assert.equal(agent?.error, "agent exploded");
    assert.equal(agent?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(agent?.recoverable, true);
  }),
);

test(
  "runSync stores compact subagent history for /workflows detail",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options: { onHistory?: (history: unknown[]) => void }) {
          options.onHistory?.([{ role: "assistant", kind: "text", text: "inspecting files" }]);
          return "ok";
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const run = manager.listRuns().find((r) => r.workflowName === "tracked_demo");
    const agent = run?.agents[0];
    assert.equal(agent?.history?.length, 1);
    assert.equal(agent?.history?.[0]?.text, "inspecting files");
  }),
);

test(
  "runSync retains the full agent result for live and persisted detail views",
  withTempCwd(async (cwd) => {
    const expected = { summary: "complete", findings: [{ path: "src/a.ts", line: 42 }] };
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({}, expected) });

    const result = await manager.runSync(oneAgentScript);
    const live = manager.getRun(result.runId)?.snapshot.agents[0];
    const persistedRun = manager.listRuns().find((run) => run.runId === result.runId);
    const persisted = persistedRun?.agents[0];

    assert.deepEqual(live?.result, expected);
    assert.deepEqual(persisted?.result, expected);
    assert.match(live?.resultPreview ?? "", /complete/);
    assert.equal(persistedRun?.journal, undefined, "completed runs do not duplicate full results in the journal");
  }),
);

test(
  "cold persisted resumable runs restore full agent results from the journal",
  withTempCwd(async (cwd) => {
    const expected = {
      summary: "x".repeat(100),
      durableMarker: "FULL_RESULT_FROM_JOURNAL",
    };
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          if (prompt === "first") return expected;
          throw new WorkflowError("quota reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
          });
        },
      } as never,
    });
    const script = `export const meta = { name: 'cold_result', description: 'cold result test' }
phase('Work')
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })`;

    const { runId, promise } = manager.startInBackground(script);
    await promise.catch(() => {});

    const persisted = manager.listRuns().find((run) => run.runId === runId);
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.agents[0]?.result, undefined, "resumable agent result is stored only in the journal");
    assert.doesNotMatch(persisted?.agents[0]?.resultPreview ?? "", /FULL_RESULT_FROM_JOURNAL/);
    assert.deepEqual(persisted?.journal?.find((entry) => entry.index === 0)?.result, expected);

    // A fresh manager has no live snapshot, so NavigatorModel must rehydrate the
    // pager's cold-read snapshot from the persisted journal.
    const freshManager = new WorkflowManager({ cwd });
    assert.equal(freshManager.getRun(runId), undefined);
    const model = new NavigatorModel(freshManager);
    assert.deepEqual(model.agentDetail(runId, 1)?.result, expected);

    const state = new NavigatorState();
    assert.equal(state.drill(model), true);
    assert.equal(state.drill(model), true);
    assert.equal(state.drill(model), true);
    state.togglePager();
    assert.match(renderNavigator(state, model, 120, undefined, 30).join("\n"), /FULL_RESULT_FROM_JOURNAL/);
  }),
);

test(
  "startInBackground returns immediately with runId and promise",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    assert.ok(runId, "should generate a run id");
    assert.ok(promise instanceof Promise, "should return a promise");
    const runs = manager.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, runId);
    assert.equal(runs[0].status, "running");
    await promise;
  }),
);

test(
  "startInBackground result resolves on completion",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(oneAgentScript);
    const result = await promise;
    assert.equal(result.agentCount, 1);
    assert.equal(result.meta.name, "tracked_demo");
  }),
);

test(
  "stop stops a running workflow and transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    // Suppress the expected unhandled rejection from the aborted run
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    // Wait a tick for the run to start processing
    await new Promise((r) => setTimeout(r, 20));
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted", "run should be aborted");
    // Clean up: resolve the deferred agent and catch the expected rejection
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.stop("nonexistent"), false);
  }),
);

test(
  "pause pauses a running workflow",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "paused", "run should be paused");
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.pause("nonexistent"), false);
  }),
);

test(
  "getRun returns undefined for unknown run id",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const run = manager.getRun("no-such-run");
    assert.equal(run, undefined);
  }),
);

test(
  "getSnapshot returns null for unknown run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const snap = manager.getSnapshot("unknown");
    assert.equal(snap, null);
  }),
);

test(
  "deleteRun removes the run from memory and persistence",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion first (fast agent)
    await new Promise((r) => setTimeout(r, 30));
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);
    assert.equal(manager.getRun(runId), undefined);
  }),
);

test(
  "deleteRun returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.deleteRun("nonexistent"), false);
  }),
);

test(
  "setModelRegistry stores the registry and forwards it to subagent runs",
  withTempCwd(async (cwd) => {
    const fakeRegistry = {
      getAvailable: () => [{ provider: "mock", id: "m" }],
      find: () => undefined,
      getAll: () => [],
    } as any;
    const rec = new (class {
      calls: Array<{ options: any }> = [];
      async run(_prompt: string, options: any) {
        this.calls.push({ options });
        options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      }
    })();
    const manager = new WorkflowManager({ cwd, agent: rec });
    manager.setModelRegistry(fakeRegistry);
    await manager.runSync(oneAgentScript);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].options.modelRegistry, fakeRegistry);
  }),
);

test(
  "setMainModel sets the main model used for default agents",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    manager.setMainModel("anthropic/claude-sonnet-4");
    const script = `export const meta = { name: 'mm_test', description: 'main model test' }
const a = await agent('test', { label: 'a' })
return { a }`;
    await manager.runSync(script);
    const run = manager.listRuns().find((r) => r.workflowName === "mm_test");
    assert.ok(run, "run should exist");
  }),
);

test(
  "getPersistence returns the persistence layer",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const p = manager.getPersistence();
    assert.ok(p, "p should be truthy");
    assert.equal(typeof p.save, "function");
    assert.equal(typeof p.list, "function");
  }),
);

test(
  "runSync emits manager events (agentStart -> agentEnd -> complete)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const events: string[] = [];
    manager.on("agentStart", () => events.push("agentStart"));
    manager.on("agentEnd", () => events.push("agentEnd"));
    manager.on("complete", () => events.push("complete"));
    await manager.runSync(oneAgentScript);
    assert.deepEqual(events, ["agentStart", "agentEnd", "complete"]);
  }),
);

test(
  "resume returns false when run is already running",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    const resumed = await manager.resume(runId);
    assert.equal(resumed, false);
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "resume returns false when run doesn't exist",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const resumed = await manager.resume("nonexistent");
    assert.equal(resumed, false);
  }),
);

test(
  "manager emits complete event with runId",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let capturedId = "";
    manager.on("complete", ({ runId }: { runId: string }) => {
      capturedId = runId;
    });
    await manager.runSync(oneAgentScript);
    assert.ok(capturedId, "should capture runId on complete");
  }),
);

test(
  "stop returns false for completed/aborted run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion
    const stopped = manager.stop(runId);
    assert.equal(stopped, false, "cannot stop an already completed run");
  }),
);

test(
  "pause returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause completed run");
  }),
);

// ─── Abort propagation tests ───────────────────────────────────────────────────

test(
  "abort via externalSignal propagates through workflow execution and yields WorkflowError",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    let errorEmitted = false;
    manager.on("error", () => {
      errorEmitted = true;
    });

    // runSync with externalSignal links the abort controller to the manager
    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });

    // Let the agent start (deferred, so it hangs inside agentRunner.run())
    await new Promise((r) => setTimeout(r, 20));

    // Abort from outside — this triggers managed.controller.abort()
    ac.abort();

    // Resolve the deferred agent so the in-flight agent completes,
    // then throwIfAborted() fires and the error propagates.
    da.resolve("done");

    try {
      await runPromise;
      assert.fail("runSync should have thrown on abort");
    } catch (err) {
      assert.ok(err instanceof WorkflowError, "error should be WorkflowError");
      assert.equal(
        (err as WorkflowError).code,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        "error code should be WORKFLOW_ABORTED",
      );
      assert.ok((err as WorkflowError).recoverable, "abort error should be recoverable");
    }

    assert.equal(errorEmitted, true, "manager should emit 'error' event on abort");
  }),
);

test(
  "abort via externalSignal does not crash Pi (no uncaught exception)",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let uncaughtFromTest: Error | null = null;
    const errorHandler = (err: Error) => {
      uncaughtFromTest = err;
    };
    process.on("uncaughtException", errorHandler);

    try {
      const runPromise = manager.runSync(oneAgentScript, undefined, {
        externalSignal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      da.resolve("done");

      try {
        await runPromise;
      } catch {
        // Expected — abort throws WorkflowError
      }

      // Give microtasks a chance to settle
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(uncaughtFromTest, null, "abort should NOT produce an uncaught exception");
    } finally {
      process.off("uncaughtException", errorHandler);
    }
  }),
);

test(
  "abort mid-way through multi-agent workflow: remaining agents are skipped",
  withTempCwd(async (cwd) => {
    // Per-call deferred agent: each call to run() gets its own promise.
    const resolves: Array<(v: unknown) => void> = [];
    let callIdx = 0;
    const multiDa = {
      resolve(idx: number, v: unknown = "done") {
        resolves[idx]?.(v);
      },
      runner: {
        async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
          const idx = callIdx++;
          return new Promise((resolve) => {
            resolves[idx] = resolve;
          });
        },
      },
    };

    const manager = new WorkflowManager({ cwd, agent: multiDa.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete (gets journaled)
    multiDa.resolve(0, "first-done");
    // Wait for agent 1's result to be journaled and agent 2 to start
    await new Promise((r) => setTimeout(r, 30));

    // Stop the run while agent 2 is in-flight
    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed");

    // Resolve agent 2 so the abort/throwIfAborted path executes
    multiDa.resolve(1, "second-done");
    await promise.catch(() => {});

    // Verify the run is aborted
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "run should be aborted after stop");

    // Verify the error is a WorkflowError
    const managedRun = manager.getRun(runId);
    assert.ok(managedRun?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal((managedRun.error as WorkflowError).code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);

// ─── Stop tests ────────────────────────────────────────────────────────────────

test(
  "stop on paused run transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause first
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Then stop the paused run
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    assert.equal(manager.getRun(runId)?.status, "aborted", "paused run should become aborted after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop emits 'stopped' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let stoppedEvent: { runId: string } | null = null;
    manager.on("stopped", (ev: { runId: string }) => {
      stoppedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.stop(runId);

    assert.ok(stoppedEvent, "stopped event should fire");
    assert.equal(stoppedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const secondStop = manager.stop(runId);
    assert.equal(secondStop, false, "second stop on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Pause tests ───────────────────────────────────────────────────────────────

test(
  "pause emits 'paused' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let pausedEvent: { runId: string } | null = null;
    manager.on("paused", (ev: { runId: string }) => {
      pausedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);

    assert.ok(pausedEvent, "paused event should fire");
    assert.equal(pausedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause an already stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-paused run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.pause(runId);
    const secondPause = manager.pause(runId);
    assert.equal(secondPause, false, "second pause on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Resume tests ──────────────────────────────────────────────────────────────

test(
  "resume full cycle: pause then resume then complete",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Resume — replays journal (empty for single-agent that never completed) and
    // re-runs the live agent with a fresh (non-aborted) controller.
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed");

    // The resumed run should be running
    assert.equal(manager.getRun(runId)?.status, "running", "resumed run should be running");

    // Resolve the deferred agent so the resumed run's agent completes
    da.resolve("resumed-done");

    // The original promise will reject (its controller was aborted). Suppress it.
    await origPromise.catch(() => {});

    // Wait for the resumed run to complete
    await new Promise((r) => setTimeout(r, 50));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run should complete successfully");
    assert.equal(finalRun?.result?.result?.a, "resumed-done", "resumed run should have the agent result");

    // The run should also appear in listRuns as completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed");
  }),
);

test(
  "resume with journal replay replays completed agents and runs remaining live",
  withTempCwd(async (cwd) => {
    // Use a multi-agent workflow: agent 1 completes before pause (gets journaled),
    // agent 2 runs live after resume.
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise: origPromise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete
    da.resolve("first-result");
    await new Promise((r) => setTimeout(r, 30));

    // Agent 1 should have completed and been journaled. Pause.
    const paused = manager.pause(runId);
    const statusAtPause = manager.getRun(runId)?.status;

    if (paused) {
      assert.equal(statusAtPause, "paused");

      // Journal should have at least agent 1's entry
      const persisted = manager.listRuns().find((r) => r.runId === runId);
      assert.ok(persisted?.journal && persisted.journal.length >= 1, "journal should have at least one entry");

      // Resume
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true);

      // Wait for resumed run to complete (agent 1 replayed from journal, agent 2 live)
      await new Promise((r) => setTimeout(r, 50));

      const finalRun = manager.getRun(runId);
      assert.equal(finalRun?.status, "completed", "resumed multi-agent run should complete");
      assert.equal(finalRun?.result?.result?.a, "first-result");
    }

    await origPromise.catch(() => {});
  }),
);

test(
  "a provider usage limit pauses the run (not failed) and is resumable, replaying the journal",
  withTempCwd(async (cwd) => {
    let limitActive = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          if (prompt.includes("second") && limitActive) {
            throw new WorkflowError(
              "Codex usage limit reached (plus plan). Resets in ~3h.",
              WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
              { recoverable: false, resetHint: "Resets in ~3h" },
            );
          }
          return prompt.includes("first") ? "first-result" : "second-result";
        },
      },
    });
    const pausedEvents: Array<{ runId: string; reason?: string; resetHint?: string }> = [];
    manager.on("paused", (e: { runId: string; reason?: string; resetHint?: string }) => pausedEvents.push(e));

    const twoAgentScript = `export const meta = { name: 'quota_demo', description: 'two agents' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise.catch(() => {}); // settles: rejects with PROVIDER_USAGE_LIMIT

    // The run is checkpointed as paused, not failed.
    assert.equal(manager.getRun(runId)?.status, "paused");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1's result should be journaled");

    // A 'paused' event with reason usage_limit fired (not 'error').
    assert.equal(pausedEvents.length, 1);
    assert.equal(pausedEvents[0].reason, "usage_limit");
    assert.equal(pausedEvents[0].resetHint, "Resets in ~3h");

    // After the budget refills, resume replays agent 1 and runs agent 2 live to completion.
    limitActive = false;
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 50));
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run completes once the limit clears");
    assert.equal(finalRun?.result?.result?.a, "first-result");
    assert.equal(finalRun?.result?.result?.b, "second-result");
  }),
);

test(
  "a non-quota non-recoverable agent error still fails the run (control)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("schema bad", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
        },
      },
    });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "failed");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.pauseReason, undefined, "a real failure carries no usage-limit pause reason");
  }),
);

// ─── persistRun: honest per-agent timestamps + throttled progress persists ────

test(
  "persisted per-agent timestamps are real, not fabricated from the run's startedAt/now",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: firstThenHangAgent() });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);

    // Wait until 'a' has finished and 'b' has started (and is hanging) so both
    // a terminal and a still-running agent coexist in the snapshot.
    await new Promise((resolve) => {
      manager.on("agentStart", (event) => {
        if ((event as { label?: string }).label === "b") resolve(undefined);
      });
    });

    // pause() forces a synchronous flush (see the "safety net" tests below), so
    // this reads the true current state without any arbitrary wait.
    manager.pause(runId);

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    const agentA = persisted?.agents.find((a) => a.label === "a");
    const agentB = persisted?.agents.find((a) => a.label === "b");

    assert.equal(agentA?.status, "done");
    assert.ok(agentA?.startedAt, "finished agent has a real startedAt");
    assert.ok(agentA?.endedAt, "finished agent has a real endedAt");

    assert.equal(agentB?.status, "running");
    assert.ok(agentB?.startedAt, "running agent has a real startedAt too");
    assert.equal(agentB?.endedAt, undefined, "a still-running agent must NOT get a fabricated endedAt");

    assert.notEqual(
      agentA?.startedAt,
      agentB?.startedAt,
      "agents must not all share one fabricated run-start timestamp",
    );

    // firstThenHangAgent's 'second' call never resolves on its own (only pause()
    // marks the run as aborted in bookkeeping — the in-flight call has no timeout
    // to race against), so don't await it; just avoid an unhandled rejection.
    promise.catch(() => {});
  }),
);

test(
  "a burst of agent completions coalesces to a small, bounded number of disk writes",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), concurrency: 8 });
    const persistence = manager.getPersistence();
    let saveCount = 0;
    const originalSave = persistence.save.bind(persistence);
    persistence.save = ((...args: Parameters<typeof persistence.save>) => {
      saveCount++;
      return originalSave(...args);
    }) as typeof persistence.save;

    const result = await manager.runSync(burstAgentScript);

    assert.equal((result.result as unknown[]).length, 6);
    // Unthrottled, each of the 6 near-simultaneous agent completions would persist
    // on its own: 1 (initial) + 6 (one per agent) + 1 (final) = 8 writes. Throttled,
    // the whole burst coalesces into at most one trailing write, so the total stays
    // small regardless of agent count.
    assert.ok(saveCount <= 3, `expected a coalesced write count (<=3), got ${saveCount}`);
  }),
);

test(
  "pause() flushes a pending throttled progress persist synchronously — no stale read",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: firstThenHangAgent() });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);

    // 'a' finishing schedules a throttled (trailing-edge) write via onAgentJournal
    // that would normally not hit disk for hundreds of ms.
    await new Promise((resolve) => {
      manager.on("agentStart", (event) => {
        if ((event as { label?: string }).label === "b") resolve(undefined);
      });
    });

    manager.pause(runId);

    // Read persisted state immediately — no sleep/setTimeout. If pause() didn't
    // flush the pending write first (and write the current, final state), this
    // would race a stale read or a delayed write clobbering the paused status.
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused", "terminal status must be visible immediately, with no wait");
    const agentA = persisted?.agents.find((a) => a.label === "a");
    assert.equal(agentA?.status, "done", "the already-completed agent's state is flushed synchronously too");
    assert.ok(agentA?.endedAt, "flushed agent state carries its real endedAt, not stale/missing data");

    // 'second' never resolves on its own; don't await it, just avoid an unhandled rejection.
    promise.catch(() => {});
  }),
);

test(
  "stop() flushes a pending throttled progress persist synchronously — no stale read",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: firstThenHangAgent() });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);

    await new Promise((resolve) => {
      manager.on("agentStart", (event) => {
        if ((event as { label?: string }).label === "b") resolve(undefined);
      });
    });

    manager.stop(runId);

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "terminal status must be visible immediately, with no wait");
    const agentA = persisted?.agents.find((a) => a.label === "a");
    assert.equal(agentA?.status, "done");
    assert.ok(agentA?.endedAt, "flushed agent state carries its real endedAt, not stale/missing data");

    // 'second' never resolves on its own; don't await it, just avoid an unhandled rejection.
    promise.catch(() => {});
  }),
);

test(
  "resume returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    if (runId) {
      const resumed = await manager.resume(runId);
      assert.equal(resumed, false, "cannot resume a completed run");
    }
  }),
);

// ─── Cold-start resume tests ────────────────────────────────────────────────────
// These tests manually persist runs via the persistence layer (as though the
// process was restarted) and then resume them from disk — no in-memory state.

test(
  "cold-start resume: persisted run can be resumed from disk",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const pers = manager.getPersistence();
    const runId = "cold-start-ok-1";

    // Manually save a persisted run — cold-start scenario, no in-memory state
    pers.save({
      runId,
      workflowName: "cold_start",
      script: oneAgentScript,
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // No in-memory run exists at this point; resume loads from persistence
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed for cold-start persisted run");

    // Wait for the background execution (fake agent resolves instantly)
    await new Promise((r) => setTimeout(r, 100));

    const run = manager.getRun(runId);
    assert.ok(run, "run should be in memory after resume");
    assert.equal(run?.status, "completed", "cold-start resumed run should complete");
    assert.equal(run?.result?.result?.a, "ok", "agent result should be present");

    // Verify persistence was updated to completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed", "persistence should reflect completed status");
  }),
);

test(
  "cold-start resume: completed run cannot be resumed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "cold-start-completed-1";

    pers.save({
      runId,
      workflowName: "completed_test",
      script: oneAgentScript,
      args: undefined,
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "completed persisted run cannot be resumed");
  }),
);

test(
  "cold-start resume: persisted run with empty script cannot be resumed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "cold-start-noscript-1";

    pers.save({
      runId,
      workflowName: "no_script_test",
      script: "",
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "persisted run with empty script cannot be resumed");
  }),
);

test(
  "cold-start resume: a second manager cannot resume a run while another manager owns the lease",
  withTempCwd(async (cwd) => {
    const ownerAgent = deferredAgent();
    const owner = new WorkflowManager({ cwd, agent: ownerAgent.runner });
    owner.on("error", () => {});
    const runId = "cold-start-leased-1";
    owner.getPersistence().save({
      runId,
      workflowName: "leased",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await owner.resume(runId), true, "first manager should acquire the lease and start");
    await new Promise((r) => setTimeout(r, 20));

    const contender = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          assert.fail("second manager must not run an agent without the lease");
        },
      },
    });
    assert.equal(await contender.resume(runId), false, "second manager should be refused by the live lease");

    ownerAgent.resolve("done");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(owner.getRun(runId)?.status, "completed", "leased owner should still finish");
  }),
);

test(
  "cold-start recovery leaves a live leased running run untouched",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "live-running-lease";
    pers.save({
      runId,
      workflowName: "live",
      script: oneAgentScript,
      status: "running",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const lease = pers.acquireRunLease(runId);
    assert.ok(lease, "test setup should acquire the live lease");

    try {
      new WorkflowManager({ cwd });
      assert.equal(pers.load(runId)?.status, "running", "live leased run is not recovered to paused");
    } finally {
      pers.releaseRunLease(lease);
    }
  }),
);

test(
  "cold-start resume releases the lease after failure so another manager can retry",
  withTempCwd(async (cwd) => {
    const failing = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("boom", WorkflowErrorCode.UNKNOWN, { recoverable: false });
        },
      },
    });
    failing.on("error", () => {});
    const runId = "failed-lease-retry";
    failing.getPersistence().save({
      runId,
      workflowName: "failed_once",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await failing.resume(runId), true, "first resume starts");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(failing.getRun(runId)?.status, "failed", "first resume failed");

    const retry = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal(await retry.resume(runId), true, "failed run can be resumed after lease release");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(retry.getRun(runId)?.status, "completed", "retry manager completed the run");
  }),
);

test(
  "cold-start stop: a persisted paused run not in this.runs can be stopped from disk",
  withTempCwd(async (cwd) => {
    // Simulate a prior pi session: a run persisted as "paused" (e.g. by
    // recoverStaleRuns() flipping a stale "running" run on a previous cold
    // start) that this fresh manager never loaded into its in-memory map.
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const pers = manager.getPersistence();
    const runId = "cold-start-stop-paused-1";

    pers.save({
      runId,
      workflowName: "cold_start_stop",
      script: oneAgentScript,
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(manager.getRun(runId), undefined, "run is not in memory (cold-start simulation)");

    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed for a cold-start persisted paused run");

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "persisted status should become aborted");
  }),
);

test(
  "cold-start stop: a persisted running run not in this.runs can be stopped from disk",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const pers = manager.getPersistence();
    const runId = "cold-start-stop-running-1";

    pers.save({
      runId,
      workflowName: "cold_start_stop_running",
      script: oneAgentScript,
      args: undefined,
      status: "running",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed for a cold-start persisted running run");

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "persisted status should become aborted");
  }),
);

test(
  "cold-start stop: a persisted completed run cannot be stopped",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "cold-start-stop-completed-1";

    pers.save({
      runId,
      workflowName: "cold_start_stop_completed",
      script: oneAgentScript,
      args: undefined,
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    assert.equal(manager.stop(runId), false, "completed persisted run cannot be stopped");
  }),
);

test(
  "cold-start stop: an unknown run ID returns false",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.stop("does-not-exist"), false);
  }),
);

test(
  "cold-start stop: a second manager cannot stop a run while another manager owns the lease",
  withTempCwd(async (cwd) => {
    const ownerAgent = deferredAgent();
    const owner = new WorkflowManager({ cwd, agent: ownerAgent.runner });
    owner.on("error", () => {});
    const runId = "cold-start-stop-leased-1";
    owner.getPersistence().save({
      runId,
      workflowName: "leased_stop",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Owner resumes the run, so it's live in owner's this.runs and owner holds
    // the cross-process lease.
    assert.equal(await owner.resume(runId), true, "owner should acquire the lease and start");
    await new Promise((r) => setTimeout(r, 20));

    // A second manager doesn't have the run in memory, so stop() takes the
    // persisted fallback path — but the owner still holds the lease, so the
    // contender must not be able to mark it aborted on disk.
    const contender = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal(contender.stop(runId), false, "contender cannot steal the lease to stop the run");
    assert.equal(contender.getPersistence().load(runId)?.status, "running", "run is untouched by the contender");

    ownerAgent.resolve("done");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(owner.getRun(runId)?.status, "completed", "leased owner should still finish");
  }),
);

// ─── getRun tests ──────────────────────────────────────────────────────────────

test(
  "getRun returns ManagedRun with correct fields for active background run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    const run = manager.getRun(runId);
    assert.ok(run, "getRun should return the managed run");
    assert.equal(run?.runId, runId);
    assert.equal(run?.status, "running");
    assert.equal(run?.script, oneAgentScript);
    assert.ok(run?.controller instanceof AbortController, "should have an AbortController");
    assert.ok(run?.startedAt instanceof Date, "should have a startedAt date");
    assert.equal(run?.background, true, "should be marked as background");
    assert.ok(Array.isArray(run?.journal), "should have a journal array");

    // snapshot should be populated
    assert.equal(run?.snapshot.name, "tracked_demo");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns ManagedRun with status 'aborted' after stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns undefined after deleteRun",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Stop first, then delete
    manager.stop(runId);
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    const run = manager.getRun(runId);
    assert.equal(run, undefined, "deleted run should not be accessible");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── deleteRun tests ───────────────────────────────────────────────────────────

test(
  "deleteRun can delete a running run (removes from memory and persistence)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Delete while running — should succeed (removes from tracking)
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    // Should not be in memory
    assert.equal(manager.getRun(runId), undefined);

    // Should not be in persistence
    const runs = manager.listRuns();
    assert.equal(
      runs.find((r) => r.runId === runId),
      undefined,
    );

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "deleteRun aborts a live run so its later (delayed) settle can't resurrect the deleted file (#A3)",
  withTempCwd(async (cwd) => {
    // delayedAgent always resolves after a fixed real delay, IGNORING the abort
    // signal entirely — so the stale execution's eventual settle is driven
    // purely by its own timer, independent of whether deleteRun()'s abort call
    // actually interrupts it. This isolates the identity-guard mechanism (the
    // resurrection must not happen) from the separate "did abort() fire" check.
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(40) });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    promise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 15)); // let the agent start

    const liveManaged = manager.getRun(runId);
    assert.ok(liveManaged, "the run should be tracked while running");
    assert.equal(liveManaged?.controller.signal.aborted, false, "not aborted yet, before delete");

    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);
    assert.equal(
      liveManaged?.controller.signal.aborted,
      true,
      "deleteRun must abort a live run's controller so it winds down instead of running forever in the background",
    );
    assert.equal(manager.getRun(runId), undefined);
    assert.equal(manager.getPersistence().load(runId), null, "deleted immediately");

    // Wait past the stale execution's delayed (40ms) resolution settling.
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(
      manager.getPersistence().load(runId),
      null,
      "the stale execution's later settle must not resurrect the deleted run's file",
    );
    assert.equal(manager.getRun(runId), undefined);
  }),
);

test(
  "resume immediately after pause is not clobbered by the stale paused execution's delayed settle (#A4)",
  withTempCwd(async (cwd) => {
    let secondAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { signal?: AbortSignal; onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "first") {
          options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
          return "first-result";
        }
        // "second"
        secondAttempts++;
        if (secondAttempts === 1) {
          // First attempt: hang until aborted, then reject only after an
          // artificial delay, so the stale settle races the resumed execution.
          return new Promise((_resolve, reject) => {
            const fire = () => setTimeout(() => reject(new Error("aborted (delayed)")), 40);
            if (options?.signal?.aborted) fire();
            else options?.signal?.addEventListener("abort", fire, { once: true });
          });
        }
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "second-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");

    assert.equal(manager.pause(runId), true);
    // Immediately resume — races the stale execution's still-pending (delayed) rejection.
    assert.equal(await manager.resume(runId), true);

    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const afterResume = manager.getPersistence().load(runId);
    assert.equal(afterResume?.status, "completed", "the resumed execution's outcome");

    // Wait past the stale first execution's delayed (40ms) rejection settling.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const finalState = manager.getPersistence().load(runId);
    assert.equal(
      finalState?.status,
      "completed",
      "the stale execution's later settle must not clobber the resumed run's persisted state",
    );
  }),
);

test(
  "pause() -> immediate resume(): the stale (paused) execution's delayed agent rejection never emits a stray 'error' event (emitLive gate)",
  withTempCwd(async (cwd) => {
    // Same race as #A4 (pause() then immediately resume(), the OLD execution's
    // 'second' agent hangs until aborted and only rejects ~40ms later), but
    // this test targets emitLive()'s isCurrent() gate directly rather than
    // persisted status: executeRun()'s own catch tail (reached when the stale
    // execution's runWorkflow() promise finally rejects) unconditionally
    // computes `usageLimitPaused` and, when it's false and an "error" listener
    // is attached, calls `this.emitLive(managed, "error", ...)`. With the gate
    // intact, isCurrent(managed) is false by then (resume() already replaced
    // this.runs's entry for runId with a brand-new managed/controller), so
    // that emit is silently dropped. Removing the isCurrent() check inside
    // emitLive() (the exact mutation this test targets) would let that stale
    // "error" event reach every listener — including, in production, the task
    // panel's failure-delivery path — for a run that has already resumed (and,
    // as asserted below, completed successfully).
    let secondAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { signal?: AbortSignal; onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "first") {
          options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
          return "first-result";
        }
        secondAttempts++;
        if (secondAttempts === 1) {
          return new Promise((_resolve, reject) => {
            const fire = () => setTimeout(() => reject(new Error("stale agent rejected")), 40);
            if (options?.signal?.aborted) fire();
            else options?.signal?.addEventListener("abort", fire, { once: true });
          });
        }
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "second-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    const errorEvents: unknown[] = [];
    manager.on("error", (e) => errorEvents.push(e));

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");

    assert.equal(manager.pause(runId), true);
    assert.equal(await manager.resume(runId), true);

    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.getPersistence().load(runId)?.status, "completed", "the resumed execution completes");

    // Wait past the stale execution's delayed (40ms) rejection settling —
    // this is when its executeRun() catch tail runs and attempts the stray
    // emitLive("error", ...).
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(
      errorEvents.length,
      0,
      "the stale (paused, superseded) execution's delayed rejection must never reach an 'error' listener",
    );
  }),
);

test(
  "resume() superseding a run-fatal-aborted failed run never delivers a stray sibling agent's agentEnd event (#1)",
  withTempCwd(async (cwd) => {
    // Historical note: this test used to document a genuine gap — a run that
    // reached "failed" WITHOUT managed.controller ever aborting (a parallel()
    // fan-out where one sibling ('failer') throws a non-recoverable error
    // while another ('straggler') is still in flight: Promise.all rejects
    // immediately but does NOT cancel 'straggler'). That gap is now closed at
    // the ROOT — runWorkflow's own run-fatal handling (SharedRuntime.
    // runFatalController, see workflow.ts) fires the instant 'failer's error
    // escapes the top-level script, and every in-flight agent (including
    // 'straggler') links its abort controller to that signal. So 'straggler'
    // still runs to completion here (the fake agent below doesn't check its
    // signal, simulating a real subagent process that doesn't cooperate with
    // abort) — stragglerSettles below proves that — but once it resolves,
    // agentImpl's OWN throwIfAborted() now trips before onAgentEnd is ever
    // called, for BOTH the old (never-resumed) execution and the new
    // (resumed) one, since 'failer' fails identically on replay. So
    // onAgentEnd for "straggler" is never delivered at all — a strictly
    // stronger guarantee than the old isCurrent()-based suppression this test
    // originally probed (that guard remains in place as defense-in-depth for
    // OTHER supersede paths — pause()/stop()/deleteRun() — see the tests
    // below), it just never has to fire for THIS scenario anymore.
    // managed.controller.signal itself still never aborts here (asserted
    // below) — the two abort signals are deliberately independent (see
    // SharedRuntime.runFatalController's doc comment).
    let stragglerSettles = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "failer") {
          throw new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        }
        // "straggler": a real delay, and deliberately ignores any abort
        // signal — simulating a real subagent process that doesn't
        // cooperate with cancellation.
        await new Promise((resolve) => setTimeout(resolve, 60));
        stragglerSettles++;
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "straggler-done";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});
    const agentEndsByLabel = new Map<string, number>();
    manager.on("agentEnd", (e: { label: string }) => {
      agentEndsByLabel.set(e.label, (agentEndsByLabel.get(e.label) ?? 0) + 1);
    });

    const script = `export const meta = { name: 'stray_sibling_demo', description: 'stray sibling agent' }
const xs = await parallel([
  () => agent('failer', { label: 'failer' }),
  () => agent('straggler', { label: 'straggler' }),
])
return xs`;

    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});
    for (let i = 0; i < 200 && manager.getRun(runId)?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.getRun(runId)?.status, "failed", "the run must fail (via 'failer')");
    assert.equal(
      manager.getRun(runId)?.controller.signal.aborted,
      false,
      "managed.controller (options.signal) itself is never aborted by a run-fatal error — only the internal runFatalController is",
    );
    const oldManaged = manager.getRun(runId);

    // Resume: builds a brand-new managed/controller for this runId. The OLD
    // execution's 'straggler' call is still in flight (its run-fatal abort
    // only discards its RESULT once it settles — it doesn't forcibly kill a
    // signal-ignoring runner mid-call), entirely unaffected by resume().
    assert.equal(await manager.resume(runId), true);
    assert.notEqual(manager.getRun(runId), oldManaged, "resume() must have replaced the managed run object");

    // Wait past BOTH the old and the new execution's 'straggler' (each ~60ms
    // from its own start) so both have settled.
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(stragglerSettles, 2, "both the old (stale) and new (current) straggler calls actually ran");
    assert.equal(
      agentEndsByLabel.get("straggler"),
      undefined,
      "run-fatal abort suppresses BOTH stragglers' agentEnd before the manager ever sees them",
    );
  }),
);

test(
  "writeRunToDisk's isCurrent guard is unreachable defense-in-depth: run-fatal abort now stops a stale straggler from ever journaling (#2)",
  withTempCwd(async (cwd) => {
    // HISTORY: this test used to drive a stale schedulePersist() deferred
    // timer (the one path into writeRunToDisk() that skips persistRun()'s own
    // isCurrent guard) by having a superseded-but-never-aborted execution's
    // straggler settle and journal AFTER resume() replaced it. That trigger
    // required a run to reach "failed" WITHOUT managed.controller ever
    // aborting AND its straggler's onAgentJournal still firing after the
    // fact — exactly the gap item 1 (run-fatal abort, see
    // SharedRuntime.runFatalController in workflow.ts) closes: ANY error that
    // fails a top-level run now seals that SAME execution's shared runtime
    // before its own catch returns, so a sibling straggler within THAT
    // execution — like 'straggler' below — trips throwIfAborted() the moment
    // it resolves and NEVER reaches onAgentJournal (see the flow proven
    // below). Since onAgentJournal is schedulePersist()'s only call site,
    // there is no longer a way to construct a genuinely stale (superseded,
    // un-aborted) execution whose straggler still journals afterward — every
    // status transition that would make a run resumable (paused OR failed)
    // is now, structurally, always preceded by at least one abort signal
    // (managed.controller for pause()/stop(), or shared.runFatalController
    // for a run-fatal escape) tripping for that same execution first.
    //
    // The isCurrent() check inside writeRunToDisk() (independent of, and
    // additional to, persistRun()'s own early-return) is KEPT as
    // defense-in-depth — it costs nothing, and protects against a future
    // change that reopens a stale-journal path without anyone re-deriving
    // this whole chain of reasoning. This test now asserts the structural
    // closure directly (the straggler's result never reaches the journal at
    // all) instead of asserting a disk-write side effect that no longer has
    // a way to occur — a test that only proved "nothing happened" for a path
    // that can no longer be exercised would silently stop meaning anything.
    const agent = {
      async run(prompt: string) {
        if (prompt === "failer") {
          throw new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        }
        // "straggler": settles well after 'failer' has already failed the run.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "straggler-stale";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});
    const journaledResults: unknown[] = [];
    manager.on("agentEnd", (e: { label: string; result: unknown }) => {
      if (e.label === "straggler") journaledResults.push(e.result);
    });

    const script = `export const meta = { name: 'stray_timer_demo', description: 'stray schedulePersist timer' }
const xs = await parallel([
  () => agent('failer', { label: 'failer' }),
  () => agent('straggler', { label: 'straggler' }),
])
return xs`;

    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});
    for (let i = 0; i < 200 && manager.getRun(runId)?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.getRun(runId)?.status, "failed");
    assert.equal(manager.getRun(runId)?.controller.signal.aborted, false, "managed.controller itself is never aborted");

    // Wait well past the OLD straggler's 30ms settle. Its result must NEVER
    // reach an agentEnd event — throwIfAborted() (tripped by run-fatal abort,
    // sealed the instant 'failer' escaped) discards it before onAgentJournal
    // (and therefore schedulePersist) is ever called.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      journaledResults.includes("straggler-stale"),
      false,
      "the old (never-aborted-by-controller) execution's straggler must never journal — run-fatal abort discards it first",
    );

    const persisted = manager.getPersistence().load(runId);
    const journal = persisted?.journal ?? [];
    assert.ok(
      !journal.some((entry) => entry.result === "straggler-stale"),
      "the persisted journal must never contain the stale straggler's result either — schedulePersist() is only ever " +
        "called from onAgentJournal, so if the journal never sees it, no stray timer was ever scheduled for it",
    );
    // (resume()'s own correctness — including a genuinely resumed execution's
    // writes landing normally — is covered by #A3/#A4 and the other resume
    // tests above; this test's whole point is the pre-resume structural
    // closure proven above, not resume() itself.)
  }),
);

test(
  "concurrent agents sharing a label get correctly attributed onAgentEnd results (never swapped)",
  withTempCwd(async (cwd) => {
    // Two agents in the same parallel() fan-out share a label ('x') — a
    // routine pattern (parallel()'s own default label is phase-scoped, not
    // per-call-unique, and authors often reuse a label across a fan-out). 'A'
    // (started first) finishes quickly; 'B' (started second) finishes much
    // later. Before keying snapshot lookups on the agent CALL's unique id
    // (see WorkflowRunOptions.onAgentEnd's `id` field in workflow.ts), the
    // manager resolved an onAgentEnd event by reverse-scanning
    // managed.snapshot.agents for the last-pushed entry with a matching label
    // AND status "running" — which, for two concurrently-running same-label
    // agents, picks whichever entry the scan happens to land on rather than
    // the one THIS event actually belongs to. Here that would misattribute
    // A's (fast) result onto B's snapshot slot (B is the last-pushed
    // still-"running" entry when A's event fires), and later attribute B's
    // (slow) result onto A's slot — a full swap.
    const agent = {
      async run(prompt: string) {
        if (prompt === "A") {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return "result-A";
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        return "result-B";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'shared_label_demo', description: 'same-label concurrency' }
const xs = await parallel([
  () => agent('A', { label: 'x' }),
  () => agent('B', { label: 'x' }),
])
return xs`;

    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});

    // Wait past A's ~5ms completion but well before B's ~150ms one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const midSnapshot = manager.getSnapshot(runId);
    assert.ok(midSnapshot, "run must still be live at this point");
    if (!midSnapshot) throw new Error("unreachable");
    const [firstAgent, secondAgent] = midSnapshot.agents;
    assert.equal(firstAgent.label, "x");
    assert.equal(secondAgent.label, "x");
    assert.equal(firstAgent.status, "done", "the first-started agent (A) has already finished");
    assert.equal(firstAgent.resultPreview, "result-A", "A's own result must land on A's own snapshot entry");
    assert.equal(secondAgent.status, "running", "the second-started agent (B) is still genuinely in flight");

    // Wait past B's completion too, then verify final attribution is still correct.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const finalSnapshot = manager.getSnapshot(runId);
    assert.equal(finalSnapshot?.agents[0].resultPreview, "result-A", "A's slot must still hold A's result");
    assert.equal(finalSnapshot?.agents[1].resultPreview, "result-B", "B's slot must hold B's own result, not A's");
  }),
);

test(
  "deleteRun deletes persisted journal entries",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion
    await new Promise((r) => setTimeout(r, 30));

    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    // Verify persistence file is gone by checking listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 0, "no persisted runs should remain after delete");
  }),
);

// ─── startInBackground tests ───────────────────────────────────────────────────

test(
  "startInBackground with args propagates args to workflow script",
  withTempCwd(async (cwd) => {
    // Script that uses args
    const argsScript = `export const meta = { name: 'args_demo', description: 'args test' }
const a = await agent('do it', { label: 'a' })
return { args, a }`;

    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(argsScript, { mode: "test", value: 42 });
    const result = await promise;
    assert.ok(result, "should complete successfully");
  }),
);

test(
  "startInBackground runId is unique per call",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    assert.notEqual(r1.runId, r2.runId, "runIds should be unique");

    // Wait for both to complete
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "startInBackground snapshot is initially populated with workflow name",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    const snap = manager.getSnapshot(runId);
    assert.equal(snap?.name, "tracked_demo");
    assert.equal(snap?.description, "one agent");
    assert.ok(Array.isArray(snap?.phases), "snap.phases should be an array");
    assert.ok(Array.isArray(snap?.logs), "snap.logs should be an array");
    await promise.catch(() => {});
  }),
);

// ─── Multiple runs lifecycle tests ─────────────────────────────────────────────

test(
  "multiple background runs are independently managed",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 30));

    // Both should be running
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Stop one independently
    manager.stop(r1.runId);
    assert.equal(manager.getRun(r1.runId)?.status, "aborted");
    assert.equal(manager.getRun(r2.runId)?.status, "running", "other run should still be running");

    // listRuns should show both
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should be listed");

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "listRuns reflects status changes after pause and stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause
    manager.pause(runId);
    let persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused", "listRuns should show paused status");

    // Stop
    manager.stop(runId);
    persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "listRuns should show aborted status after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Event tests ───────────────────────────────────────────────────────────────

test(
  "listRuns reflects running status immediately after resume",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.pause(runId);

    const resumed = await manager.resume(runId);
    const persisted = manager.listRuns().find((run) => run.runId === runId);

    assert.equal(resumed, true);
    assert.equal(persisted?.status, "running", "listRuns should show running status after resume");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "manager emits 'resumed' event on resume",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let resumedEvent: { runId: string } | null = null;
    manager.on("resumed", (ev: { runId: string }) => {
      resumedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);
    await manager.resume(runId);

    assert.ok(resumedEvent, "resumed event should fire");
    assert.equal(resumedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "manager emits 'error' event on abort with WorkflowError",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });

    let capturedError: { runId: string; error: WorkflowError } | null = null;
    manager.on("error", (ev: { runId: string; error: WorkflowError }) => {
      capturedError = ev;
    });

    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    da.resolve("done");

    try {
      await runPromise;
    } catch {
      /* expected */
    }

    assert.ok(capturedError, "error event should fire on abort");
    assert.ok(capturedError?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal(capturedError?.error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);

// ─── State transition tests ─────────────────────────────────────────────────

test(
  "state transition: running -> pause -> running (pause then resume cycle)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // running -> pause -> running
    assert.equal(manager.getRun(runId)?.status, "running", "should start as running");
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused", "should be paused after pause");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    assert.equal(manager.getRun(runId)?.status, "running", "should be running after resume");

    // Complete the resumed run
    da.resolve("resumed-done");
    await origPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(manager.getRun(runId)?.status, "completed", "should complete after resume finishes");
  }),
);

test(
  "state transition: running -> stop (direct stop while running)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.getRun(runId)?.status, "running");
    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: running -> pause -> stop (pause then stop)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: running -> stop -> resume (stop then try resume -> false)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "cannot resume a stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: completed -> resume (completed run cannot be resumed -> false)",
  withTempCwd(async (cwd) => {
    const agentObj = fakeAgent();
    const runMock = test.mock.method(agentObj, "run");
    const manager = new WorkflowManager({ cwd, agent: agentObj });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise;

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    assert.ok(runId);
    assert.equal(runs[0].status, "completed");
    assert.equal(runMock.mock.callCount(), 1, "agent.run should have been called once");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "cannot resume a completed run");
  }),
);

test(
  "state transition: running -> pause -> pause (double pause -> false)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    assert.equal(manager.pause(runId), false, "second pause should return false");
    assert.equal(manager.getRun(runId)?.status, "paused", "status should remain paused");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Concurrency / race tests ──────────────────────────────────────────────────

test(
  "double resume on a persisted paused run returns false on second call",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while running so we can resume
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // First resume should succeed
    const firstResume = await manager.resume(runId);
    assert.equal(firstResume, true, "first resume should succeed");

    // The resumed run is now running; second resume should return false
    const secondResume = await manager.resume(runId);
    assert.equal(secondResume, false, "second resume should return false when the resumed run is already running");

    da.resolve("done");
    await origPromise.catch(() => {});
  }),
);

test(
  "concurrent pause and stop produces deterministic aborted state",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Call pause and stop without awaiting — synchronous in the event loop
    const _pauseResult = manager.pause(runId);
    const _stopResult = manager.stop(runId);

    // Final state must always be "aborted" because:
    //   pause transitions "running" → "paused"
    //   stop transitions "running" or "paused" → "aborted", never back to "paused"
    // Ordering 1: pause then stop → paused then aborted
    // Ordering 2: stop then pause → aborted, pause returns false
    // In every ordering: final status is "aborted".
    assert.equal(manager.getRun(runId)?.status, "aborted", "final status must be aborted regardless of ordering");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "agent error during resume sets run to failed status",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock the agent runner to throw a non-recoverable WorkflowError on resume.
    // Regular Error/agent rejections get wrapped as recoverable (agent returns
    // null, workflow continues). A non-recoverable WorkflowError propagates up
    // to executeRun's catch block and sets status to "failed".
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — executeRun calls runWorkflow which calls the mocked runner
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");

      // Wait for the background executed run to process the agent error
      await new Promise((r) => setTimeout(r, 100));

      const finalRun = manager.getRun(runId);
      assert.equal(finalRun?.status, "failed", "resumed run should transition to failed when agent errors");
      assert.ok(finalRun?.error instanceof WorkflowError, "error should be a WorkflowError");
      assert.equal(
        (finalRun?.error as WorkflowError).code,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        "error code should be AGENT_EXECUTION_ERROR",
      );
    } finally {
      // Resolve the original deferred promise so the first executeRun settles
      da.runner.run = async (_prompt: string) => "done";
      da.resolve("done");
      await origPromise.catch(() => {});
    }
  }),
);

test(
  "two concurrent background runs are both tracked immediately in listRuns",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);

    // Both runs should be immediately visible in listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should appear in listRuns immediately after startInBackground");

    // Both should be in running status
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Run IDs must be unique
    assert.notEqual(r1.runId, r2.runId);

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

// ─── Failed state transition tests ─────────────────────────────────────────────

test(
  "pause returns false for failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run so we can resume with a failing agent
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError, making the run fail
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail because the mocked agent throws
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");

      // pause() should return false for a failed run (requires status === "running")
      const paused = manager.pause(runId);
      assert.equal(paused, false, "pause should return false for failed run");
      assert.equal(manager.getRun(runId)?.status, "failed", "status should remain failed after rejected pause");
    } finally {
      da.runner.run = async (_prompt: string) => "done";
      da.resolve("done");
      await origPromise.catch(() => {});
    }
  }),
);

test(
  "stop returns false for failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run so we can resume with a failing agent
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");

      // stop() should return false for a failed run (requires "running" or "paused")
      const stopped = manager.stop(runId);
      assert.equal(stopped, false, "stop should return false for failed run");
      assert.equal(manager.getRun(runId)?.status, "failed", "status should remain failed after rejected stop");
    } finally {
      da.runner.run = async (_prompt: string) => "done";
      da.resolve("done");
      await origPromise.catch(() => {});
    }
  }),
);

test(
  "resume restarts a failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail
      await manager.resume(runId);
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");
    } finally {
      // Restore the runner so the resumed run's agent call succeeds
      da.runner.run = async (_prompt: string) => "done";
      da.resolve("done");
      await origPromise.catch(() => {});
    }

    // Resume the failed run — resume() allows failed status
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should return true for a failed run");
    assert.equal(manager.getRun(runId)?.status, "running", "resumed failed run should transition to running");

    // Wait for the resumed run to complete successfully
    await new Promise((r) => setTimeout(r, 100));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed failed run should complete successfully after restore");
  }),
);

// ─── parallel() concurrency tests ───────────────────────────────────────────

test(
  "parallel executes all items",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const script = `export const meta = { name: 'parallel_count', description: 'count parallel agents' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n)))
return results`;
    const result = await manager.runSync(script);
    assert.equal(result.agentCount, 3, "parallel should execute all 3 agents");
    assert.ok(Array.isArray(result.result), "result should be an array");
    assert.equal(result.result.length, 3);
  }),
);

test(
  "parallel returns results in order",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          return prompt;
        },
      },
    });
    const script = `export const meta = { name: 'parallel_order', description: 'check parallel order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n)))
return results`;
    const result = await manager.runSync(script);
    assert.equal(result.agentCount, 3, "3 agents should have run");
    assert.deepEqual(result.result, ["task 1", "task 2", "task 3"], "parallel should return results in input order");
  }),
);

test(
  "parallel with empty array returns empty",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const script = `export const meta = { name: 'parallel_empty', description: 'empty parallel' }
const results = await parallel([])
return results`;
    const result = await manager.runSync(script);
    assert.ok(Array.isArray(result.result), "result should be an array");
    assert.equal(result.result.length, 0, "empty parallel should return empty array");
    assert.equal(result.agentCount, 0, "no agents should run with empty parallel");
  }),
);

test(
  "persistAgentSessions plumbs through the manager into runWorkflow options",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), persistAgentSessions: true });
    // The manager forwards the flag on every runWorkflow call; the flag is
    // captured at construction and defaults to false when omitted.
    assert.equal((manager as unknown as { persistAgentSessions: boolean }).persistAgentSessions, true);

    const defaulted = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal((defaulted as unknown as { persistAgentSessions: boolean }).persistAgentSessions, false);

    // The run still completes normally with the flag set (injected agent
    // runner, so no real session is created here).
    const result = await manager.runSync(oneAgentScript);
    assert.equal(result.agentCount, 1);
  }),
);

test(
  "agents receive an identifiable sessionName (workflow:<runId> <label>) for persisted sessions",
  withTempCwd(async (cwd) => {
    const seen: Array<{ label?: string; sessionName?: string }> = [];
    const manager = new WorkflowManager({
      cwd,
      persistAgentSessions: true,
      agent: {
        async run(_prompt: string, options?: { label?: string; sessionName?: string }) {
          seen.push({ label: options?.label, sessionName: options?.sessionName });
          return "ok";
        },
      },
    });
    const result = await manager.runSync(oneAgentScript);
    assert.equal(result.agentCount, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].label, "a");
    // runWorkflow now uses the managed run's persisted id (slug + generateRunId)
    // so result.runId / session names line up with listRuns()/resume().
    assert.match(seen[0].sessionName ?? "", /^workflow:tracked-demo-[a-z0-9-]+ a$/);
  }),
);

// ─── Edited-script resume (cached-prefix reuse / model iteration) ───────────────
// resume(runId, { script }) lets the orchestrating model re-run with an EDITED
// script: the unchanged agent() prefix replays from the journal (cache hit), and
// the first edited/new call — plus everything after — re-runs live. resume(runId)
// with NO opts stays backward-compatible (uses the persisted script) so #78's
// auto-resume (UsageLimitScheduler calls resume(runId)) is unaffected.

const editResumeScriptV1 = `export const meta = { name: 'edit_resume', description: 'two agents' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-ORIGINAL', { label: 'second' })
return { a, b }`;

/** Runner that records prompts and pauses (usage limit) on the original 2nd prompt. */
function editResumeRunner() {
  const seen: string[] = [];
  const state = { failOriginalSecond: true };
  return {
    seen,
    state,
    runner: {
      async run(prompt: string) {
        seen.push(prompt);
        if (prompt.includes("SECOND-ORIGINAL") && state.failOriginalSecond) {
          throw new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets soon",
          });
        }
        return `ran:${prompt}`;
      },
    },
  };
}

test(
  "resume with an edited script replays the unchanged prefix and re-runs only the edited call",
  withTempCwd(async (cwd) => {
    const { seen, runner } = editResumeRunner();
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("paused", () => {});
    manager.on("error", () => {});

    // First run: agent 1 completes + journals, agent 2 hits a usage limit -> paused.
    const { runId, promise } = manager.startInBackground(editResumeScriptV1);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused", "run pauses on the usage limit");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1 should be journaled");

    // Resume with an EDITED script: agent 1 unchanged, agent 2's prompt changed.
    const editResumeScriptV2 = `export const meta = { name: 'edit_resume', description: 'two agents' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-EDITED', { label: 'second' })
return { a, b }`;

    const seenBeforeResume = seen.length;
    const resumed = await manager.resume(runId, { script: editResumeScriptV2 });
    assert.equal(resumed, true, "resume with edited script should succeed");
    await new Promise((r) => setTimeout(r, 80));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run completes");
    assert.equal(finalRun?.result?.result?.a, "ran:FIRST", "agent 1 replays its cached journal result");
    assert.equal(finalRun?.result?.result?.b, "ran:SECOND-EDITED", "edited agent 2 re-runs live");

    // Cache proof: during the resume, the runner was NOT called for the unchanged
    // agent 1, and WAS called for the edited agent 2.
    const promptsDuringResume = seen.slice(seenBeforeResume);
    assert.ok(!promptsDuringResume.includes("FIRST"), "unchanged agent 1 replayed from journal, not re-run");
    assert.ok(promptsDuringResume.includes("SECOND-EDITED"), "edited agent 2 ran live");

    // The edited script is persisted, so a later resume sees it.
    const persistedAfter = manager.listRuns().find((r) => r.runId === runId);
    assert.match(persistedAfter?.script ?? "", /SECOND-EDITED/, "edited script is persisted");
  }),
);

test(
  "resume(runId) with no opts uses the persisted script (auto-resume backward-compat)",
  withTempCwd(async (cwd) => {
    const { seen, state, runner } = editResumeRunner();
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("paused", () => {});
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(editResumeScriptV1);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Let the original second prompt succeed on the second attempt, then resume
    // with NO opts — exactly how UsageLimitScheduler calls it.
    state.failOriginalSecond = false;
    const seenBeforeResume = seen.length;
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 80));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed");
    assert.equal(finalRun?.result?.result?.a, "ran:FIRST", "agent 1 still replays from journal");
    assert.equal(finalRun?.result?.result?.b, "ran:SECOND-ORIGINAL", "persisted (unedited) script runs agent 2");

    const promptsDuringResume = seen.slice(seenBeforeResume);
    assert.ok(!promptsDuringResume.includes("FIRST"), "agent 1 replayed from journal");
    assert.ok(promptsDuringResume.includes("SECOND-ORIGINAL"), "persisted script's original agent 2 re-ran");
  }),
);

/** Runner that records prompts and pauses (usage limit) on a third, later call. */
function nestedPauseResumeRunner() {
  const seen: string[] = [];
  const state = { failThird: true };
  return {
    seen,
    state,
    runner: {
      async run(prompt: string) {
        seen.push(prompt);
        if (prompt === "third-call" && state.failThird) {
          throw new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets soon",
          });
        }
        return `ran:${prompt}`;
      },
    },
  };
}

test(
  "manager resume: both a nested child's AND the parent's own index-0 journal entries cache-hit, not re-run live (M6)",
  withTempCwd(async (cwd) => {
    // Regression coverage for the manager-level journal dedup keying. The
    // nested child's agent('inner-call') and the parent's own
    // agent('outer-call') both land at callIndex 0 in their respective
    // frames and BOTH journal successfully during the SAME live execution —
    // this is exactly the shape that collides if managed.journal's dedup
    // filter matched on `index` alone (not `(index, runId)`): whichever of
    // the two journals SECOND would evict the other from managed.journal,
    // so the persisted journal silently ends up with only one of the two
    // entries. A third call then fails (usage limit) to force a pause with
    // that (possibly corrupted) journal on disk, and resume must show BOTH
    // completed calls cache-hitting — not just whichever survived a buggy
    // dedup.
    const { seen, state, runner } = nestedPauseResumeRunner();
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("paused", () => {});
    manager.on("error", () => {});

    const script = `export const meta = { name: 'nested_pause_resume', description: 'nested resume' }
const inner = await workflow(\`
  export const meta = { name: 'nested_pause_resume_inner', description: 'inner' }
  const x = await agent('inner-call', { label: 'inner' })
  return x
\`, {})
const outer = await agent('outer-call', { label: 'outer' })
const third = await agent('third-call', { label: 'third' })
return { inner, outer, third }`;

    // First run: the nested child's index-0 call AND the parent's own
    // index-0 call both complete and journal; the parent's third call hits
    // a usage limit -> run pauses.
    const { runId, promise } = manager.startInBackground(script);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused", "run pauses on the third call's usage limit");
    assert.equal(seen.filter((p) => p === "inner-call").length, 1, "the nested child's agent ran once before pause");
    assert.equal(seen.filter((p) => p === "outer-call").length, 1, "the parent's own agent ran once before pause");

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(
      persisted?.journal?.length,
      2,
      "BOTH the child's and the parent's completed index-0 calls must be journaled — neither may have evicted the other",
    );

    // Resume: let the third call succeed this time.
    state.failThird = false;
    const seenBeforeResume = seen.length;
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 80));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run completes");
    assert.equal(finalRun?.result?.result?.inner, "ran:inner-call");
    assert.equal(finalRun?.result?.result?.outer, "ran:outer-call");
    assert.equal(finalRun?.result?.result?.third, "ran:third-call");

    const promptsDuringResume = seen.slice(seenBeforeResume);
    assert.ok(
      !promptsDuringResume.includes("inner-call"),
      "the nested child's journaled call must cache-hit on resume, not re-run live",
    );
    assert.ok(
      !promptsDuringResume.includes("outer-call"),
      "the parent's own journaled call must cache-hit on resume, not re-run live",
    );
    assert.ok(promptsDuringResume.includes("third-call"), "the parent's previously-failed third call re-runs live");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// `runs` map eviction (run-level analog of the subagent memory-retention
// mitigation): terminal runs' in-memory ManagedRun (agents array, journal,
// snapshot) must not accumulate forever, but the navigator/resume must keep
// working against persisted state once a run's in-memory copy is gone.
// ═══════════════════════════════════════════════════════════════════════════

test(
  "completed runs beyond maxTerminalRunsInMemory are evicted from the in-memory map, but stay listable via listRuns()",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), maxTerminalRunsInMemory: 2 });
    const runIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await manager.runSync(oneAgentScript);
      assert.ok(result.runId);
      runIds.push(result.runId as string);
    }

    // Only the 2 most recent terminal runs still have a live ManagedRun.
    assert.equal(manager.getRun(runIds[0]), undefined, "oldest completed run's in-memory state is evicted");
    assert.equal(manager.getRun(runIds[1]), undefined, "2nd oldest completed run's in-memory state is evicted");
    assert.ok(manager.getRun(runIds[2]), "3rd run (within the cap) is still in memory");
    assert.ok(manager.getRun(runIds[3]), "most recent run is still in memory");

    // But every run is still reachable via listRuns() (backed by persistence)
    // — eviction from the in-memory map must never mean "the run vanished".
    const listed = manager
      .listRuns()
      .map((r) => r.runId)
      .sort();
    assert.deepEqual(listed, [...runIds].sort(), "all runs remain listable after eviction");
    for (const id of runIds) {
      const persisted = manager.listRuns().find((r) => r.runId === id);
      assert.equal(persisted?.status, "completed");
      assert.equal(persisted?.agents[0]?.status, "done", "persisted agent detail survives eviction too");
    }
  }),
);

test(
  "eviction never removes a running or paused run's in-memory entry, however many terminal runs pile up around it (separate managers, no queue pressure)",
  withTempCwd(async (cwd) => {
    const held = deferredAgent();
    // A dedicated manager for the long-running run so its agent (never
    // resolving until we say so) doesn't block the terminal runs below.
    const runningManager = new WorkflowManager({ cwd, agent: held.runner, maxTerminalRunsInMemory: 1 });
    const { runId: runningId, promise: runningPromise } = runningManager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(runningManager.getRun(runningId)?.status, "running");

    // Pause a second run so it sits in memory as "paused".
    const pausedManager = new WorkflowManager({ cwd, agent: held.runner, maxTerminalRunsInMemory: 1 });
    const { runId: pausedId } = pausedManager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pausedManager.pause(pausedId), true);
    assert.equal(pausedManager.getRun(pausedId)?.status, "paused");

    // Now complete several terminal runs on a manager with a tiny cap and
    // confirm neither the running nor the paused run's manager evicted them
    // (they're on other manager instances, but exercises the same in-process
    // eviction path with a maximally aggressive cap of 1).
    const busyManager = new WorkflowManager({ cwd, agent: fakeAgent(), maxTerminalRunsInMemory: 1 });
    for (let i = 0; i < 3; i++) {
      await busyManager.runSync(oneAgentScript);
    }

    assert.equal(runningManager.getRun(runningId)?.status, "running", "the running run's entry survives eviction");
    assert.equal(pausedManager.getRun(pausedId)?.status, "paused", "the paused run's entry survives eviction");

    held.resolve();
    await runningPromise.catch(() => {});
  }),
);

test(
  "recordTerminalRun's status re-validation guard: a resumed (live, running) run survives an overflow triggered by its OWN stale queue entry",
  withTempCwd(async (cwd) => {
    // Repro for the guard's necessity (single manager, real queue pressure —
    // unlike the cross-manager test above, which has no queue interaction at
    // all and is structurally unable to catch this class of bug):
    //
    //  1. Run A fails (non-recoverable) -> terminalRunQueue = [A].
    //  2. A is resumed -> a FRESH, live ManagedRun replaces the map entry for
    //     "A" (status "running"), but the STALE "A" queue entry from step 1
    //     is still sitting at the front of terminalRunQueue.
    //  3. Run B terminates -> recordTerminalRun("B") pushes the queue over
    //     maxTerminalRunsInMemory (1), so it shifts the front — the STALE "A"
    //     entry — and must decide whether to evict.
    //
    // Without the guard (evict unconditionally on shift), the LIVE, still-
    // running resumed run A is deleted from `runs` — its eventual settle
    // then fails isCurrent(), silently skipping the final persist AND lease
    // release (run stuck "running" on disk forever, lease leaked). With the
    // guard, recordTerminalRun() re-reads the CURRENT entry for "A" at
    // eviction time, sees status "running" (not terminal), and skips it.
    let aAttempts = 0;
    let resolveHang: ((v: unknown) => void) | undefined;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "A1") {
          aAttempts++;
          if (aAttempts === 1) {
            throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
              recoverable: false,
            });
          }
          // Second attempt (post-resume): hang so A stays "running" in
          // memory while B's overflow fires — exactly the window the bug
          // needs to matter.
          return new Promise((resolve) => {
            resolveHang = resolve;
          });
        }
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      },
    };
    const manager = new WorkflowManager({ cwd, agent, maxTerminalRunsInMemory: 1 });
    manager.on("error", () => {});

    const scriptA = `export const meta = { name: 'run_a', description: 'a' }
const a = await agent('A1', { label: 'a' })
return { a }`;
    const scriptB = `export const meta = { name: 'run_b', description: 'b' }
const b = await agent('B1', { label: 'b' })
return { b }`;

    // 1. A fails -> enqueued (terminal), still evictable in principle.
    const { runId: runAId, promise: aPromise } = manager.startInBackground(scriptA);
    await aPromise.catch(() => {});
    assert.equal(manager.getRun(runAId)?.status, "failed");

    // 2. Resume A: a fresh, live ManagedRun replaces the map entry; the old
    // queue entry for "A" is now stale (still at the front of the queue).
    const resumed = await manager.resume(runAId);
    assert.equal(resumed, true);
    assert.equal(manager.getRun(runAId)?.status, "running", "resumed run A is live and running (hung on attempt 2)");

    // 3. B terminates -> overflows the cap (1), shifting the stale "A" entry.
    const { promise: bPromise } = manager.startInBackground(scriptB);
    await bPromise.catch(() => {});

    // The guard must have refused to evict the LIVE, running resumed A.
    assert.ok(manager.getRun(runAId), "the guard must protect the live resumed run A from its own stale queue entry");
    assert.equal(manager.getRun(runAId)?.status, "running");

    // Clean up the hung agent so nothing keeps the process alive, and prove
    // the surviving entry settles normally afterward.
    resolveHang?.("done");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.getRun(runAId)?.status, "completed", "the protected entry still settles correctly");
  }),
);

test(
  "paused-exclusion in executeRun's catch tail: a usage-limit pause must never create eviction pressure on an unrelated, genuinely-terminal run",
  withTempCwd(async (cwd) => {
    // A separate repro from the one above: here the mutation under test is
    // the catch tail's `if (IN_MEMORY_TERMINAL_STATUSES.has(managed.status))`
    // gate around recordTerminalRun() — NOT the guard inside recordTerminalRun
    // itself. Reached via the usage-limit branch (not manual pause()), which
    // is a distinct code path through executeRun's catch tail.
    //
    // Sequence with maxTerminalRunsInMemory 1:
    //  1. T completes -> terminalRunQueue = [T], within the cap.
    //  2. P pauses on a usage limit. If the catch tail's paused-exclusion gate
    //     were removed, this would ALSO call recordTerminalRun("P"), pushing
    //     the queue to [T, P] — over the cap — and evicting the FRONT entry,
    //     T, purely because P paused (T is genuinely terminal so the
    //     recordTerminalRun-internal guard would not save it). With the gate,
    //     a paused settle never enqueues at all, so T is never touched.
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "P1") {
          throw new WorkflowError(
            "Codex usage limit reached (plus plan). Resets in ~3h.",
            WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
            { recoverable: false, resetHint: "Resets in ~3h" },
          );
        }
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      },
    };
    const manager = new WorkflowManager({ cwd, agent, maxTerminalRunsInMemory: 1 });
    manager.on("error", () => {});
    manager.on("paused", () => {});

    const scriptT = `export const meta = { name: 'run_t', description: 't' }
const t = await agent('T1', { label: 't' })
return { t }`;
    const scriptP = `export const meta = { name: 'run_p', description: 'p' }
const p = await agent('P1', { label: 'p' })
return { p }`;

    const t = await manager.runSync(scriptT);
    const tId = t.runId as string;
    assert.equal(manager.getRun(tId)?.status, "completed");

    const { runId: pId, promise: pPromise } = manager.startInBackground(scriptP);
    await pPromise.catch(() => {});
    assert.equal(manager.getRun(pId)?.status, "paused");

    assert.ok(manager.getRun(tId), "T must survive — a paused settle must never count against the terminal-run cap");
  }),
);

test(
  "resume() succeeds for a run whose in-memory ManagedRun was already evicted (reads persisted state, not the map)",
  withTempCwd(async (cwd) => {
    // A non-recoverable WorkflowError propagates all the way up (unlike a
    // plain agent error, which workflow.ts swallows per-agent and the run
    // still completes) — this settles the run to "failed" (evictable and,
    // per WorkflowManager.resume()'s status guard, still resumable).
    const failingAgent = {
      async run() {
        throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
      },
    };
    const manager = new WorkflowManager({ cwd, agent: failingAgent, maxTerminalRunsInMemory: 1 });
    manager.on("error", () => {});

    const first = await manager.runSync(oneAgentScript).catch((e) => e);
    void first;
    const evictedRunId = manager.listRuns()[0]?.runId as string;

    // Push it out of the in-memory cap with more failing runs.
    for (let i = 0; i < 2; i++) {
      await manager.runSync(oneAgentScript).catch(() => {});
    }
    assert.equal(manager.getRun(evictedRunId), undefined, "the run's in-memory entry has been evicted");

    // Fix the agent so the resumed attempt succeeds, then resume the evicted run.
    const succeedingAgent = fakeAgent();
    const manager2 = new WorkflowManager({ cwd, agent: succeedingAgent, maxTerminalRunsInMemory: 1 });
    const resumed = await manager2.resume(evictedRunId);
    assert.equal(resumed, true, "resume works purely from persisted state even though the in-memory copy is gone");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(manager2.listRuns().find((r) => r.runId === evictedRunId)?.status, "completed");
  }),
);

test(
  "stop() on an already-paused run marks it eviction-eligible (its own executeRun tail already settled at pause time, so no future tail ever will)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner, maxTerminalRunsInMemory: 1 });
    manager.on("error", () => {});

    const { runId: pausedId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager.pause(pausedId), true);
    assert.equal(manager.getRun(pausedId)?.status, "paused");

    // Let pause()'s abort-triggered executeRun() tail fully settle BEFORE
    // stopping — the realistic case the fix targets. By now the run's only
    // executeRun() promise has already resolved once (as "paused", which is
    // deliberately NOT enqueued for eviction — see IN_MEMORY_TERMINAL_STATUSES),
    // so nothing will ever call recordTerminalRun() for it again except
    // stop() itself.
    da.resolve("done");
    await promise.catch(() => {});
    assert.equal(manager.getRun(pausedId)?.status, "paused", "still paused; the already-settled tail didn't change it");

    assert.equal(manager.stop(pausedId), true);
    assert.equal(manager.getRun(pausedId)?.status, "aborted");

    // One more terminal run overflows the cap (1): the stopped run must be
    // the one evicted — proving stop() itself recorded it terminal-eligible
    // (without that, it would sit in `runs` forever: no pending tail left to
    // ever call recordTerminalRun() for it).
    const other = await manager.runSync(oneAgentScript);
    assert.ok(manager.getRun(other.runId), "the newest terminal run is in memory");
    assert.equal(
      manager.getRun(pausedId),
      undefined,
      "stop() must have recorded the already-settled paused run as terminal-eligible, so it's evicted here",
    );
  }),
);
