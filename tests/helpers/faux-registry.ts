import { join } from "node:path";
import type { createFauxCore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Build a ModelRegistry backed by one or more faux providers (no network).
 * Each entry is [provider, core]; the core's declared models are registered
 * under that provider with their reasoning flag honored.
 */
export async function fauxRegistryFor(
  home: string,
  entries: ReadonlyArray<readonly [string, ReturnType<typeof createFauxCore>]>,
): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
  for (const [provider, core] of entries) {
    runtime.registerProvider(provider, {
      name: `Faux Test ${provider}`,
      baseUrl: "http://127.0.0.1:9/faux",
      apiKey: "faux-dummy-key-not-used",
      api: core.api,
      streamSimple: core.streamSimple as never,
      models: core.models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.reasoning ?? false,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow ?? 128000,
        maxTokens: model.maxTokens ?? 4096,
      })),
    });
  }
  return new ModelRegistry(runtime);
}

export async function fauxRegistry(
  home: string,
  provider: string,
  core: ReturnType<typeof createFauxCore>,
): Promise<ModelRegistry> {
  return fauxRegistryFor(home, [[provider, core]]);
}
