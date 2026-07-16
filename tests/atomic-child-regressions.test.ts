import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentUsage } from "../src/agent.js";
import type { AgentDefinition, AgentRegistry } from "../src/agent-registry.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { saveModelTierConfig } from "../src/model-tier-config.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

interface StoreTool {
  name: string;
  execute(id: string, params: unknown): Promise<{ details?: { found?: boolean; value?: unknown } }>;
}

interface StoreAgentOptions {
  systemTools?: StoreTool[];
}

async function put(options: StoreAgentOptions, key: string, value: unknown): Promise<void> {
  await options.systemTools?.find((tool) => tool.name === "store_put")?.execute("", { key, value });
}

async function get(options: StoreAgentOptions, key: string): Promise<{ found: boolean; value: unknown }> {
  const result = await options.systemTools?.find((tool) => tool.name === "store_get")?.execute("", { key });
  return { found: result?.details?.found ?? false, value: result?.details?.value };
}

function parentScript(body: string): string {
  return `export const meta = { name: 'parent', description: 'parent' }\n${body}`;
}

test("concurrent parent activity is excluded from atomic child accounting and replay", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('child-agent')`;
  const script = parentScript(`return await Promise.all([
  workflow('child'),
  agent('parent-agent'),
])`);
  const journal: JournalEntry[] = [];
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });

  const first = await runWorkflow(script, {
    persistLogs: false,
    maxAgents: 2,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(prompt: string) {
        if (prompt === "child-agent") await childGate;
        if (prompt === "parent-agent") releaseChild();
        return prompt;
      },
    },
  });

  const atomicChild = journal.find((entry) => entry.index === 0);
  assert.equal(atomicChild?.agentCount, 1, "only the child's logical agent belongs to its atomic entry");
  assert.equal(first.agentCount, 2);

  let replayCalls = 0;
  const replay = await runWorkflow(script, {
    persistLogs: false,
    maxAgents: 2,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: {
      async run() {
        replayCalls++;
        return "unexpected";
      },
    },
  });

  assert.equal(replayCalls, 0);
  assert.equal(replay.agentCount, 2, "replay charges exactly one child and one parent agent");
});

test("atomic child replay reconstructs child agents and replay telemetry in a fresh manager report", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-child-report-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-child-report-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('child-agent', { label: 'child worker' })`;
      const script = parentScript("return await workflow('child')");
      const firstManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => childScript,
        agent: {
          async run(_prompt: string, options: any) {
            const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0.001 };
            options.onUsage?.(usage);
            options.onTelemetry?.({ execution: "live", resolvedModel: "mock/child", usage });
            return "child-result";
          },
        },
      });
      await firstManager.runSync(script);
      const persisted = firstManager.listRuns()[0];
      firstManager.getPersistence().save({ ...persisted, status: "paused", agents: [] });

      let replayCalls = 0;
      const freshManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => childScript,
        agent: {
          async run() {
            replayCalls++;
            return "must-not-run";
          },
        },
      });
      const completed = new Promise<void>((resolve) => {
        freshManager.on("complete", (event: { runId: string }) => event.runId === persisted.runId && resolve());
      });
      assert.equal(await freshManager.resume(persisted.runId), true);
      await completed;

      const replayed = freshManager.getPersistence().load(persisted.runId);
      assert.equal(replayCalls, 0);
      assert.equal(replayed?.agents.length, 1);
      assert.equal(replayed?.agents[0].label, "child worker");
      assert.equal(replayed?.agents[0].status, "done");
      assert.equal(replayed?.agents[0].telemetry?.execution, "replay");
      assert.equal(replayed?.agents[0].telemetry?.usage?.total, 5);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("recoverably failed child agents discard store writes before the child commits", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
const failed = await agent('write-then-fail')
const observed = await agent('read-ghost')
return { failed, observed }`;
  const script = parentScript(`const child = await workflow('child')
const observed = await agent('read-ghost')
return { child, observed }`);
  const journal: JournalEntry[] = [];

  const result = await runWorkflow<{
    child: { failed: null; observed: { found: boolean; value: unknown } };
    observed: { found: boolean; value: unknown };
  }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(prompt: string, options: StoreAgentOptions) {
        if (prompt === "write-then-fail") {
          await put(options, "ghost", "must-not-commit");
          throw new WorkflowError("recoverable child failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: true,
          });
        }
        if (prompt === "read-ghost") return get(options, "ghost");
        return prompt;
      },
    },
  });

  assert.equal(result.result.child.failed, null);
  assert.equal(result.result.child.observed.found, false);
  assert.equal(result.result.observed.found, false);
  assert.deepEqual(journal.find((entry) => entry.index === 0)?.storeDelta, {});
});

test("a failed child invocation cannot leak deltas into a later sequential child", async () => {
  const failedChild = `export const meta = { name: 'failed-child', description: 'failed child' }
await agent('failed-write')
throw new Error('child invocation failed')`;
  const successfulChild = `export const meta = { name: 'successful-child', description: 'successful child' }
await agent('successful-write')
return 'success'`;
  const script = parentScript(`try { await workflow('failed-child') } catch {}
const child = await workflow('successful-child')
const failedValue = await agent('read-failed')
const successfulValue = await agent('read-successful')
return { child, failedValue, successfulValue }`);
  const journal: JournalEntry[] = [];

  const result = await runWorkflow<{
    failedValue: { found: boolean; value: unknown };
    successfulValue: { found: boolean; value: unknown };
  }>(script, {
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "failed-child" ? failedChild : successfulChild),
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(prompt: string, options: StoreAgentOptions) {
        if (prompt === "failed-write") {
          await put(options, "failed", "ghost");
          throw new WorkflowError("recoverable write failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: true,
          });
        }
        if (prompt === "successful-write") {
          await put(options, "successful", "kept");
          return "wrote";
        }
        if (prompt === "read-failed") return get(options, "failed");
        if (prompt === "read-successful") return get(options, "successful");
        return prompt;
      },
    },
  });

  assert.equal(result.result.failedValue.found, false);
  assert.deepEqual(result.result.successfulValue, { found: true, value: "kept" });
  const successfulAtomicEntry = journal.find((entry) => entry.index === 1);
  assert.deepEqual(successfulAtomicEntry?.storeDelta, { successful: "kept" });
});

test("atomic child delta preserves actual conflicting write order on replay", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
await Promise.all([agent('late-write'), agent('early-write')])
return 'child-result'`;
  const script = parentScript(`const child = await workflow('child')
const observed = await agent('read-winner')
return { child, observed }`);
  const journal: JournalEntry[] = [];
  let releaseLate!: () => void;
  const earlyWritten = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  const runner = {
    async run(prompt: string, options: StoreAgentOptions) {
      if (prompt === "late-write") {
        await earlyWritten;
        await put(options, "winner", "late-call-index-but-last-write");
        return "late";
      }
      if (prompt === "early-write") {
        await put(options, "winner", "higher-call-index-but-first-write");
        releaseLate();
        return "early";
      }
      if (prompt === "read-winner") return get(options, "winner");
      return prompt;
    },
  };

  const first = await runWorkflow<{ observed: { found: boolean; value: unknown } }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: runner,
  });
  assert.deepEqual(first.result.observed, { found: true, value: "late-call-index-but-last-write" });
  assert.deepEqual(journal.find((entry) => entry.index === 0)?.storeDelta, {
    winner: "late-call-index-but-last-write",
  });

  const replay = await runWorkflow<{ observed: { found: boolean; value: unknown } }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.filter((entry) => entry.index === 0).map((entry) => [entry.index, entry])),
    agent: runner,
  });
  assert.deepEqual(replay.result.observed, { found: true, value: "late-call-index-but-last-write" });
});

