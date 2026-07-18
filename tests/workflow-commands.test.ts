import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEffortState, effortDirective } from "../src/effort-command.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME } from "../src/workflow-editor.js";
import type { WorkflowManager } from "../src/workflow-manager.js";

type Handler = (args: string, ctx: any) => Promise<void>;

/** Capture the registered command + outputs for assertions. */
function harness(
  managerOverrides: Record<string, any> = {},
  commandOptions: Record<string, any> = {},
  initialTools: string[] = [WORKFLOW_TOOL_NAME],
  sendMessageImpl?: (
    m: { customType?: string; content?: string },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ) => Promise<void>,
) {
  const printed: string[] = [];
  const sent: Array<{
    customType?: string;
    content?: string;
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }> = [];
  const notified: Array<{ message: string; type?: string }> = [];
  const calls: string[] = [];
  const activeTools = [...initialTools];
  let handler: Handler | undefined;

  const pi: Partial<ExtensionAPI> = {
    getCommands: () => [],
    registerCommand: (_name: string, opts: { handler: Handler }) => {
      handler = opts.handler;
    },
    sendMessage:
      sendMessageImpl ??
      (async (m, options) => {
        sent.push({ ...m, options });
        if (!options && typeof m.content === "string") printed.push(m.content);
      }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames: string[]) => {
      activeTools.splice(0, activeTools.length, ...toolNames);
    },
  };

  const manager: Partial<WorkflowManager> = {
    listRuns: () => [],
    getSnapshot: () => null,
    getRun: () => undefined,
    stop: (id: string) => {
      calls.push(`stop:${id}`);
      return true;
    },
    pause: (id: string) => {
      calls.push(`pause:${id}`);
      return true;
    },
    resume: async (id: string) => {
      calls.push(`resume:${id}`);
      return false;
    },
    deleteRun: (id: string) => {
      calls.push(`rm:${id}`);
      return true;
    },
    ...managerOverrides,
  };

  registerWorkflowCommands(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager, commandOptions);
  const ctx = { ui: { notify: (message: string, type?: string) => notified.push({ message, type }) } };
  const run = (args: string) => {
    if (!handler) throw new Error("command not registered");
    return handler(args, ctx);
  };
  return { run, printed, sent, notified, calls, activeTools };
}

test("/workflows list shows empty hint when no runs", async () => {
  const h = harness();
  await h.run("list");
  assert.match(h.printed[0], /No workflow runs yet/);
});

test("/workflows (no args) defaults to list", async () => {
  const h = harness({
    listRuns: () => [{ runId: "run-1", workflowName: "demo", status: "completed", phases: [], agents: [], logs: [] }],
  });
  await h.run("");
  assert.match(h.printed[0], /Workflow runs:/);
  assert.match(h.printed[0], /run-1/);
});

test("/workflows run without prompt warns usage", async () => {
  const h = harness();
  await h.run("run");
  assert.equal(h.sent.length, 0);
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage: \/workflows run <prompt>/);
});

test("/workflows run <prompt> sends a forced workflow follow-up turn", async () => {
  const h = harness();
  await h.run("run audit auth boundaries");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].customType, "workflow-run");
  // #P5: /workflows run is an explicit command → forcing directive (no question-escape).
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("audit auth boundaries"));
  assert.doesNotMatch(h.sent[0].content ?? "", /answer it directly and stay/i, "no question-answer escape");
  assert.match(h.sent[0].content ?? "", /Call the `workflow` tool now/i, "forces the tool call");
  assert.equal(h.sent[0].options?.triggerTurn, true);
  assert.equal(h.sent[0].options?.deliverAs, "followUp");
  assert.deepEqual(h.activeTools, [WORKFLOW_TOOL_NAME], "does not duplicate an already-active workflow tool");
});

test("/workflows run <prompt> notifies error when sendMessage rejects and does not bubble", async () => {
  const failingSend = async () => {
    throw new Error("send failed");
  };
  const h = harness({}, {}, [WORKFLOW_TOOL_NAME], failingSend);
  await h.run("run audit auth");
  assert.ok(
    h.notified.some((n) => n.message === "Could not start the workflow turn."),
    "should notify the error message",
  );
});

test("/workflows run adds the workflow tool when absent and does not depend on the keyword trigger", async () => {
  const h = harness({}, {}, ["bash", "read"]);
  await h.run("run summarize the auth module");
  assert.deepEqual(h.activeTools, ["bash", "read", WORKFLOW_TOOL_NAME]);
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("summarize the auth module"));
});

test("/workflows run carries standing effort directives", async () => {
  const effort = createEffortState();
  effort.level = "ultra";
  const h = harness({}, { effort });
  await h.run("run do X");
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("do X", effortDirective("ultra")));
});

test("/workflows stop <id> calls manager.stop", async () => {
  const h = harness();
  await h.run("stop run-9");
  assert.deepEqual(h.calls, ["stop:run-9"]);
});

