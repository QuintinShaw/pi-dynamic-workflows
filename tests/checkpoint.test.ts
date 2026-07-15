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
  assert.ok(journal.every((entry) => entry.source === "checkpoint"));
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
  const journal = new Map<number, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => "approved",
    onAgentJournal: (e) => journal.set(e.index, e),
  });
  assert.equal(first.result.r, "approved");

  let calledAgain = false;
  const second = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
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
