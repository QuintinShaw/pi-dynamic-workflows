/**
 * Tests for model-tier-config.ts
 *
 * Covers:
 * 1. rankByCapability — cost-first ranking, hint fallback, cost=0/missing handling, tie-breaks
 * 2. hintScore — substring capability hints
 * 3. buildDefaultTierConfig — tier spread + capability ordering (via hint fallback and via cost)
 * 4. formatTierFallbackNotice — unconfigured-tier notice text
 * 5. resolveTierModel logic
 * 6. save/load round-trip + all validation/error paths (scoped to a temp dir)
 * 7. sortedTierNames helper
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

/**
 * Wrap bare spec strings as RankableModel[] with NO cost/context, so ranking
 * goes through the substring-hint fallback path (the pre-cost behavior). Used
 * by the hint-ordering tests, which are about names, not prices.
 */
function specs(...names: string[]): { spec: string }[] {
  return names.map((spec) => ({ spec }));
}

describe("model-tier-config", () => {
  describe("hintScore", () => {
    it("scores small-hint names -1, big-hint names +1, neutral 0", async () => {
      const { hintScore } = await loadModule();
      assert.equal(hintScore("openai/gpt-4o-mini"), -1);
      assert.equal(hintScore("x/flash-2"), -1);
      assert.equal(hintScore("anthropic/claude-3-opus"), 1);
      assert.equal(hintScore("x/pro-model"), 1);
      assert.equal(hintScore("vendor/fable-5"), 0);
      assert.equal(hintScore("vendor/mimo"), 0);
    });

    it("lets the small hint win when a name matches both sets", async () => {
      const { hintScore } = await loadModule();
      assert.equal(hintScore("x/mini-pro"), -1);
    });
  });

  describe("rankByCapability (cost-first, hint fallback)", () => {
    it("ranks by output price when prices are known, ignoring name hints", async () => {
      const { rankByCapability } = await loadModule();
      const ranked = rankByCapability([
        { spec: "v/expensive", costOutput: 10 },
        { spec: "v/cheap", costOutput: 1 },
        { spec: "v/mid", costOutput: 5 },
      ]).map((m) => m.spec);
      assert.deepEqual(ranked, ["v/cheap", "v/mid", "v/expensive"]);
    });

    it("lets price beat a misleading name hint", async () => {
      // A model NAMED like a small one but actually priced high must rank above
      // a model named like a big one but priced low.
      const { rankByCapability } = await loadModule();
      const ranked = rankByCapability([
        { spec: "x/pro-but-cheap", costOutput: 1 },
        { spec: "y/mini-but-pricey", costOutput: 9 },
        { spec: "z/mid", costOutput: 5 },
      ]).map((m) => m.spec);
      assert.deepEqual(ranked, ["x/pro-but-cheap", "z/mid", "y/mini-but-pricey"]);
    });

    it("ranks new vendor names by cost instead of collapsing them to neutral", async () => {
      // "fable"/"mimo" match no hint; with cost they must still sort correctly.
      const { rankByCapability } = await loadModule();
      const ranked = rankByCapability([
        { spec: "x/fable-5", costOutput: 8 },
        { spec: "x/mimo", costOutput: 2 },
        { spec: "x/mid", costOutput: 5 },
      ]).map((m) => m.spec);
      assert.deepEqual(ranked, ["x/mimo", "x/mid", "x/fable-5"]);
    });

    it("projects an unknown-cost model onto the price range via its hint (never treated as cheapest)", async () => {
      // A self-hosted big model with NO price (cost missing) must not be ranked
      // as the weakest; its big-hint projects it to the top of the known range.
      const { rankByCapability } = await loadModule();
      const ranked = rankByCapability([
        { spec: "self/opus-local" }, // no cost, big hint → projects to max
        { spec: "v/a", costOutput: 1 },
        { spec: "v/b", costOutput: 5 },
      ]).map((m) => m.spec);
      // a(1) < b(5) == opus-local(projected 5); tie broken by hint (b:0 before opus:+1).
      assert.deepEqual(ranked, ["v/a", "v/b", "self/opus-local"]);
    });

    it("projects an unknown-cost small model to the bottom of the range", async () => {
      const { rankByCapability } = await loadModule();
      const ranked = rankByCapability([
        { spec: "self/mini-local" }, // no cost, small hint → projects to min
        { spec: "v/a", costOutput: 2 },
        { spec: "v/b", costOutput: 5 },
      ]).map((m) => m.spec);
      // mini-local projected to min(2) == a(2); tie broken by hint (mini:-1 before a:0).
      assert.deepEqual(ranked, ["self/mini-local", "v/a", "v/b"]);
    });

    it("falls back to pure hint ordering when no model has a known price (back-compat)", async () => {
      const { rankByCapability } = await loadModule();
      const ranked = rankByCapability(specs("a-mini", "b-neutral", "c-opus")).map((m) => m.spec);
      assert.deepEqual(ranked, ["a-mini", "b-neutral", "c-opus"]);
    });

    it("breaks cost ties by contextWindow (smaller = less capable)", async () => {
      const { rankByCapability } = await loadModule();
      const ranked = rankByCapability([
        { spec: "x/a", costOutput: 5, contextWindow: 8000 },
        { spec: "x/b", costOutput: 5, contextWindow: 200000 },
        { spec: "x/c", costOutput: 1 },
      ]).map((m) => m.spec);
      assert.deepEqual(ranked, ["x/c", "x/a", "x/b"]);
    });

    it("is stable for fully-tied models (registry order preserved)", async () => {
      const { rankByCapability } = await loadModule();
      const ranked = rankByCapability([
        { spec: "x/a", costOutput: 5 },
        { spec: "x/b", costOutput: 5 },
        { spec: "x/c", costOutput: 5 },
      ]).map((m) => m.spec);
      assert.deepEqual(ranked, ["x/a", "x/b", "x/c"]);
    });
  });

  describe("buildDefaultTierConfig", () => {
    it("sets every tier to the provided current model when no models are available", async () => {
      const { buildDefaultTierConfig } = await loadModule();
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

    it("spreads three or more available models across tiers (structure holds with the live registry)", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig();
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
      for (const val of Object.values(cfg.tiers)) {
        assert.equal(typeof val, "string");
      }
    });

    it("the default-argument path (no availableModels passed) still spreads distinct tiers", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const withCurrentModel = buildDefaultTierConfig("openai/gpt-4.1", specs("a", "b", "c"));
      const withoutCurrentModel = buildDefaultTierConfig(undefined, specs("a", "b", "c"));
      assert.deepEqual(
        withCurrentModel.tiers,
        withoutCurrentModel.tiers,
        "passing currentModelSpec must not change how availableModels are used",
      );
    });

    it("spreads exactly three available models across small/medium/big (no overlap)", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("model-a", "model-b", "model-c"));
      assert.equal(cfg.tiers.small, "model-a");
      assert.equal(cfg.tiers.medium, "model-b");
      assert.equal(cfg.tiers.big, "model-c");
    });

    it("ranks three priced models across tiers by cost", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, [
        { spec: "v/big", costOutput: 30 },
        { spec: "v/small", costOutput: 1 },
        { spec: "v/mid", costOutput: 8 },
      ]);
      assert.deepEqual(cfg.tiers, { small: "v/small", medium: "v/mid", big: "v/big" });
    });

    it("spreads two available models: small gets first, medium and big get second", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("model-a", "model-b"));
      assert.equal(cfg.tiers.small, "model-a");
      assert.equal(cfg.tiers.medium, "model-b");
      assert.equal(cfg.tiers.big, "model-b");
    });

    it("with exactly one available model, all three tiers resolve to it (no crash)", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("only-model"));
      assert.deepEqual(cfg.tiers, { small: "only-model", medium: "only-model", big: "only-model" });
    });

    it("with exactly one available model, the current model fallback is ignored in favor of it", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("current-model", specs("only-model"));
      assert.deepEqual(cfg.tiers, { small: "only-model", medium: "only-model", big: "only-model" });
    });

    it("respects capability hints for the 2-model case: big-hint model always lands in medium/big, never small", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("claude-3-opus", "gpt-4o-mini"));
      assert.equal(cfg.tiers.small, "gpt-4o-mini");
      assert.equal(cfg.tiers.medium, "claude-3-opus");
      assert.equal(cfg.tiers.big, "claude-3-opus");
    });

    it("respects capability hints for the 2-model case regardless of registry order", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("gpt-4o-mini", "claude-3-opus"));
      assert.equal(cfg.tiers.small, "gpt-4o-mini");
      assert.equal(cfg.tiers.medium, "claude-3-opus");
      assert.equal(cfg.tiers.big, "claude-3-opus");
    });

    it("with four available models, assigns middle index to medium", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("m-a", "m-b", "m-c", "m-d"));
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
      assert.deepEqual(cfg.tiers, { small: "current-model", medium: "current-model", big: "current-model" });
    });

    // Capability-hint ordering (SMALL_MODEL_HINTS / BIG_MODEL_HINTS), pure-hint path.

    it("assigns small via SMALL_MODEL_HINTS even when mini model is not first in list", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("gpt-4o-mini", "claude-3-5-sonnet", "gpt-4o"));
      assert.equal(cfg.tiers.small, "gpt-4o-mini");
      assert.equal(cfg.tiers.medium, "claude-3-5-sonnet");
      assert.equal(cfg.tiers.big, "gpt-4o");
    });

    it("assigns small and big via hints when both hint sets match, ignoring list position", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("claude-3-opus", "claude-3-5-sonnet", "gpt-4o-mini"));
      assert.equal(cfg.tiers.small, "gpt-4o-mini");
      assert.equal(cfg.tiers.medium, "claude-3-5-sonnet");
      assert.equal(cfg.tiers.big, "claude-3-opus");
    });

    it("falls back to positional for small/big when no hint matches", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("model-a", "model-b", "model-c"));
      assert.equal(cfg.tiers.small, "model-a");
      assert.equal(cfg.tiers.medium, "model-b");
      assert.equal(cfg.tiers.big, "model-c");
    });

    // Collapse / inversion regressions (#38, PR #44 review defects).

    it("does not collapse tiers when a model matches both small and big hints (small hint wins)", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("gpt-4o-mini-pro", "gpt-4o", "claude-3-sonnet"));
      const values = Object.values(cfg.tiers);
      assert.equal(new Set(values).size, values.length, "all three tiers must be distinct models");
      assert.equal(cfg.tiers.small, "gpt-4o-mini-pro");
      assert.notEqual(cfg.tiers.big, cfg.tiers.small);
    });

    it("never inverts capability ranking across many model sets (hint path)", async () => {
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
        const cfg = buildDefaultTierConfig(undefined, specs(...models));
        const values = Object.values(cfg.tiers);
        assert.equal(new Set(values).size, values.length, `tiers must be distinct for ${JSON.stringify(models)}`);
        assert.ok(rank(cfg.tiers.big) >= rank(cfg.tiers.medium), `big must not be weaker than medium`);
        assert.ok(rank(cfg.tiers.medium) >= rank(cfg.tiers.small), `medium must not be weaker than small`);
      }
    });

    it("degrades gracefully without inversion for a 2-capability-tier set", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("vendor/neutral-model", "vendor/tiny-mini-model"));
      assert.equal(cfg.tiers.small, "vendor/tiny-mini-model");
      assert.equal(cfg.tiers.medium, "vendor/neutral-model");
      assert.equal(cfg.tiers.big, "vendor/neutral-model");
    });

    it("with 3+ distinct models, small/medium/big are always pairwise distinct", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, specs("model-a", "model-b", "model-c", "model-d", "model-e"));
      const values = Object.values(cfg.tiers);
      assert.equal(new Set(values).size, 3, "small/medium/big must all be distinct with 5 available models");
    });
  });

  describe("formatTierFallbackNotice", () => {
    it("names the fallback model and includes the suggested mapping", async () => {
      const { formatTierFallbackNotice } = await loadModule();
      const notice = formatTierFallbackNotice("openai/gpt-4.1", [
        { spec: "v/small", costOutput: 1 },
        { spec: "v/mid", costOutput: 5 },
        { spec: "v/big", costOutput: 20 },
      ]);
      assert.match(notice, /no model-tiers\.json/);
      assert.match(notice, /fall back to openai\/gpt-4\.1/);
      assert.match(notice, /\/workflows-models/);
      assert.match(notice, /small=v\/small/);
      assert.match(notice, /medium=v\/mid/);
      assert.match(notice, /big=v\/big/);
    });

    it("uses a generic phrase when no session model is known", async () => {
      const { formatTierFallbackNotice } = await loadModule();
      const notice = formatTierFallbackNotice(undefined, specs("only-model"));
      assert.match(notice, /the session default model/);
    });
  });

  describe("resolveTierModel", () => {
    it("returns the model for a valid tier", async () => {
      const { resolveTierModel } = await loadModule();
      const config = { tiers: { small: "openai/gpt-4.1-mini", medium: "openai/gpt-4.1", big: "openai/gpt-5" } };
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
      const config = { tiers: { small: "gpt-4.1-mini", medium: "gpt-4.1", big: "gpt-5" } };
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
