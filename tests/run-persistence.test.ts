import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WORKFLOW_RUNS_DIR } from "../src/config.js";
import { createRunPersistence, generateRunId, type PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-rp-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await fn(cwd);
    } finally {
      process.env.HOME = origHome;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test(
  "createRunPersistence creates runs directory on first save",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.equal(existsSync(runsDir), false, "dir should not exist yet");
    rp.save({
      runId: "test-1",
      workflowName: "demo",
      script: "export const meta = { name: 'd', description: 'd' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.ok(existsSync(runsDir), "dir should be created");
    assert.ok(existsSync(join(runsDir, "test-1.json")), "run file should exist");
    assert.equal(existsSync(join(cwd, WORKFLOW_RUNS_DIR)), false, "legacy project runs dir should not be created");
  }),
);

test(
  "createRunPersistence save and load round-trips correctly",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "roundtrip-1",
      workflowName: "test-wf",
      script: "export const meta = { name: 't', description: 't' }",
      args: { key: "value" },
      status: "running",
      phases: ["Scan", "Report"],
      currentPhase: "Scan",
      agents: [{ id: 1, label: "agent-1", prompt: "do it", status: "running" }],
      logs: ["started", "phase: Scan"],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
    };
    rp.save(state);

    const loaded = rp.load("roundtrip-1");
    assert.ok(loaded, "should load saved state");
    assert.equal(loaded?.runId, "roundtrip-1");
    assert.equal(loaded?.workflowName, "test-wf");
    assert.equal(loaded?.status, "running");
    assert.deepEqual(loaded?.phases, ["Scan", "Report"]);
    assert.equal(loaded?.currentPhase, "Scan");
    assert.equal(loaded?.agents.length, 1);
    assert.equal(loaded?.agents[0].label, "agent-1");
    assert.deepEqual(loaded?.logs, ["started", "phase: Scan"]);
    assert.deepEqual(loaded?.args, { key: "value" });
  }),
);

test(
  "createRunPersistence save updates updatedAt",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "update-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    rp.save(state);
    const before = rp.load("update-test");
    const beforeTime = before?.updatedAt;

    // Small delay so updatedAt changes
    await new Promise((r) => setTimeout(r, 10));

    rp.save({ ...state, status: "running" });
    const after = rp.load("update-test");
    assert.notEqual(after?.updatedAt, beforeTime, "updatedAt should change");
    assert.equal(after?.status, "running");
  }),
);

test(
  "createRunPersistence load returns null for missing run",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const loaded = rp.load("nonexistent");
    assert.equal(loaded, null);
  }),
);

test(
  "createRunPersistence reads legacy project run files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-run.json"),
      JSON.stringify({
        runId: "legacy-run",
        workflowName: "legacy",
        script: "export const meta = { name: 'legacy', description: 'legacy' }",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    assert.equal(rp.load("legacy-run")?.workflowName, "legacy");
    assert.equal(
      rp.list().some((run) => run.runId === "legacy-run"),
      true,
    );
  }),
);

test(
  "createRunPersistence list returns runs sorted by updatedAt descending",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    // Save with explicit updatedAt values to guarantee order
    // (save() overwrites updatedAt, so we need to write files directly)
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(runsDir, { recursive: true });
    const makeFile = (runId: string, date: string) => {
      writeFileSync(
        join(runsDir, `${runId}.json`),
        JSON.stringify({
          runId,
          workflowName: `wf-${runId}`,
          script: "export const meta = { name: 'w', description: 'w' }",
          status: "completed",
          phases: [],
          agents: [],
          logs: [],
          startedAt: date,
          updatedAt: date,
        }),
      );
    };
    makeFile("oldest", "2024-01-01T00:00:00.000Z");
    makeFile("middle", "2024-03-01T00:00:00.000Z");
    makeFile("newest", "2024-06-01T00:00:00.000Z");

    const runs = rp.list();
    assert.equal(runs.length, 3);
    assert.equal(runs[0].runId, "newest");
    assert.equal(runs[1].runId, "middle");
    assert.equal(runs[2].runId, "oldest");
  }),
);

test(
  "createRunPersistence list handles empty state",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runs = rp.list();
    assert.deepEqual(runs, []);
    assert.equal(existsSync(workflowProjectPaths(cwd).runsDir), false, "list should not create the runs dir");
  }),
);

