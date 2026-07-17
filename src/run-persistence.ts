/**
 * Workflow run state persistence for pause/resume support.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { MAX_AGENTS_PER_RUN } from "./config.js";
import type { WorkflowErrorCode } from "./errors.js";
import { canonicalWorkflowCwd, workflowProjectKey, workflowProjectPaths } from "./workflow-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
export type TerminalRunStatus = Extract<RunStatus, "completed" | "failed" | "aborted">;

export interface PersistedExecutionOptions {
  maxAgents: number;
  concurrency: number;
  agentRetries: number;
  agentTimeoutMs: number | null;
  tokenBudget: number | null;
}

export const LEGACY_EXECUTION_OPTIONS: Readonly<PersistedExecutionOptions> = Object.freeze({
  maxAgents: MAX_AGENTS_PER_RUN,
  concurrency: 8,
  agentRetries: 0,
  agentTimeoutMs: null,
  tokenBudget: null,
});

export interface TerminalSnapshot {
  version: 1;
  outcome: TerminalRunStatus;
  terminalAt: string;
  runId: string;
  workflowName: string;
  currentPhase?: string;
  agents: {
    total: number;
    done: number;
    error: number;
    skipped: number;
  };
  journalEntries: number;
  tokenUsage?: PersistedRunState["tokenUsage"];
  resultEvidence?: string;
  error?: {
    code?: WorkflowErrorCode;
    message: string;
  };
  reason?: "stopped" | "aborted";
}

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
  /** Version 2 is the projected/validated format; absent means legacy v1 input. */
  version?: 2;
  runId: string;
  /** Canonical execution cwd. Missing in legacy files and filled from the selected namespace on read. */
  cwd?: string;
  /** Stable project namespace derived from canonical cwd. */
  projectKey?: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** The pi session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  /** Immutable session provenance for new runs; falls back to legacy sessionId on read. */
  originSessionId?: string;
  /** Live session that requested the latest resume and should receive delivery. */
  deliverySessionId?: string;
  /** Effective runtime options. Legacy files receive deterministic historical defaults. */
  executionOptions?: PersistedExecutionOptions;
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
  journal?: Array<{ index: number; hash: string; result: unknown; storeDelta?: Record<string, unknown> }>;
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
  /** Bounded deterministic terminal evidence. Paused runs never carry this field. */
  terminalSnapshot?: TerminalSnapshot;
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
  /** Check that a lease is still owned by its exact token. */
  ownsRunLease(lease: RunLease): boolean;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
}

export function isSafeRunId(runId: string): boolean {
  return runId.length > 0 && runId.length <= 256 && runId !== "." && runId !== ".." && /^[a-zA-Z0-9._-]+$/.test(runId);
}

