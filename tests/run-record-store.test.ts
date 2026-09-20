import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsModule, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  type WriteFileOptions,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WORKFLOW_RUNS_DIR } from "../src/config.js";
import { defaultPersistenceFs, type PersistenceFsLayer } from "../src/fs-persistence.js";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { createRunRecordStore } from "../src/run-record-store.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function withFixture(fn: (cwd: string) => Promise<void> | void) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-record-store-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-record-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function state(runId: string, journal: PersistedRunState["journal"] = []): PersistedRunState {
  return {
    runId,
    workflowName: "record-store-test",
    script: "export const meta = { name: 'record-store-test', description: 'test' }",
    args: { runId },
    status: "completed",
    phases: [],
    agents: [],
    logs: [],
    journal,
    startedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}

function fsWith(overrides: Partial<PersistenceFsLayer>): PersistenceFsLayer {
  return { ...defaultPersistenceFs(), ...overrides };
}

function bytesOf(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
}

test(
  "growing journal append writes stay close to linear rather than rewriting the full record",
  withFixture((cwd) => {
    const path = join(cwd, "run.json");
    let writeBytes = 0;
    const real = defaultPersistenceFs();
    const fs = fsWith({
      writeFileSync: ((file, data, options?: WriteFileOptions) => {
        writeBytes += bytesOf(data as string | Uint8Array);
        return real.writeFileSync(file, data as never, options as never);
      }) as PersistenceFsLayer["writeFileSync"],
    });
    const store = createRunRecordStore(fs);
    mkdirSync(cwd, { recursive: true });
    let bytesAt200 = 0;
    let current = state("growth");
    for (let i = 0; i < 400; i++) {
      current = {
        ...current,
        journal: [...(current.journal ?? []), { index: i, hash: `hash-${i}`, result: "x".repeat(2048) }],
      };
      store.save(path, current);
      if (i === 199) bytesAt200 = writeBytes;
    }
    assert.ok(bytesAt200 > 0);
    assert.ok(writeBytes / bytesAt200 < 2.5, `400-entry writes must stay subquadratic: ${writeBytes}/${bytesAt200}`);
  }),
);

test(
  "a committed head remains authoritative after append succeeds but head rename fails, then retry drops the tail",
  withFixture(async (cwd) => {
    const path = join(cwd, "run.json");
    const real = defaultPersistenceFs();
    let headRenames = 0;
    const fs = fsWith({
      renameSync: ((from, to) => {
        if (String(from) === `${path}.tmp` && String(to) === path && ++headRenames === 2)
          throw new Error("injected head rename failure");
        return real.renameSync(from, to);
      }) as PersistenceFsLayer["renameSync"],
    });
    const store = createRunRecordStore(fs);
    const first = state("commit-boundary", [{ index: 0, hash: "h0", result: "old" }]);
    store.save(path, first);
    const failed = { ...first, journal: [...(first.journal ?? []), { index: 1, hash: "h1", result: "tail" }] };
    assert.throws(() => store.save(path, failed), /injected head rename failure/);

    assert.deepEqual(store.read(path)?.journal, first.journal, "same instance must expose only the old committed head");
    const cold = createRunRecordStore(defaultPersistenceFs());
    assert.deepEqual(cold.read(path)?.journal, first.journal, "cold reader must ignore the uncommitted tail");

    const retried = { ...first, journal: [...(first.journal ?? []), { index: 1, hash: "h1", result: "retry" }] };
    store.save(path, retried);
    assert.deepEqual(createRunRecordStore(defaultPersistenceFs()).read(path)?.journal, retried.journal);
  }),
);

test(
  "truncating or modifying committed events causes load to fail closed",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const truncatedId = "truncated-events";
    rp.save(state(truncatedId, [{ index: 0, hash: "h", result: "value" }]));
    const truncatedLog = join(runsDir, `${truncatedId}.json.events.jsonl`);
    truncateSync(truncatedLog, statSync(truncatedLog).size - 1);
    assert.equal(createRunPersistence(cwd).load(truncatedId), null);

    const modifiedId = "modified-events";
    rp.save(state(modifiedId, [{ index: 0, hash: "h", result: "value" }]));
    const modifiedLog = join(runsDir, `${modifiedId}.json.events.jsonl`);
    const raw = readFileSync(modifiedLog, "utf8");
    writeFileSync(modifiedLog, raw.replace("value", "tampered"), "utf8");
    assert.equal(createRunPersistence(cwd).load(modifiedId), null);
  }),
);

