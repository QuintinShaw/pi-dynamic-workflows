import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ResolvedModelSpec {
  requestedSpec: string;
  model?: Model<Api>;
  thinkingLevel?: ModelThinkingLevel;
  resolvedSpec?: string;
  warning?: string;
  error?: string;
}

interface ParseModelPatternOptions {
  allowInvalidThinkingLevelFallback?: boolean;
}

interface ParsedModelPattern {
  model?: Model<Api>;
  thinkingLevel?: ModelThinkingLevel;
  warning?: string;
}

const DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.4",
  "azure-openai-responses": "gpt-5.4",
  "openai-codex": "gpt-5.5",
  deepseek: "deepseek-v4-pro",
  google: "gemini-3.1-pro-preview",
  "google-vertex": "gemini-3.1-pro-preview",
  "github-copilot": "gpt-5.4",
  openrouter: "moonshotai/kimi-k2.6",
  "vercel-ai-gateway": "zai/glm-5.1",
  zai: "glm-5.1",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M2.7",
  "minimax-cn": "MiniMax-M2.7",
  moonshotai: "kimi-k2.6",
  "moonshotai-cn": "kimi-k2.6",
  huggingface: "moonshotai/Kimi-K2.6",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  together: "moonshotai/Kimi-K2.6",
  opencode: "kimi-k2.6",
  "opencode-go": "kimi-k2.6",
  "kimi-coding": "kimi-for-coding",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
  xiaomi: "mimo-v2.5-pro",
  "xiaomi-token-plan-cn": "mimo-v2.5-pro",
  "xiaomi-token-plan-ams": "mimo-v2.5-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

export function isThinkingLevel(value: string): value is ModelThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function formatModelSpecWithThinking(modelSpec: string, thinkingLevel: ModelThinkingLevel | undefined): string {
  return thinkingLevel ? `${modelSpec}:${thinkingLevel}` : modelSpec;
}

export function canonicalModelSpec(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Split a stored tier spec for display/editing. Exact known model specs win, so
 * model ids that legitimately contain colons are not mistaken for thinking.
 */
export function splitModelSpecThinking(
  spec: string | undefined,
  knownModelSpecs?: readonly string[],
): { modelSpec: string; thinkingLevel?: ModelThinkingLevel } {
  const trimmed = spec?.trim() ?? "";
  if (!trimmed) return { modelSpec: "", thinkingLevel: undefined };

  const known = knownModelSpecs ? new Set(knownModelSpecs) : undefined;
  if (known?.has(trimmed)) return { modelSpec: trimmed, thinkingLevel: undefined };

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return { modelSpec: trimmed, thinkingLevel: undefined };

  const prefix = trimmed.slice(0, lastColon);
  const suffix = trimmed.slice(lastColon + 1);
  if (!prefix || !isThinkingLevel(suffix)) return { modelSpec: trimmed, thinkingLevel: undefined };
  if (known && !known.has(prefix)) return { modelSpec: trimmed, thinkingLevel: undefined };
  return { modelSpec: prefix, thinkingLevel: suffix };
}

function isAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;
  const normalizedReference = trimmedReference.toLowerCase();

  const canonicalMatches = availableModels.filter(
    (model) => canonicalModelSpec(model).toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.slice(0, slashIndex).trim();
    const modelId = trimmedReference.slice(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }

  const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
  if (exactMatch) return exactMatch;

  const normalizedPattern = modelPattern.toLowerCase();
  const matches = availableModels.filter(
    (model) =>
      model.id.toLowerCase().includes(normalizedPattern) || model.name?.toLowerCase().includes(normalizedPattern),
  );
  if (matches.length === 0) return undefined;

  const aliases = matches.filter((model) => isAlias(model.id));
  if (aliases.length > 0) {
    aliases.sort((a, b) => b.id.localeCompare(a.id));
    return aliases[0];
  }

  const datedVersions = matches.filter((model) => !isAlias(model.id));
  datedVersions.sort((a, b) => b.id.localeCompare(a.id));
  return datedVersions[0];
}

function parseModelPattern(
  pattern: string,
  availableModels: Model<Api>[],
  options?: ParseModelPatternOptions,
): ParsedModelPattern {
  const exactMatch = tryMatchModel(pattern, availableModels);
  if (exactMatch) return { model: exactMatch };

  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) return {};

  const prefix = pattern.slice(0, lastColonIndex);
  const suffix = pattern.slice(lastColonIndex + 1);
  if (isThinkingLevel(suffix)) {
    const result = parseModelPattern(prefix, availableModels, options);
    if (!result.model) return result;
    return {
      model: result.model,
      thinkingLevel: result.warning ? undefined : suffix,
      warning: result.warning,
    };
  }

  if (options?.allowInvalidThinkingLevelFallback === false) return {};

  const result = parseModelPattern(prefix, availableModels, options);
  if (!result.model) return result;
  return {
    model: result.model,
    warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
  };
}

