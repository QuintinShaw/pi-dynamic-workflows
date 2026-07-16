/**
 * Workflow run state persistence for pause/resume support.
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { JournalEntry } from "./workflow.js";
import { workflowProjectPaths } from "./workflow-paths.js";
import type { Worktree } from "./worktree.js";

export const RUN_STATE_VERSION = 3;

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  /** Stable runtime identity (`runId:callIndex`). Optional for legacy save callers. */
  executionId?: string;
  callIndex?: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "paused" | "done" | "error" | "skipped";
  result?: unknown;
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** Exact cumulative usage. Streaming estimates are never persisted. */
  usage?: AgentUsage;
  /** Legacy per-agent usage field retained for backward-compatible readers. */
  tokenUsage?: AgentUsage;
  tokens?: number;
  startedAt?: string;
  endedAt?: string;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /** Hash of the agent call that owns this durable invocation. */
  callHash?: string;
  /** File-backed Pi child session used for turn-boundary continuation. */
  sessionFile?: string;
  /** Preserved isolated cwd for a paused child session. */
  worktree?: Worktree;
}

export interface LoadedPersistedAgentState extends PersistedAgentState {
  executionId: string;
  callIndex: number;
}

export interface PersistedRunState {
  version?: number;
  runId: string;
  workflowName: string;
  workflowDescription?: string;
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
  /** Run controls required to resume with equivalent execution behavior. */
  concurrency?: number;
  maxAgents?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  tokenBudget?: number | null;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Cached agent results for resume, keyed by deterministic call index. */
  journal?: JournalEntry[];
  /** Auto-resume eligibility for provider usage-limit pauses. Undefined means enabled. */
  autoResume?: boolean;
  /** Best-effort scheduler attempt count for the current usage-limit pause cycle. */
  autoResumeAttempts?: number;
}

export interface LoadedPersistedRunState extends Omit<PersistedRunState, "version" | "agents"> {
  version: number;
  agents: LoadedPersistedAgentState[];
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. Built-in persistence returns normalized state. */
  load(runId: string): PersistedRunState | null;
  /** List persisted runs. Built-in persistence returns normalized state. */
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

interface NormalizedRunPersistence extends RunPersistence {
  load(runId: string): LoadedPersistedRunState | null;
  list(): LoadedPersistedRunState[];
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
}

const RUN_STATUSES = new Set<RunStatus>(["pending", "running", "paused", "completed", "failed", "aborted"]);
const AGENT_STATUSES = new Set<PersistedAgentState["status"]>([
  "queued",
  "running",
  "paused",
  "done",
  "error",
  "skipped",
]);
const warnedMigrationSources = new Set<string>();

function warnMigrationOnce(source: string, message: string): void {
  if (warnedMigrationSources.has(source)) return;
  warnedMigrationSources.add(source);
  console.warn(message);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function exactUsage(value: unknown): AgentUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  return {
    input: finiteNumber(usage.input) ?? 0,
    output: finiteNumber(usage.output) ?? 0,
    cacheRead: finiteNumber(usage.cacheRead) ?? 0,
    cacheWrite: finiteNumber(usage.cacheWrite) ?? 0,
    total: finiteNumber(usage.total) ?? 0,
    cost: finiteNumber(usage.cost) ?? 0,
    estimated: false,
  };
}

function migrateWorktree(value: unknown): Worktree | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const worktree = value as Record<string, unknown>;
  if (typeof worktree.cwd !== "string" || typeof worktree.isolated !== "boolean") return undefined;
  return {
    cwd: worktree.cwd,
    isolated: worktree.isolated,
    ...(typeof worktree.branch === "string" ? { branch: worktree.branch } : {}),
    ...(typeof worktree.repoRoot === "string" ? { repoRoot: worktree.repoRoot } : {}),
    ...(typeof worktree.reason === "string" ? { reason: worktree.reason } : {}),
  };
}

