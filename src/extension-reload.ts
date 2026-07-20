import packageJson from "../package.json" with { type: "json" };
import type { EffortState } from "./effort-command.js";
import type { WorkflowManager } from "./workflow-manager.js";

/**
 * Live extension state that Pi may hand from one extension generation to the
 * next during `/reload`. This deliberately stays process-local: run snapshots
 * and journals already provide the durable cold-start path, while the live
 * manager is what owns in-flight promises, abort controllers, and event streams.
 */
export const WORKFLOW_EXTENSION_VERSION = packageJson.version;

export interface WorkflowReloadRuntime {
  cwd: string;
  /** Package version that created this manager. Only an exact match is retained. */
  extensionVersion: string;
  manager: WorkflowManager;
  effort: EffortState;
}

export interface WorkflowRuntimeClaim {
  compatible?: WorkflowReloadRuntime;
  versionMismatch?: WorkflowReloadRuntime;
}

interface HandoffEntry {
  runtime: WorkflowReloadRuntime;
  timer: ReturnType<typeof setTimeout>;
}

const RELOAD_HANDOFF_KEY = Symbol.for("@quintinshaw/pi-dynamic-workflows:reload-handoffs");
const RELOAD_HANDOFF_TTL_MS = 30_000;

function handoffs(): Map<string, HandoffEntry> {
  const root = globalThis as typeof globalThis & { [RELOAD_HANDOFF_KEY]?: Map<string, HandoffEntry> };
  const existing = root[RELOAD_HANDOFF_KEY];
  if (existing) return existing;
  const created = new Map<string, HandoffEntry>();
  root[RELOAD_HANDOFF_KEY] = created;
  return created;
}

/** Stage a live runtime immediately before Pi tears down the old extension runner. */
export function handoffWorkflowRuntime(runtime: WorkflowReloadRuntime): void {
  const store = handoffs();
  const previous = store.get(runtime.cwd);
  if (previous) clearTimeout(previous.timer);

  const entry = {} as HandoffEntry;
  entry.runtime = runtime;
  entry.timer = setTimeout(() => {
    if (store.get(runtime.cwd) === entry) store.delete(runtime.cwd);
  }, RELOAD_HANDOFF_TTL_MS);
  entry.timer.unref?.();
  store.set(runtime.cwd, entry);
}

/** Claim a staged runtime from the extension generation that `/reload` just stopped. */
export function takeWorkflowRuntime(cwd: string): WorkflowReloadRuntime | undefined {
  const store = handoffs();
  const entry = store.get(cwd);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  store.delete(cwd);
  return entry.runtime;
}

/**
 * Claim a staged runtime and compare its package version with this extension
 * generation. Any package update falls back to a fresh manager; only reloads
 * within the exact same installed version retain live workflow state.
 */
export function claimWorkflowRuntime(cwd: string): WorkflowRuntimeClaim {
  const runtime = takeWorkflowRuntime(cwd);
  if (!runtime) return {};
  return runtime.extensionVersion === WORKFLOW_EXTENSION_VERSION
    ? { compatible: runtime }
    : { versionMismatch: runtime };
}

/**
 * Move live runs from a replaced extension version onto the existing journal
 * recovery path before the fresh manager is constructed.
 */
export function pauseVersionMismatchWorkflowRuntime(runtime: WorkflowReloadRuntime): number {
  let paused = 0;
  for (const run of runtime.manager.listRuns()) {
    if (run.status === "running" && runtime.manager.pause(run.runId)) paused++;
  }
  return paused;
}

/** Test/cleanup helper; identity guard avoids deleting a newer handoff. */
export function discardWorkflowRuntime(cwd: string, runtime?: WorkflowReloadRuntime): void {
  const store = handoffs();
  const entry = store.get(cwd);
  if (!entry || (runtime && entry.runtime !== runtime)) return;
  clearTimeout(entry.timer);
  store.delete(cwd);
}
