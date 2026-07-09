import type { ThinkingLevel } from "./model-tier-config.js";

/** Short, human-friendly model label: drop the provider prefix for display. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** Format a model label with its optional thinking/reasoning effort beside it. */
export function formatModelWithThinking(
  model: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): string | undefined {
  const modelLabel = shortModel(model);
  if (modelLabel && thinkingLevel) return `${modelLabel} · ${thinkingLevel}`;
  if (modelLabel) return modelLabel;
  if (thinkingLevel) return `thinking ${thinkingLevel}`;
  return undefined;
}