test(
  "legacy complete JSON loads and first save migrates without losing journal, script, or args",
  withFixture((cwd) => {
    const legacyDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyDir, { recursive: true });
    const legacy = state("legacy-migrate", [{ index: 0, hash: "legacy", result: { ok: true } }]);
    writeFileSync(join(legacyDir, `${legacy.runId}.json`), JSON.stringify(legacy), "utf8");
    const rp = createRunPersistence(cwd);
    const loaded = rp.load(legacy.runId);
    assert.deepEqual(loaded?.journal, legacy.journal);
    assert.equal(loaded?.script, legacy.script);
    assert.deepEqual(loaded?.args, legacy.args);

    assert.ok(loaded);
    rp.save({ ...loaded, status: "paused" });
    const migratedPath = join(workflowProjectPaths(cwd).runsDir, `${legacy.runId}.json`);
    assert.ok(existsSync(migratedPath));
    const migrated = createRunPersistence(cwd).load(legacy.runId);
    assert.deepEqual(migrated?.journal, legacy.journal);
    assert.equal(migrated?.script, legacy.script);
    assert.deepEqual(migrated?.args, legacy.args);
  }),
);

test(
  "fresh list and manager construction avoid opening 100 event logs; detail access hydrates one",
  withFixture(async (cwd) => {
    const rp = createRunPersistence(cwd);
    for (let i = 0; i < 100; i++) rp.save(state(`terminal-${i}`, [{ index: 0, hash: `${i}`, result: `result-${i}` }]));

    let opens = 0;
    const real = defaultPersistenceFs();
    const fs = fsWith({
      openSync: ((...args) => {
        opens++;
        return real.openSync(...args);
      }) as PersistenceFsLayer["openSync"],
    });
    const fresh = createRunPersistence(cwd, fs);
    const listed = fresh.list();
    assert.equal(listed.length, 100);
    assert.equal(opens, 0, "list must read heads/previews without opening event logs");

    const { WorkflowManager } = await import("../src/workflow-manager.js");
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.listAllRuns().length, 100, "manager construction/list must retain all terminal previews");

    assert.equal((listed[0]?.journal ?? [])[0]?.result, `result-${listed[0]?.runId.split("-")[1]}`);
    assert.ok(opens > 0, "detail access must hydrate the selected event log");
  }),
);

test(
  "metadata marker updates set and clear without opening events, and mismatched delivery IDs preserve the marker",
  withFixture((cwd) => {
    const opens = { count: 0 };
    const real = defaultPersistenceFs();
    const fs = fsWith({
      openSync: ((...args) => {
        opens.count++;
        return real.openSync(...args);
      }) as PersistenceFsLayer["openSync"],
    });
    const rp = createRunPersistence(cwd, fs);
    const runId = "metadata-marker";
    rp.save(state(runId));
    opens.count = 0;
    assert.equal(
      rp.updateMetadata?.(runId, { pendingDelivery: { kind: "text", text: "hello", deliveryId: "d1" } }),
      true,
    );
    assert.equal(opens.count, 0, "setting metadata must not hydrate the event log");
    assert.equal(rp.load(runId)?.pendingDelivery?.deliveryId, "d1");
    opens.count = 0;

    assert.equal(rp.updateMetadata?.(runId, { pendingDelivery: undefined }, "wrong"), false);
    assert.equal(opens.count, 0, "mismatched clear must not hydrate the event log");
    assert.equal(rp.load(runId)?.pendingDelivery?.deliveryId, "d1");
    opens.count = 0;

    assert.equal(rp.updateMetadata?.(runId, { pendingDelivery: undefined }, "d1"), true);
    assert.equal(opens.count, 0, "clearing metadata must not hydrate the event log");
    assert.equal(rp.load(runId)?.pendingDelivery, undefined);
  }),
);

test(
  "delete removes the head, backup, tmp, and event log and then load returns null",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "delete-record-store";
    rp.save(state(runId));
    const path = join(workflowProjectPaths(cwd).runsDir, `${runId}.json`);
    writeFileSync(`${path}.tmp`, "stale tmp", "utf8");
    assert.ok(existsSync(path));
    assert.ok(existsSync(`${path}.bak`));
    assert.ok(existsSync(`${path}.events.jsonl`));
    assert.equal(rp.delete(runId), true);
    for (const candidate of [path, `${path}.bak`, `${path}.tmp`, `${path}.events.jsonl`])
      assert.equal(existsSync(candidate), false, `${candidate} should be deleted`);
    assert.equal(rp.load(runId), null);
  }),
);