test("child args omit own enumerable undefined properties before execution and hashing", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return args`;
  const script = parentScript(`const args = { support: undefined, nested: { task: undefined, keep: true } }
return await workflow('child', args)`);
  const journal: JournalEntry[] = [];

  const live = await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
  });

  assert.deepEqual(live.result, { nested: { keep: true } });

  const normalizedArgsJournal: JournalEntry[] = [];
  await runWorkflow(parentScript("return await workflow('child', { nested: { keep: true } })"), {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => normalizedArgsJournal.push(entry),
  });
  assert.equal(journal[0]?.hash, normalizedArgsJournal[0]?.hash);

  let childCalls = 0;
  const replay = await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: {
      async run() {
        childCalls++;
        return "must-not-run";
      },
    },
  });

  assert.deepEqual(replay.result, { nested: { keep: true } });
  assert.equal(childCalls, 0, "the child hash must use the normalized args");
});

test("child args reject custom prototypes and normalize aliases to JSON-tree semantics", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
args.left.value = 2
return { rightValue: args.right.value }`;
  const aliasResult = await runWorkflow<{ rightValue: number }>(
    parentScript(`const shared = { value: 1 }
return await workflow('child', { left: shared, right: shared })`),
    { persistLogs: false, loadSavedWorkflow: () => childScript },
  );
  assert.equal(aliasResult.result.rightValue, 1, "JSON aliases normalize to independent tree branches");

  await assert.rejects(
    () =>
      runWorkflow(
        parentScript(`const custom = Object.create({ inherited: true })
custom.value = 1
return await workflow('child', { left: custom, right: { value: 1 } })`),
        { persistLogs: false, loadSavedWorkflow: () => childScript },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.message, "workflow() child args must be deterministic JSON-serializable values");
      return true;
    },
  );
});

