import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowCheckpointSuspensionError } from "../src/errors.js";
import type { JournalEntry, WorkflowCheckpoint } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

test("checkpoint(): headless takes the declared default and journals it", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const ok = await checkpoint('Approve plan?', { default: true })
const name = await checkpoint('Pick a name', { default: 'fallback' })
return { ok, name }`;
  const res = await runWorkflow<{ ok: boolean; name: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.name, "fallback");
  assert.equal(journal.length, 2, "both checkpoints journaled");
});

test("checkpoint(): headless 'abort' throws when no UI is threaded in", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('Approve?', { headless: 'abort' })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /human input|headless/i);
});

test("checkpoint(): uses the threaded confirm when present", async () => {
  let asked = "";
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?', { kind: 'confirm' })`;
  const res = await runWorkflow<string>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async (p) => {
      asked = p;
      return "yes";
    },
  });
  assert.equal(res.result, "yes");
  assert.equal(asked, "Proceed?");
});

test("checkpoint(): replays the journaled reply on resume (no re-prompt)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const r = await checkpoint('Approve?', {})
return { r }`;
  const journal = new Map<string, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    runId: "checkpoint-resume-run",
    confirm: async () => "approved",
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  assert.equal(first.result.r, "approved");

  let calledAgain = false;
  const second = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    runId: "checkpoint-resume-run",
    resumeJournal: journal,
    confirm: async () => {
      calledAgain = true;
      return "DIFFERENT";
    },
  });
  assert.equal(second.result.r, "approved", "reply replays from the journal");
  assert.equal(calledAgain, false, "confirm is not called again on resume");
});

test("checkpoint(): counts against maxAgents (no tokens, but bounded)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('a', { default: 1 })
await checkpoint('b', { default: 1 })
await checkpoint('c', { default: 1 })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false, maxAgents: 2 }), /limit/i);
});

test("checkpoint(): durable object suspends, then replays its persisted response", async () => {
  const script = `export const meta = { name: 'durable', description: 'durable checkpoint' }
const publication = await checkpoint({ kind: 'proposal-ready', checkpointId: 'proposal-1', payload: { digest: 'abc' } })
return { publication }`;
  const updates: WorkflowCheckpoint[] = [];

  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "durable-checkpoint-run",
        onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
      }),
    (error) => error instanceof WorkflowCheckpointSuspensionError,
  );
  assert.deepEqual(updates, [
    {
      version: 1,
      checkpointId: "proposal-1",
      kind: "proposal-ready",
      status: "waiting",
      payload: { digest: "abc" },
      createdAt: updates[0]?.createdAt,
    },
  ]);

  const journal = new Map<string, JournalEntry>();
  const resumed = await runWorkflow<{ publication: unknown }>(script, {
    agent: noopAgent,
    persistLogs: false,
    runId: "durable-checkpoint-run",
    resumeCheckpoint: {
      ...updates[0],
      status: "resuming",
      response: { head: "def" },
    },
    onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry),
    onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
  });

  assert.deepEqual(resumed.result.publication, { head: "def" });
  assert.deepEqual(updates[1], {
    ...updates[0],
    status: "consumed",
    response: { head: "def" },
    consumedAt: updates[1]?.consumedAt,
  });
  assert.equal(journal.size, 1, "the resumed response is journaled before execution continues");
});

test("checkpoint(): durable payload rejects lossy non-JSON values", async () => {
  const scripts = [
    `export const meta = { name: 'nan', description: 'nan payload' }
await checkpoint({ kind: 'proposal-ready', checkpointId: 'nan', payload: { approved: NaN } })`,
    `export const meta = { name: 'undefined', description: 'undefined payload' }
await checkpoint({ kind: 'proposal-ready', checkpointId: 'undefined', payload: { approved: undefined } })`,
    `export const meta = { name: 'accessor', description: 'accessor payload' }
const values = []
Object.defineProperty(values, '0', { enumerable: true, get() { return true } })
values.length = 1
await checkpoint({ kind: 'proposal-ready', checkpointId: 'accessor', payload: { values } })`,
  ];
  for (const script of scripts) {
    await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /lossless JSON value/);
  }
});

test("checkpoint(): durable object accepts only controller checkpoint kinds", async () => {
  const script = `export const meta = { name: 'kind', description: 'invalid kind' }
await checkpoint({ kind: 'custom', checkpointId: 'custom', payload: {} })`;
  await assert.rejects(
    () => runWorkflow(script, { agent: noopAgent, persistLogs: false }),
    /exactly.*kind.*checkpointId.*payload/i,
  );
});

test("checkpoint(): concurrent distinct checkpoints expose only one active checkpoint", async () => {
  const script = `export const meta = { name: 'concurrent', description: 'concurrent checkpoints' }
const values = await Promise.all([
  checkpoint({ kind: 'proposal-ready', checkpointId: 'first', payload: { order: 1 } }),
  checkpoint({ kind: 'waiting-for-gitlab', checkpointId: 'second', payload: { order: 2 } }),
])
return values`;
  const updates: WorkflowCheckpoint[] = [];
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "concurrent-checkpoint-run",
        onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
      }),
    WorkflowCheckpointSuspensionError,
  );
  assert.deepEqual(
    updates.map(({ checkpointId, status }) => ({ checkpointId, status })),
    [{ checkpointId: "first", status: "waiting" }],
  );

  const first = updates[0];
  assert.ok(first);
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "concurrent-checkpoint-run",
        resumeCheckpoint: { ...first, status: "resuming", response: { accepted: true } },
        onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
      }),
    WorkflowCheckpointSuspensionError,
  );
  assert.deepEqual(
    updates.slice(1).map(({ checkpointId, status }) => ({ checkpointId, status })),
    [
      { checkpointId: "first", status: "consumed" },
      { checkpointId: "second", status: "waiting" },
    ],
  );
});
test("checkpoint(): outer then nested checkpoints consume one shared response in order", async () => {
  const child = `export const meta = { name: 'child', description: 'nested checkpoint' }
return await checkpoint({ kind: 'waiting-for-gitlab', checkpointId: 'nested-second', payload: { order: 2 } })`;
  const outer = `export const meta = { name: 'outer', description: 'outer then nested' }
const first = await checkpoint({ kind: 'proposal-ready', checkpointId: 'outer-first', payload: { order: 1 } })
const second = await workflow('child')
return { first, second }`;
  const journal = new Map<string, JournalEntry>();
  const updates: WorkflowCheckpoint[] = [];
  const execute = (resumeCheckpoint?: WorkflowCheckpoint) =>
    runWorkflow<{ first: unknown; second: unknown }>(outer, {
      agent: noopAgent,
      persistLogs: false,
      runId: "outer-nested-run",
      loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
      resumeJournal: journal,
      ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
      onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry),
      onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
    });

  await assert.rejects(() => execute(), WorkflowCheckpointSuspensionError);
  const first = updates.at(-1);
  assert.ok(first);
  await assert.rejects(
    () => execute({ ...first, status: "resuming", response: { accepted: 1 } }),
    WorkflowCheckpointSuspensionError,
  );
  const second = updates.at(-1);
  assert.ok(second);
  assert.equal(second.checkpointId, "nested-second");
  const completed = await execute({ ...second, status: "resuming", response: { accepted: 2 } });
  assert.equal(JSON.stringify(completed.result), JSON.stringify({ first: { accepted: 1 }, second: { accepted: 2 } }));
});

test("checkpoint(): nested then outer checkpoints consume one shared response in order", async () => {
  const child = `export const meta = { name: 'child', description: 'nested checkpoint' }
return await checkpoint({ kind: 'proposal-ready', checkpointId: 'nested-first', payload: { order: 1 } })`;
  const outer = `export const meta = { name: 'outer', description: 'nested then outer' }
const first = await workflow('child')
const second = await checkpoint({ kind: 'waiting-for-gitlab', checkpointId: 'outer-second', payload: { order: 2 } })
return { first, second }`;
  const journal = new Map<string, JournalEntry>();
  const updates: WorkflowCheckpoint[] = [];
  const execute = (resumeCheckpoint?: WorkflowCheckpoint) =>
    runWorkflow<{ first: unknown; second: unknown }>(outer, {
      agent: noopAgent,
      persistLogs: false,
      runId: "nested-outer-run",
      loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
      resumeJournal: journal,
      ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
      onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry),
      onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
    });

  await assert.rejects(() => execute(), WorkflowCheckpointSuspensionError);
  const first = updates.at(-1);
  assert.ok(first);
  await assert.rejects(
    () => execute({ ...first, status: "resuming", response: { accepted: 1 } }),
    WorkflowCheckpointSuspensionError,
  );
  const second = updates.at(-1);
  assert.ok(second);
  assert.equal(second.checkpointId, "outer-second");
  const completed = await execute({ ...second, status: "resuming", response: { accepted: 2 } });
  assert.equal(JSON.stringify(completed.result), JSON.stringify({ first: { accepted: 1 }, second: { accepted: 2 } }));
});

test("checkpoint(): nested workflow frames cannot reuse a durable checkpoint ID", async () => {
  const child = (name: string) => `export const meta = { name: '${name}', description: 'duplicate nested ID' }
return await checkpoint({ kind: 'proposal-ready', checkpointId: 'shared-id', payload: { child: '${name}' } })`;
  const outer = `export const meta = { name: 'outer', description: 'duplicate nested IDs' }
await workflow('one')
await workflow('two')
return 'unreachable'`;
  const journal = new Map<string, JournalEntry>();
  let waiting: WorkflowCheckpoint | undefined;
  const options = {
    agent: noopAgent,
    persistLogs: false,
    runId: "nested-duplicate-run",
    loadSavedWorkflow: (name: string) => (name === "one" || name === "two" ? child(name) : undefined),
    resumeJournal: journal,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId}:${entry.index}`, entry),
    onWorkflowCheckpoint: (checkpoint: WorkflowCheckpoint) => {
      waiting = checkpoint;
    },
  };
  await assert.rejects(() => runWorkflow(outer, options), WorkflowCheckpointSuspensionError);
  assert.ok(waiting);
  await assert.rejects(
    () => runWorkflow(outer, { ...options, resumeCheckpoint: { ...waiting, status: "resuming", response: {} } }),
    /must be unique within the run/,
  );
});

