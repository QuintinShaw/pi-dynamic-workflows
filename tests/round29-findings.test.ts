import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { deliverText } from "../src/task-panel.js";
import { runWorkflow } from "../src/workflow.js";
import { type ManagedRun, WorkflowManager } from "../src/workflow-manager.js";
import {
  createWorktree,
  RetainedWorktreeRegistry,
  removeWorktree,
  type Worktree,
  type WorktreeOperations,
} from "../src/worktree.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const childScript = `export const meta = { name: 'child', description: 'child' }\nreturn args`;
const parentScript = (body: string): string => `export const meta = { name: 'parent', description: 'parent' }\n${body}`;

function createGitRepo(prefix: string): { repo: string; cleanup(): void } {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

function runtimeWorktree(name: string): Worktree {
  return {
    isolated: true,
    cwd: `/runtime/${name}`,
    repoRoot: "/runtime",
    branch: `pi/wf/${name}`,
    branchRef: `refs/heads/pi/wf/${name}`,
    baseSha: "a".repeat(40),
  };
}

test("nested workflow validation returns rejected Promises and snapshots valid args synchronously", async () => {
  const unsupported = [
    { setup: "const value = {}; value.self = value", pattern: /cyclic/i },
    { setup: "const value = () => true", pattern: /unsupported function/i },
    { setup: "const value = Symbol('value')", pattern: /unsupported symbol/i },
    { setup: "const value = 1n", pattern: /unsupported bigint/i },
  ];
  for (const item of unsupported) {
    const result = await runWorkflow(
      parentScript(`${item.setup}\nreturn workflow('child', value).catch(error => String(error.message))`),
      { loadSavedWorkflow: () => childScript, persistLogs: false },
    );
    assert.match(String(result.result), item.pattern);
  }

  await assert.rejects(
    runWorkflow(parentScript("const value = {}; value.self = value\nreturn workflow('child', value)"), {
      loadSavedWorkflow: () => childScript,
      persistLogs: false,
    }),
    /cyclic/i,
  );

  const snapshotted = await runWorkflow(
    parentScript(`const value = { nested: { status: 'before' } }
const pending = workflow('child', value)
value.nested.status = 'after'
return pending`),
    { loadSavedWorkflow: () => childScript, persistLogs: false },
  );
  assert.deepEqual(snapshotted.result, { nested: { status: "before" } });
});

test("cross-root retained-handle scanning rejects through .catch without child side effects", async () => {
  const worktree = runtimeWorktree("cross-root");
  const first = await runWorkflow(
    `export const meta = { name: 'producer', description: 'producer' }
return await agent('produce', { isolation: 'worktree', retainWorktree: true })`,
    {
      persistLogs: false,
      agent: {
        async run() {
          return "produced";
        },
      },
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree() {
          return [];
        },
      },
    },
  );
  const handle = (first.result as { worktree: object }).worktree;
  let childLoads = 0;
  const second = await runWorkflow(
    parentScript("return workflow('child', args.handle).catch(error => String(error.message))"),
    {
      args: { handle },
      loadSavedWorkflow: () => {
        childLoads++;
        return childScript;
      },
      persistLogs: false,
    },
  );
  assert.match(String(second.result), /cross-run/i);
  assert.equal(childLoads, 0);
});

