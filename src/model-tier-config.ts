/**
 * Model tier configuration for workflow subagent routing.
 *
 * A tier is a named slot (small/medium/big) holding one model spec plus an
 * optional Pi thinking/reasoning effort level. When an agent() call specifies
 * opts.tier, that tier's model and thinkingLevel are applied to the subagent
 * (unless an explicit opts.model is given, which still wins for the model — see
 * agent.ts). Legacy configs that stored a tier as a plain string are accepted
 * and normalized to { model: string } on load/save.
 *
 * This augments the phase-pattern routing in model-routing.ts: phase routing
 * maps workflow phases → models via the script's meta; tiers give scripts a
 * coarse, user-configurable small/medium/big knob that is independent of any
 * concrete provider/model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listAvailableModelSpecs } from "./agent.js";
import { MODEL_TIERS_FILE } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** One tier's concrete runtime selection. */
export interface ModelTierEntry {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

/** Backward-compatible in-memory value: legacy callers may still pass strings. */
export type ModelTierValue = string | ModelTierEntry;

/**
 * Model tier configuration. Maps tier names (e.g. "small", "medium", "big")
 * to one model spec and, optionally, one Pi thinking/reasoning effort level.
 */
export interface ModelTierConfig {
  tiers: Record<string, ModelTierValue>;
}

// ---------------------------------------------------------------------------
// Configuration path
// ---------------------------------------------------------------------------

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homedir(), MODEL_TIERS_FILE);
}

// ---------------------------------------------------------------------------
// Thinking-level validation / normalization
// ---------------------------------------------------------------------------

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Normalize a legacy string or object tier entry. Returns null for invalid shapes. */
export function normalizeTierEntry(value: unknown): ModelTierEntry | null {
  if (typeof value === "string") return { model: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const entry = value as { model?: unknown; thinkingLevel?: unknown };
  if (typeof entry.model !== "string") return null;

  const normalized: ModelTierEntry = { model: entry.model };
  if (entry.thinkingLevel != null) {
    if (!isThinkingLevel(entry.thinkingLevel)) return null;
    normalized.thinkingLevel = entry.thinkingLevel;
  }
  return normalized;
}

/** Normalize a full tier config to the object-entry shape used when saving. */
export function normalizeModelTierConfig(config: unknown): ModelTierConfig | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const tiers = (config as { tiers?: unknown }).tiers;
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) return null;

  const normalized: Record<string, ModelTierEntry> = {};
  for (const [name, raw] of Object.entries(tiers)) {
    const entry = normalizeTierEntry(raw);
    if (!entry) return null;
    normalized[name] = entry;
  }
  return { tiers: normalized };
}

// ---------------------------------------------------------------------------
// Capability hints
// ---------------------------------------------------------------------------

/**
 * Substrings that identify small/cheap models (case-insensitive).
 * Used by `rankByCapability` to rank models lowest so a mini/flash/haiku model
 * never lands in a higher tier than a model without this hint.
 */
export const SMALL_MODEL_HINTS = ["mini", "flash", "haiku", "nano", "small"] as const;

/**
 * Substrings that identify large/capable models (case-insensitive).
 * Used by `rankByCapability` to rank models highest so they are preferred for
 * the big tier over models without this hint.
 */
export const BIG_MODEL_HINTS = ["opus", "pro", "ultra", "large", "plus"] as const;

/**
 * Capability score for a single model spec: +1 if it matches a big-model hint,
 * -1 if it matches a small-model hint, 0 otherwise. If a model happens to
 * match both hint sets (e.g. a name containing both "mini" and "pro"), the
 * small hint wins — we never want a "mini"-labelled model to outrank a
 * neutral or clearly-large one.
 */
function capabilityScore(model: string): number {
  const lower = model.toLowerCase();
  if (SMALL_MODEL_HINTS.some((hint) => lower.includes(hint))) return -1;
  if (BIG_MODEL_HINTS.some((hint) => lower.includes(hint))) return 1;
  return 0;
}

/**
 * Rank `available` models from least to most capable using `capabilityScore`.
 * The sort is stable (ties preserve registry order), so within a score bucket
 * models keep their original relative order.
 */