test(
  "cache evicts old records after eight entries and caller mutation never poisons cached state",
  withFixture(async (cwd) => {
    const real = defaultPersistenceFs();
    const paths = Array.from({ length: 10 }, (_, i) => join(cwd, `cache-${i}.json`));
    const writer = createRunRecordStore(real);
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      assert.ok(path);
      writer.save(path, state(`cache-${i}`, [{ index: 0, hash: `${i}`, result: `v${i}` }]));
    }

    let opens = 0;
    const fs = fsWith({
      openSync: ((...args) => {
        opens++;
        return real.openSync(...args);
      }) as PersistenceFsLayer["openSync"],
    });
    const store = createRunRecordStore(fs);
    const firstPath = paths[0];
    assert.ok(firstPath);
    const first = store.read(firstPath);
    assert.ok(first);
    first.script = "caller mutation";
    first.journal?.push({ index: 99, hash: "caller", result: "caller" });
    const unchanged = store.read(firstPath);
    assert.ok(unchanged);
    assert.notEqual(unchanged.script, "caller mutation");
    assert.equal(unchanged.journal?.length, 1);
    opens = 0;
    for (let i = 1; i < paths.length; i++) {
      const path = paths[i];
      assert.ok(path);
      store.read(path);
    }
    opens = 0;
    assert.equal(store.read(firstPath)?.script, state("cache-0").script);
    assert.ok(opens > 0, "the oldest entry must be rehydrated after cache capacity is exceeded");
  }),
);

test(
  "save input mutation after commit does not alter a previously committed record",
  withFixture(async (cwd) => {
    const path = join(cwd, "input-isolation.json");
    const store = createRunRecordStore(defaultPersistenceFs());
    const input = state("input-isolation", [{ index: 0, hash: "h", result: { original: true } }]);
    store.save(path, input);
    input.script = "mutated after save";
    input.args = { changed: true };
    const firstEntry = input.journal?.[0];
    assert.ok(firstEntry);
    firstEntry.result = { changed: true };
    const loaded = createRunRecordStore(defaultPersistenceFs()).read(path);
    assert.equal(loaded?.script, "export const meta = { name: 'record-store-test', description: 'test' }");
    assert.deepEqual(loaded?.args, { runId: "input-isolation" });
    assert.deepEqual(loaded?.journal?.[0]?.result, { original: true });
  }),
);

test(
  "startup recovery and metadata routing never open historical event logs",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    for (let i = 0; i < 30; i++) rp.save(state(`history-${i}`, [{ index: 0, hash: "h", result: "x".repeat(65536) }]));
    rp.save({
      ...state("orphan", [{ index: 0, hash: "paid", result: "PAID_RESULT" }]),
      status: "running",
      sessionId: "old",
      agents: [{ id: 1, label: "interrupted", prompt: "p", status: "running" }],
      pendingDelivery: { kind: "complete", deliveryId: "pending" },
    });
    const original = fsModule.openSync;
    let opens = 0;
    fsModule.openSync = ((path, ...args) => {
      if (String(path).endsWith(".events.jsonl") && args[0] === "r") opens++;
      return original(path, ...args);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      const manager = new WorkflowManager({ cwd, sessionId: "old" });
      assert.equal(manager.listAllRuns().length, 31);
      manager.adoptLiveRunsToSession("new", "old");
      manager.recordAutoResumeAttempts("orphan", 2);
      assert.equal(opens, 0, "startup, ownership and counter updates must only read index heads");
    } finally {
      fsModule.openSync = original;
      syncBuiltinESMExports();
    }
    const recovered = createRunPersistence(cwd).load("orphan");
    assert.equal(recovered?.status, "paused");
    assert.equal(recovered?.agents[0].status, "skipped");
    assert.equal(recovered?.agents[0].error, "interrupted");
    assert.equal(recovered?.journal?.[0].result, "PAID_RESULT");
    assert.equal(recovered?.sessionId, "new");
    assert.equal(recovered?.autoResumeAttempts, 2);
  }),
);

test(
  "live writer mutex refuses a second writer and releases after failure",
  withFixture((cwd) => {
    const first = createRunPersistence(cwd);
    first.save(state("mutex"));
    const lock = join(first.getRunsDir(), "mutex.json.write-lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "foreign" }));
    assert.throws(() => first.save({ ...state("mutex"), script: "must not commit" }), /EEXIST/);
    assert.equal(first.load("mutex")?.script, state("mutex").script);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "foreign");
  }),
);

test(
  "cached reads reject a tampered commit hash and unsupported future heads",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("tampered-head"));
    const path = join(rp.getRunsDir(), "tampered-head.json");
    const head = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...head, hash: "invalid" }));
    assert.equal(rp.load("tampered-head"), null);
    writeFileSync(path, JSON.stringify({ ...head, format: "pi-workflow-run-v99" }));
    assert.equal(rp.load("tampered-head"), null);
    assert.throws(() => rp.save(state("tampered-head")), /Unsupported/);
  }),
);