test("concurrent parent and child conflicts preserve actual write order on live run and replay", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
await agent('child-write')
return 'child-result'`;
  const script = parentScript(`await Promise.all([workflow('child'), agent('parent-write')])
return await agent('read-winner')`);
  const journal: JournalEntry[] = [];
  let childWritten!: () => void;
  const childWriteComplete = new Promise<void>((resolve) => {
    childWritten = resolve;
  });

  const runner = {
    async run(prompt: string, options: StoreAgentOptions) {
      if (prompt === "child-write") {
        await put(options, "winner", "child-first");
        childWritten();
        await new Promise<void>((resolve) => setImmediate(resolve));
        return "child";
      }
      if (prompt === "parent-write") {
        await childWriteComplete;
        await put(options, "winner", "parent-last");
        return "parent";
      }
      if (prompt === "read-winner") return get(options, "winner");
      return prompt;
    },
  };

  const first = await runWorkflow<{ found: boolean; value: unknown }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: runner,
  });
  assert.deepEqual(first.result, { found: true, value: "parent-last" });

  const replay = await runWorkflow<{ found: boolean; value: unknown }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.filter((entry) => entry.index < 2).map((entry) => [entry.index, entry])),
    agent: runner,
  });
  assert.deepEqual(replay.result, { found: true, value: "parent-last" });
});

test("a timed-out attempt cannot write into its retry attempt scope", async () => {
  const script = parentScript(`await agent('retrying', { timeoutMs: 5, retries: 1 })
return await agent('read-winner')`);
  let staleOptions: StoreAgentOptions | undefined;
  let attempts = 0;

  const result = await runWorkflow<{ found: boolean; value: unknown }>(script, {
    persistLogs: false,
    agent: {
      async run(prompt: string, options: StoreAgentOptions) {
        if (prompt === "retrying") {
          attempts++;
          if (attempts === 1) {
            staleOptions = options;
            return new Promise<never>(() => {});
          }
          await put(options, "winner", "retry");
          try {
            await put(staleOptions ?? {}, "winner", "timed-out-late-write");
          } catch {}
          return "retry-complete";
        }
        if (prompt === "read-winner") return get(options, "winner");
        return prompt;
      },
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result.result, { found: true, value: "retry" });
});

test("a late timed-out child runner cannot use its disposed store", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
await agent('late-child', { timeoutMs: 5 })
return 'child-complete'`;
  const script = parentScript(`await agent('seed-parent')
const child = await workflow('child')
const late = await agent('release-late-child')
return { child, late }`);
  let releaseLate!: () => void;
  const lateGate = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let lateFinished!: (value: { readRejected: boolean; writeRejected: boolean }) => void;
  const lateResult = new Promise<{ readRejected: boolean; writeRejected: boolean }>((resolve) => {
    lateFinished = resolve;
  });

  const result = await runWorkflow<{
    child: string;
    late: { readRejected: boolean; writeRejected: boolean; orphanFound: boolean; parentValue: unknown };
  }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    agent: {
      async run(prompt: string, options: StoreAgentOptions) {
        if (prompt === "seed-parent") {
          await put(options, "parent-secret", "parent-value");
          return "seeded";
        }
        if (prompt === "late-child") {
          await lateGate;
          let readRejected = false;
          let writeRejected = false;
          try {
            await get(options, "parent-secret");
          } catch {
            readRejected = true;
          }
          try {
            await put(options, "orphan", "must-not-be-accepted");
          } catch {
            writeRejected = true;
          }
          lateFinished({ readRejected, writeRejected });
          return "late-finished";
        }
        if (prompt === "release-late-child") {
          releaseLate();
          const late = await lateResult;
          const orphan = await get(options, "orphan");
          const parent = await get(options, "parent-secret");
          return { ...late, orphanFound: orphan.found, parentValue: parent.value };
        }
        return prompt;
      },
    },
  });

  assert.equal(
    JSON.stringify(result.result),
    JSON.stringify({
      child: "child-complete",
      late: { readRejected: true, writeRejected: true, orphanFound: false, parentValue: "parent-value" },
    }),
  );
});

test("agent journal failure accounts usage once, rolls back store delta, and surfaces the original error", async () => {
  const journalError = new Error("journal persistence failed exactly");
  const script = parentScript(`let failure
try { await agent('write-before-journal') } catch (error) { failure = error.message }
const observed = await agent('inspect-after:' + budget.spent())
return { failure, observed }`);
  let rejectFirstJournal = true;

  const result = await runWorkflow<{ failure: string; observed: { spentPrompt: string; found: boolean } }>(script, {
    persistLogs: false,
    onAgentJournal() {
      if (rejectFirstJournal) {
        rejectFirstJournal = false;
        throw journalError;
      }
    },
    agent: {
      async run(prompt: string, options: StoreAgentOptions & { onUsage?: (usage: AgentUsage) => void }) {
        if (prompt === "write-before-journal") {
          await put(options, "uncommitted", true);
          options.onUsage?.({ input: 6, output: 4, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0 });
          return "written";
        }
        const value = await get(options, "uncommitted");
        return { spentPrompt: prompt, found: value.found };
      },
    },
  });

  assert.equal(
    JSON.stringify(result.result),
    JSON.stringify({
      failure: journalError.message,
      observed: { spentPrompt: "inspect-after:10", found: false },
    }),
  );
});

