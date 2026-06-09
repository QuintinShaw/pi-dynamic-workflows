import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { WORKFLOW_SAVED_DIR } from "../src/config.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";

/**
 * Run tests with HOME overridden to a temp directory so the user-level
 * saved workflows directory (~/.pi/workflows/saved) is isolated.
 */
function withIsolatedHome(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ws-"));
    const origHome = process.env.HOME;
    // Create a fake home with .pi/workflows/saved subdir
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
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
  "createWorkflowStorage save creates directory and file",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save({
      name: "test-wf",
      description: "A test workflow",
      script: "export const meta = { name: 'test', description: 'test' }",
    });
    assert.equal(saved.name, "test-wf");
    assert.equal(saved.location, "project");
    assert.ok(saved.path.endsWith("test-wf.json"), "should end with test-wf.json");
    assert.ok(saved.savedAt, "should have savedAt timestamp");
    const dir = join(cwd, WORKFLOW_SAVED_DIR);
    assert.ok(existsSync(dir), "project saved dir should exist");
    assert.ok(existsSync(join(dir, "test-wf.json")), "file should exist");
  }),
);

test(
  "createWorkflowStorage save to user location",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save(
      {
        name: "user-wf",
        description: "User workflow",
        script: "export const meta = { name: 'u', description: 'u' }",
      },
      "user",
    );
    assert.equal(saved.location, "user");
    assert.ok(saved.path.includes(`.pi${sep}workflows${sep}saved`), "should contain .pi/workflows/saved");
  }),
);

test(
  "createWorkflowStorage load returns project workflow (takes precedence)",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({
      name: "shared",
      description: "Project version",
      script: "project script",
    });
    storage.save(
      {
        name: "shared",
        description: "User version",
        script: "user script",
      },
      "user",
    );
    const loaded = storage.load("shared");
    assert.ok(loaded, "should load");
    assert.equal(loaded?.script, "project script", "project should take precedence");
  }),
);

test(
  "createWorkflowStorage load returns null for nonexistent workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const loaded = storage.load("nonexistent");
    assert.equal(loaded, null);
  }),
);

test(
  "createWorkflowStorage load returns user workflow when no project version exists",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save(
      {
        name: "user-only",
        description: "Only in user",
        script: "user script",
      },
      "user",
    );
    const loaded = storage.load("user-only");
    assert.ok(loaded, "should load successfully");
    assert.equal(loaded?.script, "user script");
    assert.equal(loaded?.location, "user");
  }),
);

test(
  "createWorkflowStorage list combines project and user workflows sorted by name",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "b-project", description: "b", script: "b" });
    storage.save({ name: "a-project", description: "a", script: "a" });
    storage.save({ name: "c-user", description: "c", script: "c" }, "user");

    const list = storage.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].name, "a-project");
    assert.equal(list[1].name, "b-project");
    assert.equal(list[2].name, "c-user");
  }),
);

test(
  "createWorkflowStorage list returns empty array when no workflows saved",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const list = storage.list();
    assert.deepEqual(list, []);
  }),
);

test(
  "createWorkflowStorage delete removes project workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "to-delete", description: "d", script: "d" });
    assert.ok(storage.load("to-delete"), "load() should succeed");
    const deleted = storage.delete("to-delete");
    assert.equal(deleted, true);
    assert.equal(storage.load("to-delete"), null);
  }),
);

test(
  "createWorkflowStorage delete returns false for nonexistent",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.equal(storage.delete("no-such"), false);
  }),
);

test(
  "createWorkflowStorage delete removes from one location only",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "both", description: "p", script: "p" });
    storage.save({ name: "both", description: "u", script: "u" }, "user");
    assert.ok(storage.load("both"), "load() should succeed");
    // Delete only from project
    const deleted = storage.delete("both", "project");
    assert.equal(deleted, true);
    // User version should still exist
    const userVersion = storage.load("both");
    assert.ok(userVersion, "user version should still exist");
    assert.equal(userVersion?.location, "user");
  }),
);

test(
  "createWorkflowStorage save preserves parameters",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save({
      name: "param-wf",
      description: "Has params",
      script: "export const meta = { name: 'p', description: 'p' }",
      parameters: {
        input: { type: "string", description: "Input value", required: true },
        limit: { type: "number", description: "Max results", default: 10 },
      },
    });
    assert.ok(saved.parameters, "parameters should be truthy");
    assert.equal(saved.parameters?.input.type, "string");
    assert.equal(saved.parameters?.input.required, true);
    assert.equal(saved.parameters?.limit.default, 10);

    const loaded = storage.load("param-wf");
    assert.deepEqual(loaded?.parameters, saved.parameters);
  }),
);

test(
  "createWorkflowStorage file contents are valid JSON with expected fields",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({
      name: "check-json",
      description: "desc",
      script: "export const meta = { name: 'c', description: 'c' }",
    });
    const filePath = join(cwd, WORKFLOW_SAVED_DIR, "check-json.json");
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(raw.name, "check-json");
    assert.equal(raw.description, "desc");
    assert.equal(raw.script, "export const meta = { name: 'c', description: 'c' }");
    assert.ok(raw.savedAt, "savedAt should be truthy");
    assert.ok(raw.path, "path should be truthy");
  }),
);

test(
  "createWorkflowStorage handles corrupted files gracefully",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const projectDir = join(cwd, WORKFLOW_SAVED_DIR);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "corrupted.json"), "not valid json{{{");

    const loaded = storage.load("corrupted");
    assert.equal(loaded, null, "corrupted file returns null");
    const list = storage.list();
    assert.ok(Array.isArray(list), "list should be an array");
    assert.equal(list.length, 0); // only corrupted file
  }),
);
