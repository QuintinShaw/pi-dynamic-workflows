import { join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { type AgentHistoryEntry, compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  loadModelTierConfig,
  type ModelTierConfig,
  resolveTierModel,
  resolveTierThinkingLevel,
  type ThinkingLevel,
} from "./model-tier-config.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";
import { estimateCharCountTokens, estimateTextTokens } from "./token-estimate.js";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string },
  lastText: (messages: unknown[]) => string,
): Promise<T> {
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit the provider limit. Surface that as the real
  // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
  throwIfProviderLimit(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/**
 * Resolve which concrete model spec and thinking level a subagent should use.
 * Model precedence, most specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Thinking precedence is options.thinkingLevel, then the selected tier's
 * thinkingLevel, then the session default (undefined here).
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export interface AgentModelSelection {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/** Resolve the model plus optional thinking level for an agent run. */
export function resolveAgentModelSelection(
  options: { model?: string; tier?: string; thinkingLevel?: ThinkingLevel },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
): AgentModelSelection {
  const needsTierConfig = Boolean(options.tier) || !options.model;
  const config = needsTierConfig ? loadConfig() : null;

  if (options.model) {
    const tierThinking = options.tier && config ? resolveTierThinkingLevel(options.tier, config) : undefined;
    return { model: options.model, thinkingLevel: options.thinkingLevel ?? tierThinking };
  }

  if (options.tier) {
    return {
      model: (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel,
      thinkingLevel: options.thinkingLevel ?? (config ? resolveTierThinkingLevel(options.tier, config) : undefined),
    };
  }

  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) {
      return { model: medium, thinkingLevel: options.thinkingLevel ?? resolveTierThinkingLevel("medium", config) };
    }
  }
  return { thinkingLevel: options.thinkingLevel };
}

export function resolveAgentModelSpec(
  options: { model?: string; tier?: string; thinkingLevel?: ThinkingLevel },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
): string | undefined {
  return resolveAgentModelSelection(options, mainModel, loadConfig).model;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model (`provider/modelId`). Used as a fallback when
   * resolving opts.tier and no model-tiers.json config exists. Without this,
   * a workflow using `{ tier: "small" }` would log a warning and fall through
   * to the session default when no config is saved yet.
   */
  mainModel?: string;
  /**
   * Shared model registry from the host Pi session. When provided, subagents
   * resolve tier/model specs against the same registry the main session uses,
   * including dynamically-registered providers such as ollama-cloud. Without
   * this, the agent builds an isolated registry from disk and may miss models
   * that are only available via extension registration.
   */
  modelRegistry?: ModelRegistry;
}

/**
 * List the user's currently available models (those with auth configured) as
 * `provider/modelId` specs. Used to tell the workflow author which models it may
 * route agents to. Best-effort: returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry?: ModelRegistry): string[] {
  try {
    if (registry) {
      return registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
    }
    const dir = getAgentDir();
    const auth = AuthStorage.create(join(dir, "auth.json"));
    const r = ModelRegistry.create(auth, join(dir, "models.json"));
    return r.getAvailable().map((m) => `${m.provider}/${m.id}`);
  } catch {
    return [];
  }
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface AgentUsageUpdate extends AgentUsage {
  /** True when this is a live estimate; omitted/false means provider-reported usage. */
  estimated?: boolean;
}

const ZERO_USAGE: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
const LIVE_USAGE_THROTTLE_MS = 250;
const LIVE_REASONING_TOKENS_PER_SECOND = 3;

function usageFromStats(stats: unknown): AgentUsage | undefined {
  const s = stats as
    | {
        tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
        cost?: number;
      }
    | undefined;
  const t = s?.tokens;
  if (!t) return undefined;
  const input = finiteNumber(t.input);
  const output = finiteNumber(t.output);
  const cacheRead = finiteNumber(t.cacheRead);
  const cacheWrite = finiteNumber(t.cacheWrite);
  const total = finiteNumber(t.total) || input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total, cost: finiteNumber(s?.cost) };
}

