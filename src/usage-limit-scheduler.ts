/**
 * Auto-resume for runs paused on a provider usage limit.
 *
 * A workflow run pauses (does not fail) when a provider quota/usage limit is hit
 * (see errors.ts PROVIDER_USAGE_LIMIT, workflow-manager.ts executeRun()'s catch
 * block). Left alone, the run just sits there until a human runs /workflows and
 * hits resume. This module watches the manager's public event stream and, for
 * runs that are auto-resume-eligible, arms a timer to call manager.resume() once
 * the provider's quota is likely to have refilled — with exponential backoff if
 * it keeps hitting the wall, and a hard attempt cap so it never retries forever.
 *
 * Seam note: the authoritative attempt counter lives in memory here and on
 * ManagedRun/persisted records (written through recordAutoResumeAttempts); the
 * two can drift briefly when the manager's lease-guarded disk merge skips on
 * contention — harmless, since the owning process then persists the record.
 *
 * Deliberately standalone: it consumes ONLY WorkflowManager's public surface
 * (on/off, listAllRuns, resume, getPersistence, recordAutoResumeAttempts) so it
 * stays decoupled from manager/persistence internals. It owns its own timers
 * and its own bookkeeping (in-memory, best-effort persisted) — it does not
 * rely on manager.stop(), which only operates on in-memory runs.
 */

import type { PersistedRunState, RunPersistence, RunStatus } from "./run-persistence.js";
import { sanitizeAutoResumeAttempts } from "./run-persistence.js";

/** Narrow surface this scheduler depends on — satisfied by WorkflowManager. */
export interface SchedulableWorkflowManager {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  listAllRuns(): PersistedRunState[];
  resume(runId: string): Promise<boolean>;
  getPersistence(): RunPersistence;
  /**
   * Record the auto-resume backoff counter THROUGH the manager so the next
   * manager persist carries it — a raw persistence.save side-channel gets
   * erased by writeRunToDisk (#207).
   */
  recordAutoResumeAttempts(runId: string, attempts: number): void;
}

/** Opaque timer handle so tests can inject a fake clock/timer. */
export type TimerHandle = unknown;