function migrateAgent(
  raw: unknown,
  runId: string,
  fallbackIndex: number,
  legacyIdentity: boolean,
): LoadedPersistedAgentState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const agent = raw as Record<string, unknown>;
  const persistedId = finiteNumber(agent.id);
  const callIndex = Math.max(0, Math.floor(finiteNumber(agent.callIndex) ?? (persistedId ?? fallbackIndex + 1) - 1));
  const id = Math.max(1, Math.floor(persistedId ?? callIndex + 1));
  const status = AGENT_STATUSES.has(agent.status as PersistedAgentState["status"])
    ? (agent.status as PersistedAgentState["status"])
    : "queued";
  const usage = exactUsage(agent.usage ?? agent.tokenUsage);
  return {
    id,
    executionId: !legacyIdentity && typeof agent.executionId === "string" ? agent.executionId : `${runId}:${callIndex}`,
    callIndex,
    label: typeof agent.label === "string" ? agent.label : `agent-${id}`,
    phase: typeof agent.phase === "string" ? agent.phase : undefined,
    prompt: typeof agent.prompt === "string" ? agent.prompt : "",
    status,
    result: agent.result,
    resultPreview: typeof agent.resultPreview === "string" ? agent.resultPreview : undefined,
    error: typeof agent.error === "string" ? agent.error : undefined,
    errorCode: typeof agent.errorCode === "string" ? (agent.errorCode as WorkflowErrorCode) : undefined,
    recoverable: typeof agent.recoverable === "boolean" ? agent.recoverable : undefined,
    history: Array.isArray(agent.history) ? (agent.history as AgentHistoryEntry[]) : undefined,
    usage,
    tokens: finiteNumber(agent.tokens) ?? usage?.total,
    startedAt: typeof agent.startedAt === "string" ? agent.startedAt : undefined,
    endedAt: typeof agent.endedAt === "string" ? agent.endedAt : undefined,
    model: typeof agent.model === "string" ? agent.model : undefined,
    callHash: typeof agent.callHash === "string" ? agent.callHash : undefined,
    sessionFile: typeof agent.sessionFile === "string" ? agent.sessionFile : undefined,
    worktree: migrateWorktree(agent.worktree),
  };
}

