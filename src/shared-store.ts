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
 * whole-Map restore() would cause.
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

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  /**
   * Store a value and record the write in the per-agent delta for `deltaKey`
   * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
   * per-agent tools created via `createAgentStoreTools` so that each agent's
   * writes can be journaled and replayed independently.
   */
  trackPut(key: string, value: unknown, deltaKey: string): void {
    this.map.set(key, value);
    let delta = this.agentDeltas.get(deltaKey);
    if (!delta) {
      delta = {};
      this.agentDeltas.set(deltaKey, delta);
    }
    delta[key] = value;
  }

  /** Retrieve the value for `key`, or `undefined` when absent. */
  get(key: string): unknown {
    return this.map.get(key);
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
   * Called after an agent completes to get the set of keys it wrote.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    const delta = this.agentDeltas.get(deltaKey) ?? {};
    this.agentDeltas.delete(deltaKey);
    return delta;
  }

  /**
   * Apply a write delta additively — sets each key without clearing others.
   * Used during resume replay so parallel-agent deltas applied in callSeq
   * order accumulate correctly regardless of original completion order.
   */
  applyDelta(delta: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(delta)) {
      this.map.set(k, v);
    }
  }

  /**
   * Replace all entries with a snapshot (for full resets).
   * Prefer `applyDelta` for resume replay — see journal integration above.
   */
  restore(snap: Record<string, unknown>): void {
    this.map.clear();
    for (const [k, v] of Object.entries(snap)) {
      this.map.set(k, v);
    }
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.map.clear();
    this.agentDeltas.clear();
  }
}

/**
 * Create the `store_put` and `store_get` tool definitions bound to a specific
 * `SharedStore` instance. Inject the returned array into every agent in the run
 * via `systemTools` so all agents, including those with a restrictive
 * `tools` allowlist, can read and write shared state.
 *
 * For workflow-internal use where delta-journaling is needed, use
 * `createAgentStoreTools(store, deltaKey)` instead — it attributes each put to
 * the given agent (via a run-unique deltaKey) so the write can be replayed
 * correctly on resume.
 */
export function createSharedStoreTools(store: SharedStore): ToolDefinition[] {
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
      store.put(params.key, params.value);
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
