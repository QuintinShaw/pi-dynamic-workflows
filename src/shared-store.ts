/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: callers capture `store.commitDelta(deltaKey)` alongside
 * each agent result in the journal. On resume, `store.applyDelta(delta)` rebuilds
 * the store state additively in callSeq order, so parallel-agent writes are
 * replayed correctly without the last-complete-wins ordering bug that a
 * whole-Map restore() would cause. Known limitation: when two PARALLEL agents
 * write the SAME key, live resolution follows last-WRITE order while replay
 * follows callSeq order, so the final value can differ between live and resume
 * (the deltas themselves are journaled and replayed faithfully; only the
 * same-key ordering is not reconstructible).
 *
 * Aliasing (#208): values are structured-cloned on write AND on read, so a
 * caller can never mutate store state through a live reference — the journaled
 * delta and any rollback-restored value always match what resume replays.
 * Values must be structured-cloneable (functions/symbols throw at write time)
 * AND JSON-serializable for journal persistence (BigInt/cycles fail that) —
 * the two classes overlap but differ; both constraints apply.
 *
 * `deltaKey` must be unique across every run that shares this store instance,
 * not just within one run's callSeq. A nested `workflow()` call restarts its own
 * callSeq at 0 while inheriting the parent's store (so parent and nested-run
 * agents can share state), so a bare callIndex would collide between a parent
 * agent and a concurrently-running nested-run agent that both got index 0 —
 * whichever commits its delta last would clobber the other's entry in
 * `agentDeltas`. Callers compose `deltaKey` as `${runId}:${callIndex}`, and
 * since every run (including each nested run) gets its own distinct `runId`,
 * the composite key is unique across the whole store's lifetime.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export class SharedStore {
  private readonly map = new Map<string, unknown>();
  // Per-agent write deltas for delta-journaling; keyed by a run-unique
  // `${runId}:${callIndex}` string (see class doc) so nested workflow() runs
  // sharing this store can't collide on a bare callIndex.
  private readonly agentDeltas = new Map<string, Record<string, unknown>>();
  // Per-key write history implementing event-log undo semantics for
  // discardDelta (#208): each tracked write pushes an entry tagged with its
  // window; untracked put()/applyDelta() writes push untagged entries that no
  // discard can remove. Discarding a window removes ITS entries, and the
  // visible value recomputes as the last surviving write (or the captured
  // base). Value/stamp comparisons cannot express this: a sibling's overwrite
  // with an Object.is-equal value is still a write that must survive, and a
  // discarded window's shadow must never resurface — the log makes both
  // exact. Retention is bounded per key by the number of DISTINCT live windows
  // plus one permanent entry: trackPut keeps only its window's latest entry
  // (moved to the top, preserving last-write order), and compaction (see
  // compactHistory) drops everything below the topmost permanent write.
  private readonly keyHistories = new Map<string, { writes: Array<{ window?: string; value: unknown }> }>();

  private historyFor(key: string) {
    let history = this.keyHistories.get(key);
    if (!history) {
      history = { writes: [] };
      this.keyHistories.set(key, history);
    }
    return history;
  }

  /**
   * Drop entries below the topmost untagged (permanent) write: an untagged
   * entry can never be removed by a discard, so everything below it is
   * unobservable and would otherwise grow the log without bound (#208 M1).
   */
  private compactHistory(history: { writes: Array<{ window?: string; value: unknown }> }): void {
    let floor = -1;
    for (let i = history.writes.length - 1; i >= 0; i--) {
      if (history.writes[i].window === undefined) {
        floor = i;
        break;
      }
    }
    if (floor > 0) history.writes = history.writes.slice(floor);
  }

  /** Recompute a key's visible value as its last surviving write (or absent). */
  private recompute(key: string, history: { writes: Array<{ value: unknown }> }): void {
    const top = history.writes.at(-1);
    if (top) this.map.set(key, top.value);
    else this.map.delete(key);
    if (history.writes.length === 0) this.keyHistories.delete(key);
  }

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    // Untracked (direct-API) write: survives every window discard. One clone,
    // shared by the log entry and the map (recompute relies on that sharing),
    // so caller-side mutation can never alias into the store (#208).
    const stored = structuredClone(value);
    const history = this.historyFor(key);
    history.writes.push({ value: stored });
    this.compactHistory(history);
    this.map.set(key, stored);
  }

  /**
   * Store a value and record the write in the per-agent delta for `deltaKey`
   * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
   * per-agent tools created via `createAgentStoreTools` so that each agent's
   * writes can be journaled and replayed independently.
   */
  trackPut(key: string, value: unknown, deltaKey: string): void {
    // A non-string deltaKey would tag the entry window === undefined — PERMANENT,
    // un-rollbackable — and key the delta map with "undefined". Refuse it.
    if (typeof deltaKey !== "string") {
      throw new TypeError(`trackPut requires a string deltaKey, got ${String(deltaKey)}`);
    }
    // Clone both copies BEFORE any state mutation: a throwing second clone
    // (hostile getter) must not leave a live write with an empty delta, which
    // no discard could roll back.
    const stored = structuredClone(value);
    const journaled = structuredClone(stored);
    const history = this.historyFor(key);
    // Keep only this window's LATEST entry, moved to the top: a discard removes
    // every entry of the window anyway, so earlier same-window entries are never
    // observable, and the entry's position must reflect last-write order. This
    // bounds the per-key log by the number of DISTINCT live windows (plus one
    // permanent entry), even under interleaved writes.
    history.writes = history.writes.filter((write) => write.window !== deltaKey);
    history.writes.push({ window: deltaKey, value: stored });
    this.map.set(key, stored);
    let delta = this.agentDeltas.get(deltaKey);
    if (!delta) {
      delta = {};
      this.agentDeltas.set(deltaKey, delta);
    }
    // defineProperty, not assignment: "__proto__" (or any prototype-setter key)
    // must register as an OWN enumerable property so the Object.keys(delta)
    // loops in commitDelta/discardDelta see it; JSON round-trips it fine.
    // A second, separate clone for the journaled delta: commitDelta hands the
    // delta to the caller, so it must not share references with store state.
    Object.defineProperty(delta, key, {
      value: journaled,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  /**
   * Retrieve a structured CLONE of the value for `key`, or `undefined` when
   * absent. Callers receive their own copy: in-place mutation through the
   * returned reference must never leak into the store, the journaled delta,
   * or a value a later rollback restores (#208).
   */
  get(key: string): unknown {
    return structuredClone(this.map.get(key));
  }

  /** Whether `key` is present in the store. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Return a deep-copied plain-object snapshot of all entries. */
  snapshot(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(this.map));
  }

  /**
   * Extract and clear the write delta accumulated for `deltaKey`.
   * Called after an agent completes to get the set of keys it wrote. The
   * window's write-log entries stay: a committed write is permanent history
   * that later discards must not remove (resume replay re-applies it). A
   * later discardDelta for the same key is a no-op — the delta bookkeeping
   * is gone — so committed entries are unreachable by rollbacks.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    const delta = this.agentDeltas.get(deltaKey) ?? {};
    this.agentDeltas.delete(deltaKey);
    // Detach this window's surviving log entries (they are permanent history
    // now) so a LATER write under the same deltaKey starts a fresh generation:
    // a discard of that generation must never remove committed entries.
    for (const key of Object.keys(delta)) {
      const history = this.keyHistories.get(key);
      if (!history) continue;
      for (const write of history.writes) {
        if (write.window === deltaKey) write.window = undefined;
      }
      // The freshly-detached entries may make older history unobservable.
      this.compactHistory(history);
    }
    return delta;
  }

  /**
   * Undo the writes recorded for `deltaKey` and discard its bookkeeping,
   * without touching any other key. Used when a retry attempt fails: that
   * attempt's writes must not remain visible in the live store (e.g. to a
   * concurrently-running sibling agent's store_get, or to embedder code
   * reading `store.get` directly) and must not merge into the delta eventually
   * recorded when a later attempt of the SAME call succeeds — otherwise a
   * failed attempt's mutations would silently survive into the run's live
   * state while being absent from the journaled delta that resume replay
   * reconstructs from, leaving live execution and replay permanently
   * inconsistent.
   *
   * Exact undo semantics (#208): the attempt's entries are removed from each
   * key's write log and the visible value recomputes as the last SURVIVING
   * write — a concurrent sibling's later write (even an Object.is-equal one)
   * survives, an untracked put()/replay applyDelta() survives, and a shadowed
   * write by an earlier window resurfaces only if that window itself is still
   * live or committed.
   *
   * A no-op if `deltaKey` never wrote anything (nothing to roll back).
   */
  discardDelta(deltaKey: string): void {
    // Guard against undefined/non-string callers: untagged entries have
    // window === undefined, and a filter on an undefined key would silently
    // delete permanent history.
    if (typeof deltaKey !== "string") return;
    const delta = this.agentDeltas.get(deltaKey);
    if (!delta) return;
    for (const key of Object.keys(delta)) {
      const history = this.keyHistories.get(key);
      if (!history) continue;
      history.writes = history.writes.filter((write) => write.window !== deltaKey);
      this.recompute(key, history);
    }
    this.agentDeltas.delete(deltaKey);
  }

  /**
   * Apply a write delta additively — sets each key without clearing others.
   * Used during resume replay so parallel-agent deltas applied in callSeq
   * order accumulate correctly regardless of original completion order.
   * Replay writes are untagged log entries: they belong to no live window and
   * no window's discard may remove them.
   */
  applyDelta(delta: Record<string, unknown>): void {
    // Clone everything first: a clone failure mid-loop must not leave the
    // store half-applied.
    const entries = Object.entries(delta).map(([k, v]) => [k, structuredClone(v)] as const);
    for (const [k, stored] of entries) {
      const history = this.historyFor(k);
      history.writes.push({ value: stored });
      this.compactHistory(history);
      this.map.set(k, stored);
    }
  }

  /**
   * Replace all entries with a snapshot (for full resets).
   * Prefer `applyDelta` for resume replay — see journal integration above.
   */
  restore(snap: Record<string, unknown>): void {
    // Clone everything BEFORE clearing: a clone failure must leave the current
    // state untouched rather than half-restored.
    const entries = Object.entries(snap).map(([k, v]) => [k, structuredClone(v)] as const);
    this.map.clear();
    this.keyHistories.clear();
    this.agentDeltas.clear();
    // Seed each entry as an untagged (permanent) write — cloned, like every
    // other write path, so the caller's snapshot object cannot alias in.
    for (const [k, stored] of entries) {
      this.historyFor(k).writes.push({ value: stored });
      this.map.set(k, stored);
    }
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.map.clear();
    this.agentDeltas.clear();
    this.keyHistories.clear();
  }
}

/**
 * Create per-agent store tools that attribute writes to `deltaKey`, a
 * run-unique `${runId}:${callIndex}` string (see the `SharedStore` class doc
 * for why the bare callIndex alone is not enough once a nested `workflow()`
 * call shares this store).
 * Used internally by `runWorkflow` so each agent's puts are tracked in the
 * store's delta journal and can be replayed additively on resume.
 */
export function createAgentStoreTools(store: SharedStore, deltaKey: string): ToolDefinition[] {
  const storePut = defineTool({
    name: "store_put",
    label: "Store Put",
    description:
      "Write a value to the shared run store. Any other agent in this workflow run can read it with store_get. Overwrites any existing value for the key. Note: when two parallel agents write the same key, the last write wins — no merge is performed.",
    promptSnippet: "Write a value to the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to store the value under." }),
      value: Type.Any({ description: "The value to store (any JSON-serializable value)." }),
    }),
    async execute(_id: string, params: { key: string; value: unknown }) {
      store.trackPut(params.key, params.value, deltaKey);
      return {
        content: [{ type: "text", text: `Stored value under key "${params.key}".` }],
        details: { key: params.key },
      };
    },
  }) as unknown as ToolDefinition;

  const storeGet = defineTool({
    name: "store_get",
    label: "Store Get",
    description:
      "Read a value from the shared run store previously written by store_put. Returns the stored value, or null when the key does not exist.",
    promptSnippet: "Read a value from the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to read." }),
    }),
    async execute(_id: string, params: { key: string }) {
      const found = store.has(params.key);
      const value = store.get(params.key);
      const text = found
        ? `Value for key "${params.key}": ${JSON.stringify(value)}`
        : `Key "${params.key}" not found in store.`;
      return {
        content: [{ type: "text", text }],
        details: { key: params.key, value: found ? value : null, found },
      };
    },
  }) as unknown as ToolDefinition;

  return [storePut, storeGet];
}
