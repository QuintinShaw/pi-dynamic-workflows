/**
 * Tests for workflows-models-command.ts
 *
 * Since pi.registerCommand and ctx.ui functions are only available at runtime
 * inside Pi, these tests focus on the pure logic: command creation,
 * the editSingleTier helper, and integration with model-tier-config.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

async function loadCommand() {
  const mod = await import("../src/workflows-models-command.js");
  return mod;
}

function editCtx(selectResults: Array<string | null>, customResult: string | null = null) {
  let selectIndex = 0;
  return {
    ui: {
      select: mock.fn(async () => selectResults[selectIndex++] ?? null),
      custom: mock.fn(async () => customResult),
      notify: mock.fn(),
    },
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai", id: "gpt-4.1-mini" },
        { provider: "openai", id: "gpt-5" },
      ],
      getAll: () => [],
      find: () => undefined,
    },
  };
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
      assert.ok(capturedDescription.toLowerCase().includes("thinking"), "description should mention thinking");
    });
  });

  describe("editSingleTier", () => {
    it("exports editSingleTier function", async () => {
      const mod = await import("../src/workflows-models-command.js");
      assert.equal(typeof mod.editSingleTier, "function");
    });

    it("returns null when user cancels", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = editCtx(["Cancel"]);
      const tiers = { small: { model: "gpt-4.1-mini" } };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.equal(result, null);
    });

    it("returns null when user selects Done without changes", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = editCtx(["Done"]);
      const tiers = { small: { model: "gpt-4.1-mini" } };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.equal(result, null);
    });

    it("selects a different model and returns updated tiers", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = editCtx(["Model → gpt-4.1-mini", "Save tier"], "openai/gpt-5");
      const tiers = { small: { model: "gpt-4.1-mini" } };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.deepEqual(result.small, { model: "openai/gpt-5" });
      assert.equal(ctx.ui.notify.mock.callCount(), 1);
    });

    it("selects a thinking level without changing the model", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = editCtx(["Thinking → inherit", "high", "Save tier"]);
      const tiers = { small: { model: "gpt-4.1-mini" } };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.deepEqual(result.small, { model: "gpt-4.1-mini", thinkingLevel: "high" });
    });

    it("can clear an existing thinking level back to inherit", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = editCtx(["Thinking → high", "Inherit session/default", "Save tier"]);
      const tiers = { small: { model: "gpt-4.1-mini", thinkingLevel: "high" as const } };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.deepEqual(result.small, { model: "gpt-4.1-mini" });
    });

    it("normalizes a legacy string tier when editing", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = editCtx(["Thinking → inherit", "xhigh", "Save tier"]);
      const tiers = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.deepEqual(result.small, { model: "gpt-4.1-mini", thinkingLevel: "xhigh" });
    });
  });
});