export function assertSafeRunId(runId: string): void {
  if (!isSafeRunId(runId)) throw new Error("Workflow runId must be a non-empty path-safe identifier");
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

const TERMINAL_EVIDENCE_MAX_CHARS = 4096;
const TERMINAL_STRING_MAX_CHARS = 512;
const TERMINAL_ERROR_MAX_CHARS = 1024;
const TERMINAL_COLLECTION_MAX_ITEMS = 20;
const TERMINAL_MAX_DEPTH = 4;

export function createTerminalSnapshot(
  state: PersistedRunState,
  options: {
    terminalAt?: string;
    result?: unknown;
    error?: { code?: WorkflowErrorCode; message: string };
    reason?: "stopped" | "aborted";
  } = {},
): TerminalSnapshot | undefined {
  if (state.terminalSnapshot) return state.terminalSnapshot;
  if (state.status !== "completed" && state.status !== "failed" && state.status !== "aborted") return undefined;

  const result = options.result !== undefined ? options.result : state.result;
  const resultEvidence = result === undefined ? undefined : boundedTerminalEvidence(result);
  const error = options.error
    ? {
        code: options.error.code,
        message: options.error.message.slice(0, TERMINAL_ERROR_MAX_CHARS),
      }
    : undefined;
  return {
    version: 1,
    outcome: state.status,
    terminalAt: options.terminalAt ?? state.completedAt ?? state.updatedAt ?? state.startedAt,
    runId: state.runId,
    workflowName: state.workflowName.slice(0, 256),
    currentPhase: state.currentPhase?.slice(0, 256),
    agents: {
      total: state.agents.length,
      done: state.agents.filter((agent) => agent.status === "done").length,
      error: state.agents.filter((agent) => agent.status === "error").length,
      skipped: state.agents.filter((agent) => agent.status === "skipped").length,
    },
    journalEntries: state.journal?.length ?? 0,
    tokenUsage: state.tokenUsage ? { ...state.tokenUsage } : undefined,
    resultEvidence,
    error,
    reason: state.status === "aborted" ? (options.reason ?? "aborted") : undefined,
  };
}

function boundedTerminalEvidence(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") {
      return current.length > TERMINAL_STRING_MAX_CHARS ? `${current.slice(0, TERMINAL_STRING_MAX_CHARS)}…` : current;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") return current;
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "undefined") return "[undefined]";
    if (typeof current === "function" || typeof current === "symbol") return `[${typeof current}]`;
    if (depth >= TERMINAL_MAX_DEPTH) return "[max-depth]";
    if (seen.has(current as object)) return "[circular]";
    seen.add(current as object);
    if (Array.isArray(current)) {
      const items = current.slice(0, TERMINAL_COLLECTION_MAX_ITEMS).map((item) => visit(item, depth + 1));
      if (current.length > TERMINAL_COLLECTION_MAX_ITEMS) items.push(`[+${current.length - items.length} items]`);
      return items;
    }
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys.slice(0, TERMINAL_COLLECTION_MAX_ITEMS)) {
      result[key.slice(0, 128)] = visit(record[key], depth + 1);
    }
    if (keys.length > TERMINAL_COLLECTION_MAX_ITEMS) {
      result.__truncatedKeys = keys.length - TERMINAL_COLLECTION_MAX_ITEMS;
    }
    return result;
  };
  const serialized = JSON.stringify(visit(value, 0));
  return serialized.length > TERMINAL_EVIDENCE_MAX_CHARS
    ? `${serialized.slice(0, TERMINAL_EVIDENCE_MAX_CHARS - 1)}…`
    : serialized;
}

