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

test("SharedStore.discardDelta rolls back to the pre-window value, not an intermediate write", () => {
  // Load-bearing guard: trackPut only shadows a key's value the FIRST time it
  // is written within the current delta window — a second write to the SAME
  // key within that window must not overwrite the shadow with the first
  // write's (still in-window) value. If it did, discardDelta would roll back
  // to the intermediate write "w1" instead of the true pre-window value
  // "pre" — an in-window leak of a value that was never meant to survive
  // either.
  const store = new SharedStore();
  store.put("k", "pre");
  store.trackPut("k", "w1", "run-1:0");
  store.trackPut("k", "w2", "run-1:0"); // second write to the SAME key, same window
  store.discardDelta("run-1:0");
  assert.equal(store.get("k"), "pre", "rollback must restore the true pre-window value, not the first in-window write");
  assert.deepEqual(store.commitDelta("run-1:0"), {}, "the delta must be fully discarded, including the first write");
});

test("SharedStore.discardDelta deletes a key that did not exist before the window", () => {
  const store = new SharedStore();
  store.trackPut("brandNew", "w1", "run-1:0");
  assert.equal(store.has("brandNew"), true);
  store.discardDelta("run-1:0");
  assert.equal(
    store.has("brandNew"),
    false,
    "a key with no pre-window value must be deleted on rollback, not left as undefined",
  );
});

test("SharedStore.discardDelta on a deltaKey with no writes is a no-op", () => {
  const store = new SharedStore();
  store.put("k", "v");
  store.discardDelta("run-1:never-wrote");
  assert.equal(store.get("k"), "v");
});

test("SharedStore.discardDelta must not clobber a concurrent sibling's legitimate overwrite of the same key", () => {
  // A failed attempt ("run-1:0") writes key "k", then — before it's rolled
  // back — a concurrently-running SIBLING call ("run-1:1", e.g. another
  // agent in the same parallel() batch) legitimately overwrites the same
  // key. Rolling back "run-1:0" unconditionally to its pre-window value
  // would erase the sibling's write, which "run-1:0" never made and has no
  // business undoing.
  const store = new SharedStore();
  store.put("k", "pre");
  store.trackPut("k", "poisoned", "run-1:0");
  store.trackPut("k", "sibling-value", "run-1:1");
  store.discardDelta("run-1:0");
  assert.equal(
    store.get("k"),
    "sibling-value",
    "the sibling's legitimate write must survive the failed attempt's rollback",
  );
});

test("SharedStore.discardDelta still rolls back a key untouched by any concurrent sibling", () => {
  const store = new SharedStore();
  store.put("k", "pre");
  store.put("other", "pre-other");
  store.trackPut("k", "poisoned", "run-1:0");
  store.trackPut("other", "sibling-value", "run-1:1"); // sibling touches a DIFFERENT key
  store.discardDelta("run-1:0");
  assert.equal(store.get("k"), "pre", "a key no sibling touched still rolls back normally");
  assert.equal(
    store.get("other"),
    "sibling-value",
    "the sibling's own key is untouched by the other deltaKey's rollback",
  );
});

