import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { describe, it } from "node:test";
import { WORKFLOW_SETTINGS_FILE } from "../src/config.js";
import { getWorkflowSettingsPath, loadWorkflowSettings, saveWorkflowSettings } from "../src/workflow-settings.js";

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

  it("saves and loads keyword trigger preference", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: false }, settingsPath);

      assert.ok(existsSync(settingsPath), "settings file should be created");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { keywordTriggerEnabled: false });
    });
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

  it("ignores corrupt or invalid settings", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, "{not json", "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ keywordTriggerEnabled: "off" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });
});
