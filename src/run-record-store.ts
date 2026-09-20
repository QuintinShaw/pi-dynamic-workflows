/** Versioned run records: append changed cells, then atomically commit a small index head. */
import { createHash, randomUUID } from "node:crypto";
import { aggregateAgentUsage } from "./display.js";
import { type PersistenceFsLayer, readJsonWithBackupRecovery, writeJsonAtomicWithBackup } from "./fs-persistence.js";
import { INTERRUPTED_AGENT_CAUSE, settleInterruptedPersistedAgents } from "./run-agent-settlement.js";
import type { PersistedRunState } from "./run-persistence.js";

interface RunSummary {
  total: number;
  done: number;
  active: number;
  running: number;
  queued: number;
  error: number;
  skipped: number;
  activeLabels: string[];
  checkpoint: Pick<NonNullable<PersistedRunState["checkpoint"]>, "checkpointId" | "kind" | "status"> | null;
  usage: ReturnType<typeof aggregateAgentUsage>;
}
const summaries = new WeakMap<PersistedRunState, RunSummary>();
export function runSummary(state: PersistedRunState): RunSummary {
  const cached = summaries.get(state);
  if (cached) return cached;
  const agents = Array.isArray(state.agents) ? state.agents.filter((a) => a && typeof a === "object") : [];
  return {
    total: agents.length,
    done: agents.filter((a) => a.status === "done").length,
    active: agents.filter((a) => a.status === "running" || a.status === "queued").length,
    running: agents.filter((a) => a.status === "running").length,
    queued: agents.filter((a) => a.status === "queued").length,
    error: agents.filter((a) => a.status === "error").length,
    skipped: agents.filter((a) => a.status === "skipped").length,
    activeLabels: agents.filter((a) => a.status === "running").map((a) => a.label),
    checkpoint: state.checkpoint
      ? { checkpointId: state.checkpoint.checkpointId, kind: state.checkpoint.kind, status: state.checkpoint.status }
      : null,
    usage: aggregateAgentUsage(agents),
  };
}

// Only small routing/status fields belong in the index. Arbitrary user payloads,
// scripts, checkpoint responses, agent histories and results remain in the log.
const INDEX_KEYS = new Set([
  "runId",
  "workflowName",
  "status",
  "sessionId",
  "parentSessionId",
  "parentSessionFile",
  "startedAt",
  "updatedAt",
  "completedAt",
  "durationMs",
  "tokenUsage",
  "currentPhase",
  "pauseReason",
  "resetHint",
  "autoResume",
  "autoResumeAttempts",
]);
interface Head {
  format: "pi-workflow-run-v2";
  generation: string;
  bytes: number;
  sequence: number;
  hash: string;
  keys: string[];
  index: Record<string, unknown>;
  summary: RunSummary;
  pendingDelivery?: { kind: "complete" | "text"; deliveryId?: string };
}
function markerIndex(marker: Head["pendingDelivery"]): Head["pendingDelivery"] {
  return marker ? { kind: marker.kind, deliveryId: marker.deliveryId } : undefined;
}
type Cell = string | string[] | Map<string, string>;
type Cells = Map<string, Cell>;
interface Delta {
  settleAgentsAt?: string;
  set: Record<string, unknown>;
  remove: string[];
  arrays: Record<string, { length: number; set: [number, unknown][] }>;
  objects?: Record<string, { set: Record<string, unknown>; remove: string[] }>;
}
interface Entry {
  generation: string;
  sequence: number;
  previous: string;
  delta: Delta;
}
interface Cached {
  generation: string;
  bytes: number;
  state: PersistedRunState;
  cells: Cells;
  size: number;
  stamp: string;
  hash: string;
}
const FORMAT = "pi-workflow-run-v2";
const MAX_CACHE_ENTRIES = 8;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