test("an atomic child journal callback failure leaves no child writes visible", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
await agent('child-write')
return 'child-result'`;
  const script = parentScript(`try { await workflow('child') } catch {}
return await agent('read-child-write')`);
  let rejectedChildJournal = false;

  const result = await runWorkflow<{ found: boolean; value: unknown }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal(entry) {
      if (entry.index === 0 && !rejectedChildJournal) {
        rejectedChildJournal = true;
        throw new Error("journal persistence failed");
      }
    },
    agent: {
      async run(prompt: string, options: StoreAgentOptions) {
        if (prompt === "child-write") {
          await put(options, "child", "must-rollback");
          return "wrote";
        }
        if (prompt === "read-child-write") return get(options, "child");
        return prompt;
      },
    },
  });

  assert.equal(rejectedChildJournal, true);
  assert.deepEqual(result.result, { found: false, value: null });
});

test("child args reject custom-prototype arrays and spoofed inherited JSON semantics", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return args`;
  const invalidExpressions = [
    `const value = []; Object.setPrototypeOf(value, Object.create(Array.prototype)); value`,
    `const proto = Object.create(null); Object.defineProperty(proto, 'constructor', { value: Object, enumerable: false }); proto.toJSON = () => ({ spoofed: true }); const value = Object.create(proto); value.safe = true; value`,
  ];

  for (const expression of invalidExpressions) {
    await assert.rejects(
      () =>
        runWorkflow(
          parentScript(`const value = (() => { ${expression.includes("const value") ? `${expression}; return value` : `return ${expression}`} })()
return await workflow('child', value)`),
          {
            persistLogs: false,
            loadSavedWorkflow: () => childScript,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(error.message, "workflow() child args must be deterministic JSON-serializable values");
        return true;
      },
    );
  }
});

