import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  registerCheckpointResumeDispatchService,
  releaseCheckpointResponse,
  resolveCheckpointResponse,
} from "./checkpoint-response-token.js";
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
    checkpointId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Exact durable checkpoint ID. For resume only; supply with either response or responseToken.",
      }),
    ),
    response: Type.Optional(
      Type.Unknown({
        description: "JSON-serializable durable checkpoint response. For resume only; requires checkpointId.",
      }),
    ),
    responseToken: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Opaque registered durable checkpoint response. For resume only; requires checkpointId and replaces response.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type WorkflowControlInput = Static<typeof workflowControlSchema>;

export interface WorkflowControlToolOptions {
  manager?: WorkflowManager;
  /** Live manager accessor; prefer over a closed-over manager when the extension may replace it. */
  getManager?: () => WorkflowManager;
}

export interface WorkflowControlRunDetails {
  runId: string;
  workflowName: string;
  status: RunStatus;
  phase: string | null;
  checkpoint: PersistedRunState["checkpoint"] | null;
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
  const getManager = (): WorkflowManager => {
    const m = options.getManager?.() ?? options.manager;
    if (!m) throw new Error("workflow_control: no WorkflowManager configured");
    return m;
  };
  const executeControl = async (params: WorkflowControlInput): Promise<ControlResult> => {
    const manager = getManager();
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
        case "resume": {
          const binding =
            params.checkpointId === undefined ? undefined : { runId: run.runId, checkpointId: params.checkpointId };
          const response =
            binding !== undefined && params.responseToken !== undefined
              ? resolveCheckpointResponse(params.responseToken, binding)
              : params.response;
          const resumeOptions = binding === undefined ? undefined : { checkpointId: binding.checkpointId, response };
          if (!(await manager.resume(run.runId, resumeOptions))) return invalidTransition("resume", run);
          if (binding !== undefined && params.responseToken !== undefined) {
            releaseCheckpointResponse(params.responseToken, binding);
          }
          return actionSuccess("resume", "resumed", currentSummary(manager, run));
        }
        case "stop":
          if (!manager.stop(run.runId)) return invalidTransition("stop", run);
          return actionSuccess("stop", "stopped", currentSummary(manager, run));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return controlError(params.action, run.runId, message, allowedActions(run.status));
    }
  };
  registerCheckpointResumeDispatchService({
    resume: async (request) => executeControl(normalizeInput(request)),
  });
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
      return executeControl(params);
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

  const allowedKeys =
    input.action === "list"
      ? new Set(["action"])
      : input.action === "resume"
        ? new Set(["action", "runId", "checkpointId", "response", "responseToken"])
        : new Set(["action", "runId"]);
  const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (extraKey) throw new Error(`workflow_control action "${input.action}" does not accept ${extraKey}`);

  if (input.action !== "list" && (typeof input.runId !== "string" || !input.runId.trim())) {
    throw new Error(`workflow_control action "${input.action}" requires runId`);
  }
  if (input.action === "resume") {
    const hasCheckpoint = Object.hasOwn(input, "checkpointId");
    const hasResponse = Object.hasOwn(input, "response");
    const hasToken = Object.hasOwn(input, "responseToken");
    if (
      hasCheckpoint !== (hasResponse || hasToken) ||
      (hasResponse && hasToken) ||
      (hasCheckpoint && (typeof input.checkpointId !== "string" || input.checkpointId.length === 0)) ||
      (hasToken && (typeof input.responseToken !== "string" || input.responseToken.length === 0))
    ) {
      throw new Error(
        'workflow_control action "resume" requires checkpointId with exactly one of response or responseToken',
      );
    }
  }
  return input as WorkflowControlInput;
}

function result(text: string, details: Record<string, unknown>): ControlResult {
  return { content: [{ type: "text", text }], details };
}

function findRun(manager: WorkflowManager, runId: string): PersistedRunState | undefined {
  return manager.listAllRuns().find((candidate) => candidate.runId === runId);
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
    checkpoint: run.checkpoint ?? null,
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
  const checkpoint = JSON.stringify(run.checkpoint ?? null);
  return `runId=${run.runId} name=${quote(run.workflowName)} status=${run.status} phase=${quote(run.phase ?? "-")} checkpoint=${checkpoint} total=${run.counts.total} done=${run.counts.done} running=${run.counts.running} queued=${run.counts.queued} error=${run.counts.error} skipped=${run.counts.skipped} active=${quote(active)} tokens=${run.tokenTotal}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
