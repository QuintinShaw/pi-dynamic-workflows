/**
 * Save and load reusable workflow commands.
 */

import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ensureDir as ensureDirFs,
  listJsonFilesSafe,
  type PersistenceFsLayer,
  readJsonWithBackupRecovery,
  resolvePersistenceFs,
  writeJsonAtomicWithBackup,
  writeJsonAtomicWithBackupStrict,
} from "./fs-persistence.js";
import { workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.js";

export type SavedWorkflowSource = "project" | "legacy" | "user";

export interface SavedWorkflow {
  /** Command name (filename without extension). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** The workflow script. Filled from a sibling `scriptPath` when that field is used instead of an inline script. */
  script: string;
  /** Optional parameter schema for parameterized workflows. */
  parameters?: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }>;
  /** Display location retained for compatibility with existing callers. */
  location: "project" | "user";
  /** Exact persistence tier that supplied this row. */
  source: SavedWorkflowSource;
  /** Full file path. This is part of the row's identity, not display metadata. */
  path: string;
  /** When it was saved. */
  savedAt: string;
}

export type SavedWorkflowMutationResult =
  | { ok: true; workflow?: SavedWorkflow }
  | {
      ok: false;
      code: "missing" | "stale" | "conflict" | "invalid" | "io-error";
      message: string;
    };

/** Stable content fingerprint used to guard mutations against same-path races. */
export function savedWorkflowRevision(
  workflow: Pick<SavedWorkflow, "name" | "description" | "script" | "parameters" | "savedAt">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: workflow.name,
        description: workflow.description,
        script: workflow.script,
        parameters: workflow.parameters ?? null,
        savedAt: workflow.savedAt,
      }),
    )
    .digest("hex");
}

export interface WorkflowStorage {
  /** Save a workflow. New saves default to the current project tier. */
  save(workflow: Omit<SavedWorkflow, "path" | "savedAt" | "source">, location?: "project" | "user"): SavedWorkflow;
  /** Load a workflow by name according to project > legacy > user precedence. */
  load(name: string): SavedWorkflow | null;
  /** List visible workflows, one highest-precedence row per command name. */
  list(): SavedWorkflow[];
  /** Delete precisely the source represented by the visible row. */
  delete(workflow: SavedWorkflow | string, location?: "project" | "user"): SavedWorkflowMutationResult | boolean;
  /** Rename precisely the source represented by the visible row. */
  rename(workflow: SavedWorkflow, name: string): SavedWorkflowMutationResult;
}

/**
 * Saved workflow names are Pi slash-command names as well as filenames. Keep the
 * validation in one place so `/workflows save`, rename, and command registration
 * have the same reachability boundary. Whitespace, controls, Unicode format
 * characters (including bidi controls), and path separators never form a safe
 * command/file identity.
 */
export function isSafeSavedWorkflowName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name.trim() === name &&
    !/[\s/\\\0]/u.test(name) &&
    !/[\p{Cc}\p{Cf}]/u.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

export function assertSafeSavedWorkflowName(name: string): void {
  if (!isSafeSavedWorkflowName(name)) {
    throw new Error(
      "Saved workflow name must be a non-empty path-safe name usable as a slash command, without whitespace, controls, or paths.",
    );
  }
}

/**
 * Resolve a saved-workflow `scriptPath` against that workflow's own saved
 * directory. Returns the resolved file path, or null if the value is empty,
 * absolute, contains NUL, or would escape the directory.
 */
export function resolveSavedScriptPath(savedDir: string, scriptPath: string): string | null {
  if (typeof scriptPath !== "string") return null;
  if (scriptPath.length === 0 || scriptPath.trim().length === 0 || scriptPath.includes("\0")) return null;
  if (isAbsolute(scriptPath)) return null;
  const asPosix = scriptPath.replace(/\\/g, "/");
  if (asPosix.startsWith("/") || /^[a-zA-Z]:/.test(asPosix)) return null;
  const resolved = resolve(savedDir, scriptPath);
  const rel = relative(resolve(savedDir), resolved);
  if (rel === "") return null;
  if (isAbsolute(rel)) return null;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return resolved;
}