test(
  "large pending text stays out of index heads and is read only for delivery",
  withFixture((cwd) => {
    const text = "large error details ".repeat(10000);
    const rp = createRunPersistence(cwd);
    rp.save({ ...state("large-marker"), pendingDelivery: { kind: "text", text, deliveryId: "marker" } });
    const head = readFileSync(join(rp.getRunsDir(), "large-marker.json"), "utf8");
    assert.ok(head.length < 5000);
    assert.ok(!head.includes("large error details"));
    let opens = 0;
    const real = defaultPersistenceFs();
    const fresh = createRunPersistence(cwd, {
      openSync: ((...args) => {
        opens++;
        return real.openSync(...args);
      }) as typeof real.openSync,
    });
    const marker = fresh.list()[0].pendingDelivery;
    assert.equal(marker?.deliveryId, "marker");
    assert.equal(opens, 0);
    assert.equal(marker?.kind === "text" ? marker.text : undefined, text);
    assert.equal(opens, 1);
  }),
);

test(
  "result artifacts remain directly readable and are removed with their run",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("export"));
    const result = { longAnswer: "result ".repeat(2000) };
    const path = rp.exportResult?.("export", result);
    assert.ok(path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { runId: "export", result });
    assert.equal(rp.exportResult?.("export", result), path);
    assert.equal(rp.list().length, 1, "artifacts are not indexed as additional runs");
    assert.equal(rp.delete("export"), true);
    assert.equal(existsSync(path), false);
    assert.throws(() => rp.exportResult?.("export", result), /disappeared/);
  }),
);

test(
  "object cell changes preserve removals, arrays, null and phase budgets",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    const first = {
      ...state("object-cells"),
      args: { a: 1, b: [1, 2] },
      phaseBudgets: { a: { budget: 10, startSpent: 0 } },
    };
    rp.save(first);
    rp.save({
      ...first,
      args: { b: null, c: "new" },
      phaseBudgets: { ...first.phaseBudgets, b: { budget: 20, startSpent: 4 } },
    });
    const next = createRunPersistence(cwd).load(first.runId);
    assert.deepEqual(next?.args, { b: null, c: "new" });
    assert.deepEqual(next?.phaseBudgets, { a: { budget: 10, startSpent: 0 }, b: { budget: 20, startSpent: 4 } });
    const events = readFileSync(join(rp.getRunsDir(), `${first.runId}.json.events.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(Object.keys(events[1].delta.objects.phaseBudgets.set), ["b"]);
  }),
);

test(
  "dead writer reclamation excludes a concurrent reaper and recovers a dead reaper",
  withFixture((cwd) => {
    const real = defaultPersistenceFs();
    const base = createRunPersistence(cwd);
    base.save(state("reapers"));
    const lock = join(base.getRunsDir(), "reapers.json.write-lock");
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "dead" }));
    const guard = `${lock}.reap-${createHash("sha256").update(`${lock}\0dead`).digest("hex")}`;
    writeFileSync(guard, JSON.stringify({ pid: 2147483647, token: "dead-reaper" }));
    let tested = false;
    const first = createRunPersistence(cwd, {
      linkSync: ((from, to) => {
        real.linkSync(from, to);
        if (String(to) === guard && !tested) {
          tested = true;
          assert.throws(() => base.save(state("reapers")), /EEXIST/);
          assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "dead");
        }
      }) as typeof real.linkSync,
    });
    first.save({ ...state("reapers"), script: "recovered" });
    assert.ok(tested);
    assert.equal(base.load("reapers")?.script, "recovered");
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(guard), false);
  }),
);

test(
  "a stale observation cannot remove a newly claimed live writer mutex",
  withFixture((cwd) => {
    const real = defaultPersistenceFs();
    const base = createRunPersistence(cwd);
    base.save(state("replacement-owner"));
    const lock = join(base.getRunsDir(), "replacement-owner.json.write-lock");
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "stale" }));
    let replaced = false;
    const contender = createRunPersistence(cwd, {
      linkSync: ((from, to) => {
        if (String(to).startsWith(`${lock}.reap-`) && !replaced) {
          replaced = true;
          // Another writer reclaimed and claimed the original lock while this
          // contender was paused after reading its old dead-owner identity.
          writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "new-live-owner" }));
        }
        real.linkSync(from, to);
      }) as typeof real.linkSync,
    });
    assert.throws(() => contender.save(state("replacement-owner")), /EEXIST/);
    assert.ok(replaced);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "new-live-owner");
  }),
);
