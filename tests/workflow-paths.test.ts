import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import { describe, it } from "node:test";
import {
  WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_PROJECTS_SUBDIR,
  workflowHomeDir,
  workflowProjectKey,
  workflowProjectPaths,
  workflowUserSavedDir,
} from "../src/workflow-paths.js";

function withIsolatedHome(fn: (home: string, cwd: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-project-"));
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fn(home, cwd);
  } finally {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("workflow paths", () => {
  it("resolves workflow home under the user home", () => {
    withIsolatedHome((home) => {
      assert.equal(workflowHomeDir(), join(home, WORKFLOW_HOME_RELATIVE_DIR));
      assert.equal(workflowUserSavedDir(), join(home, WORKFLOW_HOME_RELATIVE_DIR, "saved"));
    });
  });

  it("creates stable project namespaces from cwd", () => {
    withIsolatedHome((_home, cwd) => {
      const key = workflowProjectKey(cwd);
      assert.equal(key, workflowProjectKey(cwd));
      assert.match(key, /^[a-z0-9._-]+-[a-f0-9]{12}$/);
      assert.ok(key.startsWith(basename(cwd).toLowerCase()));
    });
  });

  it("keeps new project storage under workflow home and legacy paths under cwd", () => {
    withIsolatedHome((home, cwd) => {
      const paths = workflowProjectPaths(cwd);
      assert.ok(paths.rootDir.startsWith(join(home, WORKFLOW_HOME_RELATIVE_DIR, WORKFLOW_PROJECTS_SUBDIR)));
      assert.equal(paths.runsDir, join(paths.rootDir, "runs"));
      assert.equal(paths.savedDir, join(paths.rootDir, "saved"));
      assert.equal(paths.settingsPath, join(paths.rootDir, "settings.json"));
      assert.equal(paths.legacyRunsDir, normalize(join(cwd, ".pi/workflows/runs")));
      assert.equal(paths.legacySavedDir, normalize(join(cwd, ".pi/workflows/saved")));
    });
  });
});
