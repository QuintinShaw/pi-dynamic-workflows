import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const resumeScript = `export const meta = { name: 'resume-args', description: 'resume args' }
return await agent(JSON.stringify(args), { label: 'capture' })`;

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-resume-args-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-resume-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function persistedRun(runId: string, args: unknown): PersistedRunState {
  const now = new Date().toISOString();
  return {
    runId,
    workflowName: "resume-args",
    script: resumeScript,
    args,
    status: "paused",
    phases: [],
    agents: [],
    logs: [],
    startedAt: now,
    updatedAt: now,
  };
}

function waitForComplete(manager: WorkflowManager, runId: string): Promise<void> {
  return new Promise((resolve) => {
    manager.on("complete", (event: { runId: string }) => {
      if (event.runId === runId) resolve();
    });
  });
}

test(
  "resume(runId, { argsPatch }) safely shallow-merges plain objects, supplied keys win, and persists before execution",
  withTempCwd(async (cwd) => {
    const runId = "resume-safe-patch";
    let prompt = "";
    let persistedAtRunnerStart: unknown;
    let manager!: WorkflowManager;
    manager = new WorkflowManager({
      cwd,
      agent: {
        async run(value: string) {
          prompt = value;
          persistedAtRunnerStart = manager.getPersistence().load(runId)?.args;
          return "ok";
        },
      },
    });
    manager.getPersistence().save(persistedRun(runId, { keep: 1, override: "old" }));
    const completed = waitForComplete(manager, runId);

    assert.equal(await manager.resume(runId, { argsPatch: { override: "new", added: true } }), true);
    await completed;

    const expected = { keep: 1, override: "new", added: true };
    assert.deepEqual(JSON.parse(prompt), expected);
    assert.deepEqual(persistedAtRunnerStart, expected, "the merged args are durable before the runner starts");
    assert.deepEqual(manager.getPersistence().load(runId)?.args, expected);
  }),
);

test(
  "resume(runId) keeps the existing no-patch behavior even for non-object persisted args",
  withTempCwd(async (cwd) => {
    const runId = "resume-no-patch";
    let prompt = "";
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(value: string) {
          prompt = value;
          return "ok";
        },
      },
    });
    manager.getPersistence().save(persistedRun(runId, ["legacy", 1]));
    const completed = waitForComplete(manager, runId);

    assert.equal(await manager.resume(runId), true);
    await completed;
    assert.deepEqual(JSON.parse(prompt), ["legacy", 1]);
  }),
);

test(
  "resume script plus args replaces persisted input and rejects simultaneous argsPatch",
  withTempCwd(async (cwd) => {
    const runId = "resume-replace-input";
    const prompts: string[] = [];
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(value: string) {
          prompts.push(value);
          return "ok";
        },
      },
    });
    manager.getPersistence().save(persistedRun(runId, { old: true }));
    const editedScript = `export const meta = { name: 'resume-args', description: 'edited' }
return await agent('edited:' + JSON.stringify(args), { label: 'capture' })`;
    const completed = waitForComplete(manager, runId);

    assert.equal(await manager.resume(runId, { script: editedScript, args: ["replacement"] }), true);
    await completed;
    assert.deepEqual(prompts, ['edited:["replacement"]']);
    assert.equal(manager.getPersistence().load(runId)?.script, editedScript);
    assert.deepEqual(manager.getPersistence().load(runId)?.args, ["replacement"]);

    const otherRunId = "resume-mutually-exclusive";
    manager.getPersistence().save(persistedRun(otherRunId, { old: true }));
    await assert.rejects(
      () => manager.resume(otherRunId, { args: { replacement: true }, argsPatch: { patch: true } }),
      /mutually exclusive/,
    );
    assert.equal(manager.getPersistence().load(otherRunId)?.status, "paused");
  }),
);

test(
  "resume argsPatch rejects arrays, null, non-objects, and prototype-pollution keys before execution",
  withTempCwd(async (cwd) => {
    const runId = "resume-invalid-patch";
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          calls++;
          return "unexpected";
        },
      },
    });
    manager.getPersistence().save(persistedRun(runId, { existing: true }));

    const customPrototype = Object.create({ polluted: true }) as Record<string, unknown>;
    customPrototype.safe = true;
    const invalidPatches: unknown[] = [
      null,
      [],
      "value",
      42,
      customPrototype,
      JSON.parse('{"__proto__":{"polluted":true}}'),
      { constructor: { prototype: { polluted: true } } },
      { prototype: { polluted: true } },
    ];

    for (const patch of invalidPatches) {
      await assert.rejects(
        () => manager.resume(runId, { argsPatch: patch as never }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
          assert.equal(error.message, "resume argsPatch must be a safe plain object");
          return true;
        },
      );
    }
    assert.equal(calls, 0);
    assert.equal(manager.getPersistence().load(runId)?.status, "paused");
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  }),
);

test(
  "resume argsPatch recursively rejects lossy JSON values before persistence or execution",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          calls++;
          return "unexpected";
        },
      },
    });
    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    customPrototype.value = "own";
    const sparse = Array(2) as unknown[];
    sparse[1] = "present";
    const customArray = [] as unknown[];
    Object.setPrototypeOf(customArray, Object.create(Array.prototype));
    const spoofPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(spoofPrototype, "constructor", { value: Object, enumerable: false });
    spoofPrototype.toJSON = () => ({ spoofed: true });
    const spoofedObject = Object.create(spoofPrototype) as Record<string, unknown>;
    spoofedObject.safe = true;
    const lossyPatches: Record<string, unknown>[] = [
      { nested: { omitted: undefined } },
      { nested: { callable: () => true } },
      { nested: { invalidNumber: Number.NaN } },
      { nested: { invalidNumber: Number.POSITIVE_INFINITY } },
      { nested: customPrototype },
      { nested: sparse },
      { nested: customArray },
      { nested: spoofedObject },
    ];

    for (const [index, patch] of lossyPatches.entries()) {
      const runId = `resume-lossy-${index}`;
      manager.getPersistence().save(persistedRun(runId, { existing: true }));
      await assert.rejects(
        () => manager.resume(runId, { argsPatch: patch }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
          assert.equal(error.message, "resume argsPatch must contain only plain JSON values");
          return true;
        },
      );
      assert.deepEqual(manager.getPersistence().load(runId)?.args, { existing: true });
      assert.equal(manager.getPersistence().load(runId)?.status, "paused");
    }
    assert.equal(calls, 0);
  }),
);

test(
  "resume argsPatch rejects incompatible persisted args before execution",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          calls++;
          return "unexpected";
        },
      },
    });

    for (const [index, args] of [null, [], "legacy", 1].entries()) {
      const runId = `resume-incompatible-${index}`;
      manager.getPersistence().save(persistedRun(runId, args));
      await assert.rejects(
        () => manager.resume(runId, { argsPatch: { added: true } }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
          assert.equal(error.message, "persisted workflow args are incompatible with argsPatch");
          return true;
        },
      );
      assert.equal(manager.getPersistence().load(runId)?.status, "paused");
    }
    assert.equal(calls, 0);
  }),
);
