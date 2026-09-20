/**
 * Workflow run state persistence for pause/resume support.
 */

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { WorkflowErrorCode } from "./errors.js";
import {
  ensureDir as ensureDirFs,
  listJsonFilesSafe,
  type PersistenceFsLayer,
  resolvePersistenceFs,
  unlinkIfExistsSafe,
} from "./fs-persistence.js";
import { settleInterruptedPersistedAgents } from "./run-agent-settlement.js";
import { createRunRecordStore } from "./run-record-store.js";

export {
  agentHasNonTerminalStatus,
  INTERRUPTED_AGENT_CAUSE,
  settleInterruptedPersistedAgents,
} from "./run-agent-settlement.js";

import type { WorkflowCheckpoint } from "./workflow.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
  callId?: string;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  /** Compact result written by releases before full agent results were retained. */
  resultPreview?: string;
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
  /** Child SessionManager identity, captured before the first prompt. */
  sessionId?: string;
  /** Child session file, absent for in-memory child sessions. */
  sessionFile?: string;
}

/** Serialized journal entry; runId is absent on legacy numeric-only journals. */
export interface PersistedJournalEntry {
  index: number;
  runId?: string;
  hash: string;
  result: unknown;
  storeDelta?: Record<string, unknown>;
  /** The model the call ran on; absent on journals written before this field existed. */
  model?: string;
}

/**
 * Sanitize a persisted/incoming auto-resume attempt counter: corrupt or
 * foreign values (non-number, NaN, Infinity, negative, non-integer) become
 * undefined — a NaN/negative counter would defeat the scheduler's give-up
 * cap and produce NaN timer delays (#207).
 */
export function sanitizeAutoResumeAttempts(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** The pi session currently used for run ownership/delivery. Runs persist on
   * disk across sessions but the navigator shows only the current session's
   * runs (undefined = legacy/global). */
  sessionId?: string;
  /** Immutable parent session identity for this workflow run. */
  parentSessionId?: string;
  /** Immutable parent session file for this workflow run, when persisted. */
  parentSessionFile?: string;
  status: RunStatus;
  /**
   * Terminal failure/abort message. Written for `failed` and `aborted` runs;
   * absent on running/paused/completed and on records persisted before this field.
   */
  error?: string;
  /**
   * Classified terminal cause. Written with `error` for `failed` and `aborted`
   * runs; absent on running/paused/completed and on legacy records.
   */
  errorCode?: WorkflowErrorCode;
  /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  /** Durable workflow-controlled suspension and its at-most-once response. */
  checkpoint?: WorkflowCheckpoint;
  phases: string[];
  /**
   * Per-phase soft sub-budgets declared so far in this run's lifetime, keyed by
   * `${frameRunId}:${phaseTitle}` (nested workflow() frames have stable runIds
   * across resume) -> ceiling + the run-wide spent baseline at declaration.
   * Persisted so a resumed execution ADOPTS the original baseline instead of
   * re-basing (audit2 #4) — a phase ceiling holds cumulatively across resume.
   */
  phaseBudgets?: Record<string, { budget: number; startSpent: number; warned?: boolean }>;
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
    /** True when the totals include character-heuristic estimates (#209). */
    estimated?: boolean;
  };
  /**
   * Cached agent/checkpoint results for resume, keyed by deterministic call
   * index. `runId` namespaces `index` (a nested workflow() call restarts its
   * own callSeq at 0) — absent on journals persisted before that namespacing
   * existed; see PersistedJournalEntry.runId in workflow.ts / the manager's
   * resume() for the resume-time legacy-degradation behavior. `storeDelta` is
   * this call's SharedStore write delta, replayed additively on resume.
   */
  journal?: PersistedJournalEntry[];
  /**
   * Opt-out of auto-resume for this run (default true, i.e. eligible unless
   * explicitly set to false via ExecOptions.autoResume). Set once at run start
   * and carried through resumes; see UsageLimitScheduler.
   */
  autoResume?: boolean;
  /**
   * The run's resolved hard token budget, fixed at start (per-run value, else
   * the manager default at the time). Resume re-applies THIS value — never the
   * current default — so an explicit no-budget (`null`) or custom cap survives
   * a pause/resume cycle. Absent on legacy runs (resumed unbudgeted).
   */
  tokenBudget?: number | null;
  /**
   * Named toolset tag (WorkflowManagerOptions.toolsets). ToolDefinitions are
   * functions and can't be serialized, so this tag is how a resumed run (e.g.
   * /deep-research with web tools) re-resolves the tool set it started with.
   */
  toolset?: string;
  /**
   * The run's resolved cap on total agents, fixed at start (per-run value,
   * else undefined so runWorkflow applies its own MAX_AGENTS_PER_RUN default).
   * Resume re-applies THIS value — never the manager's current default — same
   * rationale as tokenBudget. Absent on legacy runs (resumed with no cap
   * carried forward, i.e. runWorkflow's own default applies).
   */
  maxAgents?: number;
  /**
   * The run's resolved per-agent timeout, fixed at start (per-run value, else
   * the manager default at the time). Absent on legacy runs — unlike
   * tokenBudget, a legacy run's real timeout was never "no timeout" by
   * omission; it was always the manager's default (pre-A1 resume always fell
   * back to it), so resume applies the manager's CURRENT default for such
   * runs rather than null, preserving both the run's original semantics and
   * pre-fix resume behavior.
   */
  agentTimeoutMs?: number | null;
  /**
   * The run's resolved concurrency, fixed at start (per-run value, else the
   * manager's concurrency at the time). Same rationale as tokenBudget.
   */
  concurrency?: number;
  /**
   * The run's resolved agent-retry count, fixed at start (per-run value, else
   * the manager default at the time). Same rationale as tokenBudget.
   */
  agentRetries?: number;
  /**
   * Auto-resume attempt counter for the current usage_limit pause-cycle.
   * Owned by WorkflowManager (written on every persistRun; the scheduler
   * records through recordAutoResumeAttempts, never a raw save — #207).
   * Absent/0 means no auto-resume attempt has been recorded yet.
   */
  autoResumeAttempts?: number;
  /**
   * Undelivered background-result payload waiting for the originating session's
   * delivery endpoint. Written before the send attempt (fail-closed); cleared
   * only after a successful session-routed delivery. `complete` recomputes text
   * from the persisted result on flush so we don't retain a second full copy.
   */
  pendingDelivery?: PendingDeliveryMarker;
}

