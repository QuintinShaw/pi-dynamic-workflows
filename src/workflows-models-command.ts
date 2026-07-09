/**
 * `/workflows-models` command handler.
 *
 * Uses Pi's built-in `ctx.ui.select()`, `ctx.ui.confirm()`, and `ctx.ui.notify()`
 * to let users view and manage model tier configuration for workflows.
 *
 * Model selection draws from the host session's shared model registry so users
 * see every provider Pi can reach, including extension-registered providers such
 * as `ollama-cloud`.
 *
 * Each tier holds exactly one model spec plus an optional Pi thinking level.
 * When editing a tier, users can change the model and/or thinking effort.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { listAvailableModelSpecs } from "./agent.js";
import {
  buildDefaultTierConfig,
  loadModelTierConfig,
  type ModelTierConfig,
  type ModelTierEntry,
  type ModelTierValue,
  normalizeTierEntry,
  saveModelTierConfig,
  sortedTierNames,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./model-tier-config.js";

/**
 * Register the `/workflows-models` command with Pi.
 */
export function registerWorkflowModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows-models", {
    description: "View and edit workflow model tiers and thinking levels (small/medium/big)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      // Load the saved config, or build an in-memory default spread across the
      // available models. If the model registry is empty, fall back to the
      // current Pi model so the tiers are still usable. Defaults intentionally
      // leave thinkingLevel unset (inherit session/default) until the user picks
      // a tier-specific level.
      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const availableModels = () => listAvailableModelSpecs(ctx.modelRegistry);
      let config = loadModelTierConfig() ?? buildDefaultTierConfig(currentModel, availableModels());
      let dirty = false;

      const ensureFresh = (cfg: typeof config) => {
        config = cfg;
        dirty = true;
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tiers = sortedTierNames(config);
        const menuOptions: string[] = [];

        menuOptions.push("─".repeat(30));
        for (const name of tiers) {
          const entry = getTierEntry(config.tiers[name]);
          menuOptions.push(`${name} tier → ${formatTierEntry(entry)}`);
        }
        menuOptions.push("─".repeat(30));

        menuOptions.push("Reset to defaults");
        menuOptions.push(dirty ? "Save and exit" : "Exit");

        const choice = await ctx.ui.select("Model tier configuration", menuOptions);

        if (!choice) break;

        // Handle "<tier> → [model]" selections
        for (const name of tiers) {
          if (choice.startsWith(`${name} tier →`)) {
            const updatedTiers = await editSingleTier(ctx, config.tiers, name);
            if (updatedTiers !== null) {
              ensureFresh({ ...config, tiers: updatedTiers });
            }
            break;
          }
        }

        if (choice === "Reset to defaults") {
          const confirmed = await ctx.ui.confirm(
            "Reset model tiers",
            "This will reset tiers from your available model list and clear tier-specific thinking levels. Continue?",
          );
          if (confirmed) {
            ensureFresh(buildDefaultTierConfig(currentModel, availableModels()));
            ctx.ui.notify("Tiers reset to defaults. Use 'Save and exit' to persist.", "info");
          }
        }

        if (choice === "Save and exit" || choice === "Exit") {
          if (choice === "Save and exit") {
            saveModelTierConfig(config);
            ctx.ui.notify("Model tiers saved.", "info");
          }
          break;
        }
      }
    },
  });
}

function getTierEntry(value: ModelTierValue | undefined): ModelTierEntry {
  return normalizeTierEntry(value) ?? { model: "" };
}

function formatThinking(thinkingLevel: ThinkingLevel | undefined): string {
  return thinkingLevel ?? "inherit";
}

function withThinking(entry: ModelTierEntry, thinkingLevel: ThinkingLevel | undefined): ModelTierEntry {
  return thinkingLevel ? { model: entry.model, thinkingLevel } : { model: entry.model };
}

function formatTierEntry(entry: ModelTierEntry): string {
  const model = entry.model || "(none)";
  return `${model} · thinking: ${formatThinking(entry.thinkingLevel)}`;
}

/**
 * Interactive editor for a single tier — model picker + thinking-level picker.
 *
 * Returns the updated tiers object, or null if nothing changed / user cancelled.
 */
export async function editSingleTier(
  ctx: ExtensionCommandContext,
  tiers: ModelTierConfig["tiers"],
  tierName: string,
): Promise<ModelTierConfig["tiers"] | null> {
  let entry = getTierEntry(tiers[tierName]);
  let dirty = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const choice = await ctx.ui.select(`Edit "${tierName}" tier`, [
      `Model → ${entry.model || "(none)"}`,
      `Thinking → ${formatThinking(entry.thinkingLevel)}`,
      dirty ? "Save tier" : "Done",
      "Cancel",
    ]);

    if (!choice || choice === "Cancel") return null;

    if (choice.startsWith("Model →")) {
      const nextModel = await pickModelForTier(ctx, tierName, entry.model);
      if (nextModel != null && nextModel !== entry.model) {
        entry = { ...entry, model: nextModel };
        dirty = true;
      }
      continue;
    }

    if (choice.startsWith("Thinking →")) {
      const nextThinking = await pickThinkingLevel(ctx, tierName, entry.thinkingLevel);
      if (nextThinking !== null && nextThinking !== entry.thinkingLevel) {
        entry = withThinking(entry, nextThinking);
        dirty = true;
      }
      continue;
    }

    if (choice === "Save tier" || choice === "Done") {
      if (!dirty) return null;
      ctx.ui.notify(`"${tierName}" tier → ${formatTierEntry(entry)}`, "info");
      return { ...tiers, [tierName]: entry };
    }
  }
}

/** Scrollable model picker for a tier. Returns null on cancel. */
async function pickModelForTier(
  ctx: ExtensionCommandContext,
  tierName: string,
  current: string | undefined,
): Promise<string | null> {
  const available = listAvailableModelSpecs(ctx.modelRegistry);
  const choices = current && !available.includes(current) ? [current, ...available] : available;

  // Build SelectItems: all available models as scrollable list.
  const items: SelectItem[] = choices.map((m) => ({ value: m, label: m }));
  if (items.length === 0) items.push({ value: "", label: "(no available models)" });

  const result = await ctx.ui.custom<string | null>((tui: TUI, theme: Theme, _keybindings, done) => {
    const container = new Container();

    // Title showing current model
    const titleText = current
      ? `Pick a model for "${tierName}" (current: ${current})`
      : `Pick a model for "${tierName}"`;
    container.addChild(new Text(theme.fg("accent", titleText), 1, 0));
    container.addChild(new Spacer(1));

    // SelectList theme
    const selectTheme: SelectListTheme = {
      selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
      selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    };

    const selectList = new SelectList(items, 12, selectTheme);

    // Preselect the current model
    if (current) {
      const idx = items.findIndex((i) => i.value === current);
      if (idx >= 0) selectList.setSelectedIndex(idx);
    }

    // Wire up callbacks
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate  enter select  esc cancel"), 1, 0));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result;
}

/** Thinking-level picker. Undefined means inherit the session/default level; null means cancel. */
async function pickThinkingLevel(
  ctx: ExtensionCommandContext,
  tierName: string,
  current: ThinkingLevel | undefined,
): Promise<ThinkingLevel | undefined | null> {
  const inherit = "Inherit session/default";
  const options = [inherit, ...THINKING_LEVELS];
  const choice = await ctx.ui.select(`Thinking level for "${tierName}" (current: ${formatThinking(current)})`, options);
  if (!choice) return null;
  if (choice === inherit) return undefined;
  return (THINKING_LEVELS as readonly string[]).includes(choice) ? (choice as ThinkingLevel) : null;
}
