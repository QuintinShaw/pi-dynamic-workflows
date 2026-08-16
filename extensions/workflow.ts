import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createCodingTools, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  pauseStrandedWorkflowRuntime,
  SESSION_REPLACEMENT_REASONS,
  WORKFLOW_EXTENSION_VERSION,
  type WorkflowReloadRuntime,
} from "../src/extension-reload.js";
import {
  createEffortState,
  createWebTools,
  createWorkflowControlTool,
  createWorkflowStorage,
  createWorkflowTool,
  type EffortState,
  installResultDelivery,
  installTaskPanel,
  installWorkflowKeywordArming,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  resumeResultDelivery,
  saveWorkflowSettingsForCwd,
  suspendResultDelivery,
  UsageLimitScheduler,
  WorkflowManager,
} from "../src/index.js";
import type { WorkflowStorage } from "../src/workflow-saved.js";

/**
 * Bound for the read-only session-header probe (first line only). Independent of
 * pi's own ~1MiB session scan — we only need the header and keep the read small.
 */
const SESSION_HEADER_SCAN_BYTES = 64 * 1024;

/**
 * Read-only probe of a session JSONL file's project cwd from its header line.
 * Does NOT call SessionManager.open() — that API creates directories, may rewrite
 * empty/legacy files, and loads the full history. Used on session_shutdown for
 * resume/fork destination checks. Unreadable / oversized / non-session files
 * return undefined; callers decide fail-closed vs allow based on the shutdown reason.
 */
export function sessionFileCwd(sessionFile: string | undefined): string | undefined {
  if (!sessionFile || !existsSync(sessionFile)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(4096);
    const chunks: string[] = [];
    let scanned = 0;
    while (scanned < SESSION_HEADER_SCAN_BYTES) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, SESSION_HEADER_SCAN_BYTES - scanned), null);
      if (n === 0) {
        chunks.push(decoder.end());
        break;
      }
      scanned += n;
      const chunk = decoder.write(buffer.subarray(0, n));
      const nl = chunk.indexOf("\n");
      if (nl !== -1) {
        chunks.push(chunk.slice(0, nl));
        break;
      }
      chunks.push(chunk);
    }
    const line = chunks.join("").trim();
    if (!line) return undefined;
    const entry = JSON.parse(line) as { type?: string; cwd?: unknown };
    if (entry.type !== "session" || typeof entry.cwd !== "string" || !entry.cwd) return undefined;
    return resolve(entry.cwd);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors on the probe fd
      }
    }
  }
}

function buildManagerOptions(cwd: string, storage: WorkflowStorage) {
  const settings = loadWorkflowSettings({ cwd });
  return {
    loadSavedWorkflow: (name: string) => storage.load(name)?.script,
    toolsets: {
      "web-research": () => [...createCodingTools(cwd), ...createWebTools()],
    },
    excludeSubagentTools: settings.excludeSubagentTools,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    defaultTokenBudget: settings.defaultTokenBudget ?? null,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
    persistAgentSessions: settings.persistAgentSessions,
  };
}

