import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, AgentRegistry } from "../src/agent-registry.js";
import { SharedStore } from "../src/shared-store.js";
import { runWorkflow } from "../src/workflow.js";

// ─── SharedStore unit tests ───────────────────────────────────────────────────

test("SharedStore.put / get / has basics", () => {
  const store = new SharedStore();
  assert.equal(store.has("x"), false);
  assert.equal(store.get("x"), undefined);
  store.put("x", 42);
  assert.equal(store.has("x"), true);
  assert.equal(store.get("x"), 42);
});

test("SharedStore.snapshot returns deep copy", () => {
  const store = new SharedStore();
  store.put("obj", { nested: 1 });
  const snap = store.snapshot();
  (snap.obj as { nested: number }).nested = 999;
  assert.deepEqual(store.get("obj"), { nested: 1 }, "mutation of snapshot must not affect the store");
});

test("SharedStore.trackPut + commitDelta tracks per-agent writes", () => {
  const store = new SharedStore();
  store.trackPut("a", 1, "run-1:2");
  store.trackPut("b", 2, "run-1:3");
  store.trackPut("a", 10, "run-1:2"); // overwrite for agent 2

  const delta2 = store.commitDelta("run-1:2");
  const delta3 = store.commitDelta("run-1:3");

  assert.deepEqual(delta2, { a: 10 });
  assert.deepEqual(delta3, { b: 2 });

  // After commit the deltas are cleared
  assert.deepEqual(store.commitDelta("run-1:2"), {});
  assert.deepEqual(store.commitDelta("run-1:3"), {});
});

test("SharedStore.applyDelta adds keys without clearing", () => {
  const store = new SharedStore();
  store.put("existing", "keep");
  store.applyDelta({ newKey: "added" });
  assert.equal(store.get("existing"), "keep");
  assert.equal(store.get("newKey"), "added");
});

test("SharedStore.applyDelta: replaying parallel-agent deltas in callSeq order is correct", () => {
  // Scenario: agents 2 and 3 run in parallel.
  // Agent 3 finishes first and writes {y: 2}; agent 2 writes {x: 1}.
  // With full-map restore (old code), replaying in callSeq order (2 then 3)
  // would overwrite x with only {y: 2}. With deltas it accumulates correctly.
  const store = new SharedStore();

  // Simulate agent 2 delta and agent 3 delta as captured at completion time.
  const delta2 = { x: 1 };
  const delta3 = { y: 2 };

  // Replay in callSeq order (2, then 3).
  store.applyDelta(delta2);
  store.applyDelta(delta3);

  assert.equal(store.get("x"), 1, "agent 2 write must survive after agent 3 delta is applied");
  assert.equal(store.get("y"), 2, "agent 3 write must be present");
});

test("SharedStore.dispose clears map and agent deltas", () => {
  const store = new SharedStore();
  store.put("k", "v");
  store.trackPut("k2", "v2", "run-1:1");
  store.dispose();
  assert.equal(store.get("k"), undefined);
  assert.deepEqual(store.commitDelta("run-1:1"), {});
});

// ─── Delta-key collision regression (defect: nested workflow() shares a store
// but restarts callSeq at 0) ───────────────────────────────────────────────────

test("agentDeltas keyed by bare callIndex collide across two runs sharing a store", () => {
  // This documents the bug shape at the SharedStore level: if callers key
  // trackPut/commitDelta by a bare index (not a run-unique deltaKey), two
  // different logical runs sharing one store instance and both using callIndex
  // 0 stomp on each other's delta.
  const store = new SharedStore();

  // Simulate the OLD buggy call convention: both "runs" pass the bare index.
  const BUGGY_PARENT_KEY = "0";
  const BUGGY_NESTED_KEY = "0"; // collides with the parent's key under the old scheme

  store.trackPut("parentKey", "parentValue", BUGGY_PARENT_KEY);
  store.trackPut("nestedKey", "nestedValue", BUGGY_NESTED_KEY);

  // Only one delta survives under the collided key — the nested run's write
  // clobbered the parent's delta entry entirely.
  const collided = store.commitDelta(BUGGY_PARENT_KEY);
  assert.deepEqual(
    collided,
    { parentKey: "parentValue", nestedKey: "nestedValue" },
    "both puts landed in the SAME delta bucket because the keys collided",
  );

  // With run-unique keys (the fix), the same scenario keeps deltas separate.
  const store2 = new SharedStore();
  store2.trackPut("parentKey", "parentValue", "run-abc:0");
  store2.trackPut("nestedKey", "nestedValue", "run-abc-nested1:0");
  assert.deepEqual(store2.commitDelta("run-abc:0"), { parentKey: "parentValue" });
  assert.deepEqual(store2.commitDelta("run-abc-nested1:0"), { nestedKey: "nestedValue" });
});

