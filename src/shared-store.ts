/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: callers capture `store.commitDelta(deltaKey)` alongside
 * each successful agent result. Failed attempts call `discardDelta(deltaKey)` so
 * unjournaled writes do not remain observable. Atomic child workflows use a
 * child scope: they can read parent state, but their execution-ordered final
 * delta is applied to the parent only after the whole child succeeds.
 *
 * `deltaKey` must be unique across every invocation sharing a store scope, not
 * just within one run's callSeq. Callers compose it from the run ID and call
 * index; nested children additionally receive a call-index-based invocation ID.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface StoreWrite {
  key: string;
  value: unknown;
  version: number;
  deltaKey?: string;
  committed: boolean;
}

interface StoreClock {
  nextVersion: number;
}

export interface StoreDelta {
  values: Record<string, unknown>;
  versions: Record<string, number>;
}

const UNSAFE_STORE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function validateStoreKey(key: string): void {
  if (UNSAFE_STORE_KEYS.has(key)) throw new TypeError(`unsafe shared-store key: ${key}`);
}

export class SharedStore {
  /** Writes use a scope-wide monotonic version assigned at store_put execution time. */
  private writes: StoreWrite[] = [];
  private readonly agentDeltas = new Map<string, StoreWrite[]>();
  private readonly closedDeltas = new Set<string>();
  private readonly clock: StoreClock;
  private disposed = false;

  constructor(private readonly parent?: SharedStore) {
    this.clock = parent?.clock ?? { nextVersion: 0 };
  }

  /** Store a committed value under `key`. Overwrites any older write. */
  put(key: string, value: unknown): void {
    this.assertOpen();
    validateStoreKey(key);
    this.appendCommitted(key, value, ++this.clock.nextVersion);
  }

  /**
   * Store a value and record the write in the per-attempt delta for `deltaKey`.
   * Closed attempt scopes reject late writes, including work that outlives a timeout.
   */
  trackPut(key: string, value: unknown, deltaKey: string): void {
    this.assertOpen();
    validateStoreKey(key);
    if (this.closedDeltas.has(deltaKey)) throw new Error(`shared-store delta scope is closed: ${deltaKey}`);
    const write = { key, value, version: ++this.clock.nextVersion, deltaKey, committed: false };
    this.writes.push(write);
    const delta = this.agentDeltas.get(deltaKey) ?? [];
    delta.push(write);
    this.agentDeltas.set(deltaKey, delta);
  }

  /** Retrieve committed state plus the calling attempt's own pending writes. */
  get(key: string, deltaKey?: string): unknown {
    this.assertOpen();
    validateStoreKey(key);
    return this.latestWrite(key, deltaKey)?.value;
  }

  /** Whether committed state or the calling attempt's own pending state contains `key`. */
  has(key: string, deltaKey?: string): boolean {
    this.assertOpen();
    validateStoreKey(key);
    return this.latestWrite(key, deltaKey) !== undefined;
  }

  /** Return a deep-copied plain-object snapshot of all observable entries. */
  snapshot(): Record<string, unknown> {
    this.assertOpen();
    const snapshot: Record<string, unknown> = {};
    for (const write of this.allWrites().sort((left, right) => left.version - right.version)) {
      snapshot[write.key] = write.value;
    }
    return structuredClone(snapshot);
  }

  /** Inspect an attempt's final per-key values without making it irrevocable. */
  prepareDelta(deltaKey: string): StoreDelta {
    this.assertOpen();
    return this.deltaFromWrites(this.agentDeltas.get(deltaKey) ?? []);
  }

  /** Confirm an agent's writes and return its per-key final delta. */
  commitDelta(deltaKey: string): Record<string, unknown> {
    this.assertOpen();
    const delta = this.prepareDelta(deltaKey);
    for (const write of this.agentDeltas.get(deltaKey) ?? []) write.committed = true;
    this.agentDeltas.delete(deltaKey);
    this.closedDeltas.add(deltaKey);
    return delta.values;
  }