export default function extension(pi: ExtensionAPI) {
  // Mutable host state. Tools/commands resolve through getters so a
  // session_start that discovers a cross-project cwd can replace the manager
  // without leaving closed-over references pointing at the source project.
  //
  // Factory-time cwd is process.cwd() only (Pi does not pass the host session
  // cwd into the factory). The real session cwd arrives on session_start as
  // ctx.cwd; if it differs we rebuild manager/storage against it and pause
  // any foreign live runs that rode in via handoff.
  let cwd = resolve(process.cwd());
  let storage = createWorkflowStorage(cwd);
  let managerOptions = buildManagerOptions(cwd, storage);

  // Process-wide handoff slot (not cwd-keyed): the previous generation may have
  // been bound to ctx.cwd while this factory only sees process.cwd(). Claim
  // whatever is staged; session_start then keeps or rebuilds based on the true
  // session project (manager.getCwd() vs ctx.cwd).
  const runtimeClaim = claimWorkflowRuntime();
  const previousRuntime = runtimeClaim.compatible;
  let pausedForMismatch = runtimeClaim.versionMismatch ? pauseStrandedWorkflowRuntime(runtimeClaim.versionMismatch) : 0;

  // Prefer the claimed manager's own project path for construction defaults
  // when it already points at a real project (not just the launch dir).
  if (previousRuntime) {
    const claimedCwd = resolve(previousRuntime.manager.getCwd());
    if (claimedCwd !== cwd) {
      cwd = claimedCwd;
      storage = createWorkflowStorage(cwd);
      managerOptions = buildManagerOptions(cwd, storage);
    }
  }

  let manager = previousRuntime?.manager ?? new WorkflowManager({ cwd, ...managerOptions });
  if (previousRuntime) manager.reconfigureAfterReload(managerOptions);

  // Stable effort object: /effort and keyword arming close over this reference.
  // When a handoff brings a different EffortState, copy the level in place
  // rather than rebinding the local binding.
  const effort: EffortState = (previousRuntime ?? runtimeClaim.versionMismatch)?.effort ?? createEffortState();
  if (previousRuntime?.effort && previousRuntime.effort !== effort) {
    effort.level = previousRuntime.effort.level;
  }

  const getManager = () => manager;
  const getCwd = () => cwd;
  const getStorage = () => storage;

  // Install delivery listeners once. Keep suspended until session_start —
  // factory runs before Pi bindCore(), so sendMessage is still the
  // "runtime not initialized" stub. Flushing here would re-queue forever.
  installResultDelivery(pi, manager, { loadSettings: () => loadWorkflowSettings({ cwd: getCwd() }) });
  suspendResultDelivery(manager);

  const workflowTool = createWorkflowTool({
    getManager,
    getCwd,
    getStorage,
    get manager() {
      return manager;
    },
    get cwd() {
      return cwd;
    },
    get storage() {
      return storage;
    },
  });
  const workflowControlTool = createWorkflowControlTool({ getManager });
  pi.registerTool(workflowTool);
  pi.registerTool(workflowControlTool);

  let usageLimitScheduler = new UsageLimitScheduler(manager);

  pi.on("session_shutdown", (event?: { reason?: string; targetSessionFile?: string }) => {
    usageLimitScheduler.dispose();
    // Always stop live sends first so a completion racing teardown cannot
    // deliver into the outgoing session (or throw on a just-stale ctx and be
    // lost). Replacement reasons stage the runtime for the next generation
    // only when the destination is the same project; quit/unknown/cross-project
    // pause in-flight runs onto the journal path.
    suspendResultDelivery(manager);

    const reason = event?.reason;
    const runtime: WorkflowReloadRuntime = {
      cwd,
      extensionVersion: WORKFLOW_EXTENSION_VERSION,
      manager,
      effort,
    };

    if (reason && SESSION_REPLACEMENT_REASONS.has(reason)) {
      // Destination checks differ by reason:
      // - resume: fail-closed. Only hand off when the target session header
      //   positively reads as this same project. Missing/corrupt/unreadable
      //   headers must not smuggle a source-project manager across.
      // - fork: Pi forks stay in the same project; the new session file may
      //   not exist yet so a missing header is not a cross-project signal.
      //   Only refuse when we positively read a different cwd.
      // - reload/new: same project; always hand off.
      if (reason === "resume") {
        const targetCwd = sessionFileCwd(event?.targetSessionFile);
        if (targetCwd !== cwd) {
          pauseStrandedWorkflowRuntime(runtime);
          discardWorkflowRuntime(cwd, runtime);
          return;
        }
        handoffWorkflowRuntime(runtime);
        return;
      }
      if (reason === "fork") {
        const targetCwd = sessionFileCwd(event?.targetSessionFile);
        if (targetCwd && targetCwd !== cwd) {
          pauseStrandedWorkflowRuntime(runtime);
          discardWorkflowRuntime(cwd, runtime);
          return;
        }
        handoffWorkflowRuntime(runtime);
        return;
      }
      handoffWorkflowRuntime(runtime);
      return;
    }

    pauseStrandedWorkflowRuntime(runtime);
    discardWorkflowRuntime(cwd, runtime);
  });

  registerWorkflowCommands(pi, getManager, {
    getStorage,
    getCwd,
    effort,
  });
  registerWorkflowModelsCommand(pi);
  registerBuiltinWorkflows(pi, { getManager, getCwd, getStorage });
  // Saved project commands are registered on session_start (after the real
  // ctx.cwd is known and any cross-project rebuild has finished). Registering
  // them in the factory would stamp source-project descriptions onto slash
  // commands before a resume into another project could correct the cwd —
  // and Pi cannot unregister/replace a command's metadata once registered.
  registerEffortCommand(pi, effort);

  let armingInstalled = false;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    // True project cwd for this session. Pi keeps process.cwd() on the
    // launching directory across /resume into another project; ctx.cwd is
    // the session header's project path.
    const sessionCwd = resolve(ctx.cwd || process.cwd());

    if (sessionCwd !== resolve(manager.getCwd())) {
      // Cross-project: the live manager is for the wrong tree. Pause anything
      // still on it, then rebuild against the real session project.
      const stranded: WorkflowReloadRuntime = {
        cwd: manager.getCwd(),
        extensionVersion: WORKFLOW_EXTENSION_VERSION,
        manager,
        effort,
      };
      const n = pauseStrandedWorkflowRuntime(stranded);
      if (n > 0) pausedForMismatch += n;

      cwd = sessionCwd;
      storage = createWorkflowStorage(cwd);
      managerOptions = buildManagerOptions(cwd, storage);
      manager = new WorkflowManager({ cwd, ...managerOptions });
      installResultDelivery(pi, manager, { loadSettings: () => loadWorkflowSettings({ cwd: getCwd() }) });
      usageLimitScheduler.dispose();
      usageLimitScheduler = new UsageLimitScheduler(manager);
    } else if (cwd !== sessionCwd) {
      // Manager already owns the session project; just align the local cwd/storage.
      cwd = sessionCwd;
      storage = createWorkflowStorage(cwd);
      managerOptions = buildManagerOptions(cwd, storage);
      manager.reconfigureAfterReload(managerOptions);
    }

    // First registration (and post-rebuild catch-up for target-only names).
    // Handlers load by name from the live storage, so a later same-session
    // overwrite picks up the new script; Pi still cannot drop source-only
    // names left over from a prior generation — those handlers notify.
    registerAllSavedWorkflows(pi, getCwd, getStorage, getManager);

    if (pausedForMismatch > 0) {
      ctx.ui.notify(
        `Paused ${pausedForMismatch} active workflow(s) that could not safely continue in this session (extension update or project switch). Resume them from /workflows when ready.`,
        "warning",
      );
      pausedForMismatch = 0;
    }

    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    manager.setModelRegistry(ctx.modelRegistry);

    const active = pi.getActiveTools();
    const workflowTools = [workflowTool.name, workflowControlTool.name];
    const missing = workflowTools.filter((name) => !active.includes(name));
    if (missing.length) pi.setActiveTools([...active, ...missing]);

    // Bind + adopt before resuming delivery so a flushed completion is tagged
    // with this session and visible in its panel.
    let sessionId: string | undefined;
    try {
      sessionId = ctx.sessionManager?.getSessionId();
    } catch {
      // sessionManager may be unavailable — fall back to global history.
    }
    manager.setSessionId(sessionId);
    manager.adoptLiveRunsToSession(sessionId);

    // Runtime is bound now (session_start fires after bindCore). Unsuspend and
    // flush anything queued while the previous ctx was dying or this factory
    // was still loading.
    resumeResultDelivery(manager);

    installTaskPanel(pi, manager, ctx.ui, {
      storage,
      cwd,
      loadSettings: () => loadWorkflowSettings({ cwd: getCwd() }),
    });
    if (!armingInstalled) {
      installWorkflowKeywordArming(pi, effort, {
        settingsStore: {
          load: () => loadWorkflowSettings({ cwd: getCwd() }),
          save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, getCwd()),
        },
      });
      armingInstalled = true;
    }
  });

  // Keep mainModel in sync with mid-session /model (and cycle/restore). Without
  // this, workflow subagents that fall through to mainModel keep the frozen
  // session_start value for the rest of the process lifetime.
  pi.on("model_select", (event) => {
    const m = event.model;
    manager.setMainModel(m ? `${m.provider}/${m.id}` : undefined);
  });
}
