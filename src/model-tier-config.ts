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
// Defaults
// ---------------------------------------------------------------------------

/**
 * Build a default tier config. When the available model registry is known,
 * spread it across tiers so small/medium/big routing is meaningful out of the
 * box. When the registry is empty or unavailable, fall back to the current Pi
 * model so fresh installs still get usable tier values.
 *
 * `_availableModels` is injectable for testing and for callers that already
 * fetched the registry. When omitted and no current model is provided, this
 * reads from the live registry.
 */
export function buildDefaultTierConfig(currentModelSpec?: string, _availableModels?: string[]): ModelTierConfig {
  const available = _availableModels ?? (currentModelSpec === undefined ? listAvailableModelSpecs() : []);
  if (available.length >= 3) {
    return {
      tiers: {
        small: available[0],
        medium: available[Math.floor(available.length / 2)],
        big: available[available.length - 1],
      },
    };
  }
  if (available.length === 2) {
    return {
      tiers: {
        small: available[0],
        medium: available[1],
        big: available[1],
      },
    };
  }
  const fallback = available[0] ?? currentModelSpec ?? "";
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