test("checkpoint(): durable checkpoint IDs cannot be reused within one run", async () => {
  const script = `export const meta = { name: 'duplicate', description: 'duplicate durable checkpoint' }
await checkpoint({ kind: 'proposal-ready', checkpointId: 'same-id', payload: { cycle: 1 } })
await checkpoint({ kind: 'waiting-for-gitlab', checkpointId: 'same-id', payload: { cycle: 2 } })
return 'unreachable'`;
  let waiting: WorkflowCheckpoint | undefined;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "duplicate-checkpoint-run",
        onWorkflowCheckpoint: (checkpoint) => {
          waiting = checkpoint;
        },
      }),
    WorkflowCheckpointSuspensionError,
  );
  assert.ok(waiting);

  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "duplicate-checkpoint-run",
        resumeCheckpoint: { ...waiting, status: "resuming", response: {} },
      }),
    /must be unique within the run/,
  );
});

// ─── Checkpoint resume-identity hash coverage ─────────────────────────────────

test("checkpoint(): resume cache misses (re-applies the NEW default) when only `default` changes", async () => {
  const script = (def: string) => `export const meta = { name: 'c', description: 'checkpoint' }
const r = await checkpoint('Approve?', { default: ${JSON.stringify(def)} })
return { r }`;
  const journal = new Map<string, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script("A"), {
    agent: noopAgent,
    persistLogs: false,
    runId: "checkpoint-default-run",
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  assert.equal(first.result.r, "A");

  // Edited script: same prompt/kind/choices, only `default` changed. Before
  // this fix, `default` was not part of the checkpoint hash, so this would
  // wrongly cache-hit and resume with the STALE journaled "A" reply instead
  // of the new default "B".
  const second = await runWorkflow<{ r: string }>(script("B"), {
    agent: noopAgent,
    persistLogs: false,
    runId: "checkpoint-default-run",
    resumeJournal: journal,
  });
  assert.equal(second.result.r, "B", "changed default busts the cache and takes the NEW default live");
});

test("checkpoint(): resume cache misses (throws live) when only `headless` changes to 'abort'", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const r = await checkpoint('Approve?', { default: true, headless: 'default' })
return { r }`;
  const journal = new Map<string, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    runId: "checkpoint-headless-run",
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  assert.equal(first.result.r, true);

  // Edited script: same prompt/default, only `headless` changed to "abort".
  // Before this fix, `headless` was not part of the hash, so this would
  // wrongly cache-hit and silently keep replaying the old "default" reply
  // instead of ever exercising the new abort behavior.
  const abortScript = script.replace("headless: 'default'", "headless: 'abort'");
  await assert.rejects(
    () =>
      runWorkflow(abortScript, {
        agent: noopAgent,
        persistLogs: false,
        runId: "checkpoint-headless-run",
        resumeJournal: journal,
      }),
    /headless/i,
    "changed headless mode busts the cache and re-evaluates live instead of replaying the stale reply",
  );
});

test("checkpoint(): resume cache HITS when nothing (including default/headless/timeoutMs) changes", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const r = await checkpoint('Approve?', { default: true, headless: 'default', timeoutMs: 5000 })
return { r }`;
  const journal = new Map<string, JournalEntry>();
  await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    runId: "checkpoint-stable-run",
    confirm: async () => "human-said-yes",
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });

  let confirmCalledOnResume = false;
  const second = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    runId: "checkpoint-stable-run",
    resumeJournal: journal,
    confirm: async () => {
      confirmCalledOnResume = true;
      return "different";
    },
  });
  assert.equal(confirmCalledOnResume, false, "identical options must still cache-hit — no re-prompt");
  assert.equal(second.result.r, "human-said-yes", "the journaled reply replays unchanged");
});