function isHead(value: unknown): value is Head {
  return !!value && typeof value === "object" && (value as Head).format === FORMAT;
}
function validateRecord(record: PersistedRunState | Head): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid run record");
  if (Object.hasOwn(record, "format") && !isHead(record)) throw new Error("Unsupported run record format");
  if (!isHead(record)) {
    if (typeof record.runId !== "string") throw new Error("Invalid legacy run identity");
    return;
  }
  if (
    !Number.isSafeInteger(record.bytes) ||
    record.bytes <= 0 ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence <= 0 ||
    typeof record.generation !== "string" ||
    typeof record.hash !== "string" ||
    !record.index ||
    typeof record.index.runId !== "string" ||
    !record.summary ||
    !Array.isArray(record.keys) ||
    record.keys.some((key) => typeof key !== "string")
  )
    throw new Error("Invalid run head");
}
function readRecord(fs: PersistenceFsLayer, path: string): PersistedRunState | Head | null {
  const record = readJsonWithBackupRecovery<PersistedRunState | Head>(fs, path);
  if (record) validateRecord(record);
  return record;
}
function digest(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}
function cellsOf(state: PersistedRunState): Cells {
  const cells: Cells = new Map();
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      cells.set(
        key,
        value.map((v) => JSON.stringify(v) ?? "null"),
      );
    else if (
      value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype &&
      typeof (value as { toJSON?: unknown }).toJSON !== "function"
    ) {
      const entries = Object.entries(value).flatMap(([name, item]) => {
        const json = JSON.stringify(item);
        return json === undefined ? [] : [[name, json] as const];
      });
      cells.set(key, new Map(entries));
    } else cells.set(key, JSON.stringify(value));
  }
  return cells;
}
function deltaOf(before: Cells, after: Cells): Delta {
  const delta: Delta = { set: Object.create(null), remove: [], arrays: Object.create(null) };
  for (const key of before.keys()) if (!after.has(key)) delta.remove.push(key);
  for (const [key, value] of after) {
    const old = before.get(key);
    if (Array.isArray(value)) {
      const prior = Array.isArray(old) ? old : [];
      const set: [number, unknown][] = [];
      for (let i = 0; i < value.length; i++) if (value[i] !== prior[i]) set.push([i, JSON.parse(value[i])]);
      if (!Array.isArray(old) || value.length !== prior.length || set.length)
        delta.arrays[key] = { length: value.length, set };
    } else if (value instanceof Map) {
      const prior = old instanceof Map ? old : new Map();
      const set: Record<string, unknown> = Object.create(null);
      const remove = [...prior.keys()].filter((name) => !value.has(name));
      for (const [name, json] of value) if (prior.get(name) !== json) set[name] = JSON.parse(json);
      if (!(old instanceof Map)) delta.set[key] = {};
      if (remove.length || Object.keys(set).length) {
        const objects: NonNullable<Delta["objects"]> = delta.objects ?? Object.create(null);
        objects[key] = { set, remove };
        delta.objects = objects;
      }
    } else if (value !== old) delta.set[key] = JSON.parse(value);
  }
  return delta;
}
function applyDelta(state: Record<string, unknown>, delta: Delta): void {
  if (delta.settleAgentsAt)
    state.agents = settleInterruptedPersistedAgents(
      Array.isArray(state.agents) ? state.agents : [],
      INTERRUPTED_AGENT_CAUSE,
      delta.settleAgentsAt,
    );
  for (const key of delta.remove) delete state[key];
  for (const [key, value] of Object.entries(delta.set))
    Object.defineProperty(state, key, { value, writable: true, enumerable: true, configurable: true });
  for (const [key, patch] of Object.entries(delta.objects ?? {})) {
    const value =
      Object.hasOwn(state, key) && state[key] && typeof state[key] === "object" && !Array.isArray(state[key])
        ? (state[key] as Record<string, unknown>)
        : {};
    for (const name of patch.remove) delete value[name];
    for (const [name, item] of Object.entries(patch.set))
      Object.defineProperty(value, name, { value: item, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(state, key, { value, writable: true, enumerable: true, configurable: true });
  }
  for (const [key, patch] of Object.entries(delta.arrays)) {
    if (!Number.isSafeInteger(patch.length) || patch.length < 0) throw new Error("Invalid run array length");
    const value = Object.hasOwn(state, key) && Array.isArray(state[key]) ? (state[key] as unknown[]) : [];
    value.length = patch.length;
    for (const [index, item] of patch.set) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= patch.length)
        throw new Error("Invalid run array index");
      value[index] = item;
    }
    Object.defineProperty(state, key, { value, writable: true, enumerable: true, configurable: true });
  }
}

