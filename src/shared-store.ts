/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: callers capture `store.snapshot()` alongside each agent
 * result in the journal. On resume, `store.restore(snapshot)` rebuilds the
 * store state for the replayed prefix so live agents see a consistent view.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export class SharedStore {
  private readonly map = new Map<string, unknown>();

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  /** Retrieve the value for `key`, or `undefined` when absent. */
  get(key: string): unknown {
    return this.map.get(key);
  }

  /** Whether `key` is present in the store. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Return a plain-object copy of all entries (for journaling). */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }

  /**
   * Replace all entries with a snapshot (for resume replay).
   * The snapshot must be a plain object produced by `snapshot()`.
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
  }
}

/**
 * Create the `store_put` and `store_get` tool definitions bound to a specific
 * `SharedStore` instance. Inject the returned array into every agent in the run
 * via `systemTools` so all agents, including those with a restrictive
 * `tools` allowlist, can read and write shared state.
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
      const value = store.get(params.key);
      const found = value !== undefined;
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