test("SharedStore.commitDelta (success) does not roll back — the discardDelta shadow is cleared, not applied", () => {
  const store = new SharedStore();
  store.put("k", "pre");
  store.trackPut("k", "w1", "run-1:0");
  const delta = store.commitDelta("run-1:0");
  assert.deepEqual(delta, { k: "w1" });
  assert.equal(store.get("k"), "w1", "a successful commit keeps the write live — commitDelta must not roll back");
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

// ─── Nested workflow() journal-index collision (resume) ──────────────────────

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingRunnerFor(calls: { count: number }) {
  return {
    async run(prompt: string) {
      calls.count++;
      return `ran:${prompt}`;
    },
  };
}

const nestedResumeScript = `
  export const meta = { name: "nested-resume-outer", description: "outer" };
  const inner = await workflow(\`
    export const meta = { name: "nested-resume-inner", description: "inner" };
    const x = await agent("inner-call", {});
    return x;
  \`, {});
  const outer = await agent("outer-call", {});
  return { inner, outer };
`;

test("resume after nested workflow(): parent and child journal entries cache-hit independently despite both indexing at 0", async () => {
  // Regression test for the journal-index-collision bug: a nested workflow()
  // call restarts its own callSeq at 0, so its journal entry's `index` equals
  // the parent's own callIndex-0 entry. Before namespacing, the manager's
  // per-index journal map meant whichever entry was recorded LAST clobbered
  // the other, so a resume could never cache-hit both frames — often it could
  // not correctly cache-hit either, since the hash of the surviving entry
  // would only match one of the two calls.
  const journal: import("../src/workflow.js").JournalEntry[] = [];
  const firstCalls = { count: 0 };
  const first = await runWorkflow<{ inner: string; outer: string }>(nestedResumeScript, {
    agent: countingRunnerFor(firstCalls),
    persistLogs: false,
    runId: "nested-resume-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(firstCalls.count, 2, "one live call for the child, one for the parent");
  assert.equal(journal.length, 2);
  // Both entries share callIndex 0 (each frame's own callSeq restarts at 0)
  // but must carry DISTINCT runId — that's what makes them distinguishable.
  assert.deepEqual(journal.map((e) => e.index).sort(), [0, 0]);
  const runIds = new Set(journal.map((e) => e.runId));
  assert.equal(runIds.size, 2, "the parent's and child's entries must carry distinct runId");

  const resumeJournal = new Map(journal.map((e) => [`${e.runId}:${e.index}`, e] as const));
  const secondCalls = { count: 0 };
  const second = await runWorkflow<{ inner: string; outer: string }>(nestedResumeScript, {
    agent: countingRunnerFor(secondCalls),
    persistLogs: false,
    runId: "nested-resume-run",
    resumeJournal,
  });
  assert.equal(secondCalls.count, 0, "both the parent's AND the child's calls must cache-hit — neither re-runs live");
  // JSON-compare (not assert.deepEqual): the two runs execute in separate vm
  // realms, so their plain-object results have different (but structurally
  // identical) prototypes — deepStrictEqual would spuriously fail on that.
  assert.equal(JSON.stringify(second.result), JSON.stringify(first.result));
});

test("resume degrades gracefully (never corrupts) when replaying a pre-namespacing legacy journal", async () => {
  // Simulate a journal persisted by a version before JournalEntry.runId
  // existed: both the parent's and the child's index-0 entries have no
  // `runId` field on disk, exactly like WorkflowManager's on-disk format did
  // before this fix. WorkflowManager.resume() falls back to the run's own
  // top-level runId for such entries (see its resumeJournal construction),
  // which this test replicates directly against runWorkflow.
  const journal: import("../src/workflow.js").JournalEntry[] = [];
  const firstCalls = { count: 0 };
  const first = await runWorkflow<{ inner: string; outer: string }>(nestedResumeScript, {
    agent: countingRunnerFor(firstCalls),
    persistLogs: false,
    runId: "legacy-resume-run",
    onAgentJournal: (e) => journal.push(e),
  });

  // Strip `runId`, as a legacy on-disk journal would lack it.
  const legacyEntries = journal.map((e) => {
    const { runId: _runId, ...rest } = e;
    return rest as import("../src/workflow.js").JournalEntry;
  });
  const legacyResumeJournal = new Map(
    legacyEntries.map((e) => [`${e.runId ?? "legacy-resume-run"}:${e.index}`, e] as const),
  );
  // The two legacy entries collapse onto the SAME map key ("legacy-resume-run:0"),
  // since neither carries a runId to distinguish them — only one can survive
  // (the child's is journaled first, so the parent's, journaled second,
  // overwrites it in the Map).
  assert.equal(legacyResumeJournal.size, 1, "both legacy entries collapse onto one key");

  const secondCalls = { count: 0 };
  const second = await runWorkflow<{ inner: string; outer: string }>(nestedResumeScript, {
    agent: countingRunnerFor(secondCalls),
    persistLogs: false,
    runId: "legacy-resume-run",
    resumeJournal: legacyResumeJournal,
  });

  // Graceful degradation, not corruption: the surviving legacy entry belongs
  // to the parent's call (its hash matches "outer-call"'s hash under the
  // collapsed key), so the parent cache-hits and the child — whose own entry
  // was lost in the collapse — safely re-runs live instead of replaying the
  // parent's (wrong) cached value. The end result is still correct.
  assert.equal(secondCalls.count, 1, "the frame that lost its slot in the collapse re-runs live, not corrupted");
  // JSON-compare — see the note in the previous test about cross-vm-realm
  // prototypes tripping up assert.deepEqual.
  assert.equal(
    JSON.stringify(second.result),
    JSON.stringify(first.result),
    "no corruption: the final result still matches a live run's",
  );
});

const prefixNestedScript = (aPrompt: string) => `
  export const meta = { name: "prefix-nested-outer", description: "outer" };
  const a = await agent(${JSON.stringify(aPrompt)}, {});
  const inner = await workflow(\`
    export const meta = { name: "prefix-nested-inner", description: "inner" };
    const x = await agent("inner-call", {});
    return x;
  \`, {});
  return { a, inner };
`;

test("resume: an upstream parent-call miss cuts the nested child off from the journal (child re-runs live)", async () => {
  // Regression test for a correctness gap introduced by namespacing the
  // journal: propagating resumeJournal into a nested workflow() call is only
  // safe while the PARENT's own longest-unchanged-prefix is still intact.
  // SharedStore content is not part of any call's hash — a cached child
  // result was computed against whatever the store held when it originally
  // ran, which depended on the (now-edited) upstream parent call's live
  // output. If the parent's agent('A') call misses and re-runs live, a stale
  // cached child result must NOT be wholesale-replayed just because the
  // child's own hash still matches; the child must run fully live too.
  const journal: import("../src/workflow.js").JournalEntry[] = [];
  const firstCalls = { count: 0 };
  await runWorkflow<{ a: string; inner: string }>(prefixNestedScript("A-v1"), {
    agent: countingRunnerFor(firstCalls),
    persistLogs: false,
    runId: "prefix-nested-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(firstCalls.count, 2, "one live call for the parent's agent('A'), one for the nested child");

  const resumeJournal = new Map(journal.map((e) => [`${e.runId}:${e.index}`, e] as const));

  // Edit ONLY the parent's agent('A-v1') call to 'A-v2'. The child script is
  // byte-identical, so the child's own callHash still matches its journaled
  // entry — the only thing that changed is upstream of it.
  const editedCalls = { count: 0 };
  const edited = await runWorkflow<{ a: string; inner: string }>(prefixNestedScript("A-v2"), {
    agent: countingRunnerFor(editedCalls),
    persistLogs: false,
    runId: "prefix-nested-run",
    resumeJournal,
  });
  assert.equal(editedCalls.count, 2, "both the edited parent call AND the downstream child call must re-run live");
  assert.equal(edited.result.a, "ran:A-v2", "the parent call reflects the edit");
  assert.equal(edited.result.inner, "ran:inner-call", "the child re-ran live rather than replaying a stale cache hit");
});

test("resume: nested child still cache-hits when nothing upstream of it changed (positive control)", async () => {
  const journal: import("../src/workflow.js").JournalEntry[] = [];
  const firstCalls = { count: 0 };
  const first = await runWorkflow<{ a: string; inner: string }>(prefixNestedScript("A-v1"), {
    agent: countingRunnerFor(firstCalls),
    persistLogs: false,
    runId: "prefix-nested-stable-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(firstCalls.count, 2);

  const resumeJournal = new Map(journal.map((e) => [`${e.runId}:${e.index}`, e] as const));
  const secondCalls = { count: 0 };
  const second = await runWorkflow<{ a: string; inner: string }>(prefixNestedScript("A-v1"), {
    agent: countingRunnerFor(secondCalls),
    persistLogs: false,
    runId: "prefix-nested-stable-run",
    resumeJournal,
  });
  assert.equal(secondCalls.count, 0, "nothing changed upstream — both parent and child cache-hit, no live re-run");
  assert.equal(JSON.stringify(second.result), JSON.stringify(first.result));
});

// ─── Retry-attempt store-delta isolation ──────────────────────────────────────

test("a failed retry attempt's store writes are rolled back: absent from the recorded delta and from the live store", async () => {
  // Regression test: all attempts of one agent() call share the same
  // SharedStore deltaKey. A failed first attempt that writes to the store
  // before throwing must not leave that write visible to the rest of the live
  // run, and must not merge into the delta recorded for the eventual
  // successful attempt. The failed and successful attempts deliberately write
  // DIFFERENT keys ("poisonedOnly" vs "shared") — if they wrote the same key,
  // the successful attempt's write would naturally overwrite the failed one's
  // in both the live map and the delta, masking the leak entirely.
  let callAttempts = 0;
  const agent = {
    async run(
      prompt: string,
      opts: { systemTools?: Array<{ name: string; execute: (id: string, p: unknown) => Promise<unknown> }> },
    ) {
      if (prompt === "call") {
        callAttempts++;
        if (callAttempts === 1) {
          await opts.systemTools
            ?.find((t) => t.name === "store_put")
            ?.execute("", { key: "poisonedOnly", value: "should-never-survive" });
          throw new Error("transient failure");
        }
        await opts.systemTools?.find((t) => t.name === "store_put")?.execute("", { key: "shared", value: "good" });
        return "call-done";
      }
      // "check": read the live store from a SEPARATE, later agent() call —
      // proves the failed attempt's write is gone from the LIVE store, not
      // merely absent from the journaled delta.
      const found = (await opts.systemTools
        ?.find((t) => t.name === "store_get")
        ?.execute("", {
          key: "poisonedOnly",
        })) as { details?: { found?: boolean } };
      return found?.details?.found;
    },
  };
  const journal: import("../src/workflow.js").JournalEntry[] = [];
  const script = `export const meta = { name: 'retry-isolation', description: 'retry isolation' }
  const r = await agent('call', {})
  const check = await agent('check', {})
  return { r, check }`;
  const result = await runWorkflow<{ r: string; check: boolean }>(script, {
    agent,
    agentRetries: 1,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });

  assert.equal(callAttempts, 2, "first attempt fails, the retried second attempt succeeds");
  assert.equal(result.result.r, "call-done");
  assert.equal(
    result.result.check,
    false,
    "the live store must NOT contain the failed attempt's key — it must be rolled back, not merely left uncommitted",
  );
  const callEntry = journal.find((e) => e.result === "call-done");
  assert.deepEqual(
    callEntry?.storeDelta,
    { shared: "good" },
    "the recorded delta must reflect only the successful attempt, not the failed one's poisoned key",
  );
});

test("a failed retry attempt's rolled-back write matches what resume replay reconstructs", async () => {
  // The live run and a later resume's replay must agree exactly: replaying
  // the journal must additively reconstruct the SAME store state the live
  // run ended up with — not a state polluted by a discarded failed attempt.
  let callAttempts = 0;
  const agent = {
    async run(
      prompt: string,
      opts: { systemTools?: Array<{ name: string; execute: (id: string, p: unknown) => Promise<unknown> }> },
    ) {
      if (prompt === "call") {
        callAttempts++;
        if (callAttempts === 1) {
          await opts.systemTools
            ?.find((t) => t.name === "store_put")
            ?.execute("", { key: "poisonedOnly", value: "should-never-survive" });
          throw new Error("transient failure");
        }
        await opts.systemTools?.find((t) => t.name === "store_put")?.execute("", { key: "shared", value: "good" });
        return "call-done";
      }
      const found = (await opts.systemTools
        ?.find((t) => t.name === "store_get")
        ?.execute("", {
          key: "poisonedOnly",
        })) as { details?: { found?: boolean } };
      return found?.details?.found;
    },
  };
  const journal: import("../src/workflow.js").JournalEntry[] = [];
  const script = `export const meta = { name: 'retry-isolation-resume', description: 'retry isolation resume' }
  const r = await agent('call', {})
  const check = await agent('check', {})
  return { r, check }`;
  await runWorkflow(script, {
    agent,
    agentRetries: 1,
    persistLogs: false,
    runId: "retry-isolation-resume-run",
    onAgentJournal: (e) => journal.push(e),
  });

  // Resume: replay everything from the journal (no live calls at all), and
  // verify the "check" call's cached result — captured against the LIVE
  // store during the original run — shows the poisoned key was never present.
  const resumeJournal = new Map(journal.map((e) => [`${e.runId}:${e.index}`, e] as const));
  let liveCallsOnResume = 0;
  const second = await runWorkflow<{ r: string; check: boolean }>(script, {
    agent: {
      async run() {
        liveCallsOnResume++;
        return "should-not-run";
      },
    },
    persistLogs: false,
    runId: "retry-isolation-resume-run",
    resumeJournal,
  });
  assert.equal(liveCallsOnResume, 0, "fully cached — resume must not re-run anything live");
  assert.equal(
    second.result.check,
    false,
    "replay must reconstruct the same rolled-back state as the live run (the poisoned key stays absent)",
  );
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
    runId: "fan-out-resume-run",
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
    journal.filter((e) => Object.keys(e.storeDelta ?? {}).length > 0).map((e) => [`${e.runId}:${e.index}`, e] as const),
  );
  await runWorkflow(script, {
    agent,
    cwd: process.cwd(),
    runId: "fan-out-resume-run",
    resumeJournal,
    onAgentJournal: () => {},
  });

  // The get agents ran live against a store rebuilt from deltas.
  assert.equal(writeCalls.alpha, "hello", "resume: alpha delta must survive replay");
  assert.equal(writeCalls.beta, "world", "resume: beta delta must survive replay");
});