test("hostile sync and async cleanup observers never mask ordinary or retained outcomes", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  for (const lifecycle of ["ordinary", "retained"] as const) {
    for (const loggerMode of ["sync", "async"] as const) {
      for (const primaryFails of [false, true]) {
        const worktree = runtimeWorktree(`${lifecycle}-${loggerMode}-${primaryFails}`);
        const run = runWorkflow(
          `export const meta = { name: 'hostile_cleanup_observers', description: 'non-masking cleanup observers' }
${primaryFails ? "await" : "return await"} agent('work', { isolation: 'worktree'${lifecycle === "retained" ? ", retainWorktree: true" : ""} })
${primaryFails ? "throw new Error('original workflow error')" : ""}`,
          {
            persistLogs: false,
            agent: {
              async run() {
                return "successful result";
              },
            },
            worktreeOperations: {
              async createWorktree() {
                return worktree;
              },
              async removeWorktree() {
                throw new Error("cleanup remove failed");
              },
            },
            onWorktreeCleanupFailure() {
              throw new Error("cleanup observer failed");
            },
            onLog(message) {
              if (!/cleanup/i.test(message)) return;
              if (loggerMode === "sync") throw new Error("sync logger failed");
              return Promise.reject(new Error("async logger failed"));
            },
          },
        );
        if (primaryFails) await assert.rejects(run, /original workflow error/);
        else {
          const result = await run;
          const value = lifecycle === "retained" ? (result.result as { result: string }).result : result.result;
          assert.equal(value, "successful result");
          assert.equal(result.worktreeCleanupFailures?.length, 1);
        }
      }
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test("managed and registry cleanup observers consume hostile asynchronous rejections", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const registryWorktree = runtimeWorktree("registry-observer");
  const registry = new RetainedWorktreeRegistry(
    {
      async createWorktree() {
        return registryWorktree;
      },
      async removeWorktree() {
        throw new Error("registry cleanup failed");
      },
    },
    async () => {
      throw new Error("registry observer rejected");
    },
  );
  registry.register(registryWorktree);
  await registry.cleanupAll();

  for (const lifecycle of ["ordinary", "retained"] as const) {
    const cwd = mkdtempSync(join(tmpdir(), `pi-round29-managed-observer-${lifecycle}-`));
    const fakeHome = mkdtempSync(join(tmpdir(), `pi-round29-managed-observer-home-${lifecycle}-`));
    const worktree = runtimeWorktree(`managed-observer-${lifecycle}`);
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const manager = new WorkflowManager({
          cwd,
          agent: {
            async run() {
              return "successful result";
            },
          },
          worktreeOperations: {
            async createWorktree() {
              return worktree;
            },
            async removeWorktree() {
              throw new Error("managed cleanup failed");
            },
          },
        });
        manager.on("log", async () => {
          throw new Error("managed log observer rejected");
        });
        const result = await manager.runSync(
          `export const meta = { name: 'managed_observer', description: 'managed observer' }
return await agent('work', { isolation: 'worktree'${lifecycle === "retained" ? ", retainWorktree: true" : ""} })`,
        );
        assert.equal(
          lifecycle === "retained" ? (result.result as { result: string }).result : result.result,
          "successful result",
        );
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test("managed persistence redacts issued handles without changing the live foreground result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-round29-persist-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-round29-persist-home-"));
  const worktree = runtimeWorktree("managed-persistence");
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            return { ok: true };
          },
        },
        worktreeOperations: {
          async createWorktree() {
            return worktree;
          },
          async removeWorktree() {
            return [];
          },
        },
      });
      const result = await manager.runSync(
        `export const meta = { name: 'persisted_handle', description: 'redact retained capability' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
return { envelope: produced, handles: [produced.worktree], mapped: new Map([['handle', produced.worktree]]) }`,
      );
      const live = result.result as {
        envelope: { result: { ok: boolean }; worktree: object };
        handles: object[];
        mapped: Map<string, object>;
      };
      assert.equal(live.handles[0], live.envelope.worktree);
      assert.equal(live.mapped.get("handle"), live.envelope.worktree);
      assert.equal(typeof live.envelope.worktree, "object", "the foreground result retains the live capability");

      const runId = result.runId ?? "";
      const persisted = manager.getPersistence().load(runId);
      const persistedResult = persisted?.result as {
        envelope: { worktree: unknown };
        handles: unknown[];
        mapped: unknown;
      };
      assert.equal(typeof persistedResult.envelope.worktree, "string");
      assert.equal(persistedResult.handles[0], persistedResult.envelope.worktree);
      assert.notDeepEqual(persistedResult.envelope.worktree, {});

      const raw = readFileSync(join(manager.getPersistence().getRunsDir(), `${runId}.json`), "utf8");
      assert.doesNotMatch(raw, /"worktree"\s*:\s*\{\s*\}/);
      assert.equal(raw.includes("retained-worktree-handle"), true);

      const coldManager = new WorkflowManager({ cwd });
      const cold = coldManager.listRuns().find((candidate) => candidate.runId === runId);
      const coldResult = cold?.result as { envelope: { worktree: unknown } };
      assert.equal(typeof coldResult.envelope.worktree, "string");
      const registry = new RetainedWorktreeRegistry();
      assert.throws(() => registry.acquire(coldResult.envelope.worktree), /malformed|unknown/i);
      const liveManaged = manager.getRun(runId);
      assert.ok(liveManaged);
      const delivery = deliverText({
        ...liveManaged,
        result: { ...result, result: cold?.result },
      } as ManagedRun);
      assert.doesNotMatch(delivery, /"worktree"\s*:\s*\{\s*\}/);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("persistence sanitizer is cycle-safe across results, journals, agent snapshots, maps, and cross-realm objects", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-round29-direct-persist-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-round29-direct-home-"));
  const worktree = runtimeWorktree("direct-persistence");
  const operations: WorktreeOperations = {
    async createWorktree() {
      return worktree;
    },
    async removeWorktree() {
      return [];
    },
  };
  const registry = new RetainedWorktreeRegistry(operations);
  const handle = registry.register(worktree);
  const crossRealm = runInNewContext("({ nested: null, mapped: new Map() })") as {
    nested: unknown;
    mapped: Map<unknown, unknown>;
  };
  crossRealm.nested = handle;
  crossRealm.mapped.set("handle", handle);
  const cyclic: { handle: unknown; self?: unknown; map: Map<unknown, unknown> } = {
    handle,
    map: new Map([["handle", handle]]),
  };
  cyclic.self = cyclic;
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd });
      const state = {
        version: 2 as const,
        schemaVersion: 2 as const,
        runId: "round29-direct",
        cwd,
        workflowName: "direct",
        script: "export const meta = { name: 'direct', description: 'direct' }\nreturn null",
        status: "completed" as const,
        phases: [],
        agents: [{ id: 1, label: "agent", prompt: "prompt", status: "done" as const, result: { handle } }],
        logs: [],
        result: { cyclic, crossRealm },
        journal: [{ index: 0, key: "root/call:0", kind: "agent" as const, hash: "hash", result: [handle] }],
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
      };
      assert.doesNotThrow(() => manager.getPersistence().save(state));
      const loaded = manager.getPersistence().load(state.runId);
      const serialized = JSON.stringify(loaded);
      assert.equal(serialized.includes("retained-worktree-handle"), true);
      assert.doesNotMatch(serialized, /"handle"\s*:\s*\{\s*\}/);
      const loadedResult = loaded?.result as {
        cyclic: { handle: unknown; map: unknown };
        crossRealm: { nested: unknown; mapped: unknown };
      };
      assert.equal(typeof loadedResult.cyclic.handle, "string");
      assert.deepEqual(loadedResult.cyclic.map, [["handle", "[retained-worktree-handle]"]]);
      assert.equal(typeof loadedResult.crossRealm.nested, "string");
      assert.deepEqual(loadedResult.crossRealm.mapped, [["handle", "[retained-worktree-handle]"]]);
      assert.equal(typeof loaded?.journal?.[0]?.result?.[0], "string");
      assert.equal(typeof loaded?.agents[0]?.result === "object", true);
    });
  } finally {
    await registry.cleanupAll();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("cold resume receives only an inert scalar where a retained handle was persisted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-round29-cold-resume-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-round29-cold-resume-home-"));
  const worktree = runtimeWorktree("cold-resume");
  const registry = new RetainedWorktreeRegistry({
    async createWorktree() {
      return worktree;
    },
    async removeWorktree() {
      return [];
    },
  });
  const handle = registry.register(worktree);
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const seed = new WorkflowManager({ cwd });
      seed.getPersistence().save({
        version: 2,
        schemaVersion: 2,
        runId: "round29-cold-resume",
        cwd,
        workflowName: "cold_resume",
        script: `export const meta = { name: 'cold_resume', description: 'cold inert handle' }
return agent('consume', { worktree: args.handle }).catch(error => String(error.message))`,
        args: { handle },
        status: "paused",
        phases: [],
        agents: [],
        logs: [],
        journal: [],
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });

      let agentCalls = 0;
      const cold = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            agentCalls++;
            return "unexpected";
          },
        },
      });
      assert.equal(await cold.resume("round29-cold-resume"), true);
      const resumed = cold.getRun("round29-cold-resume");
      assert.ok(resumed?.settlement);
      const result = await resumed.settlement;
      assert.match(String(result.result), /runtime-issued|malformed|unknown/i);
      assert.equal(agentCalls, 0);
      const persisted = cold.getPersistence().load("round29-cold-resume");
      assert.match(String(persisted?.result), /runtime-issued|malformed|unknown/i);
      assert.doesNotMatch(JSON.stringify(persisted), /"worktree"\s*:\s*\{\s*\}/);
    });
  } finally {
    await registry.cleanupAll();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("public createWorktree/removeWorktree operations compose for ordinary and retained lifecycle", async () => {
  const exportedOperations: WorktreeOperations = { createWorktree, removeWorktree };
  for (const lifecycle of ["ordinary", "retained"] as const) {
    const { repo, cleanup } = createGitRepo(`pi-round29-composable-${lifecycle}-`);
    try {
      const result = await runWorkflow(
        `export const meta = { name: 'composable_operations', description: 'public operation composition' }
const value = await agent('work', { isolation: 'worktree'${lifecycle === "retained" ? ", retainWorktree: true" : ""} })
${lifecycle === "retained" ? "await releaseWorktree(value.worktree)\nreturn value.result" : "return value"}`,
        {
          cwd: repo,
          persistLogs: false,
          worktreeOperations: exportedOperations,
          agent: {
            async run() {
              return "ok";
            },
          },
        },
      );
      assert.equal(result.result, "ok");
      assert.equal(result.worktreeCleanupFailures, undefined);
      const listed = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
      assert.equal(listed.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
      assert.equal(existsSync(join(repo, ".pi", "worktrees")), false);
    } finally {
      cleanup();
    }
  }
});