test(
  "createRunPersistence list skips corrupted files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    // Save one valid run
    rp.save({
      runId: "valid",
      workflowName: "v",
      script: "export const meta = { name: 'v', description: 'v' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    // Write a corrupted file
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(runsDir, "corrupted.json"), "not valid json{{{");
    writeFileSync(join(runsDir, "empty.json"), "");

    const runs = rp.list();
    assert.equal(runs.length, 1, "should only return valid run");
    assert.equal(runs[0].runId, "valid");
  }),
);

test(
  "createRunPersistence delete removes run and returns true",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "delete-me",
      workflowName: "d",
      script: "export const meta = { name: 'd', description: 'd' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    assert.ok(existsSync(join(workflowProjectPaths(cwd).runsDir, "delete-me.json")), "existsSync() should succeed");
    const deleted = rp.delete("delete-me");
    assert.equal(deleted, true);
    assert.equal(rp.load("delete-me"), null);
  }),
);

test(
  "createRunPersistence delete removes legacy project run files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "delete-legacy.json"),
      JSON.stringify({
        runId: "delete-legacy",
        workflowName: "legacy",
        script: "export const meta = { name: 'legacy', description: 'legacy' }",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    assert.equal(rp.delete("delete-legacy"), true);
    assert.equal(existsSync(join(legacyRunsDir, "delete-legacy.json")), false);
  }),
);

test(
  "createRunPersistence delete returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const deleted = rp.delete("no-such-run");
    assert.equal(deleted, false);
  }),
);

test(
  "createRunPersistence getRunsDir returns the runs directory path",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    assert.equal(rp.getRunsDir(), workflowProjectPaths(cwd).runsDir);
  }),
);

test(
  "createRunPersistence save and load preserves journal entries",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "journal-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      journal: [
        { index: 0, hash: "abc123", result: { ok: true } },
        { index: 1, hash: "def456", result: { value: 42 } },
      ],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    rp.save(state);
    const loaded = rp.load("journal-test");
    assert.equal(loaded?.journal?.length, 2);
    assert.equal(loaded?.journal?.[0].index, 0);
    assert.equal(loaded?.journal?.[0].hash, "abc123");
    assert.deepEqual(loaded?.journal?.[0].result, { ok: true });
  }),
);

test(
  "createRunPersistence save and load preserves token usage",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "tokens",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      tokenUsage: { input: 100, output: 50, total: 150 },
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const loaded = rp.load("tokens");
    assert.deepEqual(loaded?.tokenUsage, { input: 100, output: 50, total: 150 });
  }),
);

test(
  "createRunPersistence save and load preserves completedAt and durationMs",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "timing",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:01:00.000Z",
      durationMs: 60000,
    });
    const loaded = rp.load("timing");
    assert.equal(loaded?.completedAt, "2024-01-01T00:01:00.000Z");
    assert.equal(loaded?.durationMs, 60000);
  }),
);

test("generateRunId returns a string with timestamp and random parts", () => {
  const id = generateRunId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 5, "run id should have reasonable length");
  assert.ok(id.includes("-"), "run id should have separator");
});

test("generateRunId produces unique ids", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
  assert.equal(ids.size, 100, "all 100 generated ids should be unique");
});

test(
  "createRunPersistence save throws ENOSPC when disk is full",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      writeFileSync: () => {
        const err = new Error("ENOSPC: no space left on device");
        (err as { code?: string }).code = "ENOSPC";
        throw err;
      },
    });

    const state: PersistedRunState = {
      runId: "enospc-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.throws(
      () => rp.save(state),
      (err: unknown) => (err as { code?: string }).code === "ENOSPC",
    );
  }),
);

test(
  "createRunPersistence save throws EACCES when permission denied",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      writeFileSync: () => {
        const err = new Error("EACCES: permission denied");
        (err as { code?: string }).code = "EACCES";
        throw err;
      },
    });

    const state: PersistedRunState = {
      runId: "eacces-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.throws(
      () => rp.save(state),
      (err: unknown) => (err as { code?: string }).code === "EACCES",
    );
  }),
);

test(
  "createRunPersistence list returns empty array when directory is unreadable",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      readdirSync: () => {
        throw new Error("EACCES: permission denied, scandir");
      },
    });

    const runs = rp.list();
    assert.deepEqual(runs, []);
  }),
);

