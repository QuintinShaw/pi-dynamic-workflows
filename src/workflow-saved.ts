/**
 * Save and load reusable workflow commands.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.js";

export interface SavedWorkflow {
  /** Command name (filename without extension). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** The workflow script. */
  script: string;
  /** Optional parameter schema for parameterized workflows. */
  parameters?: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }>;
  /** Where this workflow is saved. */
  location: "project" | "user";
  /** Full file path. */
  path: string;
  /** When it was saved. */
  savedAt: string;
}

export interface WorkflowStorage {
  /** Save a workflow. */
  save(workflow: Omit<SavedWorkflow, "path" | "savedAt">, location?: "project" | "user"): SavedWorkflow;
  /** Load a workflow by name. */
  load(name: string): SavedWorkflow | null;
  /** List all saved workflows. */
  list(): SavedWorkflow[];
  /** Delete a saved workflow. */
  delete(name: string, location?: "project" | "user"): boolean;
}

export function isSafeSavedWorkflowName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name.trim() === name &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
}

export function assertSafeSavedWorkflowName(name: string): void {
  if (!isSafeSavedWorkflowName(name)) {
    throw new Error("Saved workflow name must be a non-empty path-safe name without slashes.");
  }
}

export function createWorkflowStorage(cwd: string): WorkflowStorage {
  const paths = workflowProjectPaths(cwd);
  const projectDir = paths.savedDir;
  const legacyProjectDir = paths.legacySavedDir;
  const userDir = workflowUserSavedDir();

  const ensureDir = (dir: string) => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  };

  const workflowPath = (name: string, location: "project" | "user") => {
    assertSafeSavedWorkflowName(name);
    const dir = location === "project" ? projectDir : userDir;
    return join(dir, `${name}.json`);
  };
  const legacyProjectWorkflowPath = (name: string) => {
    assertSafeSavedWorkflowName(name);
    return join(legacyProjectDir, `${name}.json`);
  };

  const loadFromFile = (path: string, location: "project" | "user"): SavedWorkflow | null => {
    try {
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (!data || typeof data !== "object" || !isSafeSavedWorkflowName((data as { name?: string }).name ?? "")) {
        return null;
      }
      return {
        ...data,
        location,
        path,
      };
    } catch {
      return null;
    }
  };

  return {
    save(workflow, location = "project") {
      assertSafeSavedWorkflowName(workflow.name);
      const dir = location === "project" ? projectDir : userDir;
      ensureDir(dir);

      const path = workflowPath(workflow.name, location);
      const saved: SavedWorkflow = {
        ...workflow,
        location,
        path,
        savedAt: new Date().toISOString(),
      };

      writeFileSync(path, JSON.stringify(saved, null, 2));
      return saved;
    },

    load(name: string): SavedWorkflow | null {
      if (!isSafeSavedWorkflowName(name)) return null;
      // Project takes precedence over user
      const projectPath = workflowPath(name, "project");
      const project = loadFromFile(projectPath, "project");
      if (project) return project;

      const legacyProject = loadFromFile(legacyProjectWorkflowPath(name), "project");
      if (legacyProject) return legacyProject;

      const userPath = workflowPath(name, "user");
      return loadFromFile(userPath, "user");
    },

    list(): SavedWorkflow[] {
      const workflows: SavedWorkflow[] = [];

      const seen = new Set<string>();
      const addDir = (dir: string, location: "project" | "user") => {
        if (!existsSync(dir)) return;
        for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
          const wf = loadFromFile(join(dir, file), location);
          if (wf && !seen.has(wf.name)) {
            seen.add(wf.name);
            workflows.push(wf);
          }
        }
      };

      // Priority order mirrors load(): project > legacy project > user.
      addDir(projectDir, "project");
      addDir(legacyProjectDir, "project");
      addDir(userDir, "user");

      return workflows.sort((a, b) => a.name.localeCompare(b.name));
    },

    delete(name: string, location?: "project" | "user"): boolean {
      if (!isSafeSavedWorkflowName(name)) return false;
      const locations = location ? [location] : (["project", "user"] as const);
      let deleted = false;

      for (const loc of locations) {
        const path = workflowPath(name, loc);
        if (existsSync(path)) {
          unlinkSync(path);
          deleted = true;
        }
        if (loc === "project") {
          const legacyPath = legacyProjectWorkflowPath(name);
          if (existsSync(legacyPath)) {
            unlinkSync(legacyPath);
            deleted = true;
          }
        }
      }

      return deleted;
    },
  };
}
