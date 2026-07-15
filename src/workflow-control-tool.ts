import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
import type { PersistedRunState, RunStatus } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";

const runActionSchema = Type.Union([
  Type.Literal("status"),
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("stop"),
  Type.Literal("restart"),
  Type.Literal("remove"),
]);

const workflowControlSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("list", { description: "List workflow runs." }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: runActionSchema,
      runId: Type.String({ minLength: 1, description: "Canonical workflow run ID." }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("set_concurrency", { description: "Resize a live or resumable workflow." }),
      runId: Type.String({ minLength: 1, description: "Canonical workflow run ID." }),
      concurrency: Type.Integer({ minimum: 1, description: "New positive-integer concurrency limit." }),
    },
    { additionalProperties: false },
  ),
]);

export type WorkflowControlInput = Static<typeof workflowControlSchema>;

export interface WorkflowControlToolOptions {
  manager: WorkflowManager;
}

type ControlResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function createWorkflowControlTool(
  options: WorkflowControlToolOptions,
): ToolDefinition<typeof workflowControlSchema, Record<string, unknown>> {
  const manager = options.manager;
  return defineTool({
    name: "workflow_control",
    label: "Workflow Control",
    description:
      "List and inspect workflow runs, resize live concurrency, or pause, resume, stop (terminate/quit), restart, and remove them without asking the user to run slash commands.",
    promptSnippet: "Manage workflow runs directly by canonical run ID.",
    promptGuidelines: [
      "Use workflow_control for workflow lifecycle management; do not ask the user to type /workflows when this tool can perform the action.",
      "Use stop to terminate or quit a run. Navigator q only closes the navigator and does not stop a run.",
      "Use set_concurrency to resize a running workflow without restarting it. Increasing releases queued agents immediately; decreasing never aborts agents already running.",
    ],
    parameters: workflowControlSchema,
    prepareArguments: normalizeInput,
    async execute(_toolCallId, params) {
      if (params.action === "list") {
        const runs = manager.listRuns();
        return result(
          runs.length
            ? `action=list result=ok runs=${runs.length}\n${runs.map((run) => formatRun(run, manager.getSnapshot(run.runId))).join("\n")}`
            : "action=list result=ok runs=0",
          { action: "list", result: "ok", runIds: runs.map((run) => run.runId) },
        );
      }

      const run = findRun(manager, params.runId);
      if (!run) return controlError(params.action, params.runId, "run not found", ["list"]);

      switch (params.action) {
        case "status":
          return result(`action=status result=ok ${formatRun(run, manager.getSnapshot(run.runId))}`, {
            action: "status",
            result: "ok",
            runId: run.runId,
          });
        case "set_concurrency": {
          const updated = manager.setConcurrency(run.runId, params.concurrency);
          if (!updated) return invalidTransition("set_concurrency", run);
          const current = currentRun(manager, run);
          return result(
            `action=set_concurrency result=updated previous=${updated.previousConcurrency ?? "-"} ${formatRun(current, manager.getSnapshot(run.runId))}`,
            { action: "set_concurrency", result: "updated", runId: run.runId, ...updated },
          );
        }
        case "pause":
          if (!manager.pause(run.runId)) return invalidTransition("pause", run);
          return actionSuccess("pause", "paused", currentRun(manager, run));
        case "resume":
          if (!(await manager.resume(run.runId))) return invalidTransition("resume", run);
          return actionSuccess("resume", "resumed", currentRun(manager, run));
        case "stop":
          if (!manager.stop(run.runId)) return invalidTransition("stop", run);
          return actionSuccess("stop", "stopped", currentRun(manager, run));
        case "restart": {
          if (run.status === "running") {
            return controlError("restart", run.runId, "cannot restart a running run", [
              "status",
              "set_concurrency",
              "pause",
              "stop",
            ]);
          }
          if (!run.script)
            return controlError("restart", run.runId, "run has no saved script", allowedActions(run.status));
          const restarted = manager.restart(run.runId);
          if (!restarted)
            return controlError("restart", run.runId, "run could not be restarted", allowedActions(run.status));
          const next = findRun(manager, restarted.runId);
          return result(
            `action=restart result=restarted sourceRunId=${run.runId} ${next ? formatRun(next, manager.getSnapshot(next.runId)) : `runId=${restarted.runId} status=running`}`,
            { action: "restart", result: "restarted", sourceRunId: run.runId, runId: restarted.runId },
          );
        }
        case "remove":
          if (run.status === "running" || run.status === "paused") {
            return controlError("remove", run.runId, `cannot remove a ${run.status} run; stop it first`, [
              "status",
              "stop",
            ]);
          }
          if (!manager.deleteRun(run.runId))
            return controlError("remove", run.runId, "run could not be removed", ["list"]);
          return result(`action=remove result=removed runId=${run.runId}`, {
            action: "remove",
            result: "removed",
            runId: run.runId,
          });
      }
    },
  });
}