test(
  "createRunPersistence concurrent save and load returns consistent data",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);

    const state: PersistedRunState = {
      runId: "concurrent-test",
      workflowName: "test-wf",
      script: "export const meta = { name: 't', description: 't' }",
      args: { items: [1, 2, 3] },
      status: "running",
      phases: ["Scan", "Analyze", "Report"],
      currentPhase: "Analyze",
      agents: [
        { id: 1, label: "agent-a", prompt: "scan", status: "done", result: { found: true } },
        { id: 2, label: "agent-b", prompt: "analyze", status: "running" },
      ],
      logs: ["started", "phase: Scan", "phase: Analyze"],
      tokenUsage: { input: 500, output: 200, total: 700 },
      journal: [{ index: 0, hash: "abc", result: { ok: true } }],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: undefined,
    };

    rp.save(state);
    const loaded = rp.load("concurrent-test");

    assert.ok(loaded, "should load immediately after save");
    assert.equal(loaded.runId, state.runId);
    assert.equal(loaded.workflowName, state.workflowName);
    assert.equal(loaded.status, "running");
    assert.equal(loaded.currentPhase, "Analyze");
    assert.deepEqual(loaded.args, { items: [1, 2, 3] });
    assert.deepEqual(loaded.phases, ["Scan", "Analyze", "Report"]);
    assert.equal(loaded.agents.length, 2);
    assert.deepEqual(loaded.agents[0].result, { found: true });
    assert.equal(loaded.agents[1].status, "running");
    assert.deepEqual(loaded.logs, ["started", "phase: Scan", "phase: Analyze"]);
    assert.deepEqual(loaded.tokenUsage, { input: 500, output: 200, total: 700 });
    assert.deepEqual(loaded.journal, [{ index: 0, hash: "abc", result: { ok: true } }]);
  }),
);

// ─── P1-1: crash-safe durable resume ────────────────────────────────────────────

test(
  "save writes the primary plus a .bak (atomic temp+rename leaves no .tmp)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "running",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.ok(existsSync(join(runsDir, "r1.json")), "primary written");
    assert.ok(existsSync(join(runsDir, "r1.json.bak")), ".bak written");
    assert.equal(existsSync(join(runsDir, "r1.json.tmp")), false, "no leftover .tmp");
  }),
);

test(
  "load recovers from .bak when the primary is corrupt",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "running",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    // Corrupt the primary; the .bak from the good save should still load.
    writeFileSync(join(workflowProjectPaths(cwd).runsDir, "r1.json"), "{ truncated", "utf-8");
    const loaded = rp.load("r1");
    assert.equal(loaded?.runId, "r1", "load falls back to the intact .bak");
  }),
);

test(
  "delete removes the .bak sidecar too",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    rp.delete("r1");
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.equal(existsSync(join(runsDir, "r1.json")), false);
    assert.equal(existsSync(join(runsDir, "r1.json.bak")), false, ".bak cleaned up");
  }),
);

test(
  "persistence round-trips cost and cache fields in tokenUsage",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "tu",
      workflowName: "w",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      tokenUsage: { input: 1, output: 2, total: 3, cost: 0.5, cacheRead: 9, cacheWrite: 4 },
    } as PersistedRunState);
    const loaded = rp.load("tu");
    assert.equal(loaded?.tokenUsage?.cost, 0.5, "cost survives reload");
    assert.equal(loaded?.tokenUsage?.cacheRead, 9, "cacheRead survives reload");
    assert.equal(loaded?.tokenUsage?.cacheWrite, 4, "cacheWrite survives reload");
  }),
);

test(
  "run lease creates an exclusive lock and releases only with the owner token",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const lease = rp.acquireRunLease("lease-1");
    assert.ok(lease, "first acquire should succeed");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")), true, "lock file is created");

    const second = rp.acquireRunLease("lease-1");
    assert.equal(second, null, "second acquire should be refused while owner pid is alive");

    rp.releaseRunLease({ ...lease, token: "wrong-token" });
    assert.equal(
      existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")),
      true,
      "wrong token does not release",
    );

    rp.releaseRunLease(lease);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")), false, "owner token releases");
  }),
);

test(
  "run lease refuses while a legacy project lock owner is alive",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-live.lock"),
      JSON.stringify({
        runId: "legacy-live",
        runPath: join(legacyRunsDir, "legacy-live.json"),
        pid: process.pid,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-owner",
      }),
      "utf-8",
    );

    assert.equal(rp.acquireRunLease("legacy-live"), null);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "legacy-live.lock")), false);
  }),
);

