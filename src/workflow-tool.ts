import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listAgentTypes, loadAgentRegistry } from "./agent-registry.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  fmtCost,
  fmtFull,
  fmtTokenSegment,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  tokenFigures,
  type WorkflowSnapshot,
} from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { assertValidRunId } from "./run-persistence.js";
import { parseWorkflowScript, resolveWorkflowScriptPath, type WorkflowRunResult } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

/**
 * Model routing guideline for workflow authors.
 * Tells the LLM about opts.tier (small/medium/big) for runtime-enforced
 * model selection, and opts.model for an exact provider/id override.
 *
 * This string is injected into the workflow tool's promptGuidelines and
 * therefore appears in the LLM's system prompt for every workflow execution.
 */
export function modelRoutingGuideline(): string {
  return [
    "For workflow, the user configures per-tier models (/workflows-models), so TAG EVERY agent with opts.tier by role so those models are actually used.",
    "opts.tier accepts 'small', 'medium', or 'big' and is enforced at runtime.",
    "Small tier: lightweight exploration/search/inventory agents.",
    "Medium tier: balanced analysis agents.",
    "Big tier: synthesis/judgment/decision agents spanning the full context.",
    "An agent with no opts.tier and no opts.model falls back to the user's medium tier; do not rely on that — tag agents explicitly so small/big are used where they fit.",
    "Use opts.model only when the user names a specific model; pass that exact provider/id. opts.model always takes precedence over opts.tier.",
    "Exact model specs may include Pi CLI-style thinking suffixes such as openai-codex/gpt-5.5:xhigh or anthropic/claude-fable-5:max when the user requests a specific effort level.",
  ].join(" ");
}

/**
 * Tells the LLM which named subagent definitions (agentType) are available, so
 * it can route an agent() to a reusable role that binds tools+model+prompt.
 * Returns undefined when no definitions are registered (nothing to advertise).
 */
export function agentTypeGuideline(cwd: string = process.cwd()): string | undefined {
  let types: Array<{ name: string; description?: string }>;
  try {
    types = listAgentTypes(loadAgentRegistry(cwd));
  } catch {
    return undefined;
  }
  if (!types.length) return undefined;
  const list = types.map((t) => (t.description ? `${t.name} (${t.description})` : t.name)).join(", ");
  return `For workflow, opts.agentType routes an agent to a named definition that binds its tools, model, and role prompt. Available agentTypes: ${list}. An explicit opts.model still overrides the definition's model.`;
}