export interface UsageLimitSchedulerOptions {
  /** Injectable clock (default Date.now). */
  now?: () => number;
  /** Injectable timer scheduler (default setTimeout). */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable timer canceller (default clearTimeout). */
  clearTimer?: (handle: TimerHandle) => void;
  /** Max auto-resume attempts per pause-cycle before giving up. Default 5. */
  maxAttempts?: number;
  /** Delay floor — never arm sooner than this. Default 60_000 (1m). */
  minDelayMs?: number;
  /** Delay used when the provider's resetHint can't be parsed. Default 300_000 (5m). */
  fallbackDelayMs?: number;
  /** Delay ceiling — backoff is clamped here. Default 6h. */
  maxDelayMs?: number;
  /**
   * Jitter ratio applied to every armed delay (default 0.1 = ±10%): runs paused
   * by the same quota event would otherwise all auto-resume in the same timer
   * batch (audit2 #13). Set 0 for deterministic tests.
   */
  jitterRatio?: number;
  /** Injectable randomness for jitter (default Math.random). */
  random?: () => number;
  /**
   * Consecutive refused-resume re-arms before giving up (default 10): a refused
   * resume() isn't a real attempt (lease held elsewhere, structural refusal),
   * but polling it forever re-arms an un-backed-off 60s loop for the run's
   * lifetime (audit2 #12).
   */
  maxRefusals?: number;
  /** Diagnostics sink; defaults to console.warn. Never throws back into the caller. */
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

interface RunState {
  /** How many auto-resume attempts have been made (or armed) for this pause-cycle. */
  attempts: number;
  /** Consecutive resume() refusals (structural, not real attempts) — capped separately. */
  refusals?: number;
  /** The currently armed timer, if any. */
  timer?: TimerHandle;
  /** Set once the attempt cap is hit, so the give-up diagnostic logs once. */
  gaveUp?: boolean;
}

const DEFAULT_MAX_REFUSALS = 10;

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MIN_DELAY_MS = 60_000;
const DEFAULT_FALLBACK_DELAY_MS = 300_000;
const DEFAULT_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

/**
 * Best-effort parse of a provider's human reset hint ("Resets in ~3h",
 * "resets in 5m", "in 90s", "1h30m") into milliseconds. Sums every
 * (number, unit) pair found, so combined forms like "1h30m" work for free.
 * Returns undefined when nothing recognizable is found — callers should fall
 * back to a fixed delay rather than guess.
 */
export function parseResetHintMs(hint?: string, nowMs: number = Date.now()): number | undefined {
  if (!hint) return undefined;
  // Absolute forms providers actually emit, e.g. "It will reset at 2026-09-17
  // 13:20:54 +0800 CST" (Ark/Codex quota messages) or "Try again at 3:20 PM".
  const absoluteIso =
    /(?:resets?|resetting|try again)\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:[+-]\d{2}:?\d{2}|Z))?)/i.exec(
      hint,
    );
  if (absoluteIso) {
    // Canonicalize for Date.parse: single T separator, no whitespace before the
    // offset, bare Z kept (dropping it would silently re-interpret UTC as local).
    const canonical = absoluteIso[1]
      .replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2})/, "$1T$2")
      .replace(/\s+([+-]\d{2}:?\d{2}|Z)$/i, "$1");
    const ts = Date.parse(canonical);
    // An absolute match that fails to parse must NOT fall through to the
    // relative scan — an unrelated quantity elsewhere in the message
    // ("Retry-After: 600 seconds") would be returned instead of the fallback.
    return Number.isFinite(ts) ? Math.max(0, ts - nowMs) : undefined;
  }
  const absoluteClock = /(?:resets?|resetting|try again)\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)\b/i.exec(hint);
  if (absoluteClock) {
    const clockHour = Number.parseInt(absoluteClock[1], 10);
    const minute = Number.parseInt(absoluteClock[2], 10);
    if (clockHour < 1 || clockHour > 12 || minute > 59) return undefined;
    let hour = clockHour % 12;
    if (absoluteClock[3].toUpperCase() === "PM") hour += 12;
    const target = new Date(nowMs);
    target.setHours(hour, minute, 0, 0);
    // An explicit date elsewhere in the hint ("… at 3:20 PM on 2026-09-20")
    // pins the day; otherwise roll over to tomorrow only when the time is
    // unambiguously past (minute-truncated hints delivered within the same
    // minute must not roll a full day).
    const explicitDate = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(hint);
    if (explicitDate) {
      target.setFullYear(
        Number.parseInt(explicitDate[1], 10),
        Number.parseInt(explicitDate[2], 10) - 1,
        Number.parseInt(explicitDate[3], 10),
      );
    } else if (target.getTime() + 60_000 <= nowMs) {
      target.setDate(target.getDate() + 1);
    }
    return Math.max(0, target.getTime() - nowMs);
  }
  // No trailing \b: combined forms like "1h30m" have a digit right after the
  // unit letter, which is itself a word character, so \b would never match
  // there. A negative lookahead for another letter is the correct boundary —
  // it still stops "hours" from partially matching as bare "h" mid-word while
  // allowing a unit to be followed immediately by the next (digit, unit) pair.
  const re = /(\d+(?:\.\d+)?)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
  let match: RegExpExecArray | null;
  let totalMs = 0;
  let found = false;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = re.exec(hint)) !== null) {
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) continue;
    const unit = match[2].toLowerCase();
    found = true;
    if (unit.startsWith("w")) totalMs += value * 7 * 86_400_000;
    else if (unit.startsWith("d")) totalMs += value * 86_400_000;
    else if (unit.startsWith("h")) totalMs += value * 3_600_000;
    else if (unit.startsWith("m")) totalMs += value * 60_000;
    else if (unit.startsWith("s")) totalMs += value * 1_000;
  }
  return found ? totalMs : undefined;
}

