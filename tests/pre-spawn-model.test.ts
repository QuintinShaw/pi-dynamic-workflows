import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent, type WorkflowAgentOptions } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  classifyModelSource,
  getPreSpawnModelResolver,
  type PreSpawnModelContext,
  type PreSpawnModelDecision,
  setPreSpawnModelResolver,
} from "../src/pre-spawn-model.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function restoreResolver(): void {
  setPreSpawnModelResolver(undefined);
}

test("public seam exports exist (RED until implemented)", () => {
  assert.equal(typeof setPreSpawnModelResolver, "function");
  assert.equal(typeof getPreSpawnModelResolver, "function");
  assert.equal(typeof classifyModelSource, "function");
  assert.equal(WorkflowErrorCode.MODEL_SPAWN_REJECTED, "MODEL_SPAWN_REJECTED");
});

test("classifyModelSource: explicit / tier / phase / default / session", () => {
  assert.equal(classifyModelSource({ model: "xai/grok-4.6" }), "explicit");
  assert.equal(classifyModelSource({ model: "xai/grok-4.6", tier: "big" }), "explicit");
  assert.equal(classifyModelSource({ tier: "big" }), "tier");
  assert.equal(classifyModelSource({ model: "vendor/phase", modelSource: "phase" }), "phase");
  assert.equal(classifyModelSource({ resolvedModel: "vendor/medium" }), "default");
  assert.equal(classifyModelSource({}), "session");
});

test("U1/U2 no process resolver: getPreSpawnModelResolver is undefined", () => {
  restoreResolver();
  assert.equal(getPreSpawnModelResolver(), undefined);
});