/**
 * Disk/memory marker for a background result that still needs conversation
 * delivery. Kept small on purpose — never store full agent transcripts here.
 */
export type PendingDeliveryMarker =
  | { kind: "complete"; deliveryId?: string }
  | { kind: "text"; text: string; deliveryId?: string };

export interface RunPersistence {
  /** Immutable, directly readable result artifact for conversation delivery. */
  exportResult?(runId: string, result: unknown): string;
  /** Read routing metadata without hydrating history; detail fields are lazy. */
  loadPreview?(runId: string): PersistedRunState | null;
  /** Under the caller's run lease, settle orphaned agents using a log delta. */
  recoverInterrupted?(runId: string): boolean;
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Merge small delivery/ownership fields without hydrating the run history. */
  updateMetadata?(
    runId: string,
    patch: Partial<Pick<PersistedRunState, "sessionId" | "pendingDelivery" | "autoResumeAttempts">>,
    expectedDeliveryId?: string,
  ): boolean;
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
 * (Alias of the shared PersistenceFsLayer — see fs-persistence.ts.)
 */
export type FsLayer = PersistenceFsLayer;

/**
 * Retention policy for terminal (completed/failed/aborted) runs kept on
 * disk. Bounded so a long-lived project directory can't accumulate an
 * unbounded number of run files (each polled/listed on every list() call).
 * A run in "running" or "paused" status is NEVER counted against this cap
 * or evicted by it — only genuinely finished runs age out, oldest (by
 * updatedAt) first, once the terminal-run count exceeds the cap. 300 is
 * generous enough to cover weeks of typical usage while keeping list()'s
 * per-call directory scan bounded.
 */
export const DEFAULT_MAX_TERMINAL_RUNS_ON_DISK = 300;

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

const PERSISTED_AGENT_STATUSES = [
  "queued",
  "running",
  "done",
  "error",
  "skipped",
] as const satisfies readonly PersistedAgentState["status"][];

// Exhaustiveness: adding a member to PersistedAgentState["status"] without
// listing it above fails to compile HERE (Exclude yields a non-never).
type AssertNever<T extends never> = T;
export type _PersistedAgentStatusExhaustiveCheck = AssertNever<
  Exclude<PersistedAgentState["status"], (typeof PERSISTED_AGENT_STATUSES)[number]>
>;

/** Every status a persisted agent row may validly carry — exhaustively
 * checked against PersistedAgentState["status"] by the assertion above.
 * Forward-compat note: resume seeding DROPS rows with out-of-union statuses
 * (e.g. written by a newer release) — deliberate garbage-vs-unknown tradeoff:
 * an unknown status cannot be ghost-settled or displayed safely, so the row
 * is treated as corrupt rather than re-persisted as a lie. */
export const VALID_PERSISTED_AGENT_STATUSES: ReadonlySet<PersistedAgentState["status"]> = new Set(
  PERSISTED_AGENT_STATUSES,
);

/** Cause stamped onto leftover in-flight agents when a run reaches a terminal status. */
export function terminalRunInterruptCause(
  status: RunStatus,
  error?: { message?: string; code?: WorkflowErrorCode },
): { error: string; errorCode?: WorkflowErrorCode } {
  if (status === "aborted") {
    return { error: "aborted", errorCode: error?.code ?? WorkflowErrorCode.WORKFLOW_ABORTED };
  }
  if (status === "failed") {
    return {
      error: error?.message ?? "run failed",
      errorCode: error?.code ?? WorkflowErrorCode.UNKNOWN,
    };
  }
  return { error: "run completed" };
}

/**
 * Fail-closed rewrite of leftover queued/running agents on a terminal run.
 * Completed/failed/aborted must never persist a still-`running` agent.
 */
export function settleNonTerminalPersistedAgents(
  agents: PersistedAgentState[],
  status: RunStatus,
  error: { message?: string; code?: WorkflowErrorCode } | undefined,
  endedAt: string,
): PersistedAgentState[] {
  if (!TERMINAL_RUN_STATUSES.has(status)) return agents;
  return settleInterruptedPersistedAgents(agents, terminalRunInterruptCause(status, error), endedAt);
}

export interface RunPersistenceOptions {
  /** Override DEFAULT_MAX_TERMINAL_RUNS_ON_DISK (tests; advanced tuning). */
  maxTerminalRunsOnDisk?: number;
}

/**
 * Absorb same-tick list reads before checking directory stamps and reconciling
 * lightweight per-file views. Full histories are hydrated only on demand.
 */
const LIST_CACHE_TTL_MS = 300;

export function createRunPersistence(
  cwd: string,
  fsOverride?: Partial<FsLayer>,
  options?: RunPersistenceOptions,
): RunPersistence {
  const fs = resolvePersistenceFs(fsOverride);
  const records = createRunRecordStore(fs);
  const _existsSync = fs.existsSync;
  const _readFileSync = fs.readFileSync;
  const _statSync = fs.statSync;
  const _unlinkSync = fs.unlinkSync;
  const _writeFileSync = fs.writeFileSync;
  const maxTerminalRunsOnDisk = options?.maxTerminalRunsOnDisk ?? DEFAULT_MAX_TERMINAL_RUNS_ON_DISK;

  const paths = workflowProjectPaths(cwd);
  const runsDir = paths.runsDir;
  const legacyRunsDir = paths.legacyRunsDir;

  const ensureDir = () => ensureDirFs(fs, runsDir);

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
  // Short writer mutex serializes append + head commit, including metadata
  // writes while a long-lived execution lease is held. Never busy-wait.
  const mutate = <T>(runId: string, fn: () => T): T => {
    ensureDir();
    const path = `${primaryRunPath(runId)}.write-lock`;
    const token = `${process.pid}-${Date.now()}-${Math.random()}`;
    const ownerFile = `${path}.${randomUUID()}.owner`;
    const release = (target: string) => {
      if (readLockAt(target)?.token === token) unlinkIfExistsSafe(fs, target);
    };
    const claim = (target: string, depth = 0): void => {
      if (depth > 8) throw new Error("Run writer recovery chain is too deep");
      for (let attempt = 0; ; attempt++) {
        try {
          fs.linkSync(ownerFile, target);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
          const existing = readLockAt(target);
          if (
            !existing ||
            typeof existing.token !== "string" ||
            !Number.isInteger(existing.pid) ||
            existing.pid <= 0 ||
            pidIsAlive(existing.pid)
          )
            throw error;
          // Serialize reapers of this exact dead-owner incarnation. Without
          // this guard, a second reaper could unlink a new live mutex after
          // both had observed the same stale owner.
          const key = createHash("sha256").update(`${target}\0${existing.token}`).digest("hex");
          const guard = `${path}.reap-${key}`;
          claim(guard, depth + 1);
          try {
            if (readLockAt(target)?.token === existing.token) _unlinkSync(target);
          } finally {
            release(guard);
          }
        }
      }
    };
    // Publish a fully written owner atomically. A process dying between open
    // and write can leave only an unlinked candidate, never an empty mutex.
    try {
      _writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
      claim(path);
    } finally {
      unlinkIfExistsSafe(fs, ownerFile);
    }
    try {
      return fn();
    } finally {
      release(path);
      invalidateListCache();
    }
  };

  // list() cache: recomputed lazily, invalidated synchronously by every
  // mutation this instance performs (save()/delete()) so a stale read can
  // never outlive a mutation this process made. A read from another process
  // (or a direct fs write bypassing this instance) is picked up once the TTL
  // elapses, same as before this cache existed on the next un-cached call.
  let listCache: PersistedRunState[] | undefined;
  let listCacheAt = 0;
  let directoryStamp = "";
  let reconciledAt = 0;
  const directoryVersion = () =>
    [runsDir, legacyRunsDir]
      .map((dir) => {
        try {
          const s = fs.statSync(dir);
          return `${s.ino}:${s.mtimeMs}:${s.ctimeMs}`;
        } catch {
          return "missing";
        }
      })
      .join("|");
  const invalidateListCache = () => {
    listCache = undefined;
  };

  // Per-file mtime+size+ino cache, keyed by absolute path: even once the
  // TTL-level listCache above expires (the active panel polls roughly every
  // 300ms, i.e. faster than or comparable to the TTL), most run files on
  // disk haven't changed since the last recompute. Re-stat is cheap; re-read
  // + re-JSON.parse is not, and scales with total lifetime run history, not
  // with what actually changed. A file whose (mtimeMs, size, ino) all match
  // what we last parsed is reused as-is instead of being re-read; entries
  // for files that vanished between recomputes are pruned so this cache
  // can't grow unbounded independent of what's actually on disk.
  //
  // ino is load-bearing, not redundant with mtime+size: save() writes via
  // tmp-write + rename (writeJsonAtomicWithBackup), and a rename onto an
  // existing path allocates a NEW inode for the replacement file. Two
  // consecutive saves landing in the same mtime tick (400ms-throttled
  // progress persists vs. 1-2s mtime granularity on HFS+/many network
  // mounts/some Docker volume drivers is entirely realistic) with
  // coincidentally equal byte length (e.g. "paused" and "failed" are the
  // same length) would otherwise be indistinguishable from "unchanged" by
  // (mtimeMs, size) alone — serving stale, previously-cached content
  // forever until something ELSE about the file changes. The inode always
  // changes on such a rename, so adding it closes that hole for free.
  const fileStateCache = new Map<string, { mtimeMs: number; size: number; ino: number; state: PersistedRunState }>();

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

  const computeList = (): PersistedRunState[] => {
    const byRunId = new Map<string, PersistedRunState>();
    const seenPaths = new Set<string>();
    for (const dir of [runsDir, legacyRunsDir]) {
      for (const file of listJsonFilesSafe(fs, dir)) {
        const path = join(dir, file);
        seenPaths.add(path);
        try {
          const stat = _statSync(path);
          const cached = fileStateCache.get(path);
          // Reuse the last parse when the file is byte-identical (same
          // mtime + size + inode) to what produced it — the dominant case
          // on every poll tick once a run goes terminal and stops changing.
          // ino is what actually rules out a false "unchanged" match on a
          // coarse-mtime filesystem (see the field doc comment above).
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
            if (!byRunId.has(cached.state.runId)) byRunId.set(cached.state.runId, cached.state);
            continue;
          }
          const record = JSON.parse(_readFileSync(path, "utf-8"));
          const state = records.preview(path, record);
          fileStateCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, state });
          if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
        } catch {
          // Skip corrupted/unreadable files; don't let a stale cache entry
          // for a file that's now failing to read linger either.
          fileStateCache.delete(path);
        }
      }
    }
    // Prune cache entries for files that no longer exist (deleted runs) so
    // this map's size tracks what's actually on disk, not lifetime history.
    for (const path of fileStateCache.keys()) {
      if (!seenPaths.has(path)) fileStateCache.delete(path);
    }
    return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  };

  // Bound the number of terminal (completed/failed/aborted) runs kept on
  // disk (see DEFAULT_MAX_TERMINAL_RUNS_ON_DISK) — called after every save()
  // whose state is terminal, since that's the only time the terminal count
  // can grow. Running/paused and undelivered runs are never candidates: they're
  // filtered out before the cap is even considered.
  const enforceRetention = () => {
    const terminal = computeList()
      .filter((r) => TERMINAL_RUN_STATUSES.has(r.status) && !r.pendingDelivery)
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    const excess = terminal.length - maxTerminalRunsOnDisk;
    if (excess <= 0) return;
    for (const run of terminal.slice(0, excess)) {
      try {
        mutate(run.runId, () => {
          if (
            [primaryLockPath(run.runId), legacyLockPath(run.runId)].some((path) => {
              const lock = readLockAt(path);
              return lock && pidIsAlive(lock.pid);
            })
          )
            return;
          const fresh = records.peek(primaryRunPath(run.runId)) ?? records.peek(legacyRunPath(run.runId));
          if (fresh && TERMINAL_RUN_STATUSES.has(fresh.status) && !fresh.pendingDelivery) deleteRunFiles(run.runId);
        });
      } catch {
        // Contended or unreadable records remain available for the next pass.
      }
    }
    invalidateListCache();
  };

  const deleteRunFiles = (runId: string): boolean => {
    let deleted = false;
    const unlinkData = (path: string): boolean => {
      try {
        _unlinkSync(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    for (const path of candidateRunPaths(runId)) {
      // Delete every readable recovery candidate before releasing either lock:
      // a foreign resume that acquires between those operations must never find
      // a surviving primary, backup, or legacy record to resurrect.
      for (const sidecar of [`${path}.bak`, `${path}.tmp`, records.logPath(path)]) {
        unlinkData(sidecar);
        fileStateCache.delete(sidecar);
      }
      if (unlinkData(path)) deleted = true;
      fileStateCache.delete(path);
      records.forget(path);
    }
    for (const dir of [runsDir, legacyRunsDir]) {
      if (!_existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (
          name.startsWith(`${runId}.json.result-`) ||
          (name.startsWith(`${runId}.json.write-lock.`) && (name.endsWith(".owner") || name.includes(".reap-")))
        )
          unlinkData(join(dir, name));
      }
    }
    // Locks come LAST, after both primary and legacy data/recovery candidates
    // have been removed. deleteRun() deliberately holds its acquired lease
    // across this sequence, so opening this final release window sooner would
    // let another process resume a record that is about to be deleted.
    for (const lock of [primaryLockPath(runId), legacyLockPath(runId)]) {
      unlinkIfExistsSafe(fs, lock);
      fileStateCache.delete(lock);
    }
    return deleted;
  };

  return {
    exportResult(runId, result) {
      return mutate(runId, () => {
        if (!candidateRunPaths(runId).some((path) => _existsSync(path)))
          throw new Error("Run disappeared before result export");
        const json = JSON.stringify({ runId, result }, null, 2);
        const hash = createHash("sha256").update(json).digest("hex");
        const path = `${primaryRunPath(runId)}.result-${hash}`;
        if (_existsSync(path)) return path;
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          _writeFileSync(temporary, json, { flush: true });
          fs.renameSync(temporary, path);
        } finally {
          unlinkIfExistsSafe(fs, temporary);
        }
        return path;
      });
    },
    save(state: PersistedRunState) {
      ensureDir();
      state.updatedAt = new Date().toISOString();
      const path = primaryRunPath(state.runId);
      // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
      // atomic on the same filesystem). A .bak from the previous good save is the
      // recovery fallback if the primary is somehow truncated.
      mutate(state.runId, () => records.save(path, state));
      invalidateListCache();
      // Only a terminal write can grow the terminal-run count, so only check
      // the cap then — a "running"/"paused" save is on the hot path (every
      // progress tick) and must not pay for a retention scan.
      if (TERMINAL_RUN_STATUSES.has(state.status)) enforceRetention();
    },

    loadPreview(runId) {
      for (const path of candidateRunPaths(runId)) {
        const record = records.peek(path);
        if (record) return record;
      }
      return null;
    },

    recoverInterrupted(runId) {
      return mutate(runId, () => {
        for (const path of candidateRunPaths(runId)) {
          if (_existsSync(path) || _existsSync(`${path}.bak`)) return records.recoverInterrupted(path);
        }
        return false;
      });
    },

    updateMetadata(runId, patch, expectedDeliveryId) {
      return mutate(runId, () => {
        for (const path of candidateRunPaths(runId)) {
          if (_existsSync(path) || _existsSync(`${path}.bak`))
            return records.updateMetadata(path, patch, expectedDeliveryId);
        }
        return false;
      });
    },

    load(runId: string): PersistedRunState | null {
      // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
      for (const path of candidateRunPaths(runId)) {
        let state: PersistedRunState | null;
        try {
          state = records.read(path);
        } catch {
          return null;
        }
        if (state) return state;
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
      // Cooperative writers replace heads atomically, changing the directory
      // stamp. Reconcile in-place external edits at most every five seconds.
      const stamp = directoryVersion();
      if (listCache && stamp === directoryStamp && now - reconciledAt < 5000) {
        listCacheAt = now;
        return [...listCache];
      }
      const result = computeList();
      listCache = result;
      listCacheAt = now;
      reconciledAt = now;
      directoryStamp = stamp;
      return [...result];
    },

    delete(runId: string): boolean {
      try {
        return mutate(runId, () => deleteRunFiles(runId));
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