function normalizeInput(value: unknown): WorkflowControlInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow_control requires an object argument");
  }
  const input = value as Record<string, unknown>;
  const actions = new Set(["list", "status", "set_concurrency", "pause", "resume", "stop", "restart", "remove"]);
  if (typeof input.action !== "string" || !actions.has(input.action)) {
    throw new Error("workflow_control requires action: list|status|set_concurrency|pause|resume|stop|restart|remove");
  }
  if (input.action !== "list" && (typeof input.runId !== "string" || !input.runId.trim())) {
    throw new Error(`workflow_control action "${input.action}" requires runId`);
  }
  if (
    input.action === "set_concurrency" &&
    (typeof input.concurrency !== "number" || !Number.isInteger(input.concurrency) || input.concurrency < 1)
  ) {
    throw new Error('workflow_control action "set_concurrency" requires a positive integer concurrency');
  }
  return input as WorkflowControlInput;
}

function result(text: string, details: Record<string, unknown>): ControlResult {
  return { content: [{ type: "text", text }], details };
}

function findRun(manager: WorkflowManager, runId: string): PersistedRunState | undefined {
  return manager.listRuns().find((candidate) => candidate.runId === runId);
}

function currentRun(manager: WorkflowManager, fallback: PersistedRunState): PersistedRunState {
  return findRun(manager, fallback.runId) ?? fallback;
}

function actionSuccess(action: string, actionResult: string, run: PersistedRunState): ControlResult {
  return result(`action=${action} result=${actionResult} ${formatRun(run)}`, {
    action,
    result: actionResult,
    runId: run.runId,
  });
}

function invalidTransition(action: string, run: PersistedRunState): ControlResult {
  return controlError(action, run.runId, `cannot ${action} run with status ${run.status}`, allowedActions(run.status));
}

function controlError(action: string, runId: string, message: string, allowed: string[]): ControlResult {
  return result(
    `action=${action} result=error runId=${runId} error=${message} allowed=${allowed.join(",") || "none"}`,
    { action, result: "error", runId, error: message, allowedActions: allowed },
  );
}

function allowedActions(status: RunStatus): string[] {
  switch (status) {
    case "running":
      return ["status", "set_concurrency", "pause", "stop"];
    case "paused":
      return ["status", "set_concurrency", "resume", "stop", "restart"];
    case "failed":
      return ["status", "set_concurrency", "resume", "restart", "remove"];
    case "completed":
    case "aborted":
      return ["status", "restart", "remove"];
    case "pending":
      return ["status", "set_concurrency", "resume", "restart", "remove"];
  }
}

function formatRun(run: PersistedRunState, live?: WorkflowSnapshot | null): string {
  const agents = live?.agents ?? run.agents;
  const counts = countAgents(agents);
  const phase = live?.currentPhase ?? run.currentPhase ?? "-";
  const active = agents.filter((agent) => agent.status === "running").map((agent) => agent.label);
  const paused = agents
    .filter((agent) => agent.status === "paused")
    .map((agent) => `${agent.label} (${agent.sessionFile ? "session saved" : "fresh restart"})`);
  const concurrency = run.effectiveConcurrency ?? "-";
  const tokens = live?.tokenUsage?.total ?? run.tokenUsage?.total ?? 0;
  return `runId=${run.runId} status=${run.status} phase=${quote(phase)} done=${counts.done} running=${counts.running} paused=${counts.paused} queued=${counts.queued} error=${counts.error} active=${quote(active.join(",") || "-")} pausedAgents=${quote(paused.join(",") || "-")} concurrency=${concurrency} tokens=${tokens}`;
}

function countAgents(agents: Array<Pick<WorkflowAgentSnapshot, "status">>): {
  done: number;
  running: number;
  paused: number;
  queued: number;
  error: number;
} {
  return {
    done: agents.filter((agent) => agent.status === "done").length,
    running: agents.filter((agent) => agent.status === "running").length,
    paused: agents.filter((agent) => agent.status === "paused").length,
    queued: agents.filter((agent) => agent.status === "queued").length,
    error: agents.filter((agent) => agent.status === "error").length,
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}
