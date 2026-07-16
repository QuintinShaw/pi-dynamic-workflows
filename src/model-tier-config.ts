/**
 * Model tier configuration for workflow subagent model routing.
 *
 * A tier is a named slot (small/medium/big) holding exactly ONE model spec
 * string (e.g. "openai/gpt-4.1-mini" or "openai-codex/gpt-5.5:xhigh").
 * When an agent() call specifies opts.tier, that single model is resolved with
 * Pi CLI-style parsing and used as the subagent's model/thinking level (unless
 * an explicit opts.model is given, which always wins — see agent.ts).
 *
 * This augments the phase-pattern routing in model-routing.ts: phase routing
 * maps workflow phases → models via the script's meta; tiers give scripts a
 * coarse, user-configurable small/medium/big knob that is independent of any
 * concrete provider/model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listAvailableModels } from "./agent.js";
import { MODEL_TIERS_FILE } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Model tier configuration. Maps tier names (e.g. "small", "medium", "big")
 * to a single model spec string (e.g. "gpt-4.1-mini", "openai/gpt-4.1-mini",
 * or "openai-codex/gpt-5.5:xhigh").
 */
export interface ModelTierConfig {
  tiers: Record<string, string>;
}

/**
 * The minimal projection of a model that tier ranking needs. Deliberately NOT
 * the SDK's full `Model` type: tier logic depends only on these three fields,
 * so it stays decoupled from the SDK (no `@earendil-works/pi-ai` import here)
 * and is trivially unit-testable with plain objects. `agent.ts`'s
 * `listAvailableModels()` produces these from the live registry.
 */
export interface RankableModel {
  /** Canonical "provider/id" spec string. */
  spec: string;
  /** Per-token output price, if the registry reports one. Missing or 0 = unknown. */
  costOutput?: number;
  /** Context window size, if the registry reports one. */
  contextWindow?: number;
}

// ---------------------------------------------------------------------------
// Configuration path
// ---------------------------------------------------------------------------

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homedir(), MODEL_TIERS_FILE);
}

// ---------------------------------------------------------------------------
// Capability signal
// ---------------------------------------------------------------------------

/**
 * Substrings that identify small/cheap models (case-insensitive), used only as
 * a fallback capability hint when price signals are absent or tied.
 */
export const SMALL_MODEL_HINTS = ["mini", "flash", "haiku", "nano", "small"] as const;

/**
 * Substrings that identify large/capable models (case-insensitive), used only
 * as a fallback capability hint when price signals are absent or tied.
 */
export const BIG_MODEL_HINTS = ["opus", "pro", "ultra", "large", "plus"] as const;

/**
 * Fallback capability hint from a model's name: -1 for a small/cheap name, +1
 * for a large/capable name, 0 otherwise. If a name matches both sets, the small
 * hint wins (we never want a "mini"-labelled model to outrank a neutral or
 * clearly-large one). This is only a FALLBACK: `rankByCapability` prefers the
 * registry's price signal, which is robust to new vendor names (e.g. "fable",
 * "mimo") that match no hint and would otherwise all score 0.
 */
export function hintScore(spec: string): number {
  const lower = spec.toLowerCase();
  if (SMALL_MODEL_HINTS.some((hint) => lower.includes(hint))) return -1;
  if (BIG_MODEL_HINTS.some((hint) => lower.includes(hint))) return 1;
  return 0;
}

/**
 * Rank models from least → most capable.
 *
 * PRIMARY signal is output price (higher price ≈ more capable): within a single
 * registry, price tracks the vendor's capability tier far more robustly than
 * model-name substrings, and it works for models whose names match no hint.
 *
 * Models with an UNKNOWN price (missing or 0 — common for self-hosted
 * `models.json` entries) are NOT treated as "cheapest = weakest". Instead they
 * are projected onto the known price range via their substring hint: a
 * big-hint name lands at the top of the range, a small-hint name at the bottom,
 * a neutral name at the middle. When NO model has a known price at all, this
 * degrades to pure hint ordering (the previous behavior).
 *
 * The comparison is a single total order (projected cost → hint → contextWindow
 * → stable registry index), so the sort is transitive and stable.
 */