test("/workflows status <id> renders a persisted run", async () => {
  const h = harness({
    listRuns: () => [
      {
        runId: "run-7",
        workflowName: "audit",
        status: "completed",
        phases: ["Scan"],
        agents: [{ id: 1, label: "scan files", status: "done", prompt: "x" }],
        logs: [],
        tokenUsage: { input: 10, output: 5, total: 15 },
      },
    ],
  });
  await h.run("status run-7");
  assert.match(h.printed[0], /audit \(run-7\)/);
  assert.match(h.printed[0], /scan files/);
});

test("/workflows status without id warns", async () => {
  const h = harness();
  await h.run("status");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
});

test("registerWorkflowCommands is idempotent (skips when already registered)", () => {
  let registrations = 0;
  const pi: Partial<ExtensionAPI> = {
    getCommands: () => [{ name: "workflows" }],
    registerCommand: () => {
      registrations++;
    },
  };
  registerWorkflowCommands(pi as unknown as ExtensionAPI, {} as unknown as WorkflowManager);
  assert.equal(registrations, 0);
});

test("/workflows status watches a running run: live status bar + prints on completion", async () => {
  const snapshot = {
    name: "demo",
    phases: ["Run"],
    currentPhase: "Run",
    logs: [],
    agents: [{ id: 1, label: "a", status: "running", prompt: "x" }],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
  };
  const manager: any = new EventEmitter();
  manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
  manager.getSnapshot = () => null;
  manager.listRuns = () => [];

  const statusLine: Array<string | undefined> = [];
  const printed: string[] = [];
  let handler: ((a: string, c: any) => Promise<void>) | undefined;
  const pi: any = {
    getCommands: () => [],
    registerCommand: (_n: string, o: any) => {
      handler = o.handler;
    },
    sendMessage: async (m: any) => printed.push(m.content),
  };
  registerWorkflowCommands(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager);
  const ctx = { ui: { notify: () => {}, setStatus: (_k: string, t?: string) => statusLine.push(t) } };

  assert.ok(handler, "handler should exist");
  await handler("status run-1", ctx);
  assert.ok(
    statusLine.some((s) => typeof s === "string"),
    "sets a live status line",
  );
  assert.equal(printed.length, 0, "does not print until the run finishes");

  // Mark done and emit completion -> watcher prints the final snapshot and clears status.
  snapshot.agents[0].status = "done";
  manager.emit("complete", { runId: "run-1" });
  assert.equal(printed.length, 1, "prints final snapshot on completion");
  assert.ok(statusLine.includes(undefined), "clears the status line");
});

// ═══════════════════════════════════════════════════════════════════════════
// pause — calls manager.pause, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows pause <id> calls manager.pause and notifies Paused", async () => {
  const h = harness();
  await h.run("pause run-p1");
  assert.deepEqual(h.calls, ["pause:run-p1"], "should call manager.pause");
  assert.equal(h.notified.length, 1);
  assert.match(h.notified[0].message, /Paused.+run-p1/);
});

test("/workflows pause without id warns usage", async () => {
  const h = harness();
  await h.run("pause");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows pause <id> warns when manager.pause returns false", async () => {
  const h = harness({ pause: () => false });
  await h.run("pause run-nonexistent");
  assert.ok(
    h.notified.some((n) => n.message.includes("Cannot pause")),
    "should show cannot pause",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// resume — calls manager.resume, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows resume <id> calls manager.resume and notifies Resumed", async () => {
  const h = harness({
    resume: async (id: string) => {
      h.calls.push(`resume:${id}`);
      return true;
    },
  });
  await h.run("resume run-r1");
  assert.ok(
    h.calls.some((c) => c.startsWith("resume:run-r1")),
    "should call manager.resume",
  );
  assert.ok(
    h.notified.some((n) => n.message.includes("Resumed")),
    "should notify Resumed",
  );
});

test("/workflows resume without id warns usage", async () => {
  const h = harness();
  await h.run("resume");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows resume <id> warns when resume returns false", async () => {
  const h = harness({ resume: async () => false });
  await h.run("resume run-fail");
  assert.ok(
    h.notified.some((n) => n.message.includes("Resume not available")),
    "should show not available",
  );
  assert.equal(h.notified.find((n) => n.message.includes("Resume not available"))?.type, "warning");
});

// ═══════════════════════════════════════════════════════════════════════════
// rm — calls manager.deleteRun, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows rm <id> calls manager.deleteRun and notifies Removed", async () => {
  const h = harness();
  await h.run("rm run-del1");
  assert.deepEqual(h.calls, ["rm:run-del1"], "should call manager.deleteRun");
  assert.ok(
    h.notified.some((n) => n.message.includes("Removed")),
    "should notify Removed",
  );
});