test("atomic child execution and replay use the registry snapshot hashed by the parent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-child-registry-"));
  const agentsDir = join(cwd, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const definitionPath = join(agentsDir, "reviewer.md");
  const firstDefinition = "---\nname: reviewer\n---\nFIRST SNAPSHOT";
  const secondDefinition = "---\nname: reviewer\n---\nSECOND DISK VERSION";
  writeFileSync(definitionPath, firstDefinition);

  try {
    const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('task', { agentType: 'reviewer' })`;
    const script = parentScript(`return await workflow('child')`);
    const journal: JournalEntry[] = [];
    let loaderCalls = 0;

    const first = await runWorkflow<string>(script, {
      cwd,
      persistLogs: false,
      loadSavedWorkflow: () => {
        loaderCalls++;
        writeFileSync(definitionPath, secondDefinition);
        return childScript;
      },
      onAgentJournal: (entry) => journal.push(entry),
      agent: {
        async run(_prompt: string, options: { instructions?: string }) {
          assert.match(options.instructions ?? "", /FIRST SNAPSHOT/);
          assert.doesNotMatch(options.instructions ?? "", /SECOND DISK VERSION/);
          return "ran-with-first-snapshot";
        },
      },
    });

    assert.equal(first.result, "ran-with-first-snapshot");
    assert.equal(loaderCalls, 1);
    assert.equal(journal.length, 1);

    writeFileSync(definitionPath, firstDefinition);
    let replayCalls = 0;
    const replay = await runWorkflow<string>(script, {
      cwd,
      persistLogs: false,
      loadSavedWorkflow: () => {
        loaderCalls++;
        writeFileSync(definitionPath, secondDefinition);
        return childScript;
      },
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: {
        async run() {
          replayCalls++;
          return "must-not-run";
        },
      },
    });

    assert.equal(replay.result, "ran-with-first-snapshot");
    assert.equal(replayCalls, 0);
    assert.equal(loaderCalls, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("atomic child replay invalidates when a tier used only inside the child changes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-child-tier-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('task', { tier: 'small' })`;
      const script = parentScript(`return await workflow('child')`);
      const journal: JournalEntry[] = [];
      let calls = 0;
      const runner = {
        async run() {
          calls++;
          return `result-${calls}`;
        },
      };

      saveModelTierConfig({ tiers: { small: "mock/small-one", medium: "mock/medium" } });
      await runWorkflow(script, {
        persistLogs: false,
        loadSavedWorkflow: () => childScript,
        onAgentJournal: (entry) => journal.push(entry),
        agent: runner,
      });
      saveModelTierConfig({ tiers: { small: "mock/small-two", medium: "mock/medium" } });
      const replay = await runWorkflow<string>(script, {
        persistLogs: false,
        loadSavedWorkflow: () => childScript,
        resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
        agent: runner,
      });

      assert.equal(calls, 2);
      assert.equal(replay.result, "result-2");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("atomic child replay invalidates when the session main model changes without tier config", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('task')`;
  const script = parentScript(`return await workflow('child')`);
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };

  await runWorkflow(script, {
    mainModel: "mock/a",
    modelTierConfig: null,
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: runner,
  });
  const replay = await runWorkflow<string>(script, {
    mainModel: "mock/b",
    modelTierConfig: null,
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: runner,
  });

  assert.equal(calls, 2);
  assert.equal(replay.result, "result-2");
});

test("atomic child untagged replay uses the host session model instead of mainModel tier fallback", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('task')`;
  const script = parentScript(`return await workflow('child')`);
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };
  const firstModel = { provider: "mock", id: "session-a", name: "Session A" } as Model<any>;
  const secondModel = { provider: "mock", id: "session-b", name: "Session B" } as Model<any>;

  await runWorkflow(script, {
    agent: runner,
    mainModel: "mock/tier-fallback",
    session: { model: firstModel },
    modelTierConfig: null,
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
  });
  const replay = await runWorkflow<string>(script, {
    agent: runner,
    mainModel: "mock/tier-fallback",
    session: { model: secondModel },
    modelTierConfig: null,
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.equal(calls, 2, "the child must rerun when its actual untagged session route changes");
  assert.equal(replay.result, "result-2");
});

test("atomic child tier fallback remains bound to mainModel when the host session model changes", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('task', { tier: 'custom' })`;
  const script = parentScript(`return await workflow('child')`);
  const journal: JournalEntry[] = [];
  const tierConfig = { tiers: { medium: "mock/medium" } };
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };
  const firstModel = { provider: "mock", id: "session-a", name: "Session A" } as Model<any>;
  const secondModel = { provider: "mock", id: "session-b", name: "Session B" } as Model<any>;

  await runWorkflow(script, {
    agent: runner,
    mainModel: "mock/tier-fallback",
    session: { model: firstModel },
    modelTierConfig: tierConfig,
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
  });
  const replay = await runWorkflow<string>(script, {
    agent: runner,
    mainModel: "mock/tier-fallback",
    session: { model: secondModel },
    modelTierConfig: tierConfig,
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.equal(calls, 1, "the child explicit tier must keep the stable mainModel fallback route");
  assert.equal(replay.result, "result-1");
});

test("atomic child helper routes invalidate replay for direct, aliased, and member calls", async () => {
  const script = parentScript(`return await workflow('child')`);
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return { real: true, reason: `result-${calls}` };
    },
  };
  const bodies = [
    "return await verify('claim', { reviewers: 1 })",
    "const check = verify; return await check('claim', { reviewers: 1 })",
    "return await globalThis.verify('claim', { reviewers: 1 })",
    "return await globalThis['verify']('claim', { reviewers: 1 })",
  ];

  for (const body of bodies) {
    const childScript = `export const meta = { name: 'child', description: 'child' }\n${body}`;
    const journal: JournalEntry[] = [];
    await runWorkflow(script, {
      mainModel: "mock/a",
      modelTierConfig: null,
      persistLogs: false,
      loadSavedWorkflow: () => childScript,
      onAgentJournal: (entry) => journal.push(entry),
      agent: runner,
    });
    await runWorkflow(script, {
      mainModel: "mock/b",
      modelTierConfig: null,
      persistLogs: false,
      loadSavedWorkflow: () => childScript,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: runner,
    });
  }

  assert.equal(calls, 8);
});

test("atomic child indirect agent routes invalidate replay for aliases and computed members", async () => {
  const script = parentScript(`return await workflow('child')`);
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };
  const bodies = ["const invoke = agent; return await invoke('task')", "return await globalThis['agent']('task')"];

  for (const body of bodies) {
    const childScript = `export const meta = { name: 'child', description: 'child' }\n${body}`;
    const journal: JournalEntry[] = [];
    await runWorkflow(script, {
      mainModel: "mock/a",
      modelTierConfig: null,
      persistLogs: false,
      loadSavedWorkflow: () => childScript,
      onAgentJournal: (entry) => journal.push(entry),
      agent: runner,
    });
    await runWorkflow(script, {
      mainModel: "mock/b",
      modelTierConfig: null,
      persistLogs: false,
      loadSavedWorkflow: () => childScript,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: runner,
    });
  }

  assert.equal(calls, 4);
});

test("atomic child dynamic unknown tiers hash the main-model fallback independently of medium", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
const invoke = agent
return await invoke('task', { tier: 'custom' })`;
  const script = parentScript(`return await workflow('child')`);
  const journal: JournalEntry[] = [];
  const tierConfig = { tiers: { medium: "mock/medium" } };
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };

  await runWorkflow(script, {
    mainModel: "mock/a",
    modelTierConfig: tierConfig,
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: runner,
  });
  await runWorkflow(script, {
    mainModel: "mock/b",
    modelTierConfig: tierConfig,
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: runner,
  });

  assert.equal(calls, 2);
});