export function rankByCapability(models: readonly RankableModel[]): RankableModel[] {
  const knownCosts = models
    .map((m) => m.costOutput)
    .filter((c): c is number => typeof c === "number" && c > 0)
    .sort((a, b) => a - b);
  const hasPriceSignal = knownCosts.length > 0;
  const min = knownCosts[0];
  const max = knownCosts[knownCosts.length - 1];
  const median = knownCosts[Math.floor(knownCosts.length / 2)];

  // Project every model onto the price axis. Undefined only when there is no
  // price signal anywhere (all models unpriced) — then the sort falls through
  // to the hint comparison below.
  const costKey = (m: RankableModel): number | undefined => {
    if (typeof m.costOutput === "number" && m.costOutput > 0) return m.costOutput;
    if (!hasPriceSignal) return undefined;
    const hint = hintScore(m.spec);
    return hint > 0 ? max : hint < 0 ? min : median;
  };

  return models
    .map((m, index) => ({ m, index, cost: costKey(m), hint: hintScore(m.spec), ctx: m.contextWindow ?? 0 }))
    .sort((a, b) => {
      if (a.cost !== undefined && b.cost !== undefined && a.cost !== b.cost) return a.cost - b.cost;
      if (a.hint !== b.hint) return a.hint - b.hint;
      if (a.ctx !== b.ctx) return a.ctx - b.ctx;
      return a.index - b.index;
    })
    .map((entry) => entry.m);
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
 * Models are first ranked least → most capable via `rankByCapability` (price
 * first, name-substring hint as fallback). Tiers are then assigned from this
 * single ranked pool with exclusion — each model is used for at most one tier —
 * so distinct tiers never collapse onto the same model and a weaker model can
 * never outrank a stronger one (no inversion):
 *
 *   - big    = the most capable model (last in the ranking)
 *   - small  = the least capable model (first in the ranking)
 *   - medium = the middle-ranked model
 *
 * When fewer than 3 distinct models are available, this degrades gracefully by
 * reusing the *strongest* available model for the higher tier(s):
 *
 *   - 2 models: small = weaker, medium = big = stronger
 *   - 1 / 0 models: small = medium = big = that model (or the current model /
 *     "" fallback)
 *
 * `availableModels` is injectable for testing and for callers that already
 * fetched the registry. When omitted, this reads from the live registry.
 */
export function buildDefaultTierConfig(
  currentModelSpec?: string,
  availableModels?: readonly RankableModel[],
): ModelTierConfig {
  const models = availableModels ?? listAvailableModels();
  const ranked = rankByCapability(models).map((m) => m.spec);

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

/**
 * One-time notice shown when an agent requests `opts.tier` but no
 * model-tiers.json is configured — in that state tiers silently fall back to
 * the session model (see `resolveAgentModelSpec` in agent.ts), which is easy to
 * miss. This surfaces the fallback and the mapping the user *would* get by
 * configuring, using the same `buildDefaultTierConfig` ranking so the hint is
 * actionable. Pure/string-only so the caller owns how it's emitted.
 */
export function formatTierFallbackNotice(
  mainModel: string | undefined,
  availableModels: readonly RankableModel[],
): string {
  const fallback = mainModel ?? "the session default model";
  const suggested = buildDefaultTierConfig(mainModel, availableModels);
  const mapping = sortedTierNames(suggested)
    .map((tier) => `${tier}=${suggested.tiers[tier] || "?"}`)
    .join("  ");
  return (
    `[workflow] An agent requested opts.tier but no model-tiers.json is configured, so tiers currently ` +
    `fall back to ${fallback}. Run /workflows-models to configure them` +
    (mapping ? `. Suggested mapping from your available models: ${mapping}` : ".")
  );
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