// ─── Cross-run isolation ──────────────────────────────────────────────────────

test("each runWorkflow call gets an isolated SharedStore: run 2 does not see run 1's writes", async () => {
  const readsByRun: Record<string, boolean> = {};

  const agent = {
    async run(
      prompt: string,
      opts: { systemTools?: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] },
    ) {
      if (prompt === "put") {
        await opts.systemTools?.find((t) => t.name === "store_put")?.execute("", { key: "shared_key", value: "run1" });
        return "wrote";
      }
      // prompt === "get"
      const res = (await opts.systemTools?.find((t) => t.name === "store_get")?.execute("", { key: "shared_key" })) as {
        details?: { found?: boolean };
      };
      readsByRun[prompt] = res?.details?.found ?? false;
      return "read";
    },
  };

  const putScript = `
    export const meta = { name: "isolation-put", description: "writes to the store" };
    return await agent("put", {});
  `;
  const getScript = `
    export const meta = { name: "isolation-get", description: "reads from the store" };
    return await agent("get", {});
  `;

  // Run 1 writes "shared_key" into its own store.
  await runWorkflow(putScript, { agent, cwd: process.cwd() });
  // Run 2 is a brand new runWorkflow call (fresh SharedStore) and must NOT see it.
  await runWorkflow(getScript, { agent, cwd: process.cwd() });

  assert.equal(readsByRun.get, false, "a second, independent runWorkflow call must not see run 1's store writes");
});

test("store_put/store_get are injected as systemTools even under a restrictive agentType tools allowlist", async () => {
  let observedToolNames: string[] | undefined;
  let observedSystemToolNames: string[] | undefined;

  const agent = {
    async run(_prompt: string, opts: { toolNames?: string[]; systemTools?: { name: string }[] }) {
      observedToolNames = opts.toolNames;
      observedSystemToolNames = opts.systemTools?.map((t) => t.name);
      return "ok";
    },
  };

  // A restrictive agentType allowlist that does NOT mention store_put/store_get.
  const restrictiveDef: AgentDefinition = {
    name: "read-only-auditor",
    tools: ["read_file"], // deliberately narrow — should never include store tools
    prompt: "You audit code read-only.",
    source: "project",
  };
  const agentRegistry: AgentRegistry = new Map([["read-only-auditor", restrictiveDef]]);

  const script = `
    export const meta = { name: "allowlist-bypass-test", description: "allowlist bypass test" };
    return await agent("audit", { agentType: "read-only-auditor" });
  `;

  await runWorkflow(script, { agent, cwd: process.cwd(), agentRegistry });

  // The allowlist passed through to the coding-tool filter is indeed restrictive...
  assert.deepEqual(observedToolNames, ["read_file"], "agentType.tools allowlist must reach the agent runner");
  // ...but store_put/store_get are still present via systemTools, which bypass
  // the allowlist filter entirely (this is the headline feature of SharedStore).
  assert.ok(observedSystemToolNames?.includes("store_put"), "store_put must be injected despite the allowlist");
  assert.ok(observedSystemToolNames?.includes("store_get"), "store_get must be injected despite the allowlist");
});

// ─── Nested workflow() delta-collision regression (defect #1) ────────────────

