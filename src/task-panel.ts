/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */

import { join } from "node:path";
import {
  AgentSession,
  type ExtensionAPI,
  ExtensionRunner,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  aggregateAgentUsage,
  fmtCost,
  fmtTokenSegment,
  shorten,
  statusIcon,
  tokenFigures,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import type { PendingDeliveryMarker, PersistedRunState } from "./run-persistence.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";
import { shortModel } from "./workflow-ui.js";

// `tokenUsage` is included so the detailed panel's live token/s counter refreshes
// as tokens accrue (not only on agent start/end). It is harmless in compact mode —
// it redraws identical content.
const RUN_EVENTS = [
  "agentStart",
  "agentEnd",
  "phase",
  "log",
  "tokenUsage",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
];
/** Events after which a run is gone and its token-rate samples can be dropped. */
const RUN_END_EVENTS = ["complete", "error", "stopped"] as const;

export interface TaskPanelOptions {
  storage?: WorkflowStorage;
  cwd?: string;
  /**
   * Live settings loader. When provided, the panel reads it fresh (with a short
   * TTL cache) on each render so `/workflows-progress` takes effect without a
   * restart. Omitted in tests / minimal hosts → always compact.
   */
  loadSettings?: () => WorkflowSettings;
}

/** Default cap on the JSON-dump fallback in a delivered result summary. Overridable
 *  via the `deliveredResultMaxChars` setting in ~/.pi/workflows/settings.json. */
const DEFAULT_DELIVERED_MAX_CHARS = 400;

/** Human-readable byte size for the dropped-tail hint: 512 B, 3.2 KB, 1.4 MB. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pick a clean human-readable summary from a workflow result, in order of
 * preference: a `verdict`/`report`/`summary`/`synthesis` string field, a bare
 * string result, else a JSON dump capped at `maxChars`. When the dump is truncated the
 * dropped size is reported (the full result is still reachable via the pointer
 * that {@link deliverText} appends).
 */
function summarizeResult(result: unknown, maxChars: number = DEFAULT_DELIVERED_MAX_CHARS): string {
  if (typeof result === "string") return result;
  if (result == null) return "null";
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    // `synthesis` is what the built-in multi-perspective workflow returns.
    for (const key of ["verdict", "report", "summary", "synthesis"] as const) {
      const val = obj[key];
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  const json = JSON.stringify(result, null, 2);
  if (json.length <= maxChars) return json;
  // Slice once (the kept head); derive the dropped size by byte-length subtraction
  // so we don't also allocate the (potentially large) truncated tail to measure it.
  const kept = json.slice(0, maxChars);
  const droppedBytes = Buffer.byteLength(json, "utf8") - Buffer.byteLength(kept, "utf8");
  return `${kept}\n…(truncated ${formatBytes(droppedBytes)})`;
}

function fitLine(line: string, width?: number): string {
  if (typeof width !== "number" || !Number.isFinite(width)) return line;
  const maxWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth);
}

export function deliverText(run: ManagedRun, opts: { resultPath?: string; maxChars?: number } = {}): string {
  const summary = summarizeResult(run.result?.result, opts.maxChars);
  const tu = run.result?.tokenUsage;
  const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(tu), fmtTokensShort);
  const tokens = `${segment ? ` · ${segment}` : ""}${cost}`;
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
  const lines = [
    `✓ Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}${duration}).`,
    "",
    summary,
  ];
  // Always point at the full persisted result so the tail is never lost — even when
  // the summary above is a complete verdict/summary field or an untruncated dump.
  if (opts.resultPath) lines.push("", `↳ Full result: ${opts.resultPath}`);
  return lines.join("\n");
}

/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
function persistedResultPath(manager: WorkflowManager, runId: string): string | undefined {
  try {
    return join(manager.getPersistence().getRunsDir(), `${runId}.json`);
  } catch {
    return undefined;
  }
}

/** Delivered JSON-dump truncation threshold from settings (already normalized),
 *  defaulting to 400 when unset or unreadable. */
function deliveredMaxChars(opts: { loadSettings?: () => WorkflowSettings }): number {
  try {
    return opts.loadSettings?.().deliveredResultMaxChars ?? DEFAULT_DELIVERED_MAX_CHARS;
  } catch {
    return DEFAULT_DELIVERED_MAX_CHARS;
  }
}