function usageFromAssistantUsage(usage: unknown): AgentUsage | undefined {
  const u = usage as
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: { total?: number };
      }
    | undefined;
  if (!u) return undefined;
  const input = finiteNumber(u.input);
  const output = finiteNumber(u.output);
  const cacheRead = finiteNumber(u.cacheRead);
  const cacheWrite = finiteNumber(u.cacheWrite);
  const total = finiteNumber(u.totalTokens) || input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total, cost: finiteNumber(u.cost?.total) };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost. `total === 0` means the provider reported no usage.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Live usage progress for display while the subagent is still running. Exact
   * provider usage is generally unavailable until the turn ends, so updates may
   * be estimated and should not be used for billing/budget accounting.
   */
  onUsageUpdate?: (usage: AgentUsageUpdate) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`. When it can't be resolved, the session default is used and
   * a warning is logged. When omitted, the session default applies.
   */
  model?: string;
  /**
   * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
   * `model` is given), the model is resolved from the user's model-tiers.json
   * config before `run()` starts, falling back to the session's main model when
   * the tier has no configured entry. The tier's thinkingLevel is also applied
   * unless `thinkingLevel` is set. An explicit `model` always takes priority for
   * the model, so workflow scripts can use `{ tier: "small" }` for coarse routing
   * without caring which concrete model backs that tier.
   */
  tier?: string;
  /** Explicit Pi thinking/reasoning level for this agent. Overrides the tier's configured level. */
  thinkingLevel?: ThinkingLevel;
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** Called with the requested/effective thinking level once known (for display/telemetry). */
  onThinkingLevelResolved?: (thinkingLevel: ThinkingLevel) => void;
  /** Called when `model`/`tier`/phase resolved to a spec that wasn't found (fell back to session default). */
  onModelFallback?: (requestedSpec: string) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
  disallowedToolNames?: string[];
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts (tools restricted to
   * structured_output) before falling back to strict prose extraction. Default 2.
   */
  maxSchemaRetries?: number;
  /**
   * Tools that are always injected AFTER the tool-policy filter (`toolNames` /
   * `disallowedToolNames`), so they are available even under a restrictive
   * allowlist. Used by the workflow runtime to inject shared-store tools into
   * every agent regardless of its agentType definition.
   */
  systemTools?: ToolDefinition[];
  /**
   * Per-run model registry override. Takes precedence over the constructor's
   * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for both model
   * resolution and the `createAgentSession` call this run makes. Falls back to
   * the constructor's shared registry, then a lazily-built disk registry, when
   * omitted.
   */
  modelRegistry?: ModelRegistry;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  /** Shared registry from the host session, when provided. */
  private readonly sharedRegistry?: ModelRegistry;
  /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
  private registry?: ModelRegistry;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.sharedRegistry = options.modelRegistry;
  }

  /**
   * Resolve the registry for a run: an explicit per-run registry wins, then the
   * constructor's shared registry, then a lazily-built disk registry (shared
   * across calls once built).
   */
  private getRegistry(perRunRegistry?: ModelRegistry): ModelRegistry {
    if (perRunRegistry) {
      return perRunRegistry;
    }
    if (this.sharedRegistry) {
      return this.sharedRegistry;
    }
    if (!this.registry) {
      const dir = getAgentDir();
      // Same agentDir/auth files createAgentSession uses by default, so a model
      // resolved here carries valid credentials.
      const auth = AuthStorage.create(join(dir, "auth.json"));
      this.registry = ModelRegistry.create(auth, join(dir, "models.json"));
    }
    return this.registry;
  }

  /**
   * Resolve a model spec to a Model. Accepts `provider/modelId` (unambiguous)
   * or a bare `modelId` (prefers auth-configured models, then any known model).
   * Returns undefined when nothing matches.
   */
  private resolveModel(spec: string, perRunRegistry?: ModelRegistry): Model<any> | undefined {
    const registry = this.getRegistry(perRunRegistry);
    const slash = spec.indexOf("/");
    if (slash > 0) {
      return registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    }
    return registry.getAvailable().find((m) => m.id === spec) ?? registry.getAll().find((m) => m.id === spec);
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
    // since tools capture their cwd at construction and can't be relocated.
    const runCwd = options.cwd ?? this.cwd;
    const baseTools = runCwd === this.cwd ? this.baseTools : createCodingTools(runCwd);
    // Apply the agentType tool policy BEFORE adding structured_output, so a
    // restrictive allowlist never strips the schema tool.
    const customTools: ToolDefinition[] = applyToolPolicy(
      [...baseTools, ...(options.tools ?? [])],
      options.toolNames,
      options.disallowedToolNames,
    );

    // System tools bypass the allowlist/denylist filter (e.g. shared-store tools).
    if (options.systemTools?.length) {
      customTools.push(...options.systemTools);
    }

    const structured = Boolean(options.schema);
    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }
    const fullPrompt = this.buildPrompt(prompt, options as AgentRunOptions<any>, structured);

    // Resolve the model spec (explicit model > tier > session default). This
    // composes with phase-based routing in workflow.ts, which only supplies
    // options.model when a phase pattern matches — so an explicit model wins.
    const modelSelection = resolveAgentModelSelection(options, this.mainModel);
    const modelSpec = modelSelection.model;
    const requestedThinkingLevel = modelSelection.thinkingLevel;

    // Resolve a requested model spec to a Model object. A given-but-unresolved
    // spec falls back to the session default (with a warning) rather than failing.
    let resolvedModel: Model<any> | undefined;
    if (modelSpec) {
      resolvedModel = this.resolveModel(modelSpec, options.modelRegistry);
      if (resolvedModel) {
        options.onModelResolved?.(`${resolvedModel.provider}/${resolvedModel.id}`);
      } else {
        console.warn(`[workflow] model "${modelSpec}" not found; using session default`);
        options.onModelFallback?.(modelSpec);
      }
    }

    const agentDir = getAgentDir();
    const { session } = await createAgentSession({
      cwd: runCwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      // Use real SettingsManager to inherit user's default provider/model settings.
      // SettingsManager.inMemory() doesn't load ~/.pi/settings.json, so subagents
      // would fall back to the first available model (e.g. openai-codex) which may
      // not have valid auth, causing silent empty responses.
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      // Per-run modelRegistry wins over the constructor's shared registry, same
      // precedence as resolveModel() above.
      ...(options.modelRegistry || this.sharedRegistry
        ? { modelRegistry: options.modelRegistry ?? this.sharedRegistry }
        : {}),
      ...this.sessionOptions,
      // Per-call tier/agent thinking wins over any sessionOptions.thinkingLevel.
      ...(requestedThinkingLevel ? { thinkingLevel: requestedThinkingLevel } : {}),
      // Per-call model wins over any sessionOptions.model.
      ...(resolvedModel ? { model: resolvedModel } : {}),
    });

    const effectiveThinkingLevel =
      ((session as unknown as { thinkingLevel?: ThinkingLevel }).thinkingLevel as ThinkingLevel | undefined) ??
      requestedThinkingLevel;
    if (effectiveThinkingLevel) options.onThinkingLevelResolved?.(effectiveThinkingLevel);

    let removeAbortListener: (() => void) | undefined;
    let removeHistoryListener: (() => void) | undefined;
    let removeUsageListener: (() => void) | undefined;
    let liveUsageTimer: ReturnType<typeof setInterval> | undefined;
    let lastHistoryEmit = 0;
    let lastUsageEmit = 0;
    let lastUsageTotal = 0;
    let liveOutputChars = 0;
    let generationStartedAt: number | undefined;
    let lastActualUsage: AgentUsage | undefined;
    const emitHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
    const maybeEmitHistory = () => {
      if (!options.onHistory) return;
      const now = Date.now();
      if (now - lastHistoryEmit < 250) return;
      lastHistoryEmit = now;
      emitHistory();
    };
    const emitUsageUpdate = (usage: AgentUsageUpdate, force = false) => {
      if (!options.onUsageUpdate) return;
      if (usage.total <= 0) return;
      const now = Date.now();
      if (!force && usage.total === lastUsageTotal && now - lastUsageEmit < LIVE_USAGE_THROTTLE_MS) return;
      if (!force && usage.estimated && usage.total < lastUsageTotal) return;
      lastUsageTotal = usage.total;
      lastUsageEmit = now;
      options.onUsageUpdate(usage);
    };
    const readActualUsage = (): AgentUsage | undefined => {
      try {
        return usageFromStats(session.getSessionStats());
      } catch {
        return undefined;
      }
    };
    const emitActualUsage = (usage: AgentUsage | undefined, force = false) => {
      if (!usage || usage.total <= 0) return false;
      lastActualUsage = usage;
      emitUsageUpdate({ ...usage, estimated: false }, force);
      return true;
    };
    const inputEstimate = estimateTextTokens(fullPrompt);
    const emitEstimatedUsage = (force = false) => {
      const elapsedSeconds = generationStartedAt ? Math.max(0, (Date.now() - generationStartedAt) / 1000) : 0;
      const streamedOutput = estimateCharCountTokens(liveOutputChars);
      const heartbeatOutput = Math.ceil(elapsedSeconds * LIVE_REASONING_TOKENS_PER_SECOND);
      const output = Math.max(streamedOutput, heartbeatOutput);
      emitUsageUpdate(
        { ...ZERO_USAGE, input: inputEstimate, output, total: inputEstimate + output, estimated: true },
        force,
      );
    };
    const handleUsageEvent = (event: unknown) => {
      const e = event as {
        type?: string;
        assistantMessageEvent?: { type?: string; delta?: string; partial?: { usage?: unknown } };
        message?: { usage?: unknown };
      };
      if (e.type === "turn_start" || e.type === "message_start") {
        generationStartedAt = Date.now();
        emitEstimatedUsage(true);
        return;
      }
      if (e.type === "message_update") {
        generationStartedAt ??= Date.now();
        const actual = usageFromAssistantUsage(e.assistantMessageEvent?.partial?.usage);
        if (actual?.total) {
          emitActualUsage(actual);
          return;
        }
        const updateType = e.assistantMessageEvent?.type;
        if (updateType === "text_delta" || updateType === "thinking_delta" || updateType === "toolcall_delta") {
          liveOutputChars += e.assistantMessageEvent?.delta?.length ?? 0;
          emitEstimatedUsage();
        }
        return;
      }
      if (e.type === "turn_end") {
        emitActualUsage(usageFromAssistantUsage(e.message?.usage) ?? readActualUsage(), true);
      }
    };
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.onHistory) {
        removeHistoryListener = session.subscribe(() => maybeEmitHistory());
      }
      if (options.onUsageUpdate) {
        emitEstimatedUsage(true);
        removeUsageListener = session.subscribe((event) => handleUsageEvent(event));
        liveUsageTimer = setInterval(() => {
          if (emitActualUsage(readActualUsage())) return;
          if (session.isStreaming || generationStartedAt) emitEstimatedUsage();
        }, 1000);
      }

      await session.prompt(fullPrompt);

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK buries a provider usage/quota limit in the assistant message rather
      // than throwing; detect it here (before the schema/empty-text branches) so it
      // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
      // (schema path) or a silent empty-output null (non-schema path).
      throwIfProviderLimit(session.messages, options.label);

      if (options.schema) {
        return (await resolveStructuredOutput(session, capture, options.schema, options, (m) =>
          this.lastAssistantText(m),
        )) as AgentRunResult<TSchemaDef>;
      }

      const text = this.lastAssistantText(session.messages);
      if (!text.trim()) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: options.label,
        });
      }
      return text as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      removeHistoryListener?.();
      removeUsageListener?.();
      if (liveUsageTimer) clearInterval(liveUsageTimer);
      try {
        emitHistory();
      } catch {
        // History is diagnostic only; never let it mask the real result/error.
      }
      // Read real usage before disposing — dispose tears down the session state.
      if (options.onUsage) {
        try {
          const usage = readActualUsage() ?? lastActualUsage;
          if (usage) {
            options.onUsageUpdate?.({ ...usage, estimated: false });
            options.onUsage(usage);
          }
        } catch {
          // Usage is best-effort; never let stats failure mask the real result/error.
        }
      }
      session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
