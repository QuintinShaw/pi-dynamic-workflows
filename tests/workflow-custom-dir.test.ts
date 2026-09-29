import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getModelTierConfigPath,
  getProjectModelTierConfigPath,
  loadModelTierConfig,
  saveModelTierConfig,
} from "../src/model-tier-config.js";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { workflowProjectKey, workflowProjectPaths, workflowUserSavedDir } from "../src/workflow-paths.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import {
  getProjectLocalWorkflowSettingsPath,
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
} from "../src/workflow-settings.js";

function withCustomAgentDir(fn: (cwd: string, workflowDir: string, projectDir: string) => void): () => void {
  return () => {
    const root = mkdtempSync(join(tmpdir(), "pi-workflow-custom-dir-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    const cwd = join(root, "project");
    const agentDir = join(root, "custom-agent");
    const workflowDir = join(agentDir, "workflows");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      mkdirSync(cwd);
      fn(cwd, workflowDir, join(workflowDir, "projects", workflowProjectKey(cwd)));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "custom agent directory stores settings while preserving project-local and personal override precedence",
  withCustomAgentDir((cwd, workflowDir, projectDir) => {
    const globalPath = join(workflowDir, "settings.json");
    const projectPath = join(projectDir, "settings.json");
    const localPath = join(cwd, ".pi", "workflows", "settings.json");
    // Check destinations before saving so a regression cannot write into the real home.
    assert.equal(getWorkflowSettingsPath(), globalPath);
    assert.equal(getWorkflowProjectSettingsPath(cwd), projectPath);
    assert.equal(getProjectLocalWorkflowSettingsPath(cwd), localPath);

    saveWorkflowSettings({ defaultConcurrency: 2, defaultAgentRetries: 1, keywordTriggerEnabled: false });
    mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
    writeFileSync(localPath, JSON.stringify({ defaultConcurrency: 3, defaultAgentRetries: 2 }));
    saveWorkflowSettings({ defaultConcurrency: 4 }, { cwd, scope: "project" });

    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), {
      defaultConcurrency: 2,
      defaultAgentRetries: 1,
      keywordTriggerEnabled: false,
    });
    assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), { defaultConcurrency: 4 });
    assert.deepEqual(loadWorkflowSettings({ cwd }), {
      defaultConcurrency: 4,
      defaultAgentRetries: 2,
      keywordTriggerEnabled: false,
    });
    assert.equal(loadWorkflowSettings().defaultConcurrency, 2);
  }),
);

test(
  "custom agent directory stores global model tiers and their project overlay",
  withCustomAgentDir((cwd, workflowDir, projectDir) => {
    const globalPath = join(workflowDir, "model-tiers.json");
    const projectPath = join(projectDir, "model-tiers.json");
    assert.equal(getModelTierConfigPath(), globalPath);
    assert.equal(getProjectModelTierConfigPath(cwd), projectPath);

    const globalConfig = { tiers: { small: "test/small", medium: "test/global", big: "test/big" } };
    const projectConfig = { tiers: { medium: "test/project" } };
    saveModelTierConfig(globalConfig);
    saveModelTierConfig(projectConfig, getProjectModelTierConfigPath(cwd));

    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), globalConfig);
    assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), projectConfig);
    assert.deepEqual(loadModelTierConfig(), globalConfig);
    assert.deepEqual(loadModelTierConfig({ cwd }), {
      tiers: { small: "test/small", medium: "test/project", big: "test/big" },
    });
  }),
);

test(
  "custom agent directory stores user and project workflows with project-local fallback",
  withCustomAgentDir((cwd, workflowDir, projectDir) => {
    const userPath = join(workflowDir, "saved", "example.json");
    const projectPath = join(projectDir, "saved", "example.json");
    const legacyDir = join(cwd, ".pi", "workflows", "saved");
    assert.equal(workflowUserSavedDir(), join(workflowDir, "saved"));
    assert.equal(workflowProjectPaths(cwd).savedDir, join(projectDir, "saved"));
    const storage = createWorkflowStorage(cwd);
    const workflow = { name: "example", description: "Example", script: "return 'user'", location: "user" as const };
    assert.equal(storage.save(workflow, "user").path, userPath);
    assert.equal(JSON.parse(readFileSync(userPath, "utf8")).script, workflow.script);
    assert.equal(createWorkflowStorage(cwd).load("example")?.source, "user");

    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "example.json"), JSON.stringify({ ...workflow, script: "return 'legacy'" }));
    assert.equal(storage.load("example")?.source, "legacy");

    assert.equal(storage.save({ ...workflow, script: "return 'project'" }).path, projectPath);
    assert.equal(JSON.parse(readFileSync(projectPath, "utf8")).script, "return 'project'");
    const reopened = createWorkflowStorage(cwd);
    assert.equal(reopened.load("example")?.script, "return 'project'");
    assert.deepEqual(
      reopened.list().map(({ source }) => source),
      ["project"],
    );
  }),
);

test(
  "custom agent directory persists run records, journals and leases while reading legacy project runs",
  withCustomAgentDir((cwd, _workflowDir, projectDir) => {
    const runsDir = join(projectDir, "runs");
    const legacyRunsDir = join(cwd, ".pi", "workflows", "runs");
    const persistence = createRunPersistence(cwd);
    assert.equal(persistence.getRunsDir(), runsDir);
    const state: PersistedRunState = {
      runId: "custom-run",
      workflowName: "example",
      script: "return 42",
      status: "paused",
      phases: [],
      agents: [],
      logs: ["paused"],
      journal: [{ index: 0, hash: "result", result: 42 }],
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    persistence.save(state);
    for (const suffix of [".json", ".json.bak", ".json.events.jsonl"]) {
      assert.ok(existsSync(join(runsDir, `${state.runId}${suffix}`)));
    }
    assert.deepEqual(createRunPersistence(cwd).load(state.runId)?.journal, state.journal);
    assert.equal(existsSync(legacyRunsDir), false);

    const lease = persistence.acquireRunLease(state.runId);
    assert.ok(lease);
    const lockPath = join(runsDir, `${state.runId}.lock`);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).runPath, join(runsDir, `${state.runId}.json`));
    persistence.releaseRunLease(lease);
    assert.equal(existsSync(lockPath), false);

    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(join(legacyRunsDir, "legacy-run.json"), JSON.stringify({ ...state, runId: "legacy-run" }));
    assert.deepEqual(createRunPersistence(cwd).load("legacy-run")?.journal, state.journal);
  }),
);
