/**
 * Workflow run state persistence for pause/resume support.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import { workflowProjectPaths } from "./workflow-paths.js";

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
  /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
  tokens?: number;
  /** Per-agent token usage breakdown, when the provider reported one. */
  tokenUsage?: AgentUsage;
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
  /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
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
  /**
   * Opt-out of auto-resume for this run (default true, i.e. eligible unless
   * explicitly set to false via ExecOptions.autoResume). Set once at run start
   * and carried through resumes; see UsageLimitScheduler.
   */
  autoResume?: boolean;
  /**
   * Auto-resume attempt counter for the current usage_limit pause-cycle, owned
   * and persisted by UsageLimitScheduler (best-effort). Absent/0 means no
   * auto-resume attempt has been recorded yet.
   */
  autoResumeAttempts?: number;
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

/**
 * `list()` does a full readdirSync + per-file readFileSync + JSON.parse of the
 * entire lifetime run history. It is called on essentially every progress tick
 * (task-panel re-render → WorkflowManager.listRuns()/listAllRuns()), so an
 * unbounded number of ticks each re-walked and re-parsed every run file on
 * disk. Cache the computed list for a short TTL — long enough to absorb a
 * burst of same-tick reads, short enough that a read from a DIFFERENT process
 * (or a mutation this instance doesn't own) still shows up quickly. Mirrors
 * the ~1s settings-read TTL cache in task-panel.ts.
 */
const LIST_CACHE_TTL_MS = 300;

export function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>): RunPersistence {
  const _existsSync = fsOverride?.existsSync ?? existsSync;
  const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
  const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
  const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
  const _renameSync = fsOverride?.renameSync ?? renameSync;
  const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
  const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;

  const paths = workflowProjectPaths(cwd);
  const runsDir = paths.runsDir;
  const legacyRunsDir = paths.legacyRunsDir;

  const ensureDir = () => {
    if (!_existsSync(runsDir)) {
      _mkdirSync(runsDir, { recursive: true });
    }
  };

  const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
  const primaryRunPath = (runId: string) => runPath(runsDir, runId);
  const legacyRunPath = (runId: string) => runPath(legacyRunsDir, runId);
  const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
  const primaryLockPath = (runId: string) => lockPath(runsDir, runId);
  const legacyLockPath = (runId: string) => lockPath(legacyRunsDir, runId);
  const candidateRunPaths = (runId: string) => [primaryRunPath(runId), legacyRunPath(runId)];

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

  const readLockAt = (path: string): LockFile | null => {
    try {
      return JSON.parse(_readFileSync(path, "utf-8")) as LockFile;
    } catch {
      return null;
    }
  };

  const readLock = (runId: string): LockFile | null => readLockAt(primaryLockPath(runId));

  // list() cache: recomputed lazily, invalidated synchronously by every
  // mutation this instance performs (save()/delete()) so a stale read can
  // never outlive a mutation this process made. A read from another process
  // (or a direct fs write bypassing this instance) is picked up once the TTL
  // elapses, same as before this cache existed on the next un-cached call.
  let listCache: PersistedRunState[] | undefined;
  let listCacheAt = 0;
  const invalidateListCache = () => {
    listCache = undefined;
  };

  const removeStaleLegacyLock = (runId: string): boolean => {
    const lock = legacyLockPath(runId);
    const existing = readLockAt(lock);
    if (existing?.runId === runId && pidIsAlive(existing.pid)) return false;
    try {
      if (_existsSync(lock)) _unlinkSync(lock);
    } catch {
      return false;
    }
    return true;
  };

  return {
    save(state: PersistedRunState) {
      ensureDir();
      state.updatedAt = new Date().toISOString();
      const path = primaryRunPath(state.runId);
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
      invalidateListCache();
    },

    load(runId: string): PersistedRunState | null {
      // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
      for (const path of candidateRunPaths(runId)) {
        for (const candidate of [path, `${path}.bak`]) {
          try {
            if (!_existsSync(candidate)) continue;
            return JSON.parse(_readFileSync(candidate, "utf-8")) as PersistedRunState;
          } catch {
            // corrupt candidate -> fall through to the next candidate
          }
        }
      }
      return null;
    },

    list(): PersistedRunState[] {
      const now = Date.now();
      // Return a fresh array on every call (a cheap ref-copy) so a caller that
      // sorts/reverses/mutates the result in place can't corrupt the cache — the
      // pre-cache code re-parsed into a new array each call, preserve that.
      if (listCache && now - listCacheAt < LIST_CACHE_TTL_MS) {
        return [...listCache];
      }
      const byRunId = new Map<string, PersistedRunState>();
      for (const dir of [runsDir, legacyRunsDir]) {
        try {
          if (!_existsSync(dir)) continue;
          const files = _readdirSync(dir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            try {
              const state = JSON.parse(_readFileSync(join(dir, file), "utf-8")) as PersistedRunState;
              if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
            } catch {
              // Skip corrupted files
            }
          }
        } catch {
          // Skip unreadable directories; another storage location may still work.
        }
      }
      const result = [...byRunId.values()].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      listCache = result;
      listCacheAt = now;
      return [...result];
    },

    delete(runId: string): boolean {
      let deleted = false;
      try {
        for (const path of candidateRunPaths(runId)) {
          const dir = path === primaryRunPath(runId) ? runsDir : legacyRunsDir;
          // Best-effort cleanup of the sidecar files alongside the primary.
          for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(dir, runId)]) {
            try {
              if (_existsSync(sidecar)) _unlinkSync(sidecar);
            } catch {
              // ignore sidecar cleanup failures
            }
          }
          try {
            if (_existsSync(path)) {
              _unlinkSync(path);
              deleted = true;
            }
          } catch {
            // ignore per-file cleanup failures
          }
        }
        return deleted;
      } catch {
        return deleted;
      } finally {
        invalidateListCache();
      }
    },

    acquireRunLease(runId: string): RunLease | null {
      ensureDir();
      const path = primaryRunPath(runId);
      const lock = primaryLockPath(runId);
      if (!removeStaleLegacyLock(runId)) return null;
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
        if (existing?.token === lease.token) _unlinkSync(primaryLockPath(lease.runId));
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