function rankByCapability(available: string[]): string[] {
  return available
    .map((model, index) => ({ model, index, score: capabilityScore(model) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.model);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function tier(model: string): ModelTierEntry {
  return { model };
}

/**
 * Build a default tier config. When the available model registry is known,
 * spread it across tiers so small/medium/big routing is meaningful out of the
 * box. Default entries intentionally omit thinkingLevel so existing sessions
 * keep their current/default Pi thinking behavior until the user chooses a
 * per-tier value with `/workflows-models`.
 *
 * Models are first ranked least → most capable via `rankByCapability` (which
 * consults `SMALL_MODEL_HINTS` / `BIG_MODEL_HINTS`, falling back to registry
 * order for models that match neither). Tiers are then assigned from this
 * single ranked pool with exclusion — each model is used for at most one
 * tier — so distinct tiers never collapse onto the same model and a
 * mini/flash/haiku model can never outrank a bigger one (no inversion):
 *
 *   - big    = the most capable model (last in the ranking)
 *   - small  = the least capable model (first in the ranking)
 *   - medium = the middle-ranked model
 *
 * When fewer than 3 distinct models are available, this degrades gracefully
 * by reusing the *strongest* available model for the higher tier(s) — it
 * never reuses a weaker model for a higher tier than a stronger one:
 *
 *   - 2 models: small = weaker, medium = big = stronger
 *   - 1 model / 0 models: small = medium = big = that model (or the current
 *     model / "" fallback)
 *
 * `_availableModels` is injectable for testing and for callers that already
 * fetched the registry. When omitted, this reads from the live registry
 * regardless of whether `currentModelSpec` was also provided, so the
 * default-argument path always goes through the same corrected logic instead
 * of silently reproducing the original single-tier collapse.
 */
export function buildDefaultTierConfig(currentModelSpec?: string, _availableModels?: string[]): ModelTierConfig {
  const available = _availableModels ?? listAvailableModelSpecs();
  const ranked = rankByCapability(available);

  if (ranked.length >= 3) {
    const small = ranked[0];
    const big = ranked[ranked.length - 1];
    const medium = ranked[Math.floor(ranked.length / 2)];
    return { tiers: { small: tier(small), medium: tier(medium), big: tier(big) } };
  }
  if (ranked.length === 2) {
    const [weaker, stronger] = ranked;
    return { tiers: { small: tier(weaker), medium: tier(stronger), big: tier(stronger) } };
  }
  const fallback = ranked[0] ?? currentModelSpec ?? "";
  return {
    tiers: {
      small: tier(fallback),
      medium: tier(fallback),
      big: tier(fallback),
    },
  };
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load the model tier config from disk. Returns null if the file does not
 * exist or is unparseable (callers fall back to a default). Legacy string-valued
 * tier configs are accepted and normalized to object entries.
 */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return normalizeModelTierConfig(parsed);
  } catch {
    return null;
  }
}

/**
 * Save a model tier config to disk. Creates parent directories if needed.
 */
export function saveModelTierConfig(config: ModelTierConfig, configPath?: string): void {
  const normalized = normalizeModelTierConfig(config);
  if (!normalized) throw new Error("Invalid model tier config");

  const path = configPath ?? getModelTierConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(normalized, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Resolve / helpers
// ---------------------------------------------------------------------------

/** Resolve a tier name to its normalized entry, or undefined if missing/invalid. */
export function resolveTierEntry(tierName: string, config: ModelTierConfig): ModelTierEntry | undefined {
  const entry = normalizeTierEntry(config.tiers[tierName]);
  return entry ?? undefined;
}

/**
 * Resolve a tier name to its configured model spec, or undefined if the tier
 * is not configured.
 */
export function resolveTierModel(tierName: string, config: ModelTierConfig): string | undefined {
  return resolveTierEntry(tierName, config)?.model;
}

/** Resolve a tier name to its configured thinking level, if any. */
export function resolveTierThinkingLevel(tierName: string, config: ModelTierConfig): ThinkingLevel | undefined {
  return resolveTierEntry(tierName, config)?.thinkingLevel;
}

/** Return all tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}