export function createRunRecordStore(fs: PersistenceFsLayer) {
  const cache = new Map<string, Cached>();
  const logPath = (path: string) => `${path}.events.jsonl`;
  function logStamp(path: string): string {
    const s = fs.statSync(logPath(path));
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  }
  function remember(path: string, head: Head, state: PersistedRunState, cells: Cells): void {
    cache.delete(path);
    const size =
      [...cells.values()].reduce(
        (n, v) => n + (typeof v === "string" ? v.length * 2 : [...v.values()].reduce((s, x) => s + x.length * 2, 0)),
        0,
      ) * 2;
    if (size <= MAX_CACHE_BYTES)
      cache.set(path, {
        generation: head.generation,
        bytes: head.bytes,
        state,
        cells,
        size,
        stamp: logStamp(path),
        hash: head.hash,
      });
    let total = [...cache.values()].reduce((n, v) => n + v.size, 0);
    while (cache.size > MAX_CACHE_ENTRIES || total > MAX_CACHE_BYTES) {
      const key = cache.keys().next().value as string;
      total -= cache.get(key)?.size ?? 0;
      cache.delete(key);
    }
  }
  function hydrate(path: string, head: Head): PersistedRunState {
    if (
      !Number.isSafeInteger(head.bytes) ||
      head.bytes <= 0 ||
      !Number.isSafeInteger(head.sequence) ||
      head.sequence <= 0
    )
      throw new Error("Invalid run commit boundary");
    const cached = cache.get(path);
    if (
      cached?.generation === head.generation &&
      cached.bytes === head.bytes &&
      cached.hash === head.hash &&
      cached.stamp === logStamp(path)
    ) {
      cache.delete(path);
      cache.set(path, cached);
      return cached.state;
    }
    const fd = fs.openSync(logPath(path), "r");
    let raw: string;
    try {
      if (fs.statSync(logPath(path)).size < head.bytes) throw new Error("Truncated committed run log");
      const bytes = Buffer.alloc(head.bytes);
      let read = 0;
      while (read < bytes.length) {
        const n = fs.readSync(fd, bytes, read, bytes.length - read, read);
        if (!n) throw new Error("Truncated committed run log");
        read += n;
      }
      raw = bytes.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    if (!raw.endsWith("\n")) throw new Error("Incomplete committed run entry");
    const state: Record<string, unknown> = {};
    let previous = "",
      sequence = 0;
    for (const line of raw.slice(0, -1).split("\n")) {
      const entry = JSON.parse(line) as Entry;
      if (entry.generation !== head.generation || entry.sequence !== ++sequence || entry.previous !== previous)
        throw new Error("Invalid run log chain");
      applyDelta(state, entry.delta);
      previous = digest(line);
    }
    if (previous !== head.hash || sequence !== head.sequence || state.runId !== head.index.runId)
      throw new Error("Run commit mismatch");
    const result = state as unknown as PersistedRunState;
    remember(path, head, result, cellsOf(result));
    return result;
  }
  function read(path: string): PersistedRunState | null {
    const record = readRecord(fs, path);
    if (!record) return null;
    if (!isHead(record)) return record;
    // A committed-but-damaged log fails closed, rather than silently replaying
    // an older paid-call prefix. Only a corrupt/missing head uses its backup.
    return structuredClone(hydrate(path, record));
  }
  function peek(path: string): PersistedRunState | null {
    const record = readRecord(fs, path);
    return record ? preview(path, record) : null;
  }
  function preview(path: string, record: PersistedRunState | Head): PersistedRunState {
    validateRecord(record);
    const head = isHead(record) ? record : undefined;
    const index = head?.index ?? Object.fromEntries(Object.entries(record).filter(([key]) => INDEX_KEYS.has(key)));
    const keys = head?.keys ?? Object.keys(record);
    const view = { ...index } as unknown as PersistedRunState;
    // Getters close over only the small head/path, never the hydrated state.
    // Enumeration/spread retains the full-record API for existing consumers.
    for (const key of keys)
      if (!Object.hasOwn(index, key))
        Object.defineProperty(view, key, {
          enumerable: true,
          configurable: true,
          get: () => {
            const full = head ? hydrate(path, head) : read(path);
            if (!full) throw new Error("Run record disappeared");
            return structuredClone((full as unknown as Record<string, unknown>)[key]);
          },
        });
    // Markers are needed to route pending delivery without loading results.
    if (head?.pendingDelivery) {
      const marker = { ...head.pendingDelivery };
      if (marker.kind === "text")
        Object.defineProperty(marker, "text", {
          enumerable: true,
          get: () => {
            const full = hydrate(path, head).pendingDelivery;
            return full?.kind === "text" ? full.text : undefined;
          },
        });
      Object.defineProperty(view, "pendingDelivery", {
        value: marker,
        enumerable: true,
        configurable: true,
      });
    }
    summaries.set(view, head?.summary ?? runSummary(record as PersistedRunState));
    return view;
  }
  function commit(
    path: string,
    head: Head | undefined,
    delta: Delta,
    fields: Pick<Head, "keys" | "index" | "summary" | "pendingDelivery">,
  ): Head {
    const entry: Entry = {
      generation: head?.generation ?? randomUUID(),
      sequence: (head?.sequence ?? 0) + 1,
      previous: head?.hash ?? "",
      delta,
    };
    const line = JSON.stringify(entry);
    if (head) {
      const size = fs.statSync(logPath(path)).size;
      if (size < head.bytes) throw new Error("Truncated committed run log");
      if (size > head.bytes) fs.truncateSync(logPath(path), head.bytes);
    }
    fs.writeFileSync(logPath(path), `${line}\n`, { flag: head ? "a" : "w", flush: true });
    const next: Head = {
      ...fields,
      format: FORMAT,
      generation: entry.generation,
      bytes: (head?.bytes ?? 0) + Buffer.byteLength(line) + 1,
      sequence: entry.sequence,
      hash: digest(line),
    };
    writeJsonAtomicWithBackup(fs, path, next);
    cache.delete(path);
    return next;
  }
  function save(path: string, state: PersistedRunState): void {
    const previous = readRecord(fs, path);
    const head = isHead(previous) ? previous : undefined;
    const prior = head ? hydrate(path, head) : undefined;
    const before = prior ? (cache.get(path)?.cells ?? cellsOf(prior)) : new Map();
    const after = cellsOf(state);
    const delta = deltaOf(before, after);
    const next = commit(path, head, delta, {
      keys: [...after.keys()],
      index: Object.fromEntries(
        [...after]
          .filter(([key]) => INDEX_KEYS.has(key))
          .map(([key, value]) => [
            key,
            value instanceof Map
              ? Object.fromEntries([...value].map(([name, json]) => [name, JSON.parse(json)]))
              : Array.isArray(value)
                ? value.map((json) => JSON.parse(json))
                : JSON.parse(value),
          ]),
      ),
      summary: runSummary(state),
      pendingDelivery: markerIndex(state.pendingDelivery),
    });
    // Internal cached records never escape; reuse unchanged cells in memory.
    const copy = (prior ?? {}) as unknown as Record<string, unknown>;
    applyDelta(copy, delta);
    remember(path, next, copy as unknown as PersistedRunState, after);
  }
  function updateMetadata(
    path: string,
    patch: Partial<Pick<PersistedRunState, "sessionId" | "pendingDelivery" | "autoResumeAttempts">>,
    expectedDeliveryId?: string,
  ): boolean {
    const record = readRecord(fs, path);
    if (!record) return false;
    if (
      expectedDeliveryId &&
      record.pendingDelivery?.deliveryId &&
      record.pendingDelivery.deliveryId !== expectedDeliveryId
    )
      return false;
    if (!isHead(record)) {
      save(path, { ...record, ...patch });
      return true;
    }
    const updated = { ...patch, updatedAt: new Date().toISOString() };
    const after = cellsOf(updated as PersistedRunState);
    const delta = deltaOf(new Map(Object.keys(updated).map((key) => [key, "null"])), after);
    const index = { ...record.index };
    for (const [key, value] of Object.entries(updated))
      if (INDEX_KEYS.has(key)) {
        if (value === undefined) delete index[key];
        else index[key] = value;
      }
    const keys = new Set(record.keys);
    for (const key of Object.keys(updated))
      if (after.has(key)) keys.add(key);
      else keys.delete(key);
    commit(path, record, delta, {
      summary: record.summary,
      index,
      keys: [...keys],
      pendingDelivery: Object.hasOwn(patch, "pendingDelivery")
        ? markerIndex(patch.pendingDelivery)
        : record.pendingDelivery,
    });
    return true;
  }
  function recoverInterrupted(path: string): boolean {
    const record = readRecord(fs, path);
    if (!record) return false;
    const head = isHead(record) ? record : undefined;
    const status = head ? head.index.status : (record as PersistedRunState).status;
    const summary = head?.summary ?? runSummary(record as PersistedRunState);
    if (status !== "running" && !(status === "paused" && summary.active > 0)) return false;
    const endedAt = new Date().toISOString();
    if (!head) {
      const legacy = record as PersistedRunState;
      save(path, {
        ...legacy,
        status: "paused",
        updatedAt: endedAt,
        agents: settleInterruptedPersistedAgents(legacy.agents ?? [], INTERRUPTED_AGENT_CAUSE, endedAt),
      });
      return true;
    }
    commit(
      path,
      head,
      { set: { status: "paused", updatedAt: endedAt }, remove: [], arrays: {}, settleAgentsAt: endedAt },
      {
        keys: [...new Set([...head.keys, "status", "updatedAt", "agents"])],
        index: { ...head.index, status: "paused", updatedAt: endedAt },
        summary: {
          ...summary,
          active: 0,
          running: 0,
          queued: 0,
          skipped: summary.skipped + summary.active,
          activeLabels: [],
        },
        pendingDelivery: head.pendingDelivery,
      },
    );
    return true;
  }
  return {
    read,
    peek,
    preview,
    save,
    updateMetadata,
    recoverInterrupted,
    forget: (path: string) => cache.delete(path),
    logPath,
  };
}
