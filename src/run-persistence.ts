/**
 * Workflow run state persistence for pause/resume support.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentHistoryEntry } from "./agent-history.js";
import { WORKFLOW_RUNS_DIR } from "./config.js";
import type { WorkflowErrorCode } from "./errors.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  startedAt?: string;
  endedAt?: string;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** The pi session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  status: RunStatus;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Cached agent results for resume, keyed by deterministic call index. */
  journal?: Array<{ index: number; hash: string; result: unknown }>;
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; stale/corrupt lock files are removed and retried.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 */
export type FsLayer = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

export function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>): RunPersistence {
  const _existsSync = fsOverride?.existsSync ?? existsSync;
  const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
  const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
  const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
  const _renameSync = fsOverride?.renameSync ?? renameSync;
  const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
  const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;

  const runsDir = resolve(cwd, WORKFLOW_RUNS_DIR);

  const ensureDir = () => {
    if (!_existsSync(runsDir)) {
      _mkdirSync(runsDir, { recursive: true });
    }
  };

  const runPath = (runId: string) => join(runsDir, `${runId}.json`);
  const lockPath = (runId: string) => join(runsDir, `${runId}.lock`);

  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return true;
      return false;
    }
  };

  const readLock = (runId: string): LockFile | null => {
    try {
      return JSON.parse(_readFileSync(lockPath(runId), "utf-8")) as LockFile;
    } catch {
      return null;
    }
  };

  return {
    save(state: PersistedRunState) {
      ensureDir();
      state.updatedAt = new Date().toISOString();
      const path = runPath(state.runId);
      const json = JSON.stringify(state, null, 2);
      // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
      // atomic on the same filesystem). A .bak from the previous good save is the
      // recovery fallback if the primary is somehow truncated.
      _writeFileSync(`${path}.tmp`, json);
      _renameSync(`${path}.tmp`, path);
      try {
        _writeFileSync(`${path}.bak`, json);
      } catch {
        // backup is best-effort; the primary write already succeeded
      }
    },

    load(runId: string): PersistedRunState | null {
      const path = runPath(runId);
      // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
      for (const candidate of [path, `${path}.bak`]) {
        try {
          if (!_existsSync(candidate)) continue;
          return JSON.parse(_readFileSync(candidate, "utf-8")) as PersistedRunState;
        } catch {
          // primary corrupt -> fall through to .bak
        }
      }
      return null;
    },

    list(): PersistedRunState[] {
      ensureDir();
      try {
        const files = _readdirSync(runsDir).filter((f) => f.endsWith(".json"));
        const runs: PersistedRunState[] = [];
        for (const file of files) {
          try {
            const state = JSON.parse(_readFileSync(join(runsDir, file), "utf-8")) as PersistedRunState;
            runs.push(state);
          } catch {
            // Skip corrupted files
          }
        }
        return runs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      } catch {
        return [];
      }
    },

    delete(runId: string): boolean {
      try {
        const path = runPath(runId);
        // Best-effort cleanup of the sidecar files alongside the primary.
        for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(runId)]) {
          try {
            if (_existsSync(sidecar)) _unlinkSync(sidecar);
          } catch {
            // ignore sidecar cleanup failures
          }
        }
        if (_existsSync(path)) {
          _unlinkSync(path);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },

    acquireRunLease(runId: string): RunLease | null {
      ensureDir();
      const path = runPath(runId);
      const lock = lockPath(runId);
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const payload: LockFile = {
          runId,
          runPath: path,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
        };
        try {
          _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
          return { runId, token };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "EEXIST") throw err;
          const existing = readLock(runId);
          if (existing && existing.runPath === path && pidIsAlive(existing.pid)) {
            return null;
          }
          try {
            _unlinkSync(lock);
          } catch {
            return null;
          }
        }
      }
      return null;
    },

    releaseRunLease(lease: RunLease): void {
      try {
        const existing = readLock(lease.runId);
        if (existing?.token === lease.token) _unlinkSync(lockPath(lease.runId));
      } catch {
        // Best-effort cleanup only.
      }
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
