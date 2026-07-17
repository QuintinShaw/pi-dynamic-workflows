import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createEffortState,
  createWorkflowStorage,
  createWorkflowTool,
  installResultDelivery,
  installTaskPanel,
  installWorkflowEditor,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  saveWorkflowSettingsForCwd,
  UsageLimitScheduler,
  WorkflowManager,
  WorkflowManagerRegistry,
} from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  // Preserve one default manager/storage for the slash command and TUI. The
  // registry adds one shared manager per explicit canonical cwd for tool controls.
  const cwd = process.cwd();
  const storage = createWorkflowStorage(cwd);
  const settings = loadWorkflowSettings({ cwd });
  const manager = new WorkflowManager({
    cwd,
    loadSavedWorkflow: (name) => storage.load(name)?.script,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
    persistAgentSessions: settings.persistAgentSessions,
  });
  let deliveryReady = false;
  const usageLimitSchedulers = new Map<WorkflowManager, UsageLimitScheduler>();
  const ensureUsageLimitScheduler = (registeredManager: WorkflowManager) => {
    if (!usageLimitSchedulers.has(registeredManager)) {
      usageLimitSchedulers.set(registeredManager, new UsageLimitScheduler(registeredManager));
    }
  };
  const managerRegistry = new WorkflowManagerRegistry({
    defaultCwd: cwd,
    defaultManager: manager,
    createManager: (managerCwd) => {
      const managerStorage = createWorkflowStorage(managerCwd);
      const managerSettings = loadWorkflowSettings({ cwd: managerCwd });
      return new WorkflowManager({
        cwd: managerCwd,
        loadSavedWorkflow: (name) => managerStorage.load(name)?.script,
        defaultAgentTimeoutMs: managerSettings.defaultAgentTimeoutMs ?? null,
        concurrency: managerSettings.defaultConcurrency,
        defaultAgentRetries: managerSettings.defaultAgentRetries,
        persistAgentSessions: managerSettings.persistAgentSessions,
      });
    },
    onCreate: (createdManager, managerCwd) => {
      ensureUsageLimitScheduler(createdManager);
      if (deliveryReady) {
        installResultDelivery(pi, createdManager, {
          loadSettings: () => loadWorkflowSettings({ cwd: managerCwd }),
          getActiveSessionId: () => createdManager.getSessionId(),
        });
      }
    },
  });

  const workflowTool = createWorkflowTool({ cwd, managerRegistry, storage });
  pi.registerTool(workflowTool);
  // Auto-resume runs that pause on provider usage limits in every canonical-cwd
  // manager. Constructors also re-arm persisted usage_limit pauses after restart.
  pi.on("session_shutdown", () => {
    for (const scheduler of usageLimitSchedulers.values()) scheduler.dispose();
    usageLimitSchedulers.clear();
  });
  // Standing /effort opt-in (off|high|ultra): auto-arms a workflow for substantive
  // messages, like CC's ultracode. Shared with the editor's input hook below and
  // with the explicit /workflows run <prompt> manual trigger.
  const effort = createEffortState();
  registerWorkflowCommands(pi, manager, { storage, cwd, effort });
  registerWorkflowModelsCommand(pi);
  registerBuiltinWorkflows(pi, { cwd });
  registerAllSavedWorkflows(pi, cwd, storage, manager);
  registerEffortCommand(pi, effort);
  // "Workflows mode": type `workflow(s)` to arm a forced workflow (animated),
  // Backspace right after the word disarms it. Registers the `input` hook now;
  // the editor itself is installed once the UI is available (session_start).
  let editorInstalled = false;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    // Tell the manager the session's main model so "explore" agents auto-tier
    // down to a lighter same-family sibling (e.g. Claude → Haiku).
    managerRegistry.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    // Share the host session's model registry so tier/phase routing resolves
    // extension-registered providers (e.g. ollama-cloud) consistently. Set it
    // before activating the tool: the tool's promptGuidelines read the
    // manager's registry lazily, so tool-registry refreshes from here on
    // advertise the shared registry's models.
    managerRegistry.setModelRegistry(ctx.modelRegistry);
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
    // Scope the /workflows history to this session: runs persist on disk across
    // sessions, but the navigator/task panel show only the current session's runs.
    // Switching back to a previous session re-shows that session's runs.
    try {
      managerRegistry.setSessionId(ctx.sessionManager?.getSessionId());
    } catch {
      // sessionManager may be unavailable in some contexts — fall back to global history.
    }
    // Deliver a background run's result into the conversation when it finishes.
    // The live settings loader lets `deliveredResultMaxChars` take effect without
    // a restart.
    deliveryReady = true;
    managerRegistry.forEach((registeredManager, managerCwd) => {
      installResultDelivery(pi, registeredManager, {
        loadSettings: () => loadWorkflowSettings({ cwd: managerCwd }),
        getActiveSessionId: () => registeredManager.getSessionId(),
      });
    });
    // Live "workflows running" panel below the input (focus + enter to open).
    // Pass a live settings loader so /workflows-progress (compact|detailed) takes
    // effect without a restart.
    installTaskPanel(pi, manager, ctx.ui, { storage, cwd, loadSettings: () => loadWorkflowSettings({ cwd }) });
    if (!editorInstalled) {
      installWorkflowEditor(pi, ctx.ui, effort, {
        settingsStore: {
          load: () => loadWorkflowSettings({ cwd }),
          save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, cwd),
        },
      });
      editorInstalled = true;
    }
  });
}
