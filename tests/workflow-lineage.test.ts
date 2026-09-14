import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunOptions, AgentUsage } from "../src/agent.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const zeroUsage: AgentUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 1,
  cost: 0,
};

type SessionAwareRunner = {
  run(prompt: string, options?: AgentRunOptions): Promise<string>;
};

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-lineage-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-lineage-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const duplicateLabelScript = `export const meta = { name: 'lineage', description: 'lineage' }
const results = await parallel(['one', 'two'].map((prompt) => () => agent(prompt, { label: 'same-label' })))
return results`;

function runnerWithSessions(
  onUsageAt?: (prompt: string, timestamp: number) => void,
  sessionFile = (prompt: string) => `/children/${prompt}.jsonl`,
): SessionAwareRunner {
  return {
    async run(prompt, options) {
      // Make launch-vs-usage ordering observable without a provider call.
      await new Promise((resolve) => setTimeout(resolve, prompt === "one" ? 20 : 5));
      options?.onSessionCreated?.({
        sessionId: `child-session-${prompt}`,
        sessionFile: sessionFile(prompt),
      });
      const usageAt = Date.now();
      onUsageAt?.(prompt, usageAt);
      options?.onUsage?.(zeroUsage);
      return `result-${prompt}`;
    },
  };
}

test(
  "persists the frozen parent identity and child session identity by callId",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      sessionId: "parent-session-id",
      sessionFile: "/parents/host.jsonl",
      persistAgentSessions: true,
      agent: runnerWithSessions(),
    });

    const result = await manager.runSync(duplicateLabelScript);
    const persisted = manager.getPersistence().load(result.runId as string);
    assert.equal(persisted?.sessionId, "parent-session-id");
    assert.equal(persisted?.parentSessionId, "parent-session-id");
    assert.equal(persisted?.parentSessionFile, "/parents/host.jsonl");

    assert.equal(persisted?.agents.length, 2);
    for (const agent of persisted?.agents ?? []) {
      assert.match(agent.callId ?? "", new RegExp(`^${result.runId}:[01]$`));
      assert.ok(agent.sessionId);
      assert.ok(agent.sessionFile);
      assert.equal(agent.label, "same-label");
      assert.ok(agent.startedAt);
      assert.ok(agent.endedAt);
    }
  }),
);

test(
  "concurrent duplicate labels remain distinguishable and startedAt is before child usage",
  withTempCwd(async (cwd) => {
    const usageAt = new Map<string, number>();
    const starts = new Map<string, number>();
    const manager = new WorkflowManager({
      cwd,
      agent: runnerWithSessions((prompt, timestamp) => usageAt.set(prompt, timestamp)),
    });
    manager.on("agentStart", (event: { id: string }) => starts.set(event.id, Date.now()));

    const runStartedAt = Date.now();
    const result = await manager.runSync(duplicateLabelScript);
    const persisted = manager.getPersistence().load(result.runId as string);
    const agents = persisted?.agents ?? [];
    assert.equal(new Set(agents.map((agent) => agent.callId)).size, 2);
    assert.equal(new Set(agents.map((agent) => agent.sessionFile)).size, 2);

    for (const agent of agents) {
      const callId = agent.callId as string;
      const prompt = agent.prompt;
      const startedAt = new Date(agent.startedAt as string).getTime();
      // The manager records launch time before emitting agentStart; the event
      // listener can run in the next millisecond (or later under load).
      assert.ok(startedAt >= runStartedAt);
      assert.ok(startedAt <= (starts.get(callId) as number));
      assert.ok(startedAt < (usageAt.get(prompt) as number));
    }
  }),
);

test(
  "agent session identity and launch timing survive pause/resume replay",
  withTempCwd(async (cwd) => {
    let secondAttempt = 0;
    const runner: SessionAwareRunner = {
      async run(prompt, options) {
        const attempt = prompt === "second" ? secondAttempt++ : 0;
        options?.onSessionCreated?.({
          sessionId: `child-${prompt}-${attempt}`,
          sessionFile: `/children/${prompt}-${attempt}.jsonl`,
        });
        if (prompt === "first") {
          options?.onUsage?.(zeroUsage);
          return "first-result";
        }
        if (attempt === 0) {
          return new Promise<string>((_resolve, reject) => {
            if (options?.signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        options?.onUsage?.(zeroUsage);
        return "second-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("error", () => {});
    const script = `export const meta = { name: 'resume-lineage', description: 'resume-lineage' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return { first, second }`;
    const { runId, promise } = manager.startInBackground(script);
    for (let i = 0; i < 100 && secondAttempt === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(secondAttempt, 1, "second agent should be in flight before pausing");
    assert.equal(manager.pause(runId), true);
    await promise.catch(() => {});

    const paused = manager.getPersistence().load(runId);
    const pausedFirst = paused?.agents.find((agent) => agent.callId === `${runId}:0`);
    assert.ok(pausedFirst?.startedAt);
    assert.ok(pausedFirst?.endedAt);
    assert.equal(pausedFirst?.sessionFile, "/children/first-0.jsonl");

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const resumed = manager.getPersistence().load(runId);
    const resumedFirst = resumed?.agents.find((agent) => agent.callId === `${runId}:0`);
    const resumedSecond = resumed?.agents.find((agent) => agent.callId === `${runId}:1`);
    assert.equal(resumed?.status, "completed");
    assert.equal(resumedFirst?.startedAt, pausedFirst?.startedAt, "replay keeps the original launch marker");
    assert.equal(resumedFirst?.endedAt, pausedFirst?.endedAt, "replay keeps the original completion marker");
    assert.equal(resumedFirst?.sessionId, pausedFirst?.sessionId);
    assert.equal(resumedFirst?.sessionFile, pausedFirst?.sessionFile);
    assert.ok(resumedSecond?.endedAt, "the resumed live child gets a completion marker");
  }),
);

test(
  "persistAgentSessions false keeps the workflow working without a child session file",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      persistAgentSessions: false,
      agent: runnerWithSessions(undefined, () => undefined),
    });
    const result = await manager.runSync(`export const meta = { name: 'ephemeral', description: 'ephemeral' }
const value = await agent('work', { label: 'ephemeral' })
return value`);
    const persisted = manager.getPersistence().load(result.runId as string);
    assert.equal(persisted?.status, "completed");
    assert.equal(persisted?.agents[0]?.sessionId, "child-session-work");
    assert.equal(persisted?.agents[0]?.sessionFile, undefined);
  }),
);