export interface AutoResumeDelayParams {
  /** The provider's verbatim reset hint for this pause, if any. */
  resetHint?: string;
  /** Clock reading for anchoring absolute reset hints (default Date.now()). */
  nowMs?: number;
  /** Jitter ratio applied BEFORE the min/max clamp (default 0 = no jitter). */
  jitterRatio?: number;
  /** Randomness source for jitter (default Math.random). */
  random?: () => number;
  /** 1-indexed attempt number for the pause currently being armed. */
  attempts: number;
  /** Milliseconds already elapsed since the pause began (0 for a live pause). */
  elapsedMs: number;
  minDelayMs: number;
  fallbackDelayMs: number;
  maxDelayMs: number;
}

/**
 * Compute the original capped, jittered arm delay, then subtract time elapsed
 * since that pause. Applying elapsed before backoff would multiply elapsed too,
 * and applying it before the cap would restart a capped wait after every restart.
 * The exponent is capped defensively so a pathological attempt count can't
 * overflow the multiplication to Infinity/NaN before the maxDelayMs clamp runs.
 */
export function computeAutoResumeDelayMs(params: AutoResumeDelayParams): number {
  const base = parseResetHintMs(params.resetHint, params.nowMs) ?? params.fallbackDelayMs;
  const exponent = Math.min(Math.max(params.attempts - 1, 0), 30);
  const backoff = base * 2 ** exponent;
  // Jitter BEFORE the clamp so the documented minDelayMs floor and maxDelayMs
  // ceiling both still hold on the armed delay.
  const jr = params.jitterRatio ?? 0;
  const rand = params.random ?? Math.random;
  const jittered = jr > 0 ? backoff * (1 - jr + rand() * 2 * jr) : backoff;
  const clamped = Math.min(params.maxDelayMs, Math.max(params.minDelayMs, jittered));
  // A clamped-to-ceiling delay is identical for every run paused by the same
  // quota event (the herd audit2 #13 targets): whenever the JITTERED value
  // reaches the cap (backoff exactly at the cap included — its upper jitter
  // half would otherwise pile up as a point mass), spread it downward-only,
  // keeping the ceiling intact while decorrelating the arms. Ceiling hits draw
  // a second random sample; sub-ceiling arms use exactly one.
  const initialDelay =
    jr > 0 && jittered >= params.maxDelayMs
      ? Math.max(params.minDelayMs, Math.round(params.maxDelayMs * (1 - jr * rand())))
      : Math.round(clamped);
  return Math.max(params.minDelayMs, Math.round(initialDelay - Math.max(0, params.elapsedMs)));
}

/**
 * Watches a WorkflowManager for usage-limit pauses and auto-resumes eligible
 * runs once the provider's quota is likely to have refilled.
 *
 * Event-driven "fire and watch": an attempt is consumed when a run ENTERS a
 * usage_limit pause (live via the "paused" event, or once at cold start for a
 * run that was already paused), never when a resume is merely fired. When an
 * armed timer fires, resume() is called; if it returns false (lease busy, run
 * already gone, etc.) no attempt is consumed and a short un-backed-off retry is
 * armed instead, unless the run has reached a terminal state on disk. If resume()
 * returns true, this scheduler steps back — the existing "paused" subscription
 * re-arms with backoff if the run hits the wall again, and "complete"/"error"/
 * "stopped" clean up its timer.
 */
export class UsageLimitScheduler {
  private readonly manager: SchedulableWorkflowManager;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly maxAttempts: number;
  private readonly minDelayMs: number;
  private readonly fallbackDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly maxRefusals: number;
  private readonly diagnostic: (message: string, detail?: unknown) => void;

  private readonly state = new Map<string, RunState>();
  private disposed = false;
  /**
   * Runs this scheduler is currently auto-resuming (its own timer fired). Used to
   * tell an auto-resume's "resumed" event apart from a manual one: an auto-resume
   * must keep the backoff counter (it IS the backoff), a manual resume resets it.
   */
  private readonly autoResumingRunIds = new Set<string>();

  private readonly onPaused = (event: { runId?: string; reason?: string; resetHint?: string }): void => {
    this.safe(() => this.handlePaused(event));
  };
  private readonly onTerminal = (event: { runId?: string }): void => {
    this.safe(() => this.cleanup(event?.runId));
  };
  private readonly onResumed = (event: { runId?: string }): void => {
    this.safe(() => this.handleResumed(event));
  };