function migrateRunState(raw: unknown, source: string): LoadedPersistedRunState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  if (typeof state.runId !== "string" || !state.runId) return null;
  const runId = state.runId;
  const now = new Date().toISOString();
  const legacyIdentity =
    state.version === undefined || finiteNumber(state.version) === undefined || Number(state.version) < 2;
  let malformedNested = false;
  const malformedUsage = (value: unknown): boolean => {
    if (value === undefined) return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const usage = value as Record<string, unknown>;
    return ["input", "output", "cacheRead", "cacheWrite", "total", "cost"].some(
      (field) => usage[field] !== undefined && finiteNumber(usage[field]) === undefined,
    );
  };
  const agents = Array.isArray(state.agents)
    ? state.agents.flatMap((agent, index) => {
        if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
          malformedNested = true;
          return [];
        }
        const agentRecord = agent as Record<string, unknown>;
        if (malformedUsage(agentRecord.usage ?? agentRecord.tokenUsage)) malformedNested = true;
        if (agentRecord.callHash !== undefined && typeof agentRecord.callHash !== "string") malformedNested = true;
        if (agentRecord.sessionFile !== undefined && typeof agentRecord.sessionFile !== "string") {
          malformedNested = true;
        }
        if (agentRecord.worktree !== undefined && !migrateWorktree(agentRecord.worktree)) malformedNested = true;
        const migrated = migrateAgent(agent, runId, index, legacyIdentity);
        return migrated ? [migrated] : [];
      })
    : [];
  const journal = Array.isArray(state.journal)
    ? state.journal.flatMap((rawEntry) => {
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
          malformedNested = true;
          return [];
        }
        const entry = rawEntry as Record<string, unknown>;
        const index = finiteNumber(entry.index);
        if (index === undefined || typeof entry.hash !== "string") {
          malformedNested = true;
          return [];
        }
        if (
          (!legacyIdentity && typeof entry.executionId !== "string") ||
          malformedUsage(entry.usage) ||
          (entry.storeDelta !== undefined &&
            (!entry.storeDelta || typeof entry.storeDelta !== "object" || Array.isArray(entry.storeDelta)))
        ) {
          malformedNested = true;
        }
        const usage = exactUsage(entry.usage);
        return [
          {
            index: Math.floor(index),
            executionId:
              !legacyIdentity && typeof entry.executionId === "string"
                ? entry.executionId
                : `${runId}:${Math.floor(index)}`,
            hash: entry.hash,
            result: entry.result,
            usage,
            storeDelta:
              entry.storeDelta && typeof entry.storeDelta === "object" && !Array.isArray(entry.storeDelta)
                ? (entry.storeDelta as Record<string, unknown>)
                : undefined,
          },
        ];
      })
    : undefined;
  const rawTokenUsage =
    state.tokenUsage && typeof state.tokenUsage === "object" && !Array.isArray(state.tokenUsage)
      ? (state.tokenUsage as Record<string, unknown>)
      : undefined;
  const tokenUsage = rawTokenUsage
    ? {
        input: finiteNumber(rawTokenUsage.input) ?? 0,
        output: finiteNumber(rawTokenUsage.output) ?? 0,
        total: finiteNumber(rawTokenUsage.total) ?? 0,
        ...(finiteNumber(rawTokenUsage.cost) !== undefined ? { cost: finiteNumber(rawTokenUsage.cost) } : {}),
        ...(finiteNumber(rawTokenUsage.cacheRead) !== undefined
          ? { cacheRead: finiteNumber(rawTokenUsage.cacheRead) }
          : {}),
        ...(finiteNumber(rawTokenUsage.cacheWrite) !== undefined
          ? { cacheWrite: finiteNumber(rawTokenUsage.cacheWrite) }
          : {}),
      }
    : undefined;
  const status = RUN_STATUSES.has(state.status as RunStatus) ? (state.status as RunStatus) : "paused";
  const malformed =
    (state.phases !== undefined && !Array.isArray(state.phases)) ||
    (Array.isArray(state.phases) && state.phases.some((phase) => typeof phase !== "string")) ||
    (state.agents !== undefined && !Array.isArray(state.agents)) ||
    (state.logs !== undefined && !Array.isArray(state.logs)) ||
    (Array.isArray(state.logs) && state.logs.some((log) => typeof log !== "string")) ||
    malformedNested ||
    (state.tokenBudget !== undefined && state.tokenBudget !== null && finiteNumber(state.tokenBudget) === undefined);
  if (state.version !== RUN_STATE_VERSION) {
    warnMigrationOnce(source, `[run-persistence] Migrated legacy workflow run ${runId} from ${source}`);
  } else if (malformed) {
    warnMigrationOnce(source, `[run-persistence] Ignored malformed fields in workflow run ${runId} from ${source}`);
  }
  return {
    version: RUN_STATE_VERSION,
    runId,
    workflowName: typeof state.workflowName === "string" ? state.workflowName : runId,
    workflowDescription: typeof state.workflowDescription === "string" ? state.workflowDescription : undefined,
    script: typeof state.script === "string" ? state.script : "",
    args: state.args,
    sessionId: typeof state.sessionId === "string" ? state.sessionId : undefined,
    status,
    pauseReason: typeof state.pauseReason === "string" ? state.pauseReason : undefined,
    resetHint: typeof state.resetHint === "string" ? state.resetHint : undefined,
    phases: Array.isArray(state.phases)
      ? state.phases.filter((phase): phase is string => typeof phase === "string")
      : [],
    currentPhase: typeof state.currentPhase === "string" ? state.currentPhase : undefined,
    agents,
    logs: Array.isArray(state.logs) ? state.logs.filter((log): log is string => typeof log === "string") : [],
    result: state.result,
    startedAt: typeof state.startedAt === "string" ? state.startedAt : now,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : now,
    completedAt: typeof state.completedAt === "string" ? state.completedAt : undefined,
    durationMs: finiteNumber(state.durationMs),
    concurrency: finiteNumber(state.concurrency),
    maxAgents: finiteNumber(state.maxAgents),
    agentRetries: finiteNumber(state.agentRetries),
    agentTimeoutMs: state.agentTimeoutMs === null ? null : finiteNumber(state.agentTimeoutMs),
    tokenBudget: state.tokenBudget === null ? null : finiteNumber(state.tokenBudget),
    tokenUsage,
    journal,
    autoResume: typeof state.autoResume === "boolean" ? state.autoResume : undefined,
    autoResumeAttempts: finiteNumber(state.autoResumeAttempts),
  };
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 */
export type FsLayer = {
  existsSync: typeof existsSync;
  linkSync: typeof linkSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

export function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>): NormalizedRunPersistence {
  const _existsSync = fsOverride?.existsSync ?? existsSync;
  const _linkSync = fsOverride?.linkSync ?? linkSync;
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

  const loadRun = (runId: string): LoadedPersistedRunState | null => {
    // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
    for (const path of candidateRunPaths(runId)) {
      for (const candidate of [path, `${path}.bak`]) {
        try {
          if (!_existsSync(candidate)) continue;
          const migrated = migrateRunState(JSON.parse(_readFileSync(candidate, "utf-8")), candidate);
          if (migrated) return migrated;
        } catch {
          // corrupt candidate -> fall through to the next candidate
        }
      }
    }
    return null;
  };

  return {
    save(state: PersistedRunState) {
      ensureDir();
      state.version = RUN_STATE_VERSION;
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
    },

    load: loadRun,

    list(): LoadedPersistedRunState[] {
      const byRunId = new Map<string, LoadedPersistedRunState>();
      for (const dir of [runsDir, legacyRunsDir]) {
        try {
          if (!_existsSync(dir)) continue;
          const runIds = new Set(
            _readdirSync(dir).flatMap((file) =>
              file.endsWith(".json")
                ? [file.slice(0, -".json".length)]
                : file.endsWith(".json.bak")
                  ? [file.slice(0, -".json.bak".length)]
                  : [],
            ),
          );
          for (const runId of runIds) {
            const state = loadRun(runId);
            if (state && !byRunId.has(state.runId)) byRunId.set(state.runId, state);
          }
        } catch {
          // Skip unreadable directories; another storage location may still work.
        }
      }
      return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    delete(runId: string): boolean {
      let deleted = false;
      try {
        for (const path of candidateRunPaths(runId)) {
          // Lease files are ownership records, not artifact sidecars. Only the
          // lease owner may remove them through releaseRunLease().
          for (const sidecar of [`${path}.bak`, `${path}.tmp`]) {
            try {
              if (_existsSync(sidecar)) {
                _unlinkSync(sidecar);
                deleted = true;
              }
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
      }
    },

    acquireRunLease(runId: string): RunLease | null {
      ensureDir();
      const path = primaryRunPath(runId);
      const lock = primaryLockPath(runId);
      const takeover = `${lock}.takeover`;
      if (!removeStaleLegacyLock(runId)) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (_existsSync(takeover)) {
          const claim = readLockAt(takeover);
          if (!claim || pidIsAlive(claim.pid)) return null;
          const currentClaim = readLockAt(takeover);
          if (!currentClaim || currentClaim.token !== claim.token || pidIsAlive(currentClaim.pid)) return null;
          try {
            _unlinkSync(takeover);
          } catch {
            return null;
          }
          continue;
        }

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
          if (existing && existing.runPath === path && pidIsAlive(existing.pid)) return null;
        }

        const takeoverCandidate = `${takeover}.${token}.tmp`;
        try {
          _writeFileSync(takeoverCandidate, JSON.stringify(payload, null, 2), { flag: "wx" });
          _linkSync(takeoverCandidate, takeover);
        } catch {
          return null;
        } finally {
          try {
            if (_existsSync(takeoverCandidate)) _unlinkSync(takeoverCandidate);
          } catch {
            // The fixed takeover claim, not its temporary source, is authoritative.
          }
        }
        try {
          const existing = readLock(runId);
          if (existing && existing.runPath === path && pidIsAlive(existing.pid)) return null;
          if (_existsSync(lock)) _unlinkSync(lock);
          _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
          return { runId, token };
        } finally {
          try {
            if (readLockAt(takeover)?.token === token) _unlinkSync(takeover);
          } catch {
            // A dead claimant is recovered by the next acquirer through its PID.
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
