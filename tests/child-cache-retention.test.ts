import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";
import { childCacheRetention, pinChildCacheRetention } from "../src/child-cache-retention.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

type CapturedCall = { model: unknown; context: unknown; options: Record<string, unknown> | undefined };

function recordingAgent(calls: CapturedCall[]) {
  return {
    streamFunction: (model: unknown, context: unknown, options?: Record<string, unknown>) => {
      calls.push({ model, context, options });
      return "stream-result";
    },
  };
}

test("unset agent cache retention leaves the session stream untouched", () => {
  const calls: CapturedCall[] = [];
  const agent = recordingAgent(calls);
  const original = agent.streamFunction;

  assert.equal(childCacheRetention({}), undefined);
  pinChildCacheRetention(agent, {});

  assert.equal(agent.streamFunction, original, "unset must preserve the original stream identity");
  assert.equal(agent.streamFunction("model", "context"), "stream-result");
  assert.deepEqual(calls, [{ model: "model", context: "context", options: undefined }]);
});

for (const retention of ["short", "long"]) {
  test(`${retention} agent cache retention overrides only the request env`, () => {
    const calls: CapturedCall[] = [];
    const agent = recordingAgent(calls);
    const signal = new AbortController().signal;
    const originalEnv = { PI_CACHE_RETENTION: "long", CUSTOM_PROVIDER_FLAG: "keep" };
    const options = {
      cacheRetention: "none",
      env: originalEnv,
      signal,
      headers: { "x-request-id": "request-id" },
      samplingParams: { top_p: 0.9 },
      temperature: 0.2,
      maxTokens: 321,
      transport: "websocket",
      metadata: { trace: "trace-id" },
    };
    const processRetention = process.env.PI_CACHE_RETENTION;
    const processAgentRetention = process.env.PI_WORKFLOW_AGENT_CACHE_RETENTION;

    pinChildCacheRetention(agent, { PI_WORKFLOW_AGENT_CACHE_RETENTION: retention });
    const result = agent.streamFunction("model", "context", options);

    assert.equal(result, "stream-result");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "model");
    assert.equal(calls[0].context, "context");
    assert.deepEqual(calls[0].options, {
      ...options,
      env: { CUSTOM_PROVIDER_FLAG: "keep", PI_CACHE_RETENTION: retention },
    });
    assert.deepEqual(
      originalEnv,
      { PI_CACHE_RETENTION: "long", CUSTOM_PROVIDER_FLAG: "keep" },
      "caller env is not mutated",
    );
    assert.equal(process.env.PI_CACHE_RETENTION, processRetention, "the wrapper must not mutate process.env");
    assert.equal(
      process.env.PI_WORKFLOW_AGENT_CACHE_RETENTION,
      processAgentRetention,
      "the wrapper must not mutate its own configuration source",
    );
  });
}

test("WorkflowAgent wires the cache wrapper into a real faux-backed session", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-child-cache-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-child-cache-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-child-cache",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  const seen: Array<Record<string, unknown> | undefined> = [];
  const previous = process.env.PI_WORKFLOW_AGENT_CACHE_RETENTION;

  try {
    await withFakeHomeAsync(home, async () => {
      process.env.PI_WORKFLOW_AGENT_CACHE_RETENTION = "short";
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-child-cache", {
        name: "Faux Test Child Cache",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: (model, context, options) => {
          seen.push(options as Record<string, unknown> | undefined);
          return core.streamSimple(model, context, options);
        },
        models: core.models.map((model) => ({
          ...model,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.contextWindow ?? 128000,
          maxTokens: model.maxTokens ?? 4096,
        })),
      });
      core.setResponses([fauxAssistantMessage("cache wrapper reached the real session", { stopReason: "stop" })]);

      const agent = new WorkflowAgent({ cwd, modelRegistry: new ModelRegistry(runtime) });
      const output = await agent.run("reply", { model: "fauxtest-child-cache/faux-model" });

      assert.match(output, /cache wrapper reached the real session/);
      assert.equal(seen.length, 1);
      assert.equal((seen[0]?.env as Record<string, string> | undefined)?.PI_CACHE_RETENTION, "short");
    });
  } finally {
    if (previous === undefined) delete process.env.PI_WORKFLOW_AGENT_CACHE_RETENTION;
    else process.env.PI_WORKFLOW_AGENT_CACHE_RETENTION = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