/**
 * Session-routed background result delivery.
 *
 * Root cause (#147): pi-coding-agent's ExtensionRunner.bindCore() writes
 * `runtime.sendMessage` on a shared runtime object (last-bindCore-wins). Calling
 * `pi.sendMessage` at completion time therefore delivers into whichever session
 * was constructed last — not the session that started the workflow. #143 only
 * covered same-manager session *replacement*; parallel sibling sessions steal
 * the route without any shutdown on the origin.
 *
 * Fix: process-wide endpoint registry keyed by sessionId. Each session_start
 * registers a session-stable send captured from the *host* AgentSession's
 * sendCustomMessage (returns a real Promise — unlike actions.sendMessage
 * which is void and swallows rejects). Completions resolve `run.sessionId`,
 * persist a pending marker first, then deliver only via that session's
 * endpoint. Clear the marker only after the send Promise settles successfully.
 * Missing/suspended endpoint or non-thenable send → leave pending (fail
 * closed). Never fall back to shared `pi.sendMessage` / runtime.sendMessage,
 * and never ACK on a durable append (that writes history without triggerTurn).
 */

type DeliverySend = (
  message: { customType: string; content: string; display: boolean },
  options: { triggerTurn: boolean; deliverAs: "followUp" },
) => unknown;

interface SessionDeliveryEndpoint {
  sessionId: string;
  /**
   * Session-stable send that MUST return a thenable for ACK. Captured from
   * the host AgentSession.sendCustomMessage (not the void actions.sendMessage
   * wrapper, and not a durable-only append).
   */
  send?: DeliverySend;
  loadSettings?: () => WorkflowSettings;
  /**
   * When true, do not call send — leave disk pending. Set for the whole window
   * between session_shutdown and the next bind for this sessionId so a
   * completion cannot land on a dying session.
   */
  suspended: boolean;
  /**
   * Generation counter bumped on every bind. An in-flight send captures the
   * generation it started under; on failure, if a newer generation has already
   * bound, we re-flush disk pending onto it.
   */
  generation: number;
  /** Owning manager used to recompute complete-text and clear pending markers. */
  manager?: WorkflowManager;
}

/** Process-wide: one live endpoint per pi session id. */
const sessionEndpoints = new Map<string, SessionDeliveryEndpoint>();

/**
 * Session-stable thenable sends (host AgentSession.sendCustomMessage). Keyed
 * by host sessionId only — workflow children (in-memory, noExtensions, or
 * named `workflow:…`) must never enter this map (#109).
 */
const boundSessionSends = new Map<string, DeliverySend>();

/** runIds with an in-flight deliver-and-ack so bind flush does not double-send. */
const inFlightDeliveries = new Set<string>();

let agentSessionPatched = false;
let bindCoreObserved = false;

interface StealCandidate {
  sendCustomMessage?: DeliverySend;
  sessionManager?: {
    persist?: boolean;
    getSessionId?: () => string;
    getSessionName?: () => string | undefined;
  };
  _resourceLoader?: { noExtensions?: boolean };
}

/**
 * Host Pi session only. Child workflow agents must not be pinned:
 *  - SessionManager.inMemory() → persist === false
 *  - shared noExtensions loader (persistAgentSessions children included)
 *  - persisted children named `workflow:<runId> …` (set after construction;
 *    still filters a later re-bindCore)
 */
function hostSessionIdToSteal(session: StealCandidate): string | undefined {
  const sm = session.sessionManager;
  if (!sm) return undefined;
  if (sm.persist === false) return undefined;
  if (session._resourceLoader?.noExtensions === true) return undefined;
  try {
    const name = sm.getSessionName?.();
    if (typeof name === "string" && name.startsWith("workflow:")) return undefined;
  } catch {
    // getSessionName unavailable — keep evaluating
  }
  if (typeof session.sendCustomMessage !== "function") return undefined;
  try {
    const sid = sm.getSessionId?.();
    if (typeof sid === "string" && sid) return sid;
  } catch {
    return undefined;
  }
  return undefined;
}

function captureHostSessionSend(session: StealCandidate): void {
  const sid = hostSessionIdToSteal(session);
  if (!sid) return;
  boundSessionSends.set(sid, (message, options) => session.sendCustomMessage!(message, options));
}

/**
 * Capture a Promise-returning send from the *host* AgentSession. bindCore's
 * `actions.sendMessage` is fire-and-forget (void + swallowed reject) and must
 * not be treated as an ACK channel. Child sessions never enter the map.
 */
function patchAgentSessionCapture(): void {
  if (agentSessionPatched) return;
  agentSessionPatched = true;
  try {
    const proto = AgentSession.prototype as unknown as {
      _bindExtensionCore?: (runner: unknown) => unknown;
    } & StealCandidate;
    const original = proto._bindExtensionCore;
    if (typeof original !== "function") return;
    proto._bindExtensionCore = function patchedBindExtensionCore(this: StealCandidate, runner: unknown) {
      try {
        captureHostSessionSend(this);
      } catch {
        // never break session construction
      }
      return original.apply(this, [runner]);
    };
  } catch {
    // AgentSession unavailable or shape changed — bind stays fail-closed without steal
  }
}