test("atomic child capture correlates concurrent duplicate labels by invocation", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return await parallel([
  () => agent('first prompt', { label: 'duplicate' }),
  () => agent('second prompt', { label: 'duplicate' }),
])`;
  const script = parentScript(`return await workflow('child')`);
  const journal: JournalEntry[] = [];
  let releaseFirst!: () => void;
  const secondFinished = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const live = await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(
        prompt: string,
        options: { onUsage?: (usage: AgentUsage) => void; onModelResolved?: (id: string) => void },
      ) {
        if (prompt === "first prompt") await secondFinished;
        const amount = prompt === "first prompt" ? 11 : 22;
        options.onUsage?.({
          input: amount,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: amount,
          cost: amount / 1000,
        });
        options.onModelResolved?.(`mock/${prompt.startsWith("first") ? "first" : "second"}`);
        if (prompt === "second prompt") releaseFirst();
        return `${prompt} result`;
      },
    },
  });

  assert.deepEqual(live.result, ["first prompt result", "second prompt result"]);
  assert.deepEqual(
    journal[0]?.childAgents?.map((agent) => [agent.prompt, agent.result, agent.tokenUsage?.total, agent.model]),
    [
      ["first prompt", "first prompt result", 11, "mock/first"],
      ["second prompt", "second prompt result", 22, "mock/second"],
    ],
  );

  const replayStarts: string[] = [];
  const replayEnds: Array<{ result: unknown; tokens?: number; model?: string }> = [];
  await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    onAgentStart: (event) => replayStarts.push(event.prompt),
    onAgentEnd: (event) => replayEnds.push(event),
    agent: {
      async run() {
        assert.fail("atomic child should replay");
      },
    },
  });
  assert.deepEqual(replayStarts, ["first prompt", "second prompt"]);
  assert.deepEqual(
    replayEnds.map((event) => [event.result, event.tokens, event.model]),
    [
      ["first prompt result", 0, "mock/first"],
      ["second prompt result", 0, "mock/second"],
    ],
  );
});

test("nested workflow path reports a stable validation error when cwd was deleted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-deleted-child-cwd-"));
  rmSync(cwd, { recursive: true, force: true });

  await assert.rejects(
    () => runWorkflow(parentScript(`return await workflow({ scriptPath: 'child.js' })`), { cwd, persistLogs: false }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /workflow cwd does not exist/);
      return true;
    },
  );
});

test("atomic child replay invalidates when any model alias target changes", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }\nreturn await agent('task', { model: 'haiku' })`;
  const script = parentScript(`return await workflow('child')`);
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };

  const first = await runWorkflow<string>(script, {
    loadSavedWorkflow: () => childScript,
    modelAliases: { haiku: "mock/one", sonnet: "mock/sonnet" },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: runner,
  });
  assert.equal(first.result, "result-1");

  const replay = await runWorkflow<string>(script, {
    loadSavedWorkflow: () => childScript,
    modelAliases: { haiku: "mock/two", sonnet: "mock/sonnet" },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: runner,
  });

  assert.equal(replay.result, "result-2");
  assert.equal(calls, 2, "changing the child-used alias must rerun the atomic child");
});

test("atomic child replay invalidates when an effective agent definition changes", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('task', { agentType: 'reviewer' })`;
  const script = parentScript(`return await workflow('child')`);
  const definition = (prompt: string): AgentDefinition => ({
    name: "reviewer",
    prompt,
    source: "project",
  });
  const firstRegistry: AgentRegistry = new Map([["reviewer", definition("first definition")]]);
  const secondRegistry: AgentRegistry = new Map([["reviewer", definition("changed definition")]]);
  const journal: JournalEntry[] = [];

  await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    agentRegistry: firstRegistry,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "first";
      },
    },
  });

  let replayCalls = 0;
  const replay = await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    agentRegistry: secondRegistry,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: {
      async run() {
        replayCalls++;
        return "changed";
      },
    },
  });

  assert.equal(replayCalls, 1);
  assert.equal(replay.result, "changed");
});

test("atomic child replay invalidates when agentTypePolicy changes from fallback to error", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('task', { agentType: 'missing' })`;
  const script = parentScript(`return await workflow('child')`);
  const journal: JournalEntry[] = [];

  await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    agentRegistry: new Map(),
    agentTypePolicy: "fallback",
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "fallback-result";
      },
    },
  });

  await assert.rejects(
    () =>
      runWorkflow(script, {
        persistLogs: false,
        loadSavedWorkflow: () => childScript,
        agentRegistry: new Map(),
        agentTypePolicy: "error",
        resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
        agent: {
          async run() {
            return "must-not-run";
          },
        },
      }),
    /Unknown agentType "missing"/,
  );
});

