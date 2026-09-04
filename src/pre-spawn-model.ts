import { WorkflowError, WorkflowErrorCode } from "./errors.js";

/**
 * How DW arrived at the model intent for this agent, before a host policy runs.
 *
 * - explicit: script `model` or agentType `model`
 * - tier: script `tier` with no explicit model
 * - phase: workflow phase/meta routing (`phases[].model` or `meta.model`)
 * - default: untagged implicit medium-tier routing (not a user pin)
 * - session: no resolved spec; createAgentSession will use the session default
 */
export type ModelSource = "explicit" | "tier" | "phase" | "default" | "session";

/** Minimal fields a host policy needs to decide. No session/history. */
export interface PreSpawnModelContext {
  requestedModel?: string;
  tier?: string;
  resolvedModel?: string;
  modelSource: ModelSource;
  label?: string;
}

export type PreSpawnModelDecision =
  | { action: "unchanged" }
  | { action: "use"; model: string }
  | { action: "reject"; reason: string };

export type PreSpawnModelResolver = (
  ctx: PreSpawnModelContext,
) => PreSpawnModelDecision | Promise<PreSpawnModelDecision>;

const PROCESS_RESOLVER_SLOT = Symbol.for("@quintinshaw/pi-dynamic-workflows.preSpawnModelResolver");

type ResolverSlot = { [PROCESS_RESOLVER_SLOT]?: PreSpawnModelResolver };

/** Process-wide host policy. Last write wins. Pass `undefined` to clear. Uses globalThis so src/dist duplicate copies still share one slot. */
export function setPreSpawnModelResolver(resolver: PreSpawnModelResolver | undefined): void {
  const g = globalThis as ResolverSlot;
  if (resolver) g[PROCESS_RESOLVER_SLOT] = resolver;
  else delete g[PROCESS_RESOLVER_SLOT];
}

export function getPreSpawnModelResolver(): PreSpawnModelResolver | undefined {
  return (globalThis as ResolverSlot)[PROCESS_RESOLVER_SLOT];
}

export function classifyModelSource(input: {
  model?: string;
  tier?: string;
  resolvedModel?: string;
  modelSource?: ModelSource;
}): ModelSource {
  if (input.modelSource) return input.modelSource;
  if (input.model) return "explicit";
  if (input.tier) return "tier";
  if (input.resolvedModel) return "default";
  return "session";
}

/**
 * Run a host policy. Reject and unexpected throw never fall back to the
 * session/parent model — the caller must not createAgentSession afterwards.
 */
export async function applyPreSpawnModel(
  resolver: PreSpawnModelResolver,
  ctx: PreSpawnModelContext,
): Promise<PreSpawnModelDecision> {
  let decision: PreSpawnModelDecision;
  try {
    decision = await resolver(ctx);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(
      error instanceof Error ? error.message : String(error),
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      {
        recoverable: false,
        agentLabel: ctx.label,
      },
    );
  }
  if (!decision || typeof decision !== "object" || typeof (decision as { action?: unknown }).action !== "string") {
    throw new WorkflowError("preSpawnModel returned an invalid decision", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
      recoverable: false,
      agentLabel: ctx.label,
    });
  }
  const action = (decision as { action: string }).action;
  if (action !== "unchanged" && action !== "use" && action !== "reject") {
    throw new WorkflowError(
      `preSpawnModel returned unknown action "${action}"`,
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      {
        recoverable: false,
        agentLabel: ctx.label,
      },
    );
  }
  if (decision.action === "reject") {
    throw new WorkflowError(
      decision.reason || "preSpawnModel rejected this agent spawn",
      WorkflowErrorCode.MODEL_SPAWN_REJECTED,
      {
        recoverable: false,
        agentLabel: ctx.label,
        details: { reason: decision.reason },
      },
    );
  }
  if (decision.action === "use" && (typeof decision.model !== "string" || !decision.model.trim())) {
    throw new WorkflowError(
      `Model "${String((decision as { model?: unknown }).model)}" not found. Use /workflows-models to choose an available model.`,
      WorkflowErrorCode.MODEL_NOT_FOUND,
      { recoverable: false, agentLabel: ctx.label },
    );
  }
  return decision;
}