/** Keep ExtensionRunner observed so module load order cannot skip the patch arm. */
function patchBindCoreObserve(): void {
  if (bindCoreObserved) return;
  bindCoreObserved = true;
  try {
    const proto = ExtensionRunner.prototype as unknown as {
      bindCore: (...args: unknown[]) => unknown;
    };
    const original = proto.bindCore;
    if (typeof original !== "function") return;
    // No capture of void actions.sendMessage — that path is not an ACK.
    proto.bindCore = function patchedBindCore(this: unknown, ...args: unknown[]) {
      return original.apply(this, args);
    };
  } catch {
    // ignore
  }
}

patchAgentSessionCapture();
patchBindCoreObserve();

type DeliveryManager = WorkflowManager & {
  __deliveryInstalled?: boolean;
  /** Last loadSettings seen on install — used when binding endpoints. */
  __deliveryLoadSettings?: () => WorkflowSettings;
};

function deliveryManager(manager: WorkflowManager): DeliveryManager {
  return manager as DeliveryManager;
}

function resolveDeliverySessionId(run: ManagedRun, manager: WorkflowManager): string | undefined {
  // Originating run wins; manager binding is legacy fallback only when the run
  // predates per-run sessionId. Never invent a session.
  return run.sessionId ?? manager.getSessionId?.();
}

function markRunPending(run: ManagedRun, marker: PendingDeliveryMarker): void {
  run.pendingDelivery = marker;
}

function clearRunPending(manager: WorkflowManager, runId: string, run?: ManagedRun): void {
  if (run?.pendingDelivery) {
    run.pendingDelivery = undefined;
  }
  // Also clear on disk for runs already written / evicted from memory. Best-effort:
  // a missing persistence layer (unit tests) is fine — memory clear is enough.
  try {
    const persistence = manager.getPersistence?.();
    if (!persistence) return;
    const state = persistence.load(runId);
    if (!state?.pendingDelivery) return;
    const { pendingDelivery: _drop, ...rest } = state;
    persistence.save(rest as PersistedRunState);
    // If the live run still exists, keep it aligned without a full persistRace.
    const live = run ?? manager.getRun(runId);
    if (live) live.pendingDelivery = undefined;
  } catch {
    // ignore persistence errors — conversation delivery already succeeded
  }
}

function persistRunPendingBestEffort(manager: WorkflowManager, run: ManagedRun): void {
  try {
    // Prefer merging into an existing on-disk record so we don't clobber the
    // manager's richer write that follows the complete/error emit. When no
    // record exists yet (complete fires before manager.persistRun), seed a
    // minimal marker-bearing record; the subsequent manager write overwrites.
    const persistence = manager.getPersistence?.();
    if (!persistence) return;
    const existing = persistence.load(run.runId);
    if (existing) {
      persistence.save({ ...existing, pendingDelivery: run.pendingDelivery, sessionId: run.sessionId });
      return;
    }
    if (run.pendingDelivery) {
      persistence.save({
        runId: run.runId,
        workflowName: run.snapshot.name,
        script: run.script ?? "",
        sessionId: run.sessionId,
        status: run.status,
        phases: run.snapshot.phases ?? [],
        agents: [],
        logs: run.snapshot.logs ?? [],
        result: run.result?.result,
        tokenUsage: run.result?.tokenUsage ?? run.snapshot.tokenUsage,
        durationMs: run.result?.durationMs,
        startedAt: run.startedAt?.toISOString?.() ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pendingDelivery: run.pendingDelivery,
      });
    }
  } catch {
    // best-effort
  }
}

function contentForPending(
  manager: WorkflowManager,
  runId: string,
  marker: PendingDeliveryMarker,
  loadSettings?: () => WorkflowSettings,
  run?: ManagedRun,
  persisted?: PersistedRunState,
): string | undefined {
  if (marker.kind === "text") return marker.text;
  // complete — recompute from live run or disk so we never store the body twice
  if (run) {
    return deliverText(run, {
      resultPath: persistedResultPath(manager, runId),
      maxChars: deliveredMaxChars({ loadSettings }),
    });
  }
  if (persisted) {
    return deliverText(
      {
        snapshot: { name: persisted.workflowName, agentCount: persisted.agents?.length ?? 0 },
        result: {
          result: persisted.result,
          tokenUsage: persisted.tokenUsage,
          agentCount: persisted.agents?.length ?? 0,
          durationMs: persisted.durationMs,
        },
      } as ManagedRun,
      {
        resultPath: persistedResultPath(manager, runId),
        maxChars: deliveredMaxChars({ loadSettings }),
      },
    );
  }
  return undefined;
}

