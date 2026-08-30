/**
 * Tests for workflows-models-command.ts
 *
 * Since pi.registerCommand and ctx.ui functions are only available at runtime
 * inside Pi, these tests focus on the pure logic: command creation,
 * the editSingleTier single-select helper, and integration with model-tier-config.
 *
 * editSingleTier now uses ctx.ui.custom() with SelectList.
 * In tests, we mock ctx.ui.custom to directly return the expected value.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { getModelTierConfigPath, getProjectModelTierConfigPath } from "../src/model-tier-config.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

async function loadCommand() {
  const mod = await import("../src/workflows-models-command.js");
  return mod;
}

describe("workflows-models-command", () => {
  describe("registerWorkflowModelsCommand", () => {
    it("registers the workflows-models command with Pi", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      const commands: string[] = [];
      const mockPi = {
        registerCommand: mock.fn((name: string, _opts: unknown) => {
          commands.push(name);
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);

      assert.equal(mockPi.registerCommand.mock.callCount(), 1);
      assert.equal(commands[0], "workflows-models");
    });

    it("provides a description", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      let capturedDescription = "";

      const mockPi = {
        registerCommand: mock.fn((_name: string, opts: { description?: string }) => {
          capturedDescription = opts.description ?? "";
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);
      assert.ok(capturedDescription.length > 0, "description should not be empty");
      assert.ok(capturedDescription.toLowerCase().includes("tier"), "description should mention tiers");
    });
  });

  describe("editSingleTier", () => {
    it("exports editSingleTier function", async () => {
      const mod = await import("../src/workflows-models-command.js");
      assert.equal(typeof mod.editSingleTier, "function");
    });

    it("returns null when user presses Escape (done with null)", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return null (simulating user cancelling)
      const ctx = {
        ui: {
          custom: mock.fn(async () => null),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.equal(result, null);
    });

    it("returns null when user selects the same model and default thinking (no change)", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return the same model that's already selected
      const ctx = {
        ui: {
          custom: mock.fn(async () => "gpt-4.1-mini"),
          select: mock.fn(async () => "Default thinking (session setting)"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.equal(result, null); // no change
    });

    it("selects a different model and returns updated tiers with default thinking", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return a different model
      const ctx = {
        ui: {
          custom: mock.fn(async () => "gpt-5"),
          select: mock.fn(async () => "Default thinking (session setting)"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.small, "gpt-5", "should have changed model");
      assert.equal(typeof result.small, "string", "should still be a string");
    });

    it("lets users choose a thinking level for the selected model", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      let thinkingOptions: string[] = [];
      const ctx = {
        ui: {
          custom: mock.fn(async () => "openai-codex/gpt-5.5"),
          select: mock.fn(async (_title: string, options: string[]) => {
            thinkingOptions = options;
            return "xhigh";
          }),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { big: "openai-codex/gpt-5.5" };

      const result = await editSingleTier(ctx as never, tiers, "big");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.big, "openai-codex/gpt-5.5:xhigh");
      assert.ok(thinkingOptions.includes("xhigh"), "TUI should offer xhigh thinking");
    });

    it("offers max thinking for the selected model", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      let thinkingOptions: string[] = [];
      const ctx = {
        ui: {
          custom: mock.fn(async () => "openai-codex/gpt-5.6-sol"),
          select: mock.fn(async (_title: string, options: string[]) => {
            thinkingOptions = options;
            return "max";
          }),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { big: "openai-codex/gpt-5.6-sol" };

      const result = await editSingleTier(ctx as never, tiers, "big");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.big, "openai-codex/gpt-5.6-sol:max");
      assert.ok(thinkingOptions.includes("max"), "TUI should offer max thinking");
    });

    it("preselects the base model when the current tier has a thinking suffix", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = {
        ui: {
          custom: mock.fn(async () => "openai-codex/gpt-5.5"),
          select: mock.fn(async () => "xhigh"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { big: "openai-codex/gpt-5.5:xhigh" };

      const result = await editSingleTier(ctx as never, tiers, "big");
      assert.equal(result, null, "same model plus same thinking suffix should be unchanged");
    });

    it("selects a model when no current model exists", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = {
        ui: {
          custom: mock.fn(async () => "openai/gpt-4.1-mini"),
          select: mock.fn(async () => "Default thinking (session setting)"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = {};

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.small, "openai/gpt-4.1-mini");
    });
  });

  describe("default tier config on first use (pi >= 0.80.8 regression)", () => {
    it("builds defaults from ctx.modelRegistry, not the empty async disk fallback", async () => {
      // Since pi 0.80.8 the no-registry fallback inside listAvailableModels()
      // initializes asynchronously and reports [] on the FIRST call. If the
      // command handler builds its default tier config without passing the host
      // session's registry, a first-ever /workflows-models open ranks tiers
      // from an empty model list (every tier => ""). Drive the real handler
      // with a stub registry and assert the first menu shows tiers ranked from
      // that registry.
      const { registerWorkflowModelsCommand } = await loadCommand();
      let handler: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
      const mockPi = {
        registerCommand: mock.fn(
          (_name: string, opts: { handler?: (args: unknown, ctx: unknown) => Promise<void> }) => {
            handler = opts.handler;
          },
        ),
      };
      registerWorkflowModelsCommand(mockPi as never);
      assert.ok(handler, "handler should be registered");

      const cheap = {
        provider: "mockvendor",
        id: "cheap-model",
        cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
      };
      const registry = { getAvailable: () => [cheap], getAll: () => [cheap], find: () => cheap };
      const selectCalls: string[][] = [];
      const ctx = {
        waitForIdle: async () => {},
        model: undefined,
        modelRegistry: registry,
        ui: {
          select: mock.fn(async (_title: string, options: string[]) => {
            selectCalls.push(options);
            return "Exit"; // leave the menu immediately, nothing saved
          }),
          notify: mock.fn(),
          confirm: mock.fn(async () => false),
          custom: mock.fn(async () => null),
        },
      };

      // Fresh fake home: no saved model-tiers.json, so the handler must build
      // an in-memory default config.
      const home = mkdtempSync(join(tmpdir(), "pi-dw-wmc-home-"));
      try {
        await withFakeHomeAsync(home, () =>
          (handler as (args: unknown, ctx: unknown) => Promise<void>)(undefined, ctx),
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }

      assert.ok(selectCalls.length >= 1, "the tier menu should have been shown");
      const menu = selectCalls[0].join("\n");
      assert.ok(
        menu.includes("mockvendor/cheap-model"),
        `default tiers must rank from the host registry's models; menu was:\n${menu}`,
      );
    });
  });

  describe("project vs global scope", () => {
    async function registeredHandler() {
      const { registerWorkflowModelsCommand } = await loadCommand();
      let handler: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
      const mockPi = {
        registerCommand: mock.fn(
          (_name: string, opts: { handler?: (args: unknown, ctx: unknown) => Promise<void> }) => {
            handler = opts.handler;
          },
        ),
      };
      registerWorkflowModelsCommand(mockPi as never);
      assert.ok(handler, "handler should be registered");
      return handler;
    }

    function cheapRegistry() {
      const cheap = {
        provider: "mockvendor",
        id: "cheap-model",
        cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
      };
      return { getAvailable: () => [cheap], getAll: () => [cheap], find: () => cheap };
    }

    it("defaults to global scope and leaves behavior unchanged when no project file exists", async () => {
      const handler = await registeredHandler();
      const titles: string[] = [];
      const selectCalls: string[][] = [];
      const home = mkdtempSync(join(tmpdir(), "pi-dw-wmc-home-"));
      const cwd = mkdtempSync(join(tmpdir(), "pi-dw-wmc-cwd-"));
      try {
        await withFakeHomeAsync(home, async () => {
          const globalPath = getModelTierConfigPath();
          mkdirSync(join(globalPath, ".."), { recursive: true });
          writeFileSync(globalPath, JSON.stringify({ tiers: { small: "global/small" } }));
          const ctx = {
            cwd,
            waitForIdle: async () => {},
            model: undefined,
            modelRegistry: cheapRegistry(),
            ui: {
              select: mock.fn(async (title: string, options: string[]) => {
                titles.push(title);
                selectCalls.push(options);
                return "Exit";
              }),
              notify: mock.fn(),
              confirm: mock.fn(async () => false),
              custom: mock.fn(async () => null),
            },
          };
          await handler(undefined, ctx);
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }

      assert.ok(titles[0]?.includes("global"), `title should indicate global scope: ${titles[0]}`);
      const menu = selectCalls[0]?.join("\n") ?? "";
      assert.ok(menu.includes("Editing global tiers"), `menu was:\n${menu}`);
      assert.ok(menu.includes("small tier → global/small"), `menu was:\n${menu}`);
      assert.ok(menu.includes("Switch to project"), `menu was:\n${menu}`);
    });

    it("defaults to project scope and shows overlay-winning models when a project file exists", async () => {
      const handler = await registeredHandler();
      const titles: string[] = [];
      const selectCalls: string[][] = [];
      const home = mkdtempSync(join(tmpdir(), "pi-dw-wmc-home-"));
      const cwd = mkdtempSync(join(tmpdir(), "pi-dw-wmc-cwd-"));
      try {
        await withFakeHomeAsync(home, async () => {
          const globalPath = getModelTierConfigPath();
          const projectPath = getProjectModelTierConfigPath(cwd);
          mkdirSync(join(globalPath, ".."), { recursive: true });
          mkdirSync(join(projectPath, ".."), { recursive: true });
          writeFileSync(globalPath, JSON.stringify({ tiers: { small: "global/small", medium: "global/medium" } }));
          writeFileSync(projectPath, JSON.stringify({ tiers: { small: "project/small" } }));
          const ctx = {
            cwd,
            waitForIdle: async () => {},
            model: undefined,
            modelRegistry: cheapRegistry(),
            ui: {
              select: mock.fn(async (title: string, options: string[]) => {
                titles.push(title);
                selectCalls.push(options);
                return "Exit";
              }),
              notify: mock.fn(),
              confirm: mock.fn(async () => false),
              custom: mock.fn(async () => null),
            },
          };
          await handler(undefined, ctx);
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }

      assert.ok(titles[0]?.includes("project"), `title should indicate project scope: ${titles[0]}`);
      const menu = selectCalls[0]?.join("\n") ?? "";
      assert.ok(menu.includes("Editing project tiers"), `menu was:\n${menu}`);
      assert.ok(menu.includes("small tier → project/small"), `menu was:\n${menu}`);
      assert.ok(menu.includes("medium tier → global/medium"), `menu was:\n${menu}`);
      assert.ok(menu.includes("Switch to global"), `menu was:\n${menu}`);
    });

    it("saves the working config to the project file after switching scope", async () => {
      const handler = await registeredHandler();
      const home = mkdtempSync(join(tmpdir(), "pi-dw-wmc-home-"));
      const cwd = mkdtempSync(join(tmpdir(), "pi-dw-wmc-cwd-"));
      try {
        await withFakeHomeAsync(home, async () => {
          const globalPath = getModelTierConfigPath();
          const projectPath = getProjectModelTierConfigPath(cwd);
          mkdirSync(join(globalPath, ".."), { recursive: true });
          writeFileSync(globalPath, JSON.stringify({ tiers: { small: "global/small" } }));
          const actions = ["Switch to project", "Reset to defaults", "Save and exit"];
          const ctx = {
            cwd,
            waitForIdle: async () => {},
            model: undefined,
            modelRegistry: cheapRegistry(),
            ui: {
              select: mock.fn(async () => actions.shift() ?? "Exit"),
              notify: mock.fn(),
              confirm: mock.fn(async () => true),
              custom: mock.fn(async () => null),
            },
          };
          await handler(undefined, ctx);
          assert.equal(existsSync(projectPath), true, "project file should be written");
          const saved = JSON.parse(readFileSync(projectPath, "utf-8"));
          assert.equal(saved.tiers.small, "mockvendor/cheap-model");
          const global = JSON.parse(readFileSync(globalPath, "utf-8"));
          assert.equal(global.tiers.small, "global/small", "global file must stay untouched");
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
