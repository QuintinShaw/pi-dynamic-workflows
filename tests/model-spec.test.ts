import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, type ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
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

/**
 * A minimal stand-in for pi's real `ModelRuntime` that satisfies exactly the two
 * members `resolveCliModel` reads (`getModels()` / `hasConfiguredAuth()`). We call
 * pi's ACTUAL exported `resolveCliModel` (not a copy) so the cross-check test below
 * exercises real pi-coding-agent code; the cast is required only because
 * `ModelRuntime` has a private constructor, so an object literal can never
 * nominally satisfy it, though it satisfies every member the function reads.
 */
function fakeModelRuntime(models: Model<Api>[], authenticatedProviders?: Set<string>): ModelRuntime {
  return {
    getModels: () => models,
    hasConfiguredAuth: (providerId: string) => authenticatedProviders?.has(providerId) ?? true,
  } as unknown as ModelRuntime;
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

describe("resolveModelSpecWithThinking parity with pi CLI's real resolveCliModel (#131)", () => {
  // resolveModelSpecWithThinking is a manual port of pi-coding-agent's
  // resolveCliModel — this cross-check calls pi's ACTUAL export against the same
  // fuzzed catalogs/specs so a future pi upgrade that changes the CLI's own
  // `--model` grammar is caught here immediately, instead of silently drifting
  // (which is exactly how #131's bare-id gap went unnoticed).
  const compoundIdSegment = fc.array(segment, { minLength: 1, maxLength: 2 }).map((parts) => parts.join("/"));

  it("property: resolves identically to pi's resolveCliModel across ambiguous vendor/provider collisions", () => {
    fc.assert(
      fc.property(
        providerSpec,
        providerSpec,
        compoundIdSegment,
        compoundIdSegment,
        (providerA, providerB, idA, idB) => {
          fc.pre(providerA !== providerB);
          // providerA doubles as both a real registered provider name AND the
          // vendor prefix of an id cataloged under providerB — the exact shape
          // that triggers #131 (bare "moonshotai/kimi-k3" when "moonshotai" is
          // also a real, separately-registered provider).
          const models = [model(providerA, idA), model(providerB, `${providerA}/${idB}`)];
          const spec = `${providerA}/${idB}`;

          const ours = resolveModelSpecWithThinking(spec, { getAll: () => models });
          const pi = resolveCliModel({ cliModel: spec, modelRuntime: fakeModelRuntime(models) });

          assert.deepEqual(ours.model, pi.model, `model mismatch for spec "${spec}"`);
          assert.equal(ours.thinkingLevel, pi.thinkingLevel);
          assert.equal(Boolean(ours.error), Boolean(pi.error));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: activates the auth-preference branch and still agrees with pi's real resolveCliModel", () => {
    // The previous cross-check ("ambiguous vendor/provider collisions") never
    // actually reaches the auth-preference branch: candidatesA's pattern (idB)
    // essentially never exact-matches idA, so `model` stays undefined there and
    // the match instead comes from the inferredProvider fallback further down —
    // and neither side supplied hasConfiguredAuth, so even if it HAD reached
    // that branch, both `ours.hasConfiguredAuth` (absent → branch skipped) and
    // pi's `hasConfiguredAuth` (defaults to true → its own guard short-circuits)
    // would no-op. This test forces the exact shape that lands in the branch:
    // providerA has a LITERAL exact-id model (so `model` resolves inside
    // providerA's own candidate list, not via the later fallback), providerA is
    // UNAUTHENTICATED, and the identical full string is also a literal id under
    // an AUTHENTICATED otherProvider.
    fc.assert(
      fc.property(providerSpec, providerSpec, segment, (providerA, otherProvider, idB) => {
        fc.pre(providerA !== otherProvider);
        const models = [model(providerA, idB), model(otherProvider, `${providerA}/${idB}`)];
        const spec = `${providerA}/${idB}`;
        const authenticated = new Set([otherProvider]);

        const ours = resolveModelSpecWithThinking(spec, {
          getAll: () => models,
          hasConfiguredAuth: (m) => authenticated.has(m.provider),
        });
        const pi = resolveCliModel({ cliModel: spec, modelRuntime: fakeModelRuntime(models, authenticated) });

        assert.deepEqual(ours.model, pi.model, `model mismatch for spec "${spec}"`);
        assert.equal(ours.thinkingLevel, pi.thinkingLevel);
        // Sanity check that the branch under test was actually exercised: the
        // authenticated compound match won, not the unauthenticated exact one.
        assert.equal(ours.model?.provider, otherProvider, "the auth-preference branch must have fired");
      }),
      { numRuns: 200 },
    );
  });

  it("property: agrees with pi on plain provider/model[:thinking] specs", () => {
    fc.assert(
      fc.property(
        providerSpec,
        modelIdSpec,
        fc.option(thinkingSpec, { nil: undefined }),
        (provider, modelId, thinking) => {
          const models = [model(provider, modelId)];
          const spec = formatModelSpecWithThinking(`${provider}/${modelId}`, thinking);

          const ours = resolveModelSpecWithThinking(spec, { getAll: () => models });
          const pi = resolveCliModel({ cliModel: spec, modelRuntime: fakeModelRuntime(models) });

          assert.deepEqual(ours.model, pi.model);
          assert.equal(ours.thinkingLevel, pi.thinkingLevel);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("resolveModelSpecWithThinking auth-aware raw-id preference (#131)", () => {
  it("prefers an authenticated aggregator's literal compound id over an unauthenticated native provider match", () => {
    // "moonshotai" is a real, unauthenticated native provider that also happens
    // to literally catalog "kimi-k3"; "openrouter" is authenticated and catalogs
    // the same string as a vendor-prefixed compound id. Without the auth
    // preference this used to silently resolve to the unauthenticated native
    // provider — deleting the preference block must turn this test red.
    const moonshotaiNative = model("moonshotai", "kimi-k3");
    const openrouterCompound = model("openrouter", "moonshotai/kimi-k3");
    const reg = {
      getAll: () => [moonshotaiNative, openrouterCompound],
      hasConfiguredAuth: (m: Model<Api>) => m.provider === "openrouter",
    };

    const resolved = resolveModelSpecWithThinking(
      "moonshotai/kimi-k3",
      reg as unknown as Pick<ModelRegistry, "getAll">,
    );

    assert.equal(resolved.model, openrouterCompound);
    assert.equal(resolved.resolvedSpec, "openrouter/moonshotai/kimi-k3");
  });

  it("keeps the native-provider match when no hasConfiguredAuth capability is supplied (backward compatible)", () => {
    const moonshotaiNative = model("moonshotai", "kimi-k3");
    const openrouterCompound = model("openrouter", "moonshotai/kimi-k3");

    const resolved = resolveModelSpecWithThinking(
      "moonshotai/kimi-k3",
      registry([moonshotaiNative, openrouterCompound]),
    );

    assert.equal(resolved.model, moonshotaiNative, "without auth info, the first provider-scoped match still wins");
  });

  it("keeps the native-provider match when it IS authenticated (no reason to prefer anything else)", () => {
    const moonshotaiNative = model("moonshotai", "kimi-k3");
    const openrouterCompound = model("openrouter", "moonshotai/kimi-k3");
    const reg = {
      getAll: () => [moonshotaiNative, openrouterCompound],
      hasConfiguredAuth: () => true,
    };

    const resolved = resolveModelSpecWithThinking(
      "moonshotai/kimi-k3",
      reg as unknown as Pick<ModelRegistry, "getAll">,
    );

    assert.equal(resolved.model, moonshotaiNative);
  });
});
