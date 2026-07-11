import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import fc from "fast-check";
import {
  formatModelSpecWithThinking,
  resolveModelSpecWithThinking,
  splitModelSpecThinking,
  THINKING_LEVELS,
} from "../src/model-spec.js";

function model(provider: string, id: string, name = id): Model<Api> {
  return { provider, id, name } as Model<Api>;
}

function registry(models: Model<Api>[]): Pick<ModelRegistry, "getAll"> {
  return { getAll: () => models } as Pick<ModelRegistry, "getAll">;
}

const letters = "abcdefghijklmnopqrstuvwxyz".split("");
const identifierChars = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");
const segment = fc
  .tuple(fc.constantFrom(...letters), fc.array(fc.constantFrom(...identifierChars), { maxLength: 12 }))
  .map(([head, tail]) => `${head}${tail.join("")}`);
const providerSpec = segment;
const modelIdSpec = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/"));
const thinkingSpec = fc.constantFrom(...THINKING_LEVELS);

describe("model spec thinking suffixes", () => {
  it("resolves provider/model:thinking using Pi CLI-style parsing", () => {
    const gpt55 = model("openai-codex", "gpt-5.5");
    const resolved = resolveModelSpecWithThinking(
      "openai-codex/gpt-5.5:xhigh",
      registry([gpt55, model("openrouter", "openai/gpt-5.5-pro")]),
    );

    assert.equal(resolved.model, gpt55);
    assert.equal(resolved.thinkingLevel, "xhigh");
    assert.equal(resolved.resolvedSpec, "openai-codex/gpt-5.5:xhigh");
  });

  it("resolves max as a Pi thinking level instead of a synthetic model id", () => {
    const gpt56 = model("openai-codex", "gpt-5.6-sol");
    const resolved = resolveModelSpecWithThinking("openai-codex/gpt-5.6-sol:max", registry([gpt56]));

    assert.equal(resolved.model, gpt56);
    assert.equal(resolved.thinkingLevel, "max");
    assert.equal(resolved.resolvedSpec, "openai-codex/gpt-5.6-sol:max");
    assert.equal(resolved.warning, undefined);
  });

  it("does not strip colon suffixes from exact model ids", () => {
    const exactColonModel = model("openrouter", "some:model");
    const resolved = resolveModelSpecWithThinking("openrouter/some:model", registry([exactColonModel]));

    assert.equal(resolved.model, exactColonModel);
    assert.equal(resolved.thinkingLevel, undefined);
    assert.equal(resolved.resolvedSpec, "openrouter/some:model");
  });

  it("uses Pi CLI-style custom provider model fallback without a thinking suffix", () => {
    const base = model("openai-codex", "gpt-5.5");
    const resolved = resolveModelSpecWithThinking("openai-codex/custom-model", registry([base]));

    assert.equal(resolved.model?.provider, "openai-codex");
    assert.equal(resolved.model?.id, "custom-model");
    assert.equal(resolved.thinkingLevel, undefined);
    assert.equal(resolved.resolvedSpec, "openai-codex/custom-model");
    assert.match(resolved.warning ?? "", /Using custom model id/);
  });

  it("preserves valid thinking suffixes for custom provider model ids", () => {
    const base = model("openai-codex", "gpt-5.5");
    const resolved = resolveModelSpecWithThinking("openai-codex/custom-model:xhigh", registry([base]));

    assert.equal(resolved.model?.provider, "openai-codex");
    assert.equal(resolved.model?.id, "custom-model");
    assert.equal(resolved.thinkingLevel, "xhigh");
    assert.equal(resolved.resolvedSpec, "openai-codex/custom-model:xhigh");
  });

  it("property: invalid thinking-like suffixes stay part of unregistered provider model ids", () => {
    fc.assert(
      fc.property(
        modelIdSpec,
        fc.constantFrom("notalevel", "x-high", "HIGH", "reasoning", "ultra"),
        (modelId, suffix) => {
          const base = model("openai-codex", "gpt-5.5");
          const customId = `${modelId}:${suffix}`;
          const resolved = resolveModelSpecWithThinking(`openai-codex/${customId}`, registry([base]));

          assert.equal(resolved.model?.provider, "openai-codex");
          assert.equal(resolved.model?.id, customId);
          assert.equal(resolved.thinkingLevel, undefined);
          assert.equal(resolved.resolvedSpec, `openai-codex/${customId}`);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("formats and splits model specs with optional thinking", () => {
    assert.equal(formatModelSpecWithThinking("openai-codex/gpt-5.5", "xhigh"), "openai-codex/gpt-5.5:xhigh");
    assert.equal(formatModelSpecWithThinking("openai-codex/gpt-5.5", undefined), "openai-codex/gpt-5.5");

    assert.deepEqual(splitModelSpecThinking("openai-codex/gpt-5.5:xhigh", ["openai-codex/gpt-5.5"]), {
      modelSpec: "openai-codex/gpt-5.5",
      thinkingLevel: "xhigh",
    });
    assert.deepEqual(splitModelSpecThinking("openrouter/some:model", ["openrouter/some:model"]), {
      modelSpec: "openrouter/some:model",
      thinkingLevel: undefined,
    });
  });

  it("property: formatting then splitting a known model spec preserves model and thinking", () => {
    fc.assert(
      fc.property(
        providerSpec,
        modelIdSpec,
        fc.option(thinkingSpec, { nil: undefined }),
        (provider, modelId, thinking) => {
          const canonical = `${provider}/${modelId}`;
          const stored = formatModelSpecWithThinking(canonical, thinking);
          assert.deepEqual(splitModelSpecThinking(stored, [canonical]), {
            modelSpec: canonical,
            thinkingLevel: thinking,
          });
        },
      ),
      { numRuns: 150 },
    );
  });

  it("property: resolver agrees with formatter for arbitrary known provider/model specs", () => {
    fc.assert(
      fc.property(
        providerSpec,
        modelIdSpec,
        fc.option(thinkingSpec, { nil: undefined }),
        (provider, modelId, thinking) => {
          const knownModel = model(provider, modelId);
          const spec = formatModelSpecWithThinking(`${provider}/${modelId}`, thinking);
          const resolved = resolveModelSpecWithThinking(spec, registry([knownModel]));
          assert.equal(resolved.model, knownModel);
          assert.equal(resolved.thinkingLevel, thinking);
          assert.equal(resolved.resolvedSpec, spec);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("property: exact model ids containing colons are not treated as thinking suffixes", () => {
    fc.assert(
      fc.property(providerSpec, segment, segment, (provider, left, right) => {
        const colonModelId = `${left}:${right}`;
        const knownModel = model(provider, colonModelId);
        const spec = `${provider}/${colonModelId}`;
        const resolved = resolveModelSpecWithThinking(spec, registry([knownModel]));

        assert.equal(resolved.model, knownModel);
        assert.equal(resolved.thinkingLevel, undefined);
        assert.equal(resolved.resolvedSpec, spec);
        assert.deepEqual(splitModelSpecThinking(spec, [spec]), { modelSpec: spec, thinkingLevel: undefined });
      }),
      { numRuns: 150 },
    );
  });
});