export function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>): RunPersistence {
  const _existsSync = fsOverride?.existsSync ?? existsSync;
  const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
  const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
  const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
  const _renameSync = fsOverride?.renameSync ?? renameSync;
  const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
  const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;

  const canonicalCwd = canonicalWorkflowCwd(cwd);
  const paths = workflowProjectPaths(canonicalCwd);
  const projectKey = workflowProjectKey(canonicalCwd);
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
  const record = (value: unknown, field: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${field}`);
    return value as Record<string, unknown>;
  };
  const string = (value: unknown, field: string, max = 20_000): string => {
    if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${field}`);
    return value;
  };
  const optionalString = (value: unknown, field: string, max = 20_000): string | undefined =>
    value === undefined ? undefined : string(value, field, max);
  const number = (value: unknown, field: string, integer = false): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
      throw new Error(`Invalid ${field}`);
    }
    return value;
  };
  const optionalNumber = (value: unknown, field: string, integer = false): number | undefined =>
    value === undefined ? undefined : number(value, field, integer);
  const stringArray = (value: unknown, field: string, legacy: boolean, maxItems: number): string[] => {
    if (value === undefined && legacy) return [];
    if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid ${field}`);
    return value.map((item, index) => string(item, `${field}[${index}]`, 4096));
  };
  const tokenUsage = (value: unknown, field: string): PersistedRunState["tokenUsage"] | undefined => {
    if (value === undefined) return undefined;
    const usage = record(value, field);
    const cost = optionalNumber(usage.cost, `${field}.cost`);
    const cacheRead = optionalNumber(usage.cacheRead, `${field}.cacheRead`);
    const cacheWrite = optionalNumber(usage.cacheWrite, `${field}.cacheWrite`);
    return {
      input: number(usage.input, `${field}.input`),
      output: number(usage.output, `${field}.output`),
      total: number(usage.total, `${field}.total`),
      ...(cost === undefined ? {} : { cost }),
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    };
  };
  const agentUsage = (value: unknown, field: string): AgentUsage | undefined => {
    if (value === undefined) return undefined;
    const usage = record(value, field);
    return {
      input: number(usage.input, `${field}.input`),
      output: number(usage.output, `${field}.output`),
      total: number(usage.total, `${field}.total`),
      cost: number(usage.cost, `${field}.cost`),
      cacheRead: number(usage.cacheRead, `${field}.cacheRead`),
      cacheWrite: number(usage.cacheWrite, `${field}.cacheWrite`),
    };
  };
  const normalizeExecutionOptions = (value: unknown, legacy: boolean): PersistedExecutionOptions => {
    if (value === undefined && legacy) return { ...LEGACY_EXECUTION_OPTIONS };
    const options = record(value, "executionOptions");
    const intInRange = (key: string, min: number, max: number): number => {
      const parsed = number(options[key], `executionOptions.${key}`, true);
      if (parsed < min || parsed > max) throw new Error(`Invalid executionOptions.${key}`);
      return parsed;
    };
    const nullablePositive = (key: string): number | null => {
      const candidate = options[key];
      if (candidate === null) return null;
      const parsed = number(candidate, `executionOptions.${key}`);
      if (parsed <= 0) throw new Error(`Invalid executionOptions.${key}`);
      return parsed;
    };
    return {
      maxAgents: intInRange("maxAgents", 1, MAX_AGENTS_PER_RUN),
      concurrency: intInRange("concurrency", 1, 16),
      agentRetries: intInRange("agentRetries", 0, 3),
      agentTimeoutMs: nullablePositive("agentTimeoutMs"),
      tokenBudget: nullablePositive("tokenBudget"),
    };
  };
  const normalizeHistory = (value: unknown, field: string): AgentHistoryEntry[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 40) throw new Error(`Invalid ${field}`);
    return value.map((item, index) => {
      const entry = record(item, `${field}[${index}]`);
      if (!["user", "assistant", "tool"].includes(entry.role as string)) throw new Error(`Invalid ${field}.role`);
      if (!["text", "toolCall", "toolResult", "error"].includes(entry.kind as string))
        throw new Error(`Invalid ${field}.kind`);
      return {
        role: entry.role as AgentHistoryEntry["role"],
        kind: entry.kind as AgentHistoryEntry["kind"],
        text: string(entry.text, `${field}.text`, 2000),
        toolName: optionalString(entry.toolName, `${field}.toolName`, 256),
        isError:
          entry.isError === undefined || typeof entry.isError === "boolean"
            ? entry.isError
            : (() => {
                throw new Error(`Invalid ${field}.isError`);
              })(),
        timestamp: optionalNumber(entry.timestamp, `${field}.timestamp`),
      };
    });
  };
  const normalizeAgents = (value: unknown, legacy: boolean): PersistedAgentState[] => {
    if (value === undefined && legacy) return [];
    if (!Array.isArray(value) || value.length > MAX_AGENTS_PER_RUN) throw new Error("Invalid agents");
    return value.map((item, index) => {
      const agent = record(item, `agents[${index}]`);
      if (!["queued", "running", "done", "error", "skipped"].includes(agent.status as string))
        throw new Error(`Invalid agents[${index}].status`);
      return {
        id: number(agent.id, `agents[${index}].id`, true),
        label: string(agent.label, `agents[${index}].label`, 512),
        phase: optionalString(agent.phase, `agents[${index}].phase`, 512),
        prompt: string(agent.prompt, `agents[${index}].prompt`, 1_000_000),
        status: agent.status as PersistedAgentState["status"],
        result: agent.result,
        error: optionalString(agent.error, `agents[${index}].error`, 20_000),
        errorCode: optionalString(agent.errorCode, `agents[${index}].errorCode`, 128) as WorkflowErrorCode | undefined,
        recoverable:
          agent.recoverable === undefined || typeof agent.recoverable === "boolean"
            ? agent.recoverable
            : (() => {
                throw new Error(`Invalid agents[${index}].recoverable`);
              })(),
        history: normalizeHistory(agent.history, `agents[${index}].history`),
        startedAt: optionalString(agent.startedAt, `agents[${index}].startedAt`, 64),
        endedAt: optionalString(agent.endedAt, `agents[${index}].endedAt`, 64),
        tokens: optionalNumber(agent.tokens, `agents[${index}].tokens`),
        tokenUsage: agentUsage(agent.tokenUsage, `agents[${index}].tokenUsage`),
        model: optionalString(agent.model, `agents[${index}].model`, 512),
      };
    });
  };
  const normalizeJournal = (value: unknown, legacy: boolean): PersistedRunState["journal"] => {
    if (value === undefined) return legacy ? [] : undefined;
    if (!Array.isArray(value) || value.length > MAX_AGENTS_PER_RUN) throw new Error("Invalid journal");
    return value.map((item, index) => {
      const entry = record(item, `journal[${index}]`);
      const storeDelta =
        entry.storeDelta === undefined ? undefined : { ...record(entry.storeDelta, `journal[${index}].storeDelta`) };
      return {
        index: number(entry.index, `journal[${index}].index`, true),
        hash: string(entry.hash, `journal[${index}].hash`, 512),
        result: entry.result,
        ...(storeDelta === undefined ? {} : { storeDelta }),
      };
    });
  };
  const normalizeTerminalSnapshot = (value: unknown): TerminalSnapshot | undefined => {
    if (value === undefined) return undefined;
    const snapshot = record(value, "terminalSnapshot");
    if (snapshot.version !== 1 || !["completed", "failed", "aborted"].includes(snapshot.outcome as string))
      throw new Error("Invalid terminalSnapshot");
    const counts = record(snapshot.agents, "terminalSnapshot.agents");
    const error = snapshot.error === undefined ? undefined : record(snapshot.error, "terminalSnapshot.error");
    return {
      version: 1,
      outcome: snapshot.outcome as TerminalRunStatus,
      terminalAt: string(snapshot.terminalAt, "terminalSnapshot.terminalAt", 64),
      runId: string(snapshot.runId, "terminalSnapshot.runId", 256),
      workflowName: string(snapshot.workflowName, "terminalSnapshot.workflowName", 256),
      currentPhase: optionalString(snapshot.currentPhase, "terminalSnapshot.currentPhase", 256),
      agents: {
        total: number(counts.total, "terminalSnapshot.agents.total", true),
        done: number(counts.done, "terminalSnapshot.agents.done", true),
        error: number(counts.error, "terminalSnapshot.agents.error", true),
        skipped: number(counts.skipped, "terminalSnapshot.agents.skipped", true),
      },
      journalEntries: number(snapshot.journalEntries, "terminalSnapshot.journalEntries", true),
      tokenUsage: tokenUsage(snapshot.tokenUsage, "terminalSnapshot.tokenUsage"),
      resultEvidence: optionalString(snapshot.resultEvidence, "terminalSnapshot.resultEvidence", 4096),
      error: error
        ? {
            code: optionalString(error.code, "terminalSnapshot.error.code", 128) as WorkflowErrorCode | undefined,
            message: string(error.message, "terminalSnapshot.error.message", 1024),
          }
        : undefined,
      reason:
        snapshot.reason === undefined || snapshot.reason === "stopped" || snapshot.reason === "aborted"
          ? (snapshot.reason as TerminalSnapshot["reason"])
          : (() => {
              throw new Error("Invalid terminalSnapshot.reason");
            })(),
    };
  };
  const normalizeState = (input: unknown, expectedRunId?: string): PersistedRunState => {
    const state = record(input, "persisted workflow record");
    if (state.version !== undefined && state.version !== 2) throw new Error("Unsupported persisted workflow version");
    const legacy = state.version === undefined;
    if (!isSafeRunId(state.runId as string) || (expectedRunId !== undefined && state.runId !== expectedRunId)) {
      throw new Error("Persisted workflow runId mismatch");
    }
    if (!["pending", "running", "paused", "completed", "failed", "aborted"].includes(state.status as string))
      throw new Error("Invalid persisted workflow status");
    if (
      !legacy &&
      (typeof state.script !== "string" || typeof state.startedAt !== "string" || typeof state.updatedAt !== "string")
    )
      throw new Error("Invalid version 2 persisted workflow fields");
    const phases = stringArray(state.phases, "phases", legacy, 1000);
    const currentPhase = optionalString(state.currentPhase, "currentPhase", 4096);
    if (currentPhase !== undefined && !phases.includes(currentPhase)) throw new Error("Invalid currentPhase");
    const normalized: PersistedRunState = {
      version: 2,
      runId: state.runId as string,
      cwd: canonicalCwd,
      projectKey,
      workflowName: string(state.workflowName, "workflowName", 4096),
      script: state.script === undefined && legacy ? "" : string(state.script, "script", 10_000_000),
      args: state.args,
      sessionId: optionalString(state.sessionId, "sessionId", 512),
      originSessionId: optionalString(state.originSessionId ?? state.sessionId, "originSessionId", 512),
      deliverySessionId: optionalString(state.deliverySessionId ?? state.sessionId, "deliverySessionId", 512),
      executionOptions: normalizeExecutionOptions(state.executionOptions, legacy),
      status: state.status as RunStatus,
      pauseReason: optionalString(state.pauseReason, "pauseReason", 512),
      resetHint: optionalString(state.resetHint, "resetHint", 512),
      phases,
      currentPhase,
      agents: normalizeAgents(state.agents, legacy),
      logs: stringArray(state.logs, "logs", legacy, 10_000),
      result: state.result,
      startedAt:
        state.startedAt === undefined && legacy ? new Date(0).toISOString() : string(state.startedAt, "startedAt", 64),
      updatedAt:
        state.updatedAt === undefined && legacy ? new Date(0).toISOString() : string(state.updatedAt, "updatedAt", 64),
      completedAt: optionalString(state.completedAt, "completedAt", 64),
      durationMs: optionalNumber(state.durationMs, "durationMs"),
      tokenUsage: tokenUsage(state.tokenUsage, "tokenUsage"),
      journal: normalizeJournal(state.journal, legacy),
      autoResume:
        state.autoResume === undefined || typeof state.autoResume === "boolean"
          ? state.autoResume
          : (() => {
              throw new Error("Invalid autoResume");
            })(),
      autoResumeAttempts: optionalNumber(state.autoResumeAttempts, "autoResumeAttempts", true),
      terminalSnapshot: normalizeTerminalSnapshot(state.terminalSnapshot),
    };
    if (normalized.terminalSnapshot?.runId !== undefined && normalized.terminalSnapshot.runId !== normalized.runId)
      throw new Error("Persisted terminalSnapshot runId mismatch");
    if (normalized.terminalSnapshot && normalized.terminalSnapshot.outcome !== normalized.status)
      throw new Error("Persisted terminalSnapshot outcome mismatch");
    normalized.terminalSnapshot = createTerminalSnapshot(normalized);
    return normalized;
  };

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

  return {
    save(state: PersistedRunState) {
      assertSafeRunId(state.runId);
      ensureDir();
      const savedAt = new Date().toISOString();
      const normalized = normalizeState(state);
      state.updatedAt = savedAt;
      normalized.updatedAt = savedAt;
      state.terminalSnapshot ??= normalized.terminalSnapshot;
      const path = primaryRunPath(state.runId);
      const json = JSON.stringify(normalized, null, 2);
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
      if (!isSafeRunId(runId)) return null;
      // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
      for (const path of candidateRunPaths(runId)) {
        for (const candidate of [path, `${path}.bak`]) {
          try {
            if (!_existsSync(candidate)) continue;
            return normalizeState(JSON.parse(_readFileSync(candidate, "utf-8")), runId);
          } catch {
            // corrupt candidate -> fall through to the next candidate
          }
        }
      }
      return null;
    },

    list(): PersistedRunState[] {
      const byRunId = new Map<string, PersistedRunState>();
      for (const dir of [runsDir, legacyRunsDir]) {
        try {
          if (!_existsSync(dir)) continue;
          const files = _readdirSync(dir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            try {
              const expectedRunId = file.slice(0, -".json".length);
              const state = normalizeState(JSON.parse(_readFileSync(join(dir, file), "utf-8")), expectedRunId);
              if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
            } catch {
              // Skip corrupted files
            }
          }
        } catch {
          // Skip unreadable directories; another storage location may still work.
        }
      }
      return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    delete(runId: string): boolean {
      if (!isSafeRunId(runId)) return false;
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
      }
    },

    acquireRunLease(runId: string): RunLease | null {
      if (!isSafeRunId(runId)) return null;
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
          if (existing && existing.runPath === path && pidIsAlive(existing.pid)) return null;

          // Atomically move the exact stale candidate out of the lock pathname.
          // Never unlink by pathname after inspection: another owner could replace
          // the file between the stale read and unlink. A contender racing this
          // rename either wins the pathname or makes the rename fail; both cases
          // leave its lease untouched and make this acquisition return null.
          const quarantine = `${lock}.stale-${token}`;
          try {
            _renameSync(lock, quarantine);
          } catch {
            return null;
          }
          try {
            const moved = readLockAt(quarantine);
            if (existing?.token && moved?.token !== existing.token) {
              try {
                _renameSync(quarantine, lock);
              } catch {
                // A new owner already claimed the path; do not disturb it.
              }
              return null;
            }
          } finally {
            try {
              if (_existsSync(quarantine)) _unlinkSync(quarantine);
            } catch {
              // Quarantine cleanup is best-effort and cannot affect lock ownership.
            }
          }
        }
      }
      return null;
    },

    ownsRunLease(lease: RunLease): boolean {
      if (!isSafeRunId(lease.runId)) return false;
      const existing = readLock(lease.runId);
      return existing?.token === lease.token;
    },

    releaseRunLease(lease: RunLease): void {
      if (!isSafeRunId(lease.runId)) return;
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
