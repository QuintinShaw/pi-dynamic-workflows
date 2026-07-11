import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { describe, it } from "node:test";
import { WORKFLOW_SETTINGS_FILE } from "../src/config.js";
import {
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
  saveWorkflowSettingsForCwd,
} from "../src/workflow-settings.js";
import { withFakeHome } from "./helpers/fake-home.js";

function withSettingsPath(fn: (settingsPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-settings-"));
  try {
    fn(join(dir, "nested", "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("workflow settings", () => {
  it("resolves the user-level settings path", () => {
    assert.ok(getWorkflowSettingsPath().endsWith(normalize(WORKFLOW_SETTINGS_FILE)));
  });

  it("returns empty settings when the file is missing", () => {
    withSettingsPath((settingsPath) => {
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("saves and loads keyword trigger preferences", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: false, keywordTriggerWord: "pi-workflow" }, settingsPath);

      assert.ok(existsSync(settingsPath), "settings file should be created");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {
        keywordTriggerEnabled: false,
        keywordTriggerWord: "pi-workflow",
      });
    });
  });

  it("normalizes keyword trigger word settings", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ keywordTriggerWord: "  pi-workflow  " }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { keywordTriggerWord: "pi-workflow" });

      for (const keywordTriggerWord of ["", "   ", "/workflow", "pi workflow", 42, false]) {
        writeFileSync(settingsPath, JSON.stringify({ keywordTriggerWord }), "utf-8");
        assert.deepEqual(loadWorkflowSettings(settingsPath), {});
      }
    });
  });

  it("saves and loads default agent timeout preference", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ defaultAgentTimeoutMs: 600000 }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultAgentTimeoutMs: 600000 });

      saveWorkflowSettings({ defaultAgentTimeoutMs: null }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultAgentTimeoutMs: null });
    });
  });

  it("normalizes default concurrency and agent retries", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 4.9, defaultAgentRetries: 2.8 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultConcurrency: 4, defaultAgentRetries: 2 });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 99, defaultAgentRetries: 99 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultConcurrency: 16, defaultAgentRetries: 3 });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 0, defaultAgentRetries: -1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("merges project settings over global settings when cwd is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        const globalPath = getWorkflowSettingsPath();
        const projectPath = getWorkflowProjectSettingsPath(cwd);
        saveWorkflowSettings({ keywordTriggerEnabled: true, defaultAgentTimeoutMs: 600000 }, globalPath);
        saveWorkflowSettings({ keywordTriggerEnabled: false }, { cwd, settingsPath: globalPath, scope: "project" });

        assert.deepEqual(loadWorkflowSettings(globalPath), {
          keywordTriggerEnabled: true,
          defaultAgentTimeoutMs: 600000,
        });
        assert.deepEqual(loadWorkflowSettings({ cwd, settingsPath: globalPath, projectSettingsPath: projectPath }), {
          keywordTriggerEnabled: false,
          defaultAgentTimeoutMs: 600000,
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves cwd preferences globally without creating a project override", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        saveWorkflowSettingsForCwd({ keywordTriggerEnabled: false }, cwd);

        assert.deepEqual(loadWorkflowSettings({ cwd }), { keywordTriggerEnabled: false });
        assert.equal(existsSync(getWorkflowProjectSettingsPath(cwd)), false);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves cwd preferences into an existing project override", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        saveWorkflowSettings({ keywordTriggerEnabled: false }, { cwd, scope: "project" });

        saveWorkflowSettingsForCwd({ keywordTriggerEnabled: true }, cwd);

        assert.deepEqual(loadWorkflowSettings(), { keywordTriggerEnabled: true });
        assert.deepEqual(loadWorkflowSettings({ cwd }), { keywordTriggerEnabled: true });
        assert.deepEqual(loadWorkflowSettings({ projectSettingsPath: getWorkflowProjectSettingsPath(cwd) }), {
          keywordTriggerEnabled: true,
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves unknown settings when saving known settings", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: true }, settingsPath);
      const current = JSON.parse(readFileSync(settingsPath, "utf-8"));
      writeFileSync(settingsPath, `${JSON.stringify({ ...current, theme: "dark" }, null, 2)}\n`, "utf-8");

      saveWorkflowSettings({ keywordTriggerEnabled: false }, settingsPath);

      assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf-8")), {
        keywordTriggerEnabled: false,
        theme: "dark",
      });
    });
  });

  it("saves and loads the progress panel mode", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ progressPanelMode: "detailed" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMode: "detailed" });

      saveWorkflowSettings({ progressPanelMode: "compact" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMode: "compact" });
    });
  });

  it("rejects an invalid progress panel mode", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ progressPanelMode: "verbose" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("clamps and floors progressPanelMaxAgents into [1, 1000]", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 12.7 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMaxAgents: 12 });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 5000 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMaxAgents: 1000 });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: "8" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("clamps and floors deliveredResultMaxChars into [1, 1000000]", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 250.9 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { deliveredResultMaxChars: 250 });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 5_000_000 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { deliveredResultMaxChars: 1_000_000 });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: "400" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("ignores corrupt or invalid settings", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, "{not json", "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ keywordTriggerEnabled: "off" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ defaultAgentTimeoutMs: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ defaultAgentTimeoutMs: -1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });
});