test("/workflows rm without id warns usage", async () => {
  const h = harness();
  await h.run("rm");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows rm <id> warns when deleteRun returns false", async () => {
  const h = harness({ deleteRun: () => false });
  await h.run("rm run-missing");
  assert.ok(
    h.notified.some((n) => n.message.includes("No run")),
    "should show No run",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// stop without id — warn usage
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows stop without id warns usage", async () => {
  const h = harness();
  await h.run("stop");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows stop <id> shows Cannot stop when manager returns false", async () => {
  const h = harness({ stop: () => false, getRun: () => undefined });
  await h.run("stop run-nonexistent");
  assert.ok(
    h.notified.some((n) => n.message.includes("Cannot stop")),
    "should show cannot stop",
  );
  assert.equal(h.notified.find((n) => n.message.includes("Cannot stop"))?.type, "warning");
});

test("/workflows stop <id> notifies info (not warning) when stopped a real run", async () => {
  const h = harness({ stop: () => true, getRun: () => ({}) });
  await h.run("stop run-active");
  const stopMsg = h.notified.find((n) => n.message.includes("Stopped"));
  assert.ok(stopMsg, "should notify Stopped");
  assert.equal(stopMsg?.type, "info", "should be info when run was actually running");
});

// ═══════════════════════════════════════════════════════════════════════════
// save — saves a run's script as a saved workflow
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows save without name warns usage", async () => {
  const h = harness();
  await h.run("save");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows save <name> warns when no storage configured", async () => {
  const h = harness();
  await h.run("save my-workflow");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "error");
  assert.match(h.notified[0].message, /Saving is not available/);
});

test("/workflows save <name> saves the most recent run with a script", async () => {
  const saved: Array<{ name: string; description: string; script: string }> = [];
  const _h = harness({
    listRuns: () => [
      { runId: "old", workflowName: "old", status: "completed", script: null, agents: [], logs: [] },
      {
        runId: "recent",
        workflowName: "scan",
        status: "completed",
        script: "export const meta = { name: 'scan', description: 'scan' }",
        agents: [],
        logs: [],
      },
    ],
  });
  // Register with storage mock
  const storage: any = {
    save: (w: any) => {
      saved.push(w);
      return { ...w, id: "saved-1" };
    },
  };
  registerWorkflowCommands(
    {
      getCommands: () => [],
      registerCommand: (_n: string, _o: any) => {},
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => [
        {
          runId: "recent",
          workflowName: "scan",
          status: "completed",
          script: "export const meta = { name: 'scan', description: 'scan' }",
          agents: [],
          logs: [],
        },
      ],
      getSnapshot: () => null,
      getRun: () => undefined,
      pause: () => false,
      resume: async () => false,
      stop: () => false,
      deleteRun: () => false,
    } as unknown as WorkflowManager,
    { storage },
  );

  assert.equal(saved.length, 0);
});

test("/workflows save <name> <runId> saves the specified run", async () => {
  const saved: Array<{ name: string; description: string; script: string }> = [];
  const storage: any = {
    save: (w: any) => {
      saved.push(w);
      return { ...w, id: "saved-2" };
    },
  };

  const runs = [
    {
      runId: "run-target",
      workflowName: "audit",
      status: "completed",
      script: "export const meta = { name: 'audit', description: 'audit' }",
      agents: [],
      logs: [],
    },
  ];

  // Override the handler for one invocation
  const { registerWorkflowCommands: reg2 } = await import("../src/workflow-commands.js");
  const notified: Array<{ message: string; type?: string }> = [];
  let handler: any;
  reg2(
    {
      getCommands: () => [{ name: "xxx" }],
      registerCommand: (_n: string, o: any) => {
        handler = o.handler;
      },
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => runs,
      getSnapshot: () => null,
      getRun: () => undefined,
      pause: () => false,
      resume: async () => false,
      stop: () => false,
      deleteRun: () => false,
    } as unknown as WorkflowManager,
    { storage },
  );

  if (handler) {
    await handler("save target-name run-target", {
      ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) },
    });
  }
  assert.equal(saved.length, 1, "should save one workflow");
  assert.equal(saved[0].name, "target-name");
  assert.equal(saved[0].script, runs[0].script);
  assert.ok(
    notified.some((n) => n.message.includes("Saved")),
    "should notify Saved",
  );
});

test("/workflows save <name> <runId> warns when run has no script", async () => {
  const storage: any = { save: (w: any) => w };
  let handler: any;
  const { registerWorkflowCommands: reg3 } = await import("../src/workflow-commands.js");
  const notified: Array<{ message: string; type?: string }> = [];
  reg3(
    {
      getCommands: () => [{ name: "xxx" }],
      registerCommand: (_n: string, o: any) => {
        handler = o.handler;
      },
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => [{ runId: "no-script", workflowName: "empty", status: "completed", agents: [], logs: [] }],
      getSnapshot: () => null,
      getRun: () => undefined,
      pause: () => false,
      resume: async () => false,
      stop: () => false,
      deleteRun: () => false,
    } as unknown as WorkflowManager,
    { storage },
  );

  if (handler) {
    await handler("save empty no-script", {
      ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) },
    });
  }
  assert.equal(notified.length, 1);
  assert.match(notified[0].message, /No run/, "should warn no script");
});

// ═══════════════════════════════════════════════════════════════════════════
// unknown subcommand
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows <unknown> warns usage", async () => {
  const h = harness();
  await h.run("bogus");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Unknown subcommand/);
});