/**
 * Attempt session-routed delivery. Resolves true only after a thenable
 * host sendCustomMessage / stableSend settles on a live endpoint. Void /
 * fire-and-forget sends and durable appends are NOT success (append writes
 * history without triggerTurn). Does not clear pending markers.
 */
function tryDeliverEndpoint(endpoint: SessionDeliveryEndpoint, content: string): Promise<boolean> {
  if (endpoint.suspended) return Promise.resolve(false);
  if (endpoint.sessionId && sessionEndpoints.get(endpoint.sessionId) !== endpoint) {
    // Stale endpoint object after rebind/drop.
    return Promise.resolve(false);
  }

  // Only a thenable session-stable send (host sendCustomMessage) may ACK.
  if (typeof endpoint.send === "function") {
    try {
      const ret = endpoint.send(
        { customType: "workflow-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      if (ret != null && typeof (ret as { then?: unknown }).then === "function") {
        const startedGeneration = endpoint.generation;
        const sessionId = endpoint.sessionId;
        return Promise.resolve(ret).then(
          () => {
            const current = sessionEndpoints.get(sessionId);
            // Succeeded under this or a newer live endpoint for the same session.
            return !!current && !current.suspended;
          },
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[workflow-delivery] async send failed; left pending on disk: ${msg}`);
            const current = sessionEndpoints.get(sessionId);
            // If a newer generation already bound, caller may re-flush; signal failure.
            if (current && current.generation !== startedGeneration && !current.suspended) {
              // Return false so disk marker stays; flush path retries.
            }
            return false;
          },
        );
      }
      // Non-thenable send (void fire-and-forget) — do not trust as ACK.
      console.warn(
        `[workflow-delivery] send for session ${endpoint.sessionId} did not return a thenable; ` +
          "not treating as delivered (fail closed).",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[workflow-delivery] send failed; left pending on disk: ${msg}`);
      return Promise.resolve(false);
    }
  }

  return Promise.resolve(false);
}

function deliverAndAck(
  manager: WorkflowManager,
  runId: string,
  sessionId: string,
  content: string,
  run?: ManagedRun,
): void {
  if (inFlightDeliveries.has(runId)) return;
  const endpoint = sessionEndpoints.get(sessionId);
  if (!endpoint || endpoint.suspended || endpoint.sessionId !== sessionId) return;

  inFlightDeliveries.add(runId);
  const startedGeneration = endpoint.generation;
  void tryDeliverEndpoint(endpoint, content)
    .then((ok) => {
      if (ok) {
        clearRunPending(manager, runId, run ?? manager.getRun?.(runId));
        return;
      }
      // Release the in-flight lock before a generation-change retry so flush
      // can actually pick this run back up.
      inFlightDeliveries.delete(runId);
      const current = sessionEndpoints.get(sessionId);
      if (current && !current.suspended && current.generation !== startedGeneration && current.manager) {
        flushSessionDiskPending(current.manager, sessionId, current);
      }
    })
    .finally(() => {
      inFlightDeliveries.delete(runId);
    });
}

function routeBackgroundDelivery(
  manager: WorkflowManager,
  run: ManagedRun,
  marker: PendingDeliveryMarker,
  content: string,
): void {
  // 1. Mark pending first (fail closed / crash safe).
  markRunPending(run, marker);
  persistRunPendingBestEffort(manager, run);

  const sessionId = resolveDeliverySessionId(run, manager);
  if (!sessionId) {
    console.warn(`[workflow-delivery] run ${run.runId} has no sessionId; leaving pending on disk (fail closed).`);
    return;
  }

  // 2. Deliver only via the originating session's endpoint; clear after ACK.
  deliverAndAck(manager, run.runId, sessionId, content, run);
}

/**
 * Register or refresh the delivery endpoint for a pi session. Requires a
 * session-stable thenable send (stolen host AgentSession.sendCustomMessage, or
 * test DI). Never falls back to shared pi.sendMessage. A durable
 * appendCustomMessageEntry is not an ACK (no triggerTurn).
 *
 * Call from session_start AFTER Pi bindCore. Unsuspends and flushes disk pending
 * for this sessionId only.
 */
export function bindSessionDelivery(
  sessionId: string,
  _pi: ExtensionAPI,
  opts: {
    loadSettings?: () => WorkflowSettings;
    manager?: WorkflowManager;
    /**
     * Optional explicit thenable send (tests / DI). Wins over the process-wide
     * steal map when provided.
     */
    stableSend?: DeliverySend;
    /**
     * Optional sessionManager. getSessionId is identity only — append is not
     * an ACK channel.
     */
    sessionManager?: {
      getSessionId?: () => string;
      appendCustomMessageEntry?: (
        customType: string,
        content: string | unknown[],
        display: boolean,
        details?: unknown,
      ) => string;
    };
  } = {},
): void {
  if (!sessionId) return;
  patchAgentSessionCapture();
  patchBindCoreObserve();

  const stolen = opts.stableSend ?? boundSessionSends.get(sessionId);

  if (!stolen) {
    console.warn(
      `[workflow-delivery] no session-stable thenable send for session ${sessionId}; ` +
        "endpoint registered fail-closed (completions stay on disk until a host send is captured).",
    );
  }

  // Optional identity check — refuse to bind when sessionManager disagrees.
  try {
    const liveId = opts.sessionManager?.getSessionId?.();
    if (liveId && liveId !== sessionId) {
      console.warn(`[workflow-delivery] refusing bind: sessionManager id ${liveId} !== endpoint ${sessionId}`);
      return;
    }
  } catch {
    // getSessionId unavailable — continue
  }

  const prev = sessionEndpoints.get(sessionId);
  const endpoint: SessionDeliveryEndpoint = {
    sessionId,
    send: stolen,
    loadSettings: opts.loadSettings ?? prev?.loadSettings,
    suspended: false,
    generation: (prev?.generation ?? 0) + 1,
    manager: opts.manager ?? prev?.manager,
  };
  sessionEndpoints.set(sessionId, endpoint);

  if (endpoint.manager) flushSessionDiskPending(endpoint.manager, sessionId, endpoint);
}

/**
 * Suspend delivery for a session. Completions only mark disk pending until
 * {@link bindSessionDelivery} / {@link resumeSessionDelivery} runs again.
 */
export function suspendSessionDelivery(sessionId: string | undefined): void {
  if (!sessionId) return;
  const endpoint = sessionEndpoints.get(sessionId);
  if (endpoint) endpoint.suspended = true;
}

/**
 * Drop endpoint + stolen send for a session that will not come back (quit /
 * discard, or the *old* id after a successful replacement bind). Releases the
 * AgentSession closure retained by the steal map (#109).
 */
export function dropSessionDelivery(sessionId: string | undefined): void {
  if (!sessionId) return;
  sessionEndpoints.delete(sessionId);
  boundSessionSends.delete(sessionId);
}

/**
 * Unsuspend and flush one session's pending deliveries (disk). Prefer
 * {@link bindSessionDelivery} on session_start (also refreshes send).
 */
export function resumeSessionDelivery(sessionId: string | undefined, manager?: WorkflowManager): void {
  if (!sessionId) return;
  const endpoint = sessionEndpoints.get(sessionId);
  if (!endpoint) return;
  endpoint.suspended = false;
  if (manager) endpoint.manager = manager;
  if (endpoint.manager) flushSessionDiskPending(endpoint.manager, sessionId, endpoint);
}

function flushSessionDiskPending(manager: WorkflowManager, sessionId: string, endpoint: SessionDeliveryEndpoint): void {
  if (endpoint.suspended) return;

  const tryOne = (runId: string, marker: PendingDeliveryMarker, run?: ManagedRun, persisted?: PersistedRunState) => {
    if (inFlightDeliveries.has(runId)) return;
    const content = contentForPending(manager, runId, marker, endpoint.loadSettings, run, persisted);
    if (content === undefined) return;
    deliverAndAck(manager, runId, sessionId, content, run);
  };

  // Live in-memory runs for this session. Null sessionId is claimable only for
  // THIS manager's live runs (pre-bind completions) — never from a foreign manager.
  try {
    for (const run of manager.listLiveRuns?.() ?? []) {
      if (!run.pendingDelivery) continue;
      if (run.sessionId != null && run.sessionId !== sessionId) continue;
      if (run.sessionId == null) run.sessionId = sessionId;
      tryOne(run.runId, run.pendingDelivery, run);
    }
  } catch {
    // listLiveRuns may be absent on stubs
  }

  // Disk runs (including terminal runs already evicted from memory). Require an
  // exact sessionId match — do not claim null-sessionId disk rows (same-cwd dual
  // manager race). Handoff re-homes previous-session pendings via adopt first.
  try {
    const persistence = manager.getPersistence?.();
    if (!persistence) return;
    for (const state of persistence.list()) {
      if (!state.pendingDelivery) continue;
      if (state.sessionId !== sessionId) continue;
      // Skip if the live copy still carries the marker — the loop above owns it.
      const live = manager.getRun?.(state.runId);
      if (live?.pendingDelivery) continue;
      tryOne(state.runId, state.pendingDelivery, live, state);
    }
  } catch {
    // best-effort
  }
}

/**
 * Stop live sends for the manager's currently bound session. In-flight
 * completions only leave disk pending until the next bind/resume.
 *
 * Call from session_shutdown BEFORE handoff or discard so a completion that
 * races the teardown cannot deliver into the outgoing session (#143).
 */
export function suspendResultDelivery(manager: WorkflowManager): void {
  suspendSessionDelivery(manager.getSessionId?.());
}

/**
 * Unsuspend and flush queued deliveries for the manager's bound session.
 * Must run only after Pi has finished bindCore (i.e. from session_start).
 * Prefer {@link bindSessionDelivery} which also captures a fresh stable send.
 */
export function resumeResultDelivery(manager: WorkflowManager): void {
  resumeSessionDelivery(manager.getSessionId?.(), manager);
}

/**
 * When a background run finishes (or fails), deliver its result back into the
 * *originating* conversation AND continue the turn so the assistant can act on
 * it — without blocking the user meanwhile:
 *
 *  - Delivery is routed by `run.sessionId` through the process-wide endpoint
 *    registry (never "latest pi wins").
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle.
 *  - `deliverAs: "followUp"` queues behind an in-flight turn — never interrupts.
 *  - Durable pending marker clears only after verified delivery ACK.
 *
 * Set up once per manager; idempotent via an internal guard. Across session
 * replacement the manager (and these listeners) survive via the handoff path;
 * each new generation calls {@link bindSessionDelivery} on session_start.
 */
export function installResultDelivery(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: { loadSettings?: () => WorkflowSettings } = {},
): void {
  const m = deliveryManager(manager);
  m.__deliveryLoadSettings = opts.loadSettings;
  patchAgentSessionCapture();
  patchBindCoreObserve();

  if (m.__deliveryInstalled) {
    // Listeners survive session replacement. Refresh loadSettings / manager
    // pointers only — do NOT mutate send, generation, or suspended here.
    // Factory runs before bindCore; session_start calls bindSessionDelivery.
    const sid = manager.getSessionId?.();
    if (sid) {
      const endpoint = sessionEndpoints.get(sid);
      if (endpoint) {
        endpoint.loadSettings = opts.loadSettings ?? endpoint.loadSettings;
        endpoint.manager = manager;
      }
    }
    return;
  }
  m.__deliveryInstalled = true;

  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    if (!run?.background) return;
    const sessionId = resolveDeliverySessionId(run, manager);
    const endpoint = sessionId ? sessionEndpoints.get(sessionId) : undefined;
    const content = deliverText(run, {
      resultPath: persistedResultPath(manager, runId),
      maxChars: deliveredMaxChars({
        loadSettings: endpoint?.loadSettings ?? m.__deliveryLoadSettings,
      }),
    });
    routeBackgroundDelivery(manager, run, { kind: "complete" }, content);
  });

  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    const run = manager.getRun(runId);
    if (!run?.background) return;
    const text = `✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`;
    routeBackgroundDelivery(manager, run, { kind: "text", text }, text);
  });

  // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
  // user it is resumable once their budget refills, rather than letting it look dead.
  // Manual pause() also emits "paused" but with no reason — guard so only the
  // usage-limit case delivers a message.
  manager.on(
    "paused",
    ({
      runId,
      reason,
      error,
      resetHint,
    }: {
      runId: string;
      reason?: string;
      error?: { message?: string };
      resetHint?: string;
    }) => {
      if (reason !== "usage_limit") return;
      const run = manager.getRun(runId);
      if (!run?.background) return;
      const when = resetHint ? ` (${resetHint})` : "";
      const cause = error?.message ?? "provider usage limit reached";
      const text =
        `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
        `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`;
      routeBackgroundDelivery(manager, run, { kind: "text", text }, text);
    },
  );
}

/** @internal test helper — reset process-wide delivery registries between cases. */
export function _resetDeliveryRegistriesForTests(): void {
  sessionEndpoints.clear();
  boundSessionSends.clear();
  inFlightDeliveries.clear();
}

/** @internal test helper — register a thenable session-stable send (steal map). */
export function _registerBoundSessionSendForTests(sessionId: string, send: DeliverySend): void {
  boundSessionSends.set(sessionId, send);
}

/** @internal test helper — whether the steal map holds a send for this session. */
export function _hasBoundSessionSendForTests(sessionId: string): boolean {
  return boundSessionSends.has(sessionId);
}

/** @internal test helper — inspect endpoint suspended flag. */
export function _getSessionDeliveryEndpointForTests(
  sessionId: string,
): { suspended: boolean; generation: number; hasSend: boolean; hasAppend: boolean } | undefined {
  const ep = sessionEndpoints.get(sessionId);
  if (!ep) return undefined;
  return {
    suspended: ep.suspended,
    generation: ep.generation,
    hasSend: typeof ep.send === "function",
    // Append is never an ACK; kept on the inspect shape so existing tests compile.
    hasAppend: false,
  };
}

export function renderPanel(manager: WorkflowManager, theme: Theme, width?: number): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const rows = active.map((r) => {
    const live = manager.getRun(r.runId);
    const agents = live?.snapshot.agents ?? r.agents;
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const phase = live?.snapshot.currentPhase ? ` · ${live.snapshot.currentPhase}` : "";
    return `  ${icon} ${r.workflowName}  ${done}/${agents.length} agents${phase}`;
  });
  // Finished runs leave this live panel but are kept in the navigator. Tell the
  // user so a completed run doesn't look like it vanished.
  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  const hint = theme.fg(
    "dim",
    finished > 0
      ? `  /workflows — open navigator (${finished} finished kept in history)`
      : "  /workflows — open navigator",
  );
  return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint].map((line) => fitLine(line, width));
}

// ─── Detailed mode: live token rate ────────────────────────────────────────────

/** Rolling window for the token/s rate. Older samples age out so a stall decays to 0. */
const RATE_WINDOW_MS = 10_000;
/** Per-run (timestamp, cumulative total) samples, keyed by the persisted runId so
 *  the rolling rate survives pause→resume. Cleared when a run ends. */
const tokenSamples = new Map<string, Array<{ ts: number; total: number }>>();

/** Record a token-total sample for `runId` at time `now` (ms). */
export function sampleTokens(runId: string, total: number, now: number): void {
  const samples = tokenSamples.get(runId) ?? [];
  const last = samples[samples.length - 1];
  // Collapse repeat renders within the same instant (e.g. width recalcs).
  if (last && last.ts === now && last.total === total) return;
  samples.push({ ts: now, total });
  // Drop samples beyond the rolling window, always keeping ≥2 so a rate is computable.
  while (samples.length > 2 && now - samples[0].ts > RATE_WINDOW_MS) samples.shift();
  tokenSamples.set(runId, samples);
}

/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export function tokensPerSecond(runId: string): number {
  const samples = tokenSamples.get(runId);
  if (!samples || samples.length < 2) return 0;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedMs = newest.ts - oldest.ts;
  if (elapsedMs <= 0) return 0;
  const delta = newest.total - oldest.total;
  if (delta <= 0) return 0;
  return (delta / elapsedMs) * 1000;
}

/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export function clearTokenSamples(runId: string): void {
  tokenSamples.delete(runId);
}

/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export function clampMaxAgents(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 8;
  return Math.min(1000, Math.floor(value));
}

/** Per-phase + per-agent body for one run in detailed mode (mirrors renderWorkflowLines). */
function renderRunBody(
  snap: WorkflowSnapshot,
  agents: WorkflowAgentSnapshot[],
  maxAgents: number,
  theme: Theme,
): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const lines: string[] = [];
  // Group agents by phase, declared order first then discovery order (as the navigator does).
  const order = snap.phases.length ? [...snap.phases] : [];
  const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
  for (const a of agents) {
    const key = a.phase ?? "(no phase)";
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)?.push(a);
    if (!order.includes(key)) order.push(key);
  }
  for (const title of order) {
    const phaseAgents = byPhase.get(title) ?? [];
    if (!phaseAgents.length) continue;
    const done = phaseAgents.filter((a) => a.status === "done").length;
    const running = phaseAgents.filter((a) => a.status === "running").length;
    const errors = phaseAgents.filter((a) => a.status === "error").length;
    const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
    const complete = done + errors + skipped === phaseAgents.length;
    const marker = running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
    const phaseMeta = [
      `${done}/${phaseAgents.length} agents`,
      running ? `${running} running` : "",
      errors ? `${errors} errors` : "",
      fmtTokenSegment(aggregateAgentUsage(phaseAgents), fmtTokensShort),
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(theme.fg("accent", `  ${marker} ${title}`) + dim(`  ${phaseMeta}`));

    const visible = phaseAgents.slice(-maxAgents);
    for (const a of visible) {
      const segment = fmtTokenSegment(tokenFigures(a.tokenUsage, a.tokens), fmtTokensShort);
      const tok = segment ? dim(` ${segment}`) : "";
      const mdl = shortModel(a.model);
      const model = mdl ? dim(` · ${mdl}`) : "";
      lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${tok}${model}`);
    }
    if (phaseAgents.length > visible.length) {
      lines.push(dim(`    … ${phaseAgents.length - visible.length} earlier agents`));
    }
  }
  return lines;
}