test("nested workflow() concurrent with its parent does not collide on shared-store deltas", async () => {
  // Regression test for the delta-key-collision bug: a nested workflow() call
  // restarts its own callSeq at 0 while sharing the parent's SharedStore. If
  // agentDeltas were keyed by bare callIndex, a parent agent and a
  // concurrently-running nested-run agent could both land on callIndex 0 and
  // steal/overwrite each other's journaled delta. Both writes must survive.
  const journal: import("../src/workflow.js").JournalEntry[] = [];

  const agent = {
    async run(
      prompt: string,
      opts: {
        systemTools?: Array<{ name: string; execute: (id: string, p: unknown) => Promise<unknown> }>;
      },
    ) {
      if (prompt.startsWith("put:")) {
        const [, key, val] = prompt.split(":");
        await opts.systemTools?.find((t) => t.name === "store_put")?.execute("", { key, value: val });
        return `wrote ${key}`;
      }
      if (prompt.startsWith("get:")) {
        const [, key] = prompt.split(":");
        const res = (await opts.systemTools?.find((t) => t.name === "store_get")?.execute("", { key })) as {
          details?: { value?: unknown; found?: boolean };
        };
        return { key, found: res?.details?.found, value: res?.details?.value };
      }
      return "ok";
    },
  };

  // Outer script: kicks off a nested workflow() concurrently with its own
  // parent-level agent() call, both writing to the shared store at the same
  // (per-run) callIndex 0. Then reads both keys back.
  const outerScript = `
    export const meta = { name: "nested-collision-outer", description: "outer" };
    const [, parentResult] = await Promise.all([
      workflow(\`
        export const meta = { name: "nested-collision-inner", description: "inner" };
        return await agent("put:nestedKey:fromNested", {});
      \`, {}),
      agent("put:parentKey:fromParent", {}),
    ]);
    const gotParent = await agent("get:parentKey");
    const gotNested = await agent("get:nestedKey");
    return { parentResult, gotParent, gotNested };
  `;

  const result = await runWorkflow<{
    gotParent: { key: string; found: boolean; value: unknown };
    gotNested: { key: string; found: boolean; value: unknown };
  }>(outerScript, {
    agent,
    cwd: process.cwd(),
    onAgentJournal: (e) => journal.push(e),
  });

  // Both the parent-run write and the nested-run write must be independently
  // visible — neither delta was stolen/overwritten by the other despite both
  // originating from callIndex 0 in their respective runs.
  assert.equal(result.result.gotParent.found, true, "parent's write must survive");
  assert.equal(result.result.gotParent.value, "fromParent");
  assert.equal(result.result.gotNested.found, true, "nested run's write must survive");
  assert.equal(result.result.gotNested.value, "fromNested");

  // At the journal level: there must be two distinct non-empty storeDelta
  // entries (one per run) rather than one clobbering the other down to a
  // single surviving key.
  const nonEmptyDeltas = journal.filter((e) => Object.keys(e.storeDelta ?? {}).length > 0);
  const allDeltaKeys = nonEmptyDeltas.flatMap((e) => Object.keys(e.storeDelta ?? {}));
  assert.ok(allDeltaKeys.includes("parentKey"), "journal must contain a delta for parentKey");
  assert.ok(allDeltaKeys.includes("nestedKey"), "journal must contain a delta for nestedKey");
});

// ─── Resume under fan-out (integration) ──────────────────────────────────────

test("resume replays parallel-agent deltas additively so no writes are lost", async () => {
  // Two parallel agents, each writing a distinct key to the shared store.
  // After the first run journals both results, we resume and verify the store
  // presents both keys to any live agents that follow.
  const journal: import("../src/workflow.js").JournalEntry[] = [];

  // Agent that either writes to the store (put agent) or reads from it (check agent).
  const writeCalls: Record<string, string> = {};
  const agent = {
    async run(
      prompt: string,
      opts: {
        systemTools?: Array<{ name: string; execute: (id: string, p: unknown) => Promise<unknown> }>;
      },
    ) {
      if (prompt.startsWith("put:")) {
        const [, key, val] = prompt.split(":");
        await opts.systemTools?.find((t) => t.name === "store_put")?.execute("", { key, value: val });
        return `wrote ${key}`;
      }
      if (prompt.startsWith("get:")) {
        const [, key] = prompt.split(":");
        const res = (await opts.systemTools?.find((t) => t.name === "store_get")?.execute("", { key })) as {
          details?: { value?: unknown; found?: boolean };
        };
        writeCalls[key] = String(res?.details?.value ?? "MISSING");
        return `got ${key}:${writeCalls[key]}`;
      }
      return "ok";
    },
  };

  // Script: two parallel puts, then one sequential get that should see both.
  const script = `
    export const meta = { name: "fan-out-resume-test", description: "fan-out resume test" };
    await Promise.all([
      agent("put:alpha:hello"),
      agent("put:beta:world"),
    ]);
    await agent("get:alpha");
    await agent("get:beta");
    return "done";
  `;

  // First run — journal all entries.
  await runWorkflow(script, {
    agent,
    cwd: process.cwd(),
    onAgentJournal: (e) => journal.push(e),
  });

  // Verify first run saw both values.
  assert.equal(writeCalls.alpha, "hello", "first run: alpha must be readable");
  assert.equal(writeCalls.beta, "world", "first run: beta must be readable");

  // Reset read results so we can tell if the resume re-reads correctly.
  delete writeCalls.alpha;
  delete writeCalls.beta;

  // Replay only the put agents from the journal — their deltas rebuild the store.
  // The get agents are intentionally absent so they run live against the rebuilt store,
  // which is how we verify the delta replay correctness.
  const resumeJournal = new Map(
    journal.filter((e) => Object.keys(e.storeDelta ?? {}).length > 0).map((e) => [e.index, e]),
  );
  await runWorkflow(script, {
    agent,
    cwd: process.cwd(),
    resumeJournal,
    onAgentJournal: () => {},
  });

  // The get agents ran live against a store rebuilt from deltas.
  assert.equal(writeCalls.alpha, "hello", "resume: alpha delta must survive replay");
  assert.equal(writeCalls.beta, "world", "resume: beta delta must survive replay");
});