  constructor(manager: SchedulableWorkflowManager, options: UsageLimitSchedulerOptions = {}) {
    this.manager = manager;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.fallbackDelayMs = options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.jitterRatio = options.jitterRatio ?? 0.1;
    this.random = options.random ?? Math.random;
    this.maxRefusals = options.maxRefusals ?? DEFAULT_MAX_REFUSALS;
    this.diagnostic =
      options.onDiagnostic ??
      ((message, detail) => {
        console.warn(message, detail ?? "");
      });

    this.manager.on("paused", this.onPaused);
    this.manager.on("resumed", this.onResumed);
    this.manager.on("complete", this.onTerminal);
    this.manager.on("error", this.onTerminal);
    this.manager.on("stopped", this.onTerminal);

    // Cold-start re-arm: pick up any run that was already paused-on-usage_limit
    // before this process (and thus this scheduler instance) existed.
    this.safe(() => this.coldStartRearm());
  }

  /** Clear every armed timer and unsubscribe from the manager. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.manager.off("paused", this.onPaused);
    this.manager.off("resumed", this.onResumed);
    this.manager.off("complete", this.onTerminal);
    this.manager.off("error", this.onTerminal);
    this.manager.off("stopped", this.onTerminal);
    for (const entry of this.state.values()) {
      if (entry.timer !== undefined) this.clearTimer(entry.timer);
    }
    this.state.clear();
  }

  /** Test/diagnostic helper: in-memory attempt count tracked for a run, if any. */
  getAttemptCount(runId: string): number | undefined {
    return this.state.get(runId)?.attempts;
  }

  /** Test/diagnostic helper: whether a resume timer is currently armed for a run. */
  hasArmedTimer(runId: string): boolean {
    return this.state.get(runId)?.timer !== undefined;
  }

  // ---- event handlers -----------------------------------------------------

  private handlePaused(event: { runId?: string; reason?: string; resetHint?: string }): void {
    if (this.disposed || !event?.runId || event.reason !== "usage_limit") return;
    const runId = event.runId;

    // The "paused" event fires BEFORE the manager's own persistRun() write for
    // this pause (see executeRun()'s catch block: emit then persist). A disk
    // read here can therefore be stale for fields this exact pause is about to
    // set (status/pauseReason/resetHint) — but NOT for `autoResume`, which is
    // fixed at run-start and persisted on every persistRun() call since, so a
    // stale read of it is still correct. resetHint comes off the event itself,
    // not disk, to avoid that race.
    const persisted = this.safeLoad(runId);
    if (persisted?.autoResume === false) {
      this.diagnostic(`[usage-limit-scheduler] ${runId}: autoResume is disabled for this run, not arming`);
      return;
    }

    // Validate the persisted counter too (corrupt/foreign JSON): an invalid
    // value would defeat the give-up cap and produce NaN timer delays.
    const priorAttempts =
      this.state.get(runId)?.attempts ?? sanitizeAutoResumeAttempts(persisted?.autoResumeAttempts) ?? 0;
    // arm() overwrites RunState wholesale on both its paths, so any refusal
    // count from a previous pause cycle is reset by construction.
    this.arm(runId, {
      attempts: priorAttempts + 1,
      resetHint: event.resetHint ?? persisted?.resetHint,
      elapsedMs: 0,
    });
  }

  private cleanup(runId?: string): void {
    if (!runId) return;
    const entry = this.state.get(runId);
    if (entry?.timer !== undefined) this.clearTimer(entry.timer);
    this.state.delete(runId);
  }

  /**
   * A run was resumed. If WE resumed it (auto-resume timer fired), leave the
   * backoff counter alone — that's the sequence doing its job, and it must still
   * be able to reach the cap. If a human resumed it (via /workflows), treat that
   * as a deliberate fresh start: drop the in-memory given-up state and reset the
   * persisted counter so a later pause re-enters the normal backoff from attempt 1
   * instead of staying silently given-up forever.
   */
  private handleResumed(event: { runId?: string }): void {
    if (this.disposed || !event?.runId) return;
    if (this.autoResumingRunIds.has(event.runId)) return;
    this.cleanup(event.runId);
    this.persistAttempts(event.runId, 0);
  }

