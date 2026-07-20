import assert from "node:assert/strict";
import test from "node:test";
import type { JournalEntry } from "../src/workflow.js";
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
