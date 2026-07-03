/**
 * Model tier configuration for workflow subagent model routing.
 *
 * A tier is a named slot (small/medium/big) holding exactly ONE model spec
 * string (e.g. "openai/gpt-4.1-mini"). When an agent() call specifies
 * opts.tier, that single model is resolved and used as the subagent's model
 * (unless an explicit opts.model is given, which always wins — see agent.ts).
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

/**
 * Model tier configuration. Maps tier names (e.g. "small", "medium", "big")
 * to a single model spec string (e.g. "gpt-4.1-mini" or "openai/gpt-4.1-mini").
 */
export interface ModelTierConfig {
  tiers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Configuration path
// ---------------------------------------------------------------------------

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homedir(), MODEL_TIERS_FILE);
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

/**
 * Build a default tier config. When the available model registry is known,
 * spread it across tiers so small/medium/big routing is meaningful out of the
 * box. When the registry is empty or unavailable, fall back to the current Pi
 * model so fresh installs still get usable tier values.
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
    return { tiers: { small, medium, big } };
  }
  if (ranked.length === 2) {
    const [weaker, stronger] = ranked;
    return { tiers: { small: weaker, medium: stronger, big: stronger } };
  }
  const fallback = ranked[0] ?? currentModelSpec ?? "";
  return {
    tiers: {
      small: fallback,
      medium: fallback,
      big: fallback,
    },
  };
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load the model tier config from disk. Returns null if the file does not
 * exist or is unparseable (callers fall back to a default).
 */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.tiers || typeof parsed.tiers !== "object") return null;
    for (const val of Object.values(parsed.tiers)) {
      if (typeof val !== "string") return null;
    }
    return parsed as ModelTierConfig;
  } catch {
    return null;
  }
}

/**
 * Save a model tier config to disk. Creates parent directories if needed.
 */
export function saveModelTierConfig(config: ModelTierConfig, configPath?: string): void {
  const path = configPath ?? getModelTierConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Resolve / helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a tier name to its configured model spec, or undefined if the tier
 * is not configured.
 */
export function resolveTierModel(tier: string, config: ModelTierConfig): string | undefined {
  return config.tiers[tier];
}

/** Return all tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}