  private coldStartRearm(): void {
    const runs = this.manager.listAllRuns();
    for (const run of runs) {
      if (run.status !== "paused" || run.pauseReason !== "usage_limit") continue;
      if (run.autoResume === false) continue;
      if (this.state.has(run.runId)) continue;

      // Validate the persisted counter: a corrupt/foreign value (NaN, string,
      // negative) would defeat the give-up cap and produce NaN timer delays.
      const priorAttempts = sanitizeAutoResumeAttempts(run.autoResumeAttempts) ?? 0;
      // A persisted value past the cap is the frozen give-up sentinel
      // (maxAttempts + 1, see arm()): that run already gave up BEFORE the
      // restart — skip it silently instead of re-logging the give-up diagnostic
      // on every cold start (#106, kept under the no-drift rearm of audit2 #11).
      if (priorAttempts > this.maxAttempts) continue;
      const updatedAtMs = Date.parse(run.updatedAt);
      const elapsedMs = Number.isFinite(updatedAtMs) ? Math.max(0, this.now() - updatedAtMs) : 0;
      // Re-arm the ALREADY-COUNTED attempt, not the next one: the counter is
      // persisted at arm time, so the armed attempt never fired if the process
      // died. Bumping it on every construction would burn the give-up budget
      // on mere restarts (/new, /resume, a second window) without any real
      // retry having happened (audit2 #11).
      this.arm(run.runId, {
        attempts: Math.max(priorAttempts, 1),
        resetHint: run.resetHint,
        elapsedMs,
      });
    }
  }

  // ---- arming / firing ------------------------------------------------------

  private arm(runId: string, params: { attempts: number; resetHint?: string; elapsedMs: number }): void {
    const existing = this.state.get(runId);
    if (existing?.timer !== undefined) this.clearTimer(existing.timer);

    if (params.attempts > this.maxAttempts) {
      const alreadyLogged = existing?.gaveUp === true;
      // Freeze the counter at a single sentinel (maxAttempts + 1) instead of
      // storing the raw overflow. coldStartRearm() reads the persisted count and
      // adds 1 on every restart; without this clamp a given-up run's counter
      // grew without bound (…6, 7, 8… → "giving up after 23") across cold starts
      // (#106). Clamping makes the persisted value idempotent — a rearm of an
      // already-given-up run rewrites the same 6.
      const frozen = this.maxAttempts + 1;
      this.state.set(runId, { attempts: frozen, gaveUp: true });
      this.persistAttempts(runId, frozen);
      // Log the give-up exactly once per crossing. In-process the gaveUp flag
      // guards it; across restarts a fresh scheduler has no memory, so also
      // suppress when this arm is merely re-giving-up an already-capped run
      // (params.attempts already past the sentinel, i.e. prior was ≥ frozen).
      if (!alreadyLogged && params.attempts <= frozen) {
        this.diagnostic(
          `[usage-limit-scheduler] ${runId}: giving up after ${this.maxAttempts} auto-resume attempt(s) ` +
            `(max ${this.maxAttempts}); leaving paused for manual resume`,
        );
      }
      return;
    }

    // nowMs is anchored at PAUSE time (now - elapsed), not arm time: an
    // absolute hint parses to (resetTime - anchor) and the elapsed subtraction
    // then yields the true remaining (resetTime - now). Anchoring at arm time
    // would double-subtract elapsedMs on the cold-start path.
    const anchorMs = this.now() - params.elapsedMs;
    const delay = computeAutoResumeDelayMs({
      resetHint: params.resetHint,
      attempts: params.attempts,
      elapsedMs: params.elapsedMs,
      minDelayMs: this.minDelayMs,
      fallbackDelayMs: this.fallbackDelayMs,
      maxDelayMs: this.maxDelayMs,
      nowMs: anchorMs,
      jitterRatio: this.jitterRatio,
      random: this.random,
    });

    const timer = this.setTimer(() => this.safe(() => this.onTimerFire(runId)), delay);
    this.state.set(runId, { attempts: params.attempts, timer });
    this.persistAttempts(runId, params.attempts);
  }