function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const providerModels = availableModels.filter((model) => model.provider === provider);
  if (providerModels.length === 0) return undefined;
  const defaultId = DEFAULT_MODEL_PER_PROVIDER[provider];
  const baseModel = defaultId
    ? (providerModels.find((model) => model.id === defaultId) ?? providerModels[0])
    : providerModels[0];
  return { ...baseModel, id: modelId, name: modelId };
}

/**
 * Resolve a workflow model-tier/agent model string with the same user-facing
 * grammar as Pi CLI `--model`: `provider/modelId[:thinking]`, bare model ids,
 * fuzzy patterns, and exact colon-containing model ids.
 */
export function resolveModelSpecWithThinking(
  spec: string,
  modelRegistry: Pick<ModelRegistry, "getAll">,
): ResolvedModelSpec {
  const requestedSpec = spec.trim();
  if (!requestedSpec) return { requestedSpec, error: "No model spec provided." };

  const availableModels = modelRegistry.getAll();
  if (availableModels.length === 0) {
    return {
      requestedSpec,
      error: "No models available. Check your installation or add models to models.json.",
    };
  }

  const providerMap = new Map<string, string>();
  for (const model of availableModels) {
    providerMap.set(model.provider.toLowerCase(), model.provider);
  }

  let provider: string | undefined;
  let pattern = requestedSpec;
  let inferredProvider = false;
  const slashIndex = requestedSpec.indexOf("/");
  if (slashIndex !== -1) {
    const maybeProvider = requestedSpec.slice(0, slashIndex);
    const canonicalProvider = providerMap.get(maybeProvider.toLowerCase());
    if (canonicalProvider) {
      provider = canonicalProvider;
      pattern = requestedSpec.slice(slashIndex + 1);
      inferredProvider = true;
    }
  }

  if (!provider) {
    const exact = findExactModelReferenceMatch(requestedSpec, availableModels);
    if (exact) {
      return { requestedSpec, model: exact, resolvedSpec: canonicalModelSpec(exact) };
    }
  }

  const candidates = provider ? availableModels.filter((model) => model.provider === provider) : availableModels;
  const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
    allowInvalidThinkingLevelFallback: false,
  });
  if (model) {
    return {
      requestedSpec,
      model,
      thinkingLevel,
      warning,
      resolvedSpec: formatModelSpecWithThinking(canonicalModelSpec(model), thinkingLevel),
    };
  }

  if (inferredProvider) {
    const exact = findExactModelReferenceMatch(requestedSpec, availableModels);
    if (exact) {
      return { requestedSpec, model: exact, resolvedSpec: canonicalModelSpec(exact) };
    }

    const fallback = parseModelPattern(requestedSpec, availableModels, {
      allowInvalidThinkingLevelFallback: false,
    });
    if (fallback.model) {
      return {
        requestedSpec,
        model: fallback.model,
        thinkingLevel: fallback.thinkingLevel,
        warning: fallback.warning,
        resolvedSpec: formatModelSpecWithThinking(canonicalModelSpec(fallback.model), fallback.thinkingLevel),
      };
    }
  }

  if (provider) {
    let fallbackPattern = pattern;
    let fallbackThinking: ModelThinkingLevel | undefined;
    const lastColon = pattern.lastIndexOf(":");
    if (lastColon !== -1) {
      const suffix = pattern.slice(lastColon + 1);
      if (isThinkingLevel(suffix)) {
        fallbackPattern = pattern.slice(0, lastColon);
        fallbackThinking = suffix;
      }
    }

    const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
    if (fallbackModel) {
      const modelWithReasoning =
        fallbackThinking && fallbackThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel;
      const fallbackWarning = warning
        ? `${warning} Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`
        : `Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`;
      return {
        requestedSpec,
        model: modelWithReasoning,
        thinkingLevel: fallbackThinking,
        warning: fallbackWarning,
        resolvedSpec: formatModelSpecWithThinking(canonicalModelSpec(modelWithReasoning), fallbackThinking),
      };
    }
  }

  const display = provider ? `${provider}/${pattern}` : requestedSpec;
  return {
    requestedSpec,
    warning,
    error: `Model "${display}" not found. Use /workflows-models to choose an available model.`,
  };
}
