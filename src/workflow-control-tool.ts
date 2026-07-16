import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { aggregateAgentUsage, tokenFigures, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
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
]);

export type WorkflowControlInput = Static<typeof workflowControlSchema>;

export interface WorkflowControlToolOptions {
  manager: WorkflowManager;
}

export interface WorkflowControlRunDetails {
  runId: string;
  workflowName: string;
  status: RunStatus;
  phase: string | null;
  counts: {
    total: number;
    done: number;
    running: number;
    paused: number;
    queued: number;
    error: number;
    skipped: number;
  };
  activeLabels: string[];
  tokenTotal: number;
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
      "List and inspect workflow runs, or pause, resume, stop, restart, and remove them without asking the user to run slash commands.",
    promptSnippet: "Inspect and manage workflow runs directly by canonical run ID.",
    promptGuidelines: [
      "Use workflow_control for workflow lifecycle management; do not ask the user to type /workflows when this tool can perform the action.",
      "Use stop to terminate or quit a run. Closing the navigator does not stop a run.",
    ],
    parameters: workflowControlSchema,
    prepareArguments: normalizeInput,
    async execute(_toolCallId, params) {
      if (params.action === "list") {
        const runs = manager.listRuns();
        const summaries = runs.map((run) => summarizeRun(run, manager.getSnapshot(run.runId)));
        return result(
          summaries.length
            ? `action=list result=ok runs=${summaries.length}\n${summaries.map(formatRun).join("\n")}`
            : "action=list result=ok runs=0",
          { action: "list", result: "ok", runs: summaries },
        );
      }

      const run = findRun(manager, params.runId);
      if (!run) return controlError(params.action, params.runId, "run not found", ["list"]);

      switch (params.action) {
        case "status": {
          const summary = summarizeRun(run, manager.getSnapshot(run.runId));
          return result(`action=status result=ok ${formatRun(summary)}`, {
            action: "status",
            result: "ok",
            run: summary,
          });
        }
        case "pause":
          if (!manager.pause(run.runId)) return invalidTransition("pause", run);
          return actionSuccess("pause", "paused", currentSummary(manager, run));
        case "resume":
          if (!(await manager.resume(run.runId))) return invalidTransition("resume", run);
          return actionSuccess("resume", "resumed", currentSummary(manager, run));
        case "stop":
          if (!manager.stop(run.runId)) return invalidTransition("stop", run);
          return actionSuccess("stop", "stopped", currentSummary(manager, run));
        case "restart": {
          if (run.status === "running") {
            return controlError("restart", run.runId, "cannot restart a running run", allowedActions(run.status));
          }
          if (!run.script) {
            return controlError("restart", run.runId, "run has no saved script", allowedActions(run.status));
          }
          const restarted = manager.restart(run.runId);
          if (!restarted) {
            return controlError("restart", run.runId, "run could not be restarted", allowedActions(run.status));
          }
          const next = findRun(manager, restarted.runId);
          const suffix = next
            ? formatRun(summarizeRun(next, manager.getSnapshot(next.runId)))
            : `runId=${restarted.runId} status=running`;
          return result(`action=restart result=restarted sourceRunId=${run.runId} ${suffix}`, {
            action: "restart",
            result: "restarted",
            sourceRunId: run.runId,
            runId: restarted.runId,
          });
        }
        case "remove":
          if (run.status === "running" || run.status === "paused") {
            return controlError("remove", run.runId, `cannot remove a ${run.status} run; stop it first`, [
              "status",
              "stop",
            ]);
          }
          if (!manager.deleteRun(run.runId)) {
            return controlError("remove", run.runId, "run could not be removed", ["list"]);
          }
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
  const actions = new Set(["list", "status", "pause", "resume", "stop", "restart", "remove"]);
  if (typeof input.action !== "string" || !actions.has(input.action)) {
    throw new Error("workflow_control requires action: list|status|pause|resume|stop|restart|remove");
  }

  const allowedKeys = input.action === "list" ? new Set(["action"]) : new Set(["action", "runId"]);
  const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (extraKey) throw new Error(`workflow_control action "${input.action}" does not accept ${extraKey}`);

  if (input.action !== "list" && (typeof input.runId !== "string" || !input.runId.trim())) {
    throw new Error(`workflow_control action "${input.action}" requires runId`);
  }
  return input as WorkflowControlInput;
}

function result(text: string, details: Record<string, unknown>): ControlResult {
  return { content: [{ type: "text", text }], details };
}

function findRun(manager: WorkflowManager, runId: string): PersistedRunState | undefined {
  return manager.listRuns().find((candidate) => candidate.runId === runId);
}

function currentSummary(manager: WorkflowManager, fallback: PersistedRunState): WorkflowControlRunDetails {
  const current = findRun(manager, fallback.runId) ?? fallback;
  return summarizeRun(current, manager.getSnapshot(current.runId));
}

function actionSuccess(action: string, actionResult: string, run: WorkflowControlRunDetails): ControlResult {
  return result(`action=${action} result=${actionResult} ${formatRun(run)}`, {
    action,
    result: actionResult,
    run,
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
      return ["status", "pause", "stop"];
    case "paused":
      return ["status", "resume", "stop", "restart"];
    case "failed":
    case "pending":
      return ["status", "resume", "restart", "remove"];
    case "completed":
    case "aborted":
      return ["status", "restart", "remove"];
  }
}

function summarizeRun(run: PersistedRunState, live?: WorkflowSnapshot | null): WorkflowControlRunDetails {
  const agents = live?.agents ?? run.agents;
  const counts = countAgents(agents);
  const liveUsage = tokenFigures(live?.tokenUsage);
  const persistedUsage = tokenFigures(run.tokenUsage);
  const agentUsage = aggregateAgentUsage(agents);
  return {
    runId: run.runId,
    workflowName: live?.name ?? run.workflowName,
    status: run.status,
    phase: live?.currentPhase ?? run.currentPhase ?? null,
    counts,
    activeLabels: agents.filter((agent) => agent.status === "running").map((agent) => agent.label),
    tokenTotal: Math.max(
      liveUsage.fresh + liveUsage.cacheRead,
      persistedUsage.fresh + persistedUsage.cacheRead,
      agentUsage.fresh + agentUsage.cacheRead,
    ),
  };
}

function countAgents(agents: Array<Pick<WorkflowAgentSnapshot, "status">>): WorkflowControlRunDetails["counts"] {
  return {
    total: agents.length,
    done: agents.filter((agent) => agent.status === "done").length,
    running: agents.filter((agent) => agent.status === "running").length,
    paused: agents.filter((agent) => agent.status === "paused").length,
    queued: agents.filter((agent) => agent.status === "queued").length,
    error: agents.filter((agent) => agent.status === "error").length,
    skipped: agents.filter((agent) => agent.status === "skipped").length,
  };
}

function formatRun(run: WorkflowControlRunDetails): string {
  const active = run.activeLabels.join(",") || "-";
  return `runId=${run.runId} name=${quote(run.workflowName)} status=${run.status} phase=${quote(run.phase ?? "-")} total=${run.counts.total} done=${run.counts.done} running=${run.counts.running} paused=${run.counts.paused} queued=${run.counts.queued} error=${run.counts.error} skipped=${run.counts.skipped} active=${quote(active)} tokens=${run.tokenTotal}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