test(
  "run lease removes a stale legacy project lock before acquiring the new lock",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    const primaryRunsDir = workflowProjectPaths(cwd).runsDir;
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-stale.lock"),
      JSON.stringify({
        runId: "legacy-stale",
        runPath: join(legacyRunsDir, "legacy-stale.json"),
        pid: 2147483647,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-stale",
      }),
      "utf-8",
    );

    const lease = rp.acquireRunLease("legacy-stale");
    assert.ok(lease, "dead-pid legacy lock should not block the new owner");
    assert.equal(existsSync(join(legacyRunsDir, "legacy-stale.lock")), false);
    assert.equal(existsSync(join(primaryRunsDir, "legacy-stale.lock")), true);
    rp.releaseRunLease(lease);
  }),
);

test(
  "run lease steals a stale lock whose pid is dead",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    rp.save({
      runId: "stale-lock",
      workflowName: "w",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);

    writeFileSync(
      join(runsDir, "stale-lock.lock"),
      JSON.stringify({
        runId: "stale-lock",
        runPath: join(runsDir, "stale-lock.json"),
        pid: 2147483647,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "stale",
      }),
      "utf-8",
    );

    const lease = rp.acquireRunLease("stale-lock");
    assert.ok(lease, "dead-pid lock should be stolen");
    const lock = JSON.parse(readFileSync(join(runsDir, "stale-lock.lock"), "utf-8")) as { token: string };
    assert.equal(lock.token, lease.token, "stale lock is replaced by the new owner");
    rp.releaseRunLease(lease);
  }),
);

test(
  "delete removes the lock sidecar too",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "delete-lock",
      workflowName: "w",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    const lease = rp.acquireRunLease("delete-lock");
    assert.ok(lease, "lease exists before delete");
    rp.delete("delete-lock");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "delete-lock.lock")), false, "lock cleaned up");
  }),
);

test(
  "WorkflowManager reconciles a stale 'running' run to 'paused' on construction",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "stale",
      workflowName: "w",
      status: "running",
      script: "export const meta = { name: 'w', description: 'd' }\nawait agent('x',{label:'x'})\nreturn 1",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    // A fresh manager (the previous process died) should recover the orphan.
    new WorkflowManager({ cwd });
    assert.equal(rp.load("stale")?.status, "paused", "stale running -> paused (journal preserved for resume)");
  }),
);

test(
  "WorkflowManager does not recover a legacy running run while its legacy lock owner is alive",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-live.json"),
      JSON.stringify({
        runId: "legacy-live",
        workflowName: "w",
        status: "running",
        script: "export const meta = { name: 'w', description: 'd' }\nawait agent('x',{label:'x'})\nreturn 1",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );
    writeFileSync(
      join(legacyRunsDir, "legacy-live.lock"),
      JSON.stringify({
        runId: "legacy-live",
        runPath: join(legacyRunsDir, "legacy-live.json"),
        pid: process.pid,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-owner",
      }),
      "utf-8",
    );

    new WorkflowManager({ cwd });

    assert.equal(rp.load("legacy-live")?.status, "running");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "legacy-live.json")), false);
  }),
);

test(
  "WorkflowManager.listRuns is scoped to the bound session and switches with setSessionId",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const run = (runId: string, sessionId: string): PersistedRunState =>
      ({
        runId,
        workflowName: "w",
        status: "completed",
        sessionId,
        phases: [],
        agents: [],
        logs: [],
      }) as PersistedRunState;
    rp.save(run("a", "s1"));
    rp.save(run("b", "s2"));

    const m = new WorkflowManager({ cwd, sessionId: "s1" });
    assert.deepEqual(
      m.listRuns().map((r) => r.runId),
      ["a"],
      "only the bound session's runs are listed",
    );

    m.setSessionId("s2");
    assert.deepEqual(
      m.listRuns().map((r) => r.runId),
      ["b"],
      "switching sessions re-shows that session's runs",
    );

    m.setSessionId(undefined);
    assert.deepEqual(
      m
        .listRuns()
        .map((r) => r.runId)
        .sort(),
      ["a", "b"],
      "unbound lists all runs (legacy/global)",
    );

    // listAllRuns ignores the session binding.
    assert.equal(new WorkflowManager({ cwd, sessionId: "s1" }).listAllRuns().length, 2);
  }),
);