export function createWorkflowStorage(cwd: string, fsOverride?: Partial<PersistenceFsLayer>): WorkflowStorage {
  const fs = resolvePersistenceFs(fsOverride);
  const paths = workflowProjectPaths(cwd);
  const dirs: Record<SavedWorkflowSource, string> = {
    project: paths.savedDir,
    legacy: paths.legacySavedDir,
    user: workflowUserSavedDir(),
  };

  const ensureDir = (dir: string) => ensureDirFs(fs, dir);
  const locationFor = (source: SavedWorkflowSource): "project" | "user" => (source === "user" ? "user" : "project");
  const sourcePath = (name: string, source: SavedWorkflowSource): string => {
    assertSafeSavedWorkflowName(name);
    return join(dirs[source], `${name}.json`);
  };
  const sourceFor = (workflow: SavedWorkflow): SavedWorkflowSource => {
    if (workflow.source === "project" || workflow.source === "legacy" || workflow.source === "user")
      return workflow.source;
    // Defensive compatibility for records supplied by older callers. Real rows
    // always carry source and are still checked against their exact path below.
    if (workflow.path.startsWith(dirs.legacy)) return "legacy";
    return workflow.location === "user" ? "user" : "project";
  };
  const loadFromFile = (path: string, source: SavedWorkflowSource): SavedWorkflow | null => {
    const data = readJsonWithBackupRecovery<Record<string, unknown>>(fs, path);
    if (!data || typeof data !== "object" || !isSafeSavedWorkflowName((data as { name?: string }).name ?? ""))
      return null;
    const raw = data as Record<string, unknown>;
    const { scriptPath: rawScriptPath, ...rest } = raw;
    let script = rest.script;
    if (!Object.hasOwn(raw, "script") && typeof rawScriptPath === "string") {
      const resolved = resolveSavedScriptPath(dirname(path), rawScriptPath);
      if (!resolved) return null;
      try {
        script = fs.readFileSync(resolved, "utf-8");
      } catch {
        return null;
      }
    }
    return {
      ...(rest as Omit<SavedWorkflow, "location" | "source" | "path">),
      script: script as string,
      location: locationFor(source),
      source,
      path,
    };
  };
  const hasRecord = (path: string): boolean => {
    try {
      return fs.existsSync(path) || fs.existsSync(`${path}.bak`);
    } catch {
      return true; // unreadable means do not overwrite something we cannot verify
    }
  };
  type ExactCurrentResult = Exclude<SavedWorkflowMutationResult, { ok: true }> | { ok: true; workflow: SavedWorkflow };
  const exactCurrent = (workflow: SavedWorkflow): ExactCurrentResult => {
    const source = sourceFor(workflow);
    let expected: string;
    try {
      expected = sourcePath(workflow.name, source);
    } catch (error) {
      return { ok: false, code: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
    if (workflow.path !== expected) {
      return {
        ok: false,
        code: "stale",
        message: "Saved workflow source changed; refresh the navigator before retrying.",
      };
    }
    const current = loadFromFile(expected, source);
    if (!current) {
      return hasRecord(expected)
        ? { ok: false, code: "stale", message: "Saved workflow source is unreadable or no longer valid." }
        : { ok: false, code: "missing", message: "Saved workflow no longer exists." };
    }
    if (
      current.source !== source ||
      current.name !== workflow.name ||
      savedWorkflowRevision(current) !== savedWorkflowRevision(workflow)
    ) {
      return { ok: false, code: "stale", message: "Saved workflow changed; refresh the navigator before retrying." };
    }
    return { ok: true, workflow: current };
  };
  type FileSnapshot = { path: string; existed: boolean; contents?: string };
  const snapshotFile = (path: string): FileSnapshot => {
    const existed = fs.existsSync(path);
    return existed ? { path, existed, contents: fs.readFileSync(path, "utf-8") } : { path, existed };
  };
  const restoreFile = (snapshot: FileSnapshot): void => {
    if (snapshot.existed) fs.writeFileSync(snapshot.path, snapshot.contents ?? "");
    else if (fs.existsSync(snapshot.path)) fs.unlinkSync(snapshot.path);
  };
  const cleanupTarget = (path: string): void => {
    // Failure injection is intentionally transient. Retry cleanup so a failed
    // transaction cannot leave a target that blocks the next attempt.
    for (const candidate of [`${path}.tmp`, path, `${path}.bak`]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!fs.existsSync(candidate)) break;
          fs.unlinkSync(candidate);
          break;
        } catch {
          if (attempt === 1) break;
        }
      }
    }
  };
  const removeSource = (path: string): SavedWorkflowMutationResult => {
    let primary: FileSnapshot;
    let backup: FileSnapshot;
    try {
      primary = snapshotFile(path);
      backup = snapshotFile(`${path}.bak`);
    } catch (error) {
      return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
    }
    if (!primary.existed && !backup.existed)
      return { ok: false, code: "missing", message: "Saved workflow no longer exists." };
    try {
      // Remove recovery first. If primary removal fails, restore the sidecar so
      // neither deletion nor a later recovery read can observe a half-state.
      if (backup.existed) fs.unlinkSync(backup.path);
      if (primary.existed) fs.unlinkSync(primary.path);
      return { ok: true };
    } catch (error) {
      try {
        restoreFile(primary);
        restoreFile(backup);
      } catch {
        // Preserve the original I/O error; the source is restored when the
        // injected failure is transient, and retry remains safe either way.
      }
      return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    save(workflow, location = "project") {
      assertSafeSavedWorkflowName(workflow.name);
      const source: SavedWorkflowSource = location === "user" ? "user" : "project";
      ensureDir(dirs[source]);
      const path = sourcePath(workflow.name, source);
      const saved: SavedWorkflow = {
        ...workflow,
        location,
        source,
        path,
        savedAt: new Date().toISOString(),
      };
      writeJsonAtomicWithBackup(fs, path, saved);
      return saved;
    },

    load(name: string): SavedWorkflow | null {
      if (!isSafeSavedWorkflowName(name)) return null;
      return (
        loadFromFile(sourcePath(name, "project"), "project") ??
        loadFromFile(sourcePath(name, "legacy"), "legacy") ??
        loadFromFile(sourcePath(name, "user"), "user")
      );
    },

    list(): SavedWorkflow[] {
      const workflows: SavedWorkflow[] = [];
      const seen = new Set<string>();
      const addDir = (source: SavedWorkflowSource) => {
        for (const file of listJsonFilesSafe(fs, dirs[source])) {
          const workflow = loadFromFile(join(dirs[source], file), source);
          if (workflow && !seen.has(workflow.name)) {
            seen.add(workflow.name);
            workflows.push(workflow);
          }
        }
      };
      addDir("project");
      addDir("legacy");
      addDir("user");
      return workflows.sort((a, b) => a.name.localeCompare(b.name));
    },

    delete(workflow: SavedWorkflow | string, location?: "project" | "user"): SavedWorkflowMutationResult | boolean {
      if (typeof workflow === "string") {
        if (!isSafeSavedWorkflowName(workflow)) return false;
        const sources: SavedWorkflowSource[] =
          location === "user"
            ? ["user"]
            : location === "project"
              ? ["project", "legacy"]
              : ["project", "legacy", "user"];
        let deleted = false;
        for (const source of sources) {
          const current = loadFromFile(sourcePath(workflow, source), source);
          if (!current) continue;
          const result = removeSource(current.path);
          if (!result.ok) return false;
          deleted = true;
        }
        return deleted;
      }
      const current = exactCurrent(workflow);
      if (!current.ok) return current;
      return removeSource(current.workflow.path);
    },

    rename(workflow, name): SavedWorkflowMutationResult {
      if (!isSafeSavedWorkflowName(name)) {
        return {
          ok: false,
          code: "invalid",
          message:
            "Saved workflow name must be a non-empty slash-command-safe name without whitespace, controls, or paths.",
        };
      }
      const current = exactCurrent(workflow);
      if (!current.ok) return current;
      if (name === current.workflow.name) return { ok: true, workflow: current.workflow };

      // A command name is globally resolved by precedence, so a target that is
      // occupied in any tier is ambiguous even when the current row is hidden by
      // another tier. Reject before writing instead of mutating a fallback by name.
      for (const source of ["project", "legacy", "user"] as const) {
        const target = sourcePath(name, source);
        if (hasRecord(target)) {
          return { ok: false, code: "conflict", message: `A saved workflow named /${name} already exists.` };
        }
      }

      const source = sourceFor(current.workflow);
      const targetPath = sourcePath(name, source);
      const renamed: SavedWorkflow = {
        ...current.workflow,
        name,
        source,
        location: locationFor(source),
        path: targetPath,
        savedAt: new Date().toISOString(),
      };
      let sourcePrimary: FileSnapshot;
      let sourceBackup: FileSnapshot;
      try {
        ensureDir(dirs[source]);
        sourcePrimary = snapshotFile(current.workflow.path);
        sourceBackup = snapshotFile(`${current.workflow.path}.bak`);
        // The replacement must have both primary and backup before the source
        // can be touched. A failed strict write is cleaned before returning.
        writeJsonAtomicWithBackupStrict(fs, targetPath, renamed);
      } catch (error) {
        cleanupTarget(targetPath);
        return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
      }
      const removed = removeSource(current.workflow.path);
      if (!removed.ok) {
        cleanupTarget(targetPath);
        try {
          restoreFile(sourcePrimary);
          restoreFile(sourceBackup);
        } catch {
          // The original bytes are restored whenever the injected failure is
          // transient; cleanup makes the next retry deterministic.
        }
        return removed;
      }
      return { ok: true, workflow: renamed };
    },
  };
}
