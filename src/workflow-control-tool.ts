import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { aggregateAgentUsage, tokenFigures, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import type { PersistedRunState, RunStatus } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";

// A tool's top-level parameter schema must be a JSON Schema object (`type:
// "object"`). A discriminated Type.Union of two objects serializes to a
// top-level `anyOf` with no `type`, which strict providers (e.g. DeepSeek)
// reject with "schema must be type object, got type: null". So the schema is a
// single object: `action` is the full set of verbs and `runId` is optional at
// the schema level. The per-action requirement (runId is mandatory for every
// action except `list`, and `list` takes no runId) is enforced at runtime in
// normalizeInput() and guarded again in execute().
const workflowControlSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("stop"),
      ],
      { description: "list = all runs (no runId); status/pause/resume/stop act on one run and require runId." },
    ),
    runId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Canonical workflow run ID. Required for status, pause, resume, and stop; omit for list.",
      }),
    ),
  },
  { additionalProperties: false },
);

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
      "List and inspect workflow runs, or pause, resume, and stop them without asking the user to run slash commands.",
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

      // runId is optional in the schema (see workflowControlSchema) but required
      // for every non-list action; normalizeInput already enforces this, and this
      // guard both narrows the type and returns a structured error if a model
      // somehow calls a run action without one.
      if (!params.runId) return controlError(params.action, "", "runId is required for this action", ["list"]);
      const run = findRun(manager, params.runId);
      if (!run) return controlError(params.action, params.runId, "run not found", ["list"]);

      try {
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
        }
      } catch (err) {
        // A transient persistence I/O error (or any unexpected throw from the
        // manager) shouldn't surface as a raw stack trace to the model — report
        // it via the tool's normal structured error shape instead.
        const message = err instanceof Error ? err.message : String(err);
        return controlError(params.action, run.runId, message, allowedActions(run.status));
      }
    },
  });
}

function normalizeInput(value: unknown): WorkflowControlInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow_control requires an object argument");
  }
  const input = value as Record<string, unknown>;
  const actions = new Set(["list", "status", "pause", "resume", "stop"]);
  if (typeof input.action !== "string" || !actions.has(input.action)) {
    throw new Error("workflow_control requires action: list|status|pause|resume|stop");
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
      return ["status", "resume", "stop"];
    case "failed":
    case "pending":
      return ["status", "resume"];
    case "completed":
    case "aborted":
      return ["status"];
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
    queued: agents.filter((agent) => agent.status === "queued").length,
    error: agents.filter((agent) => agent.status === "error").length,
    skipped: agents.filter((agent) => agent.status === "skipped").length,
  };
}

function formatRun(run: WorkflowControlRunDetails): string {
  const active = run.activeLabels.join(",") || "-";
  return `runId=${run.runId} name=${quote(run.workflowName)} status=${run.status} phase=${quote(run.phase ?? "-")} total=${run.counts.total} done=${run.counts.done} running=${run.counts.running} queued=${run.counts.queued} error=${run.counts.error} skipped=${run.counts.skipped} active=${quote(active)} tokens=${run.tokenTotal}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