async function withFauxAgent(
  fn: (agent: WorkflowAgent, provider: string, modelId: string) => Promise<void>,
  agentOptions: Partial<WorkflowAgentOptions> = {},
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-pre-spawn-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-pre-spawn-cwd-"));
  const provider = "fauxtest-pre-spawn";
  const modelId = "faux-model";
  const core = createFauxCore({
    provider,
    models: [{ id: modelId, name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider(provider, {
        name: "Faux Pre Spawn",
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
      runtime.registerProvider("fauxtest-override", {
        name: "Faux Override",
        baseUrl: "http://127.0.0.1:9/override",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: [
          {
            id: "override-model",
            name: "Override Model",
            reasoning: false,
            input: ["text"] as ("text" | "image")[],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      });
      const registry = new ModelRegistry(runtime);
      core.setResponses([fauxAssistantMessage("spawn-ok", { stopReason: "stop" })]);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: registry,
        mainModel: `${provider}/${modelId}`,
        ...agentOptions,
      });
      await fn(agent, provider, modelId);
    });
  } finally {
    restoreResolver();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("U3 resolver unchanged keeps existing resolved model", async () => {
  const seen: PreSpawnModelContext[] = [];
  await withFauxAgent(async (agent, provider, modelId) => {
    const text = await agent.run("task", {
      model: `${provider}/${modelId}`,
      preSpawnModel: (ctx) => {
        seen.push(ctx);
        return { action: "unchanged" };
      },
    });
    assert.match(String(text), /spawn-ok/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.modelSource, "explicit");
    assert.equal(seen[0]?.resolvedModel, `${provider}/${modelId}`);
  });
});

test("U4 resolver use overrides the model actually spawned", async () => {
  const seen: string[] = [];
  await withFauxAgent(async (agent, provider, modelId) => {
    const text = await agent.run("task", {
      model: `${provider}/${modelId}`,
      preSpawnModel: () => ({ action: "use", model: "fauxtest-override/override-model" }),
      onModelResolved: (id) => seen.push(id),
    });
    assert.match(String(text), /spawn-ok/);
    assert.ok(
      seen.some((id) => id.includes("override-model")),
      `resolved=${JSON.stringify(seen)}`,
    );
  });
});

test("U5 explicit reject throws MODEL_SPAWN_REJECTED and does not spawn", async () => {
  await withFauxAgent(async (agent, provider, modelId) => {
    await assert.rejects(
      agent.run("task", {
        model: `${provider}/${modelId}`,
        label: "forced",
        preSpawnModel: (ctx) => {
          assert.equal(ctx.modelSource, "explicit");
          return { action: "reject", reason: "policy-stop" };
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_SPAWN_REJECTED);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /policy-stop/);
        assert.equal(error.agentLabel, "forced");
        return true;
      },
    );
  });
});

test("U6 session source is visible and can be overridden", async () => {
  await withFauxAgent(async (agent) => {
    let source: string | undefined;
    const text = await agent.run("task", {
      preSpawnModel: (ctx) => {
        source = ctx.modelSource;
        return { action: "use", model: "fauxtest-override/override-model" };
      },
    });
    assert.equal(source, "session");
    assert.match(String(text), /spawn-ok/);
  });
});

test("U7 async resolver success is awaited", async () => {
  await withFauxAgent(async (agent, provider, modelId) => {
    const text = await agent.run("task", {
      model: `${provider}/${modelId}`,
      preSpawnModel: async (): Promise<PreSpawnModelDecision> => {
        await new Promise((r) => setTimeout(r, 20));
        return { action: "use", model: "fauxtest-override/override-model" };
      },
    });
    assert.match(String(text), /spawn-ok/);
  });
});

test("U8 resolver throw does not fall back to session model", async () => {
  await withFauxAgent(async (agent, provider, modelId) => {
    await assert.rejects(
      agent.run("task", {
        model: `${provider}/${modelId}`,
        preSpawnModel: () => {
          throw new Error("resolver-boom");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
        assert.match(error.message, /resolver-boom/);
        return true;
      },
    );
  });
});

test("U9 reject is a structured WorkflowError", async () => {
  await withFauxAgent(async (agent) => {
    await assert.rejects(
      agent.run("untagged", {
        preSpawnModel: () => ({ action: "reject", reason: "no-spawn" }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_SPAWN_REJECTED);
        assert.match(error.message, /no-spawn/);
        return true;
      },
    );
  });
});

test("U10 invalid use model follows MODEL_NOT_FOUND", async () => {
  await withFauxAgent(async (agent, provider, modelId) => {
    await assert.rejects(
      agent.run("task", {
        model: `${provider}/${modelId}`,
        preSpawnModel: () => ({ action: "use", model: "missing/does-not-exist" }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
        assert.match(error.message, /missing\/does-not-exist/);
        return true;
      },
    );
  });
});

test("process-level setPreSpawnModelResolver is invoked when per-run option is absent", async () => {
  await withFauxAgent(async (agent, provider, modelId) => {
    let called = 0;
    setPreSpawnModelResolver(() => {
      called += 1;
      return { action: "unchanged" };
    });
    const text = await agent.run("task", { model: `${provider}/${modelId}` });
    assert.equal(called, 1);
    assert.match(String(text), /spawn-ok/);
  });
});

test("tier intent reports modelSource=tier (with configured tiers)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-pre-spawn-tier-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-pre-spawn-tier-cwd-"));
  const provider = "fauxtest-pre-spawn";
  const modelId = "faux-model";
  const core = createFauxCore({
    provider,
    models: [{ id: modelId, name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { big: `${provider}/${modelId}` } }));
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider(provider, {
        name: "Faux Pre Spawn",
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
      const registry = new ModelRegistry(runtime);
      core.setResponses([fauxAssistantMessage("tier-ok", { stopReason: "stop" })]);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: `${provider}/${modelId}` });
      let source: string | undefined;
      const text = await agent.run("task", {
        tier: "big",
        preSpawnModel: (ctx) => {
          source = ctx.modelSource;
          return { action: "unchanged" };
        },
      });
      assert.equal(source, "tier");
      assert.match(String(text), /tier-ok/);
    });
  } finally {
    restoreResolver();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T1 process-level use on tier spawns the override model", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-pre-spawn-t1-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-pre-spawn-t1-cwd-"));
  const provider = "fauxtest-pre-spawn";
  const modelId = "faux-model";
  const core = createFauxCore({
    provider,
    models: [{ id: modelId, name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { big: `${provider}/${modelId}` } }));
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider(provider, {
        name: "Faux Pre Spawn",
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
      runtime.registerProvider("fauxtest-override", {
        name: "Faux Override",
        baseUrl: "http://127.0.0.1:9/override",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: [
          {
            id: "override-model",
            name: "Override Model",
            reasoning: false,
            input: ["text"] as ("text" | "image")[],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      });
      const registry = new ModelRegistry(runtime);
      core.setResponses([fauxAssistantMessage("process-tier-ok", { stopReason: "stop" })]);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: `${provider}/${modelId}` });
      const seen: string[] = [];
      setPreSpawnModelResolver(() => ({ action: "use", model: "fauxtest-override/override-model" }));
      const text = await agent.run("task", {
        tier: "big",
        onModelResolved: (id) => seen.push(id),
      });
      assert.match(String(text), /process-tier-ok/);
      assert.ok(
        seen.some((id) => id.includes("override-model")),
        `resolved=${JSON.stringify(seen)}`,
      );
    });
  } finally {
    restoreResolver();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T2 process-level reject throws MODEL_SPAWN_REJECTED without spawning", async () => {
  const seen: string[] = [];
  await withFauxAgent(async (agent, provider, modelId) => {
    setPreSpawnModelResolver(() => ({ action: "reject", reason: "process-stop" }));
    await assert.rejects(
      agent.run("task", {
        model: `${provider}/${modelId}`,
        onModelResolved: (id) => seen.push(id),
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_SPAWN_REJECTED);
        assert.match(error.message, /process-stop/);
        return true;
      },
    );
    assert.equal(seen.length, 0);
  });
});

test("T3 run resolver wins over instance and process", async () => {
  const calls: string[] = [];
  await withFauxAgent(
    async (agent, provider, modelId) => {
      setPreSpawnModelResolver(() => {
        calls.push("process");
        return { action: "use", model: `${provider}/${modelId}` };
      });
      const text = await agent.run("task", {
        model: `${provider}/${modelId}`,
        preSpawnModel: () => {
          calls.push("run");
          return { action: "use", model: "fauxtest-override/override-model" };
        },
      });
      assert.match(String(text), /spawn-ok/);
      assert.deepEqual(calls, ["run"]);
    },
    {
      preSpawnModel: () => {
        calls.push("instance");
        return { action: "unchanged" };
      },
    },
  );
});

test("T3b instance resolver wins over process when per-run is absent", async () => {
  const calls: string[] = [];
  await withFauxAgent(
    async (agent, provider, modelId) => {
      setPreSpawnModelResolver(() => {
        calls.push("process");
        return { action: "unchanged" };
      });
      const text = await agent.run("task", { model: `${provider}/${modelId}` });
      assert.match(String(text), /spawn-ok/);
      assert.deepEqual(calls, ["instance"]);
    },
    {
      preSpawnModel: () => {
        calls.push("instance");
        return { action: "unchanged" };
      },
    },
  );
});

test("T4 session use missing model names the policy spec, not tier undefined", async () => {
  await withFauxAgent(async (agent) => {
    await assert.rejects(
      agent.run("task", {
        preSpawnModel: () => ({ action: "use", model: "missing/session-policy" }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
        assert.match(error.message, /missing\/session-policy/);
        assert.match(error.message, /preSpawnModel policy/);
        assert.doesNotMatch(error.message, /tier/);
        assert.doesNotMatch(error.message, /undefined/);
        return true;
      },
    );
  });
});

test("T5 tier use missing model names the policy spec, not the original tier", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-pre-spawn-t5-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-pre-spawn-t5-cwd-"));
  const provider = "fauxtest-pre-spawn";
  const modelId = "faux-model";
  const core = createFauxCore({
    provider,
    models: [{ id: modelId, name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { big: `${provider}/${modelId}` } }));
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider(provider, {
        name: "Faux Pre Spawn",
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
      const registry = new ModelRegistry(runtime);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: `${provider}/${modelId}` });
      await assert.rejects(
        agent.run("task", {
          tier: "big",
          preSpawnModel: () => ({ action: "use", model: "missing/tier-policy" }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
          assert.match(error.message, /missing\/tier-policy/);
          assert.match(error.message, /preSpawnModel policy/);
          assert.doesNotMatch(error.message, /tier "big"/);
          return true;
        },
      );
    });
  } finally {
    restoreResolver();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T6 unknown action fails closed without spawning", async () => {
  const seen: string[] = [];
  await withFauxAgent(async (agent, provider, modelId) => {
    await assert.rejects(
      agent.run("task", {
        model: `${provider}/${modelId}`,
        onModelResolved: (id) => seen.push(id),
        preSpawnModel: () => ({ action: "wat" }) as unknown as PreSpawnModelDecision,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /unknown action "wat"/);
        return true;
      },
    );
    assert.equal(seen.length, 0);
  });
});

test("T7 phase source is reported as phase", async () => {
  await withFauxAgent(async (agent, provider, modelId) => {
    let source: string | undefined;
    const text = await agent.run("task", {
      model: `${provider}/${modelId}`,
      modelSource: "phase",
      preSpawnModel: (ctx) => {
        source = ctx.modelSource;
        return { action: "unchanged" };
      },
    });
    assert.equal(source, "phase");
    assert.match(String(text), /spawn-ok/);
  });
});