const workflowToolSchema = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("run"), Type.Literal("resume"), Type.Literal("status")], {
      description: "run starts (default), resume continues, status inspects.",
    }),
  ),
  runId: Type.Optional(
    Type.String({
      description: "Run ID for resume and status.",
    }),
  ),
  script: Type.Optional(
    Type.String({
      description:
        "Raw JavaScript workflow source (no fences). Provide exactly one of script/scriptPath. First statement exports meta with name and description; the workflow must call agent() at least once.",
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({
      description: "Path to a workflow script, rooted at ctx.cwd. Provide exactly one of script or scriptPath.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: "Background by default; false blocks and returns the result inline.",
    }),
  ),
  maxAgents: Type.Optional(
    Type.Number({
      description: "Maximum number of agents allowed in this run. Default: 1000.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({
      description:
        "Maximum concurrent agents for this run. Clamped to the runtime maximum. Use when provider/transport stability matters.",
    }),
  ),
  agentRetries: Type.Optional(
    Type.Number({
      description:
        "Retry attempts for recoverable agent failures such as timeout, connection failure, or empty assistant output. Default 0 unless configured.",
    }),
  ),
  agentTimeoutMs: Type.Optional(
    Type.Number({
      description:
        "Timeout per agent in milliseconds. Omit for no hard timeout by default. Set only when the user asks to bound time.",
    }),
  ),
  tokenBudget: Type.Optional(
    Type.Number({
      description:
        "Hard total-token budget for the whole run. Once spent reaches it, further agent() calls fail and the run stops. Omit for no limit. Set it when the user asks to cap spend.",
    }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({
      description:
        "Edit-resume this run ID: unchanged positional agent calls replay; changed/new calls rerun. Background only.",
    }),
  ),
});

export type WorkflowToolInput = {
  action?: "run" | "resume" | "status";
  runId?: string;
  script?: string;
  scriptPath?: string;
  args?: unknown;
  background?: boolean;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  tokenBudget?: number;
  resumeFromRunId?: string;
};

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /** Shared saved-workflow storage. */
  storage?: WorkflowStorage;
  /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default max concurrent agents when no tool-level concurrency is passed. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  const storage = options.storage ?? createWorkflowStorage(options.cwd ?? process.cwd());
  const cwd = options.cwd ?? process.cwd();
  const defaults = resolveWorkflowToolDefaults(options, cwd);
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      concurrency: defaults.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
      defaultAgentTimeoutMs: defaults.agentTimeoutMs,
      defaultAgentRetries: defaults.agentRetries,
      modelAliases: defaults.modelAliases,
      strictModelResolution: defaults.strictModelResolution,
    });

  return defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run, resume, or inspect a deterministic JavaScript workflow that orchestrates subagents with agent(), parallel(), and pipeline().",
    promptSnippet: "workflow agents.",
    // Lazy accessor: the SDK re-reads definition.promptGuidelines on every
    // tool-registry refresh, so changes to the agentType registry are reflected.
    get promptGuidelines() {
      return [
        "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
        "For workflow actions: run needs script or scriptPath; resume needs runId and optional args patch; status needs runId.",
        "For workflow, raw script must not include Markdown fences or prose around it; scriptPath is read fresh for each call and must be a file inside ctx.cwd (no traversal or symlink escapes).",
        "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.",
        "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
        "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
        "For workflow, prefer the built-in quality helpers when they fit (each is built on agent()/parallel() and returns plain data): verify(item, {reviewers, threshold, lens}) for adversarial fact-checking; judgePanel(attempts, {judges, rubric}) to score N candidates and return the best; loopUntilDry({round, key, consecutiveEmpty}) to keep finding until rounds stop yielding new items; completenessCheck(args, results) as a final 'what's missing' critic.",
        "For workflow, when meta.phases declares more than one phase, call phase('Exact Title') at the start of each phase's work (or set opts.phase on each agent) so every agent groups under the correct phase; never declare a phase you don't switch into — a declared phase with no agents shows as 0/0 and any agent you forgot to move stays in the previous phase.",
        "For workflow, do not set tokenBudget or agentTimeoutMs unless the user explicitly asks to cap spend or time; the defaults are unbounded.",
        "For workflow, to bound spend: pass tokenBudget for a hard run-wide cap; carve a per-phase ceiling with phase('Name', {budget: N}) (that phase throws at its sub-budget without touching the run total — wrap its work in try/catch so later phases proceed); use retry(thunk, {attempts, until}) for bounded retry, and gate(thunk, validator, {attempts}) when a validator's feedback should steer the next attempt. To degrade gracefully, branch on budget.remaining() to skip optional rounds or choose a lighter tier.",
        "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
        "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
        "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
        "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
        "For workflow, use low concurrency and agentRetries for unstable provider/transport fan-out runs; retries apply only to recoverable agent failures and still require explicit null handling after exhaustion.",
        "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
        "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
        "For workflow, the default quality shape for fan-out work is finder -> verify -> merge: run one agent per angle or work-unit (in parallel), pass each candidate finding through verify() and drop the unconfirmed, then a single synthesis agent that de-duplicates, ranks by confidence/severity, and caps the output. If nothing survives verification, return an empty result and say so rather than padding.",
        "For workflow, give each subagent a substantive, self-contained task: do not spawn an agent just to read one file or run one command, and do not use one agent only to check on another. Prefer fewer, higher-level agents over many trivial micro-tasks.",
        "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
        modelRoutingGuideline(),
        agentTypeGuideline(),
        "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
        "For workflow, runs are background by default: the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when the run finishes. Pass background: false only when you must use the result inline in this same turn (it will block).",
        "For workflow, you may call `await workflow('saved-name', argsObject)` to run a saved workflow inline and use its result; nesting is one level deep only, and the global 16-concurrent / 1000-total caps hold across the nesting.",
      ].filter((g): g is string => typeof g === "string" && g.length > 0);
    },
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const executionCwd = (ctx as { cwd?: string } | undefined)?.cwd ?? cwd;
      const normalized = normalizeWorkflowToolArgs(params);

      if (normalized.action === "status") {
        const details = workflowRunStatus(manager, normalized.runId as string);
        return {
          content: [
            {
              type: "text",
              text: `Workflow **${details.workflowName}** run \`${details.runId}\` is **${details.status}**${
                details.currentPhase ? ` in phase **${details.currentPhase}**` : ""
              } (${details.agentCount} agent(s)).`,
            },
          ],
          details,
        };
      }

      if (normalized.action === "resume") {
        const runId = normalized.runId as string;
        const resumed = Object.hasOwn(normalized, "args")
          ? await manager.resume(runId, { argsPatch: normalized.args as Record<string, unknown> })
          : await manager.resume(runId);
        if (!resumed) {
          const status = manager.getRunForReport(runId)?.status ?? "not found";
          throw new Error(`Workflow run ${runId} is not resumable (status: ${status})`);
        }
        return {
          content: [
            {
              type: "text",
              text: `Workflow run \`${runId}\` resumed in the background. Its result will be delivered when it finishes.`,
            },
          ],
          details: { runId, background: true, resumed: true },
        };
      }

      const script = resolveWorkflowToolSource(normalized, executionCwd);
      const parsed = parseWorkflowScript(script);

      // Iteration / cached-prefix reuse: resume a prior run with THIS (edited)
      // script instead of creating a brand-new run. Unchanged agent() calls
      // replay from the prior run's journal; the first edited/new call and
      // everything after it re-run live. Always background (the resumed run is
      // detached and its result is delivered back into the conversation).
      if (params.resumeFromRunId) {
        const runId = params.resumeFromRunId;
        const resumeOptions = Object.hasOwn(params, "args") ? { script, args: params.args } : { script };
        const resumed = await manager.resume(runId, resumeOptions);
        if (!resumed) {
          throw new Error(resumeFailureText(manager, runId));
        }
        return {
          content: [{ type: "text", text: resumedText(parsed.meta.name, runId) }],
          details: { runId, background: true, resumedFrom: runId },
        };
      }

      // checkpoint() reaches the human only on a UI-bearing foreground run; a
      // background run is detached, so checkpoint() falls back to its headless
      // default. Map a checkpoint to ctx.ui.confirm (a yes/no gate) when available.
      const uiCtx = ctx as
        | { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
        | undefined;
      const uiConfirm = uiCtx?.hasUI ? uiCtx.ui?.confirm : undefined;
      const confirm = uiConfirm
        ? (promptText: string) => uiConfirm.call(uiCtx?.ui, "Workflow checkpoint", promptText)
        : undefined;

      // Background execution is the default: return immediately so the turn ends
      // and the user isn't blocked. The result is delivered back into the
      // conversation when the run finishes (see installResultDelivery). Only an
      // explicit `background: false` blocks for the result inline.
      if (params.background ?? true) {
        const { runId } = manager.startInBackground(script, params.args, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          cwd: executionCwd,
        });
        return {
          content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
          details: { runId, background: true },
        };
      }

      // Synchronous execution (blocking) — but routed through the manager so the
      // run shows up live in the /workflows navigator and the task panel while it
      // runs, then stays in history afterwards. We still block on the result and
      // return it inline, so the model gets the full output in the same turn.
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
        key: "workflow",
        streamToolUpdates: true,
        maxAgents: 4,
        showResultPreviews: false,
      });

      let result: WorkflowRunResult;
      try {
        result = await manager.runSync(script, params.args, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          cwd: executionCwd,
          confirm,
          externalSignal: signal,
          onProgress(live) {
            snapshot = recomputeWorkflowSnapshot(live);
            display.update(snapshot);
          },
        });
      } catch (error) {
        if (signal?.aborted || (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      // Format token usage (include cost when the provider reports it)
      const tokenSegment = fmtTokenSegment(tokenFigures(result.tokenUsage), fmtFull);
      const tokenInfo = tokenSegment
        ? `\n\nToken usage: ${tokenSegment}${result.tokenUsage?.cost ? ` (${fmtCost(result.tokenUsage.cost)})` : ""}`
        : "";

      const formattedResult =
        result.result !== undefined ? `\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\`` : "";

      return {
        content: [
          {
            type: "text",
            text: `Workflow **${result.meta.name}** completed with **${result.agentCount}** agent(s).${tokenInfo}\n\n## Result${formattedResult}\n\n${reviseHint(result.runId)}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          tokenUsage: result.tokenUsage,
          runId: result.runId,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
      }
      // Fallback: strip markdown syntax so the TUI doesn't display raw asterisks/hashes.
      // The `content` field is for the LLM (where markdown is preserved), but the TUI
      // renderer (Text component) shows text literally — so we strip markdown here.
      const text = result.content?.[0];
      const raw = text?.type === "text" ? text.text : theme.fg("muted", "workflow");
      const clean = raw
        .replace(/\*\*/g, "")
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .replace(/^##+\s*/gm, "")
        .trim();
      return new Text(clean || theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function resolveWorkflowToolDefaults(
  options: WorkflowToolOptions,
  cwd: string,
): {
  agentTimeoutMs: number | null;
  concurrency?: number;
  agentRetries: number;
  modelAliases?: Record<string, string>;
  strictModelResolution?: boolean;
} {
  const settings = loadWorkflowSettings({ cwd });
  return {
    agentTimeoutMs:
      options.defaultAgentTimeoutMs !== undefined
        ? options.defaultAgentTimeoutMs
        : (settings.defaultAgentTimeoutMs ?? null),
    concurrency: options.defaultConcurrency ?? options.concurrency ?? settings.defaultConcurrency,
    agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
    modelAliases: settings.modelAliases,
    strictModelResolution: settings.strictModelResolution,
  };
}

/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" started in the background.`,
    `Run ID: ${runId}`,
    "It keeps running on its own. When it finishes, the result is delivered back",
    "here and the conversation continues automatically — the user does not need to",
    "do anything. Tell the user they can simply wait here for it to finish (it will",
    "resume the conversation by itself), or keep chatting / working on other things",
    "in the meantime; either way the result will come back to this conversation.",
    `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
    reviseHint(runId),
  ].join("\n");
}

/** Hint that a run can be resumed with an edited script and cached prefix. */
export function reviseHint(runId: string | undefined): string {
  if (!runId) return "";
  return `To revise without re-running everything: re-call workflow with resumeFromRunId="${runId}" and an edited script — unchanged agent() calls replay from cache, only edited/new ones re-run.`;
}

export function resumedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" resumed from run ${runId} with your edited script.`,
    "Unchanged agent() calls replay from that run's journal (cache); the first",
    "edited or newly inserted agent() call — and everything after it — re-runs live.",
    "It runs in the background; the result is delivered back here when it finishes,",
    "and the conversation continues automatically. The user can wait or keep working.",
    `Track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
  ].join("\n");
}

export function resumeFailureText(manager: WorkflowManager, runId: string): string {
  assertValidRunId(runId);
  const active = manager.getRun(runId);
  if (active?.status === "running") {
    return `Cannot resume workflow run "${runId}": it is still running. Wait for it to finish (or /workflows stop ${runId}) before resuming with an edited script.`;
  }
  const persisted = manager.getPersistence().load(runId);
  if (!persisted) {
    return `Cannot resume workflow run "${runId}": no run with that ID was found. Use the runId from a prior workflow result, or omit resumeFromRunId to start a new run.`;
  }
  if (persisted.status === "completed") {
    return `Cannot resume workflow run "${runId}": it already completed. Start a new run instead (omit resumeFromRunId).`;
  }
  if (persisted.status === "aborted" || active?.status === "aborted") {
    return `Cannot resume workflow run "${runId}": it was stopped/aborted and is not resumable. Start a new run instead (omit resumeFromRunId).`;
  }
  if (!persisted.script) {
    return `Cannot resume workflow run "${runId}": it has no persisted script to resume. Start a new run instead (omit resumeFromRunId).`;
  }
  return `Cannot resume workflow run "${runId}": it is not currently resumable (it may be busy under another process). Try again shortly, or start a new run.`;
}

function workflowRunStatus(manager: WorkflowManager, runId: string) {
  assertValidRunId(runId);
  const persisted = manager.getRunForReport(runId);
  const active = typeof manager.getRun === "function" ? manager.getRun(runId) : undefined;
  if (!persisted && !active) throw new Error(`Workflow run ${runId} was not found`);
  return {
    runId,
    workflowName: active?.snapshot.name ?? persisted?.workflowName ?? "workflow",
    status: active?.status ?? persisted?.status ?? "unknown",
    currentPhase: active?.snapshot.currentPhase ?? persisted?.currentPhase,
    phases: active?.snapshot.phases ?? persisted?.phases ?? [],
    agentCount: active?.snapshot.agents.length ?? persisted?.agents?.length ?? 0,
    startedAt: active?.startedAt.toISOString() ?? persisted?.startedAt,
    updatedAt: persisted?.updatedAt,
  };
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument");
  const value = args as Record<string, unknown>;
  const action = value.action ?? "run";
  if (action !== "run" && action !== "resume" && action !== "status") {
    throw new Error("workflow `action` must be run, resume, or status");
  }

  const hasScript = Object.hasOwn(value, "script");
  const hasScriptPath = Object.hasOwn(value, "scriptPath");
  const hasRunId = Object.hasOwn(value, "runId");

  if (action === "run") {
    if (hasRunId) throw new Error("workflow action=run must not include `runId`");
    if (hasScript === hasScriptPath) throw new Error("workflow requires exactly one of `script` or `scriptPath`");
    if (hasScript && typeof value.script !== "string") throw new Error("workflow `script` must be a string");
    if (hasScriptPath && (typeof value.scriptPath !== "string" || value.scriptPath.trim().length === 0)) {
      throw new Error("workflow `scriptPath` must be a non-empty string");
    }
    if (value.resumeFromRunId !== undefined) {
      if (typeof value.resumeFromRunId !== "string") throw new Error("workflow `resumeFromRunId` must be a string");
      assertValidRunId(value.resumeFromRunId);
    }
    return {
      ...value,
      ...(hasScript ? { script: normalizeWorkflowScript(value.script as string) } : {}),
    } as WorkflowToolInput;
  }

  if (hasScript || hasScriptPath) {
    throw new Error(`workflow action=${action} must not include \`script\` or \`scriptPath\``);
  }
  if (!hasRunId || typeof value.runId !== "string" || value.runId.trim().length === 0) {
    throw new Error(`workflow action=${action} requires a non-empty \`runId\``);
  }
  if (action === "status" && Object.hasOwn(value, "args")) {
    throw new Error("workflow action=status must not include `args`");
  }
  const runOnly = ["background", "maxAgents", "concurrency", "agentRetries", "agentTimeoutMs", "tokenBudget"];
  const invalid = runOnly.find((key) => Object.hasOwn(value, key));
  if (invalid) throw new Error(`workflow action=${action} must not include run-only \`${invalid}\``);

  const runId = value.runId.trim();
  assertValidRunId(runId);
  return { ...value, action, runId } as WorkflowToolInput;
}

function resolveWorkflowToolSource(params: WorkflowToolInput, cwd: string): string {
  const normalized = normalizeWorkflowToolArgs(params);
  if (normalized.script !== undefined) return normalized.script;
  return resolveWorkflowScriptPath(normalized.scriptPath as string, cwd).script;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function _isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