/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export function renderPanelDetailed(
  manager: WorkflowManager,
  theme: Theme,
  width: number | undefined,
  maxAgents: number,
  now: number,
): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const dim = (t: string) => theme.fg("dim", t);
  const out: string[] = [theme.bold(`Workflows running (${active.length}):`)];

  for (const r of active) {
    const live = manager.getRun(r.runId);
    const snap = live?.snapshot;
    const agents = (snap?.agents ?? r.agents) as WorkflowAgentSnapshot[];
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const usage = snap?.tokenUsage ?? r.tokenUsage;
    // The run-level tokenUsage aggregate is only finalized when the run ends, so
    // it reads 0 for the whole live run; per-agent figures update on each agent
    // completion, so aggregate those instead. The rate samples the same
    // fresh+cacheRead sum the header displays, so tok/s tracks the visible
    // figures. Tokens land at agent-completion granularity, so the rate reflects
    // completion throughput — it decays to 0 during a single long-running agent
    // or a stall (which is the intended signal). Paused runs don't accrue
    // tokens, so their rate is suppressed (a stalled rate would mislead).
    const runUsage = aggregateAgentUsage(agents);
    sampleTokens(r.runId, runUsage.fresh + runUsage.cacheRead, now);
    const rate = r.status === "running" ? tokensPerSecond(r.runId) : 0;
    const meta = [
      `${done}/${agents.length} agents`,
      snap?.currentPhase || "",
      fmtTokenSegment(runUsage, fmtTokensShort),
      // (cost is only known once the run finalizes its usage.)
      usage?.cost ? fmtCost(usage.cost) : "",
      rate > 0 ? `${Math.round(rate)} tok/s` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${icon} ${theme.bold(r.workflowName)}  ${dim(meta)}`);
    if (snap) out.push(...renderRunBody(snap, agents, maxAgents, theme));
  }

  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  out.push(
    dim(
      finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator",
    ),
  );
  return out.map((line) => fitLine(line, width));
}

/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export function installTaskPanel(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: TaskPanelOptions = {},
): void {
  // Live-read settings with a ~1s TTL: a render-path disk read every frame would
  // be wasteful, but re-reading at most once a second still makes
  // /workflows-progress take effect "immediately" (no restart).
  let cached: WorkflowSettings = {};
  let cachedAt = Number.NEGATIVE_INFINITY;
  const settings = (): WorkflowSettings => {
    if (!opts.loadSettings) return cached;
    const now = Date.now();
    if (now - cachedAt > 1000) {
      try {
        cached = opts.loadSettings() ?? {};
      } catch {
        cached = {};
      }
      cachedAt = now;
    }
    return cached;
  };
  const hasActiveRun = () => manager.listRuns().some((r) => r.status === "running" || r.status === "paused");

  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      const onEvent = () => tui.requestRender();
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      const onRunEnd = ({ runId }: { runId: string }) => clearTokenSamples(runId);
      for (const ev of RUN_END_EVENTS) manager.on(ev, onRunEnd);
      // In detailed mode, force a redraw every 2s while a run is active so the
      // token/s rate keeps updating between sparse token events — and decays to 0
      // when an agent stalls. Gated + unref'd so it costs nothing when idle.
      const timer = setInterval(() => {
        if (settings().progressPanelMode === "detailed" && hasActiveRun()) tui.requestRender();
      }, 2000);
      (timer as { unref?: () => void }).unref?.();
      // Purely informational: it lists running runs and re-renders on events. To
      // open the navigator, the user runs /workflows (the panel takes no input).
      const comp: Component & { dispose?(): void } = {
        render: (width: number) => {
          const s = settings();
          if (s.progressPanelMode === "detailed") {
            return renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), Date.now());
          }
          return renderPanel(manager, theme, width);
        },
        invalidate: () => {},
        dispose: () => {
          clearInterval(timer);
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
          for (const ev of RUN_END_EVENTS) manager.off(ev, onRunEnd);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