  /** Remove every still-uncommitted write made by a failed agent attempt. */
  discardDelta(deltaKey: string): void {
    this.assertOpen();
    const discarded = this.agentDeltas.get(deltaKey) ?? [];
    const discardedSet = new Set(discarded.filter((write) => !write.committed));
    if (discardedSet.size > 0) this.writes = this.writes.filter((write) => !discardedSet.has(write));
    this.agentDeltas.delete(deltaKey);
    this.closedDeltas.add(deltaKey);
  }

  /** Create a child-scoped overlay whose writes are atomic at workflow success. */
  createChildScope(): SharedStore {
    this.assertOpen();
    return new SharedStore(this);
  }

  /** Inspect this child's committed writes without exposing them to its parent. */
  prepareChildScope(): StoreDelta {
    this.assertOpen();
    if (!this.parent) throw new Error("Only child-scoped stores can be committed");
    return this.deltaFromWrites(this.writes.filter((write) => write.committed));
  }

  /** Commit a previously prepared child delta to its parent. */
  commitChildScope(delta = this.prepareChildScope()): Record<string, unknown> {
    this.assertOpen();
    if (!this.parent) throw new Error("Only child-scoped stores can be committed");
    this.parent.applyDelta(delta.values, delta.versions);
    return delta.values;
  }

  /** Apply a committed replay delta additively, retaining captured write versions. */
  applyDelta(delta: Record<string, unknown>, versions?: Record<string, number>): void {
    this.assertOpen();
    const entries = Object.entries(delta);
    for (const [key] of entries) {
      validateStoreKey(key);
      const version = versions?.[key];
      if (version !== undefined && (!Number.isSafeInteger(version) || version < 0)) {
        throw new TypeError(`invalid shared-store write version for key: ${key}`);
      }
    }
    for (const [key, value] of entries) {
      const version = versions?.[key];
      this.appendCommitted(key, value, version ?? ++this.clock.nextVersion);
    }
  }

  /** Replace all local entries with a committed snapshot. */
  restore(snap: Record<string, unknown>): void {
    this.assertOpen();
    this.writes = [];
    this.agentDeltas.clear();
    this.closedDeltas.clear();
    this.applyDelta(snap);
  }

  /** Permanently close this scope and clear all local entries and attempt tracking. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.writes = [];
    this.agentDeltas.clear();
    this.closedDeltas.clear();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("shared store is disposed");
  }

  private appendCommitted(key: string, value: unknown, version: number): void {
    this.assertOpen();
    this.clock.nextVersion = Math.max(this.clock.nextVersion, version);
    this.writes.push({ key, value, version, committed: true });
  }

  private latestWrite(key: string, deltaKey?: string): StoreWrite | undefined {
    this.assertOpen();
    let latest = this.parent?.latestWrite(key);
    for (const write of this.writes) {
      if (!write.committed && write.deltaKey !== deltaKey) continue;
      if (write.key === key && (!latest || write.version > latest.version)) latest = write;
    }
    return latest;
  }

  private allWrites(): StoreWrite[] {
    this.assertOpen();
    return [...(this.parent?.allWrites() ?? []), ...this.writes.filter((write) => write.committed)];
  }

  private deltaFromWrites(writes: StoreWrite[]): StoreDelta {
    this.assertOpen();
    const latestByKey = new Map<string, StoreWrite>();
    for (const write of writes) {
      const current = latestByKey.get(write.key);
      if (!current || write.version > current.version) latestByKey.set(write.key, write);
    }
    const values: Record<string, unknown> = {};
    const versions: Record<string, number> = {};
    for (const write of [...latestByKey.values()].sort((left, right) => left.version - right.version)) {
      values[write.key] = write.value;
      versions[write.key] = write.version;
    }
    return { values, versions };
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
      "Write a value to this agent attempt's shared-store scope. The value becomes visible to other agents only after this attempt commits.",
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
      "Read committed shared-store state plus values written by this agent attempt. Returns null when the key does not exist.",
    promptSnippet: "Read a value from the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to read." }),
    }),
    async execute(_id: string, params: { key: string }) {
      const found = store.has(params.key, deltaKey);
      const value = store.get(params.key, deltaKey);
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
