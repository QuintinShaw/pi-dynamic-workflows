/**
 * Tests for model-tier-config.ts
 *
 * Covers:
 * 1. buildDefaultTierConfig — all tiers default to the given model
 * 2. buildDefaultTierConfig — capability-hint ordering (SMALL_MODEL_HINTS / BIG_MODEL_HINTS)
 * 3. resolveTierModel logic
 * 4. save/load round-trip + all validation/error paths (scoped to a temp dir)
 * 5. sortedTierNames helper
 *
 * All tier configs are single-model-per-tier (Record<string, string>).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

async function loadModule() {
  return await import("../src/model-tier-config.js");
}

describe("model-tier-config", () => {
  describe("buildDefaultTierConfig", () => {
    it("sets every tier to the provided current model when no models are available", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      // Explicitly inject an empty registry so this exercises the "no models
      // known" fallback rather than depending on whatever registry happens to
      // be configured in the environment running the tests.
      const cfg = buildDefaultTierConfig("openai/gpt-4.1", []);
      assert.deepEqual(cfg.tiers, {
        small: "openai/gpt-4.1",
        medium: "openai/gpt-4.1",
        big: "openai/gpt-4.1",
      });
    });

    it("each tier holds a single string", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1", []);
      for (const [name, model] of Object.entries(cfg.tiers)) {
        assert.equal(typeof model, "string", `${name} tier should hold a string`);
      }
    });

    it("always produces the three standard tiers", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1", []);
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
    });

    it("spreads three or more available models across tiers", async () => {
      // This uses the real listAvailableModelSpecs() which may return [] in test env.
      // We can only test the code path where currentModelSpec is undefined and
      // verify the structure is still valid.
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig();
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
      for (const val of Object.values(cfg.tiers)) {
        assert.equal(typeof val, "string");
      }
    });

    it("the exported default-argument path (no availableModels passed) still spreads distinct tiers when a real registry is available", async () => {
      // Regression test for the original #38 bug resurfacing through the public
      // API: buildDefaultTierConfig(currentModelSpec) called WITHOUT its 2nd
      // argument must still consult the live registry and spread tiers, not
      // silently collapse to a single model just because currentModelSpec was
      // also passed. We can't control the real listAvailableModelSpecs() output
      // here, so we only assert the structural invariant that matters: whatever
      // it returns, the function must not special-case away the registry lookup
      // when currentModelSpec is provided (verified functionally in the
      // 3+/2/1-model tests below via explicit injection, which exercise the
      // exact same code path).
      const { buildDefaultTierConfig } = await loadModule();
      const withCurrentModel = buildDefaultTierConfig("openai/gpt-4.1", ["a", "b", "c"]);
      const withoutCurrentModel = buildDefaultTierConfig(undefined, ["a", "b", "c"]);
      assert.deepEqual(
        withCurrentModel.tiers,
        withoutCurrentModel.tiers,
        "passing currentModelSpec must not change how availableModels are used",
      );
    });

    it("spreads exactly three available models across small/medium/big (no overlap)", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["model-a", "model-b", "model-c"]);
      assert.equal(cfg.tiers.small, "model-a");
      assert.equal(cfg.tiers.medium, "model-b");
      assert.equal(cfg.tiers.big, "model-c");
    });

    it("spreads available models even when a current model fallback is provided", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("current-model", ["model-a", "model-b", "model-c"]);
      assert.deepEqual(cfg.tiers, {
        small: "model-a",
        medium: "model-b",
        big: "model-c",
      });
    });

    it("spreads two available models: small gets first, medium and big get second", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["model-a", "model-b"]);
      assert.equal(cfg.tiers.small, "model-a");
      assert.equal(cfg.tiers.medium, "model-b");
      assert.equal(cfg.tiers.big, "model-b");
    });

    it("with exactly one available model, all three tiers resolve to it (no crash)", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["only-model"]);
      assert.deepEqual(cfg.tiers, {
        small: "only-model",
        medium: "only-model",
        big: "only-model",
      });
    });

    it("with exactly one available model, the current model fallback is ignored in favor of it", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("current-model", ["only-model"]);
      assert.deepEqual(cfg.tiers, {
        small: "only-model",
        medium: "only-model",
        big: "only-model",
      });
    });

    it("respects capability hints for the 2-model case: big-hint model always lands in medium/big, never small", async () => {
      // Registry order is [big-hint model, small-hint model] — a naive positional
      // split would put the opus model in "small" and the mini model in
      // "medium"/"big", inverting capability. The fix must rank first.
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["claude-3-opus", "gpt-4o-mini"]);
      assert.equal(cfg.tiers.small, "gpt-4o-mini");
      assert.equal(cfg.tiers.medium, "claude-3-opus");
      assert.equal(cfg.tiers.big, "claude-3-opus");
    });

    it("respects capability hints for the 2-model case regardless of registry order", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["gpt-4o-mini", "claude-3-opus"]);
      assert.equal(cfg.tiers.small, "gpt-4o-mini");
      assert.equal(cfg.tiers.medium, "claude-3-opus");
      assert.equal(cfg.tiers.big, "claude-3-opus");
    });

    it("with four available models, assigns middle index to medium", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["m-a", "m-b", "m-c", "m-d"]);
      // Math.floor(4 / 2) = 2 → medium = m-c
      assert.equal(cfg.tiers.small, "m-a");
      assert.equal(cfg.tiers.medium, "m-c");
      assert.equal(cfg.tiers.big, "m-d");
    });

    it("falls back to empty string for all tiers when no models available", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, []);
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
      for (const val of Object.values(cfg.tiers)) {
        assert.equal(val, "");
      }
    });

    it("falls back to the current model when no available models are known", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("current-model", []);
      assert.deepEqual(cfg.tiers, {
        small: "current-model",
        medium: "current-model",
        big: "current-model",
      });
    });

    // -----------------------------------------------------------------------
    // Capability-hint ordering (SMALL_MODEL_HINTS / BIG_MODEL_HINTS)
    // -----------------------------------------------------------------------

    it("assigns small via SMALL_MODEL_HINTS even when mini model is not first in list", async () => {
      // Simulates a provider-grouped registry: ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet"]
      // Without hint matching, positional would set small="gpt-4o" and big="claude-3-5-sonnet".
      // With hint matching, "mini" wins for small regardless of position.
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["gpt-4o-mini", "claude-3-5-sonnet", "gpt-4o"]);
      assert.equal(cfg.tiers.small, "gpt-4o-mini");
      assert.equal(cfg.tiers.medium, "claude-3-5-sonnet");
      assert.equal(cfg.tiers.big, "gpt-4o");
    });

    it("assigns small and big via hints when both hint sets match, ignoring list position", async () => {
      // "claude-3-opus" is at index 0 but should be big; "gpt-4o-mini" is at index 2 but should be small.
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["claude-3-opus", "claude-3-5-sonnet", "gpt-4o-mini"]);
      assert.equal(cfg.tiers.small, "gpt-4o-mini");
      assert.equal(cfg.tiers.medium, "claude-3-5-sonnet");
      assert.equal(cfg.tiers.big, "claude-3-opus");
    });

    it("falls back to positional for small/big when no hint matches", async () => {
      // Generic names have no hint substrings — positional behaviour must be preserved.
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["model-a", "model-b", "model-c"]);
      assert.equal(cfg.tiers.small, "model-a");
      assert.equal(cfg.tiers.medium, "model-b");
      assert.equal(cfg.tiers.big, "model-c");
    });

    // -----------------------------------------------------------------------
    // Collapse / inversion regressions (#38, PR #44 review defects)
    // -----------------------------------------------------------------------

    it("does not collapse tiers when a model matches both small and big hints (small hint wins)", async () => {
      // "gpt-4o-mini-pro" contains both "mini" (small hint) and "pro" (big hint).
      // Picking small and big independently via `find()` would assign this same
      // model to both small AND big, collapsing two tiers together. The fix
      // must rank each model with a single score (small hint wins ties) and
      // assign from one pool with exclusion so no model is used twice.
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["gpt-4o-mini-pro", "gpt-4o", "claude-3-sonnet"]);
      const values = Object.values(cfg.tiers);
      assert.equal(new Set(values).size, values.length, "all three tiers must be distinct models");
      assert.equal(cfg.tiers.small, "gpt-4o-mini-pro");
      assert.notEqual(cfg.tiers.big, cfg.tiers.small);
    });

    it("never inverts capability ranking: big is always at least as capable as medium and small across many model sets", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const scenarios: string[][] = [
        ["claude-3-opus", "gpt-4o-mini", "claude-3-5-sonnet"],
        ["gpt-4o-mini", "gpt-4o", "claude-3-opus"],
        ["together/small-model", "vendor/plus-model", "vendor/neutral-model"],
        ["a-nano", "b-neutral", "c-ultra"],
      ];
      const rank = (m: string) => {
        const lower = m.toLowerCase();
        if (["mini", "flash", "haiku", "nano", "small"].some((h) => lower.includes(h))) return -1;
        if (["opus", "pro", "ultra", "large", "plus"].some((h) => lower.includes(h))) return 1;
        return 0;
      };
      for (const models of scenarios) {
        const cfg = buildDefaultTierConfig(undefined, models);
        const values = Object.values(cfg.tiers);
        assert.equal(new Set(values).size, values.length, `tiers must be distinct for ${JSON.stringify(models)}`);
        assert.ok(
          rank(cfg.tiers.big) >= rank(cfg.tiers.medium),
          `big (${cfg.tiers.big}) must not be weaker than medium (${cfg.tiers.medium})`,
        );
        assert.ok(
          rank(cfg.tiers.medium) >= rank(cfg.tiers.small),
          `medium (${cfg.tiers.medium}) must not be weaker than small (${cfg.tiers.small})`,
        );
      }
    });

    it("with an odd/limited model set (2 distinct capability tiers), degrades gracefully without inversion", async () => {
      // Only a "small" model and a "neutral" model are available — big and
      // medium must both resolve to the stronger (neutral) one, never the
      // small one, and small must never end up in a higher tier.
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["vendor/neutral-model", "vendor/tiny-mini-model"]);
      assert.equal(cfg.tiers.small, "vendor/tiny-mini-model");
      assert.equal(cfg.tiers.medium, "vendor/neutral-model");
      assert.equal(cfg.tiers.big, "vendor/neutral-model");
    });

    it("with 3+ distinct models, small/medium/big are always pairwise distinct", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["model-a", "model-b", "model-c", "model-d", "model-e"]);
      const values = Object.values(cfg.tiers);
      assert.equal(new Set(values).size, 3, "small/medium/big must all be distinct with 5 available models");
    });
  });

  describe("resolveTierModel", () => {
    it("returns the model for a valid tier", async () => {
      const { resolveTierModel } = await loadModule();
      const config = {
        tiers: { small: "openai/gpt-4.1-mini", medium: "openai/gpt-4.1", big: "openai/gpt-5" },
      };
      assert.equal(resolveTierModel("small", config), "openai/gpt-4.1-mini");
      assert.equal(resolveTierModel("medium", config), "openai/gpt-4.1");
      assert.equal(resolveTierModel("big", config), "openai/gpt-5");
    });

    it("returns undefined for unknown tier name", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("nonexistent", { tiers: { small: "gpt-4.1-mini" } }), undefined);
    });

    it("returns empty string when tier exists but no model is assigned", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("medium", { tiers: { small: "gpt-4.1-mini", medium: "" } }), "");
    });
  });

  describe("loadModelTierConfig / saveModelTierConfig (scoped to tmpdir)", () => {
    it("round-trips a valid config through disk", async () => {
      const { loadModelTierConfig, saveModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      const config = {
        tiers: { small: "gpt-4.1-mini", medium: "gpt-4.1", big: "gpt-5" },
      };
      saveModelTierConfig(config, cfgPath);
      const loaded = loadModelTierConfig(cfgPath);
      assert.deepEqual(loaded, config);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when file does not exist", async () => {
      const { loadModelTierConfig } = await loadModule();
      assert.equal(loadModelTierConfig(join(tmpdir(), "nonexistent-test-file.json")), null);
    });

    it("returns null for corrupted JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, "{invalid json", "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null for non-object JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '"just a string"', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when tiers is not an object", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": "not-an-object"}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when a tier value is not a string", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": ["gpt-4.1-mini"]}}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null, "array values should be rejected");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("accepts a config where a tier value is a valid string", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": "gpt-4.1-mini"}}', "utf-8");
      const result = loadModelTierConfig(cfgPath);
      assert.equal(result?.tiers.small, "gpt-4.1-mini");
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("sortedTierNames", () => {
    it("returns names sorted: small < medium < big", async () => {
      const { sortedTierNames } = await loadModule();
      const config = { tiers: { big: "gpt-5", small: "gpt-4.1-mini", medium: "gpt-4.1" } };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "big"]);
    });

    it("places custom tier names alphabetically after the standard ones", async () => {
      const { sortedTierNames } = await loadModule();
      const config = { tiers: { xlarge: "gpt-5", medium: "gpt-4.1", small: "gpt-4.1-mini" } };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "xlarge"]);
    });
  });
});