test("atomic child result is snapshotted separately from the value returned to its parent", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return { nested: { value: 1 } }`;
  const script = parentScript(`const child = await workflow('child')
child.nested.value = 2
return child`);
  const journal: JournalEntry[] = [];

  const result = await runWorkflow<{ nested: { value: number } }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
  });

  assert.equal(result.result.nested.value, 2);
  assert.equal((journal[0]?.result as { nested: { value: number } }).nested.value, 1);
  assert.notEqual(result.result, journal[0]?.result);

  const replay = await runWorkflow<{ nested: { value: number } }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map([[journal[0].index, journal[0]]]),
  });
  assert.equal(replay.result.nested.value, 2);
  assert.equal((journal[0]?.result as { nested: { value: number } }).nested.value, 1);
  assert.notEqual(replay.result, journal[0]?.result);
});

test("void atomic children execute and replay atomically", async () => {
  const childScript = `export const meta = { name: 'void-child', description: 'void child' }
await agent('child-write')`;
  const script = parentScript(`const child = await workflow('void-child')
const observed = await agent('read-child-write')
return { childIsUndefined: child === undefined, observed }`);
  const journal: JournalEntry[] = [];
  let childCalls = 0;
  const runner = {
    async run(prompt: string, options: StoreAgentOptions) {
      if (prompt === "child-write") {
        childCalls++;
        await put(options, "void-child", "committed");
        return "wrote";
      }
      if (prompt === "read-child-write") return get(options, "void-child");
      return prompt;
    },
  };

  const live = await runWorkflow<{
    childIsUndefined: boolean;
    observed: { found: boolean; value: unknown };
  }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: runner,
  });

  assert.equal(
    JSON.stringify(live.result),
    JSON.stringify({
      childIsUndefined: true,
      observed: { found: true, value: "committed" },
    }),
  );
  assert.equal(childCalls, 1);
  assert.equal(journal[0]?.resultKind, "void");
  assert.equal(journal[0]?.result, null);
  assert.equal(JSON.parse(JSON.stringify(journal[0])).resultKind, "void");

  const replay = await runWorkflow<{
    childIsUndefined: boolean;
    observed: { found: boolean; value: unknown };
  }>(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: runner,
  });

  assert.equal(
    JSON.stringify(replay.result),
    JSON.stringify({
      childIsUndefined: true,
      observed: { found: true, value: "committed" },
    }),
  );
  assert.equal(childCalls, 1, "replay must not rerun the void child");
});

test("unsupported atomic child results fail before committing child writes", async (t) => {
  const cases = [
    ["NaN", "return Number.NaN"],
    ["cyclic", "const value = {}; value.self = value; return value"],
    ["BigInt", "return 1n"],
  ] as const;

  for (const [name, childResultBody] of cases) {
    await t.test(name, async () => {
      const childScript = `export const meta = { name: 'child', description: 'child' }
await agent('child-write')
${childResultBody}`;
      const script = parentScript(`let rejected = false
try { await workflow('child') } catch { rejected = true }
const observed = await agent('read-child-write')
return { rejected, observed }`);
      const journal: JournalEntry[] = [];
      const result = await runWorkflow<{ rejected: boolean; observed: { found: boolean; value: unknown } }>(script, {
        persistLogs: false,
        loadSavedWorkflow: () => childScript,
        onAgentJournal: (entry) => journal.push(entry),
        agent: {
          async run(prompt: string, options: StoreAgentOptions) {
            if (prompt === "child-write") {
              await put(options, "child", "must-not-commit");
              return "wrote";
            }
            if (prompt === "read-child-write") return get(options, "child");
            return prompt;
          },
        },
      });

      assert.equal(result.result.rejected, true);
      assert.equal(result.result.observed.found, false);
      assert.equal(result.result.observed.value, null);
      assert.equal(
        journal.some((entry) => entry.index === 0),
        false,
      );
    });
  }
});

test("atomic child replay rejects a malformed void-result encoding", async () => {
  const childScript = `export const meta = { name: 'void-child', description: 'void child' }`;
  const script = parentScript(`return await workflow('void-child')`);
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(journal[0]?.resultKind, "void");
  journal[0].result = "not-the-canonical-null";

  await assert.rejects(
    () =>
      runWorkflow(script, {
        persistLogs: false,
        loadSavedWorkflow: () => childScript,
        resumeJournal: new Map([[journal[0].index, journal[0]]]),
      }),
    /atomic void child result must use the canonical null encoding/,
  );
});

test("atomic child replay rejects a malformed negative agentCount", async () => {
  const childScript = `export const meta = { name: 'child', description: 'child' }
return await agent('task')`;
  const script = parentScript(`return await workflow('child')`);
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "done";
      },
    },
  });
  assert.ok(journal[0]);
  journal[0].agentCount = -1;

  await assert.rejects(
    () =>
      runWorkflow(script, {
        persistLogs: false,
        loadSavedWorkflow: () => childScript,
        resumeJournal: new Map([[journal[0].index, journal[0]]]),
        agent: {
          async run() {
            return "must-not-run";
          },
        },
      }),
    /agentCount.*non-negative integer/,
  );
});

test("cold persistence preserves and replays a void atomic child", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-cold-void-child-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-cold-void-child-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const childScript = `export const meta = { name: 'void-child', description: 'void child' }
await agent('child-write')`;
      const script = parentScript(`const child = await workflow('void-child')
await agent('interrupt-parent')
const observed = await agent('read-child-write')
return { childIsUndefined: child === undefined, observed }`);
      const firstManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => childScript,
        agent: {
          async run(prompt: string, options: StoreAgentOptions) {
            if (prompt === "child-write") {
              await put(options, "void-child", "persisted");
              return "wrote";
            }
            if (prompt === "interrupt-parent") {
              throw new WorkflowError("interrupt", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: false });
            }
            return prompt;
          },
        },
      });
      firstManager.on("error", () => {});
      await assert.rejects(() => firstManager.runSync(script), /interrupt/);
      const persisted = firstManager.listRuns().find((run) => run.workflowName === "parent");
      assert.ok(persisted);
      assert.equal(persisted.journal?.[0]?.resultKind, "void");
      assert.equal(persisted.journal?.[0]?.result, null);

      let childCalls = 0;
      const resumedManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => childScript,
        agent: {
          async run(prompt: string, options: StoreAgentOptions) {
            if (prompt === "child-write") childCalls++;
            if (prompt === "interrupt-parent") return "continued";
            if (prompt === "read-child-write") return get(options, "void-child");
            return prompt;
          },
        },
      });
      const completed = new Promise<{ result: { childIsUndefined: boolean; observed: unknown } }>((resolve) => {
        resumedManager.on("complete", (event: { runId: string; result: { result: never } }) => {
          if (event.runId === persisted.runId) resolve(event.result);
        });
      });
      assert.equal(await resumedManager.resume(persisted.runId), true);
      const resumed = await completed;
      assert.equal(childCalls, 0);
      assert.equal(
        JSON.stringify(resumed.result),
        JSON.stringify({
          childIsUndefined: true,
          observed: { found: true, value: "persisted" },
        }),
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("cold persistence replays the atomic child result and execution-order delta", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-cold-child-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-cold-child-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const childScript = `export const meta = { name: 'child', description: 'child' }
await Promise.all([agent('late-write'), agent('early-write')])
return { source: 'persisted-child' }`;
      const script = parentScript(`const child = await workflow('child')
await agent('interrupt-parent')
const observed = await agent('read-winner')
return { child, observed }`);
      let releaseLate!: () => void;
      const earlyWritten = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      const firstManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => childScript,
        agent: {
          async run(prompt: string, options: StoreAgentOptions) {
            if (prompt === "late-write") {
              await earlyWritten;
              await put(options, "winner", "actual-last-write");
              return "late";
            }
            if (prompt === "early-write") {
              await put(options, "winner", "call-index-last");
              releaseLate();
              return "early";
            }
            if (prompt === "interrupt-parent") {
              throw new WorkflowError("interrupt", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: false });
            }
            return prompt;
          },
        },
      });
      firstManager.on("error", () => {});
      await assert.rejects(() => firstManager.runSync(script), /interrupt/);
      const persisted = firstManager.listRuns().find((run) => run.workflowName === "parent");
      assert.ok(persisted);
      assert.deepEqual(persisted.journal?.[0]?.result, { source: "persisted-child" });
      assert.deepEqual(persisted.journal?.[0]?.storeDelta, { winner: "actual-last-write" });

      let childCalls = 0;
      const resumedManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => childScript,
        agent: {
          async run(prompt: string, options: StoreAgentOptions) {
            if (prompt === "late-write" || prompt === "early-write") childCalls++;
            if (prompt === "interrupt-parent") return "continued";
            if (prompt === "read-winner") return get(options, "winner");
            return prompt;
          },
        },
      });
      const completed = new Promise<{ result: { child: unknown; observed: unknown } }>((resolve) => {
        resumedManager.on("complete", (event: { runId: string; result: { result: never } }) => {
          if (event.runId === persisted.runId) resolve(event.result);
        });
      });
      assert.equal(await resumedManager.resume(persisted.runId), true);
      const resumed = await completed;
      assert.equal(childCalls, 0, "the cold manager replays rather than reruns the child");
      assert.equal(
        JSON.stringify(resumed.result),
        JSON.stringify({
          child: { source: "persisted-child" },
          observed: { found: true, value: "actual-last-write" },
        }),
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
