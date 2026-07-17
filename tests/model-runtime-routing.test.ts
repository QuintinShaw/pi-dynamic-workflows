/**
 * Guards the pi >= 0.80.8 subagent routing contract end-to-end.
 *
 * WorkflowAgent shares the HOST session's model catalog with each subagent by
 * reaching through the ModelRegistry facade's PRIVATE `runtime` field (see
 * runtimeOf in src/agent.ts) and passing that ModelRuntime to
 * createAgentSession. That access is cast through `unknown`, so a pi upgrade
 * renaming the field breaks routing SILENTLY: tsc stays green, mock-based
 * tests stay green, and subagents just fall back to a default-built runtime in
 * which extension-registered providers (e.g. ollama) do not exist.
 *
 * These tests are the loud tripwire: they use the real installed pi classes,
 * and the end-to-end test gives the subagent NO session.modelRuntime override,
 * so the scripted faux provider is reachable ONLY via runtimeOf(). If pi
 * renames the internals, this file fails and the fix is to update runtimeOf().
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runtimeOf, WorkflowAgent } from "../src/agent.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

test("runtimeOf reaches the ModelRuntime behind pi's real ModelRegistry facade (pi-internals contract)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-runtimeof-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      const registry = new ModelRegistry(runtime);
      assert.equal(
        runtimeOf(registry),
        runtime,
        "ModelRegistry's private `runtime` field no longer exposes its ModelRuntime — pi internals changed; update runtimeOf() in src/agent.ts",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtimeOf degrades to undefined (no throw) on a registry without a runtime field", () => {
  const mock = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as unknown as ModelRegistry;
  assert.equal(runtimeOf(mock), undefined);
});

test("a shared host ModelRegistry routes subagents to extension-registered providers (no session override)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-routing-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-routing-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest", {
        name: "Faux Test",
        // Required by custom-model validation; never dialed — streamSimple intercepts.
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      // The extension's exact wiring (extensions/workflow.ts session_start →
      // manager.setModelRegistry → WorkflowAgentOptions.modelRegistry): the
      // host registry facade is shared, and there is NO session.modelRuntime
      // override — the subagent can only reach "fauxtest" via runtimeOf().
      const registry = new ModelRegistry(runtime);
      core.setResponses([fauxAssistantMessage("routed-through-extension-provider", { stopReason: "stop" })]);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const text = await agent.run("do the task", { label: "routing probe", model: "fauxtest/faux-model" });
      assert.ok(
        typeof text === "string" && text.includes("routed-through-extension-provider"),
        `subagent did not stream through the extension-registered provider (got: ${String(text).slice(0, 120)})`,
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
