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
 * Each tier holds exactly one model spec string.
 * When editing a tier, a single-select picker is used (like Pi's `/model`).
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
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";

/**
 * Register the `/workflows-models` command with Pi.
 */
export function registerWorkflowModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows-models", {
    description: "View and edit model tiers used by workflows (small/medium/big)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      // Load the saved config, or build an in-memory default spread across the
      // available models. If the model registry is empty, fall back to the
      // current Pi model so the tiers are still usable.
      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      let config = loadModelTierConfig() ?? buildDefaultTierConfig(currentModel, listAvailableModelSpecs());
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
          const model = config.tiers[name];
          menuOptions.push(`${name} tier → ${model}`);
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
            "This will reset tiers from your available model list. Continue?",
          );
          if (confirmed) {
            ensureFresh(buildDefaultTierConfig(currentModel, listAvailableModelSpecs()));
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

/**
 * Interactive editor for a single tier — scrollable model picker.
 *
 * Uses `ctx.ui.custom()` with Pi TUI's `SelectList` for proper
 * scrollable list with limited visible rows (like `/advisor`).
 *
 * The currently selected model is shown in the dialog title.
 * User scrolls with ↑↓, selects with Enter, cancels with Escape.
 *
 * Returns the updated tiers object, or null if nothing changed.
 */
export async function editSingleTier(
  ctx: ExtensionCommandContext,
  tiers: Record<string, string>,
  tierName: string,
): Promise<Record<string, string> | null> {
  const available = listAvailableModelSpecs(ctx.modelRegistry);
  const current = tiers[tierName];

  // Build SelectItems: all available models as scrollable list
  const items: SelectItem[] = available.map((m) => ({ value: m, label: m }));

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

  if (!result || result === current) return null;

  ctx.ui.notify(`"${tierName}" tier → ${result}`, "info");
  return { ...tiers, [tierName]: result };
}