  private async onTimerFire(runId: string): Promise<void> {
    if (this.disposed) return;
    const entry = this.state.get(runId);
    if (!entry || entry.gaveUp) return;
    // The timer that just fired is spent; clear its handle while we await.
    this.state.set(runId, { ...entry, timer: undefined });

    let resumed = false;
    // Mark this as OUR resume so handleResumed() (fired synchronously inside
    // resume(), before it returns) doesn't mistake it for a manual resume and
    // reset the backoff counter mid-sequence.
    this.autoResumingRunIds.add(runId);
    try {
      resumed = await this.manager.resume(runId);
    } catch (err) {
      this.diagnostic(`[usage-limit-scheduler] ${runId}: resume() threw`, err);
      resumed = false;
    } finally {
      this.autoResumingRunIds.delete(runId);
    }
    if (this.disposed) return;

    if (resumed) {
      // Don't consume/advance anything further here — the existing "paused"
      // subscription re-arms (with backoff) if this run hits the wall again,
      // and "complete"/"error"/"stopped" clean up on any terminal outcome.
      return;
    }

    // resume() returned false without throwing: it refused for a structural
    // reason (already running/aborted, no persisted script, or the lease is
    // held elsewhere) rather than a real failed attempt. Per the fix for bug
    // (a), that must NOT consume an attempt. Distinguish "gone for good" from
    // "try again shortly":
    const status = this.safeStatus(runId);
    if (status === undefined || status === "completed" || status === "aborted") {
      this.cleanup(runId);
      return;
    }

    const current = this.state.get(runId) ?? entry;
    // A refusal is not an attempt (bug (a) — it doesn't consume the backoff
    // budget), but it must not poll forever either: cap consecutive refusals
    // (audit2 #12 — otherwise a lease held by another window means an
    // un-backed-off 60s poll for the rest of the run's lifetime).
    const refusals = (current.refusals ?? 0) + 1;
    if (refusals > this.maxRefusals) {
      this.diagnostic(
        `[usage-limit-scheduler] ${runId}: giving up after ${refusals} refused auto-resume poll(s); leaving paused for manual resume`,
      );
      this.cleanup(runId);
      return;
    }
    const timer = this.setTimer(() => this.safe(() => this.onTimerFire(runId)), this.minDelayMs);
    this.state.set(runId, { ...current, refusals, timer });
  }

  // ---- helpers --------------------------------------------------------------

  private safeLoad(runId: string): PersistedRunState | undefined {
    try {
      const persistence = this.manager.getPersistence();
      return (persistence.loadPreview ? persistence.loadPreview(runId) : persistence.load(runId)) ?? undefined;
    } catch (err) {
      this.diagnostic(`[usage-limit-scheduler] ${runId}: persistence load failed`, err);
      return undefined;
    }
  }

  private safeStatus(runId: string): RunStatus | undefined {
    try {
      return this.manager.listAllRuns().find((r) => r.runId === runId)?.status;
    } catch (err) {
      this.diagnostic(`[usage-limit-scheduler] ${runId}: listAllRuns() failed`, err);
      return undefined;
    }
  }

  /**
   * Best-effort persist of the in-memory attempt counter, so a cold start after
   * a crash can approximately resume the backoff sequence instead of restarting
   * it. Goes through the manager, which owns the field: for a live run it sets
   * ManagedRun.autoResumeAttempts so every later writeRunToDisk carries it
   * (#207); for a disk-only run it merges the persisted record under a lease.
   * Synchronous is safe: the manager write is atomic in-process, and the
   * pause-settle persist that follows this event reads the live field.
   */
  private persistAttempts(runId: string, attempts: number): void {
    if (this.disposed) return;
    try {
      this.manager.recordAutoResumeAttempts(runId, attempts);
    } catch (err) {
      this.diagnostic(`[usage-limit-scheduler] ${runId}: failed to persist autoResumeAttempts`, err);
    }
  }

  private safe(fn: () => void | Promise<void>): void {
    try {
      const result = fn();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err: unknown) => {
          this.diagnostic("[usage-limit-scheduler] async handler error", err);
        });
      }
    } catch (err) {
      this.diagnostic("[usage-limit-scheduler] handler error", err);
    }
  }
}
