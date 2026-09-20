import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

async function fauxRegistry(
  home: string,
  provider: string,
  core: ReturnType<typeof createFauxCore>,
): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
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
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 4_096,
    })),
  });
  return new ModelRegistry(runtime);
}

type WorkflowAgentPrivates = {
  createSessionManager(thread?: string, cwd?: string): SessionManager;
};

type BindingProbe = { expectedSession?: unknown };

function probes(manager: SessionManager): BindingProbe[] {
  return (manager.getEntries() as Array<{ type?: unknown; customType?: unknown; data?: unknown }>)
    .filter((entry) => entry.type === "custom" && entry.customType === "binding-probe")
    .map((entry) => (entry.data ?? {}) as BindingProbe);
}

async function waitForBarrier(promise: Promise<void>, name: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test("trusted middleware keeps appendEntry bound to the session whose hook is running", {
  timeout: 10_000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-middleware-isolation-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-middleware-isolation-cwd-"));
  const barrierName = `pi-dw-middleware-isolation:${randomUUID()}`;
  const barrierSymbol = Symbol.for(barrierName);
  let firstEntered!: () => void;
  let releaseFirst!: () => void;
  let secondEntered!: () => void;
  const barrier = {
    arrivals: 0,
    shutdowns: [] as string[],
    firstEntered: new Promise<void>((resolve) => (firstEntered = resolve)),
    releaseFirst: new Promise<void>((resolve) => (releaseFirst = resolve)),
    secondEntered: new Promise<void>((resolve) => (secondEntered = resolve)),
  };
  (globalThis as Record<symbol, unknown>)[barrierSymbol] = barrier;

  const provider = "fauxtest-middleware-isolation";
  const core = createFauxCore({
    provider,
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128_000, maxTokens: 4_096 }],
  });

  try {
    const extensionDir = join(home, ".pi", "agent", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, "binding-isolation-adapter.js"),
      `export default function (pi) {
        pi.on("session_shutdown", (_event, ctx) => {
          globalThis[Symbol.for(${JSON.stringify(barrierName)})].shutdowns.push(ctx.sessionManager.getSessionId());
        });
        pi.on("before_agent_start", async (_event, ctx) => {
          const barrier = globalThis[Symbol.for(${JSON.stringify(barrierName)})];
          if (!barrier) throw new Error("missing isolation fixture barrier");
          barrier.arrivals += 1;
          if (barrier.arrivals === 1) {
            barrier.markFirst();
            await barrier.releaseFirst;
          } else if (barrier.arrivals === 2) {
            barrier.markSecond();
          }
          pi.appendEntry("binding-probe", { expectedSession: ctx.sessionManager.getSessionId() });
        });
      }`,
    );
    Object.assign(barrier, { markFirst: firstEntered, markSecond: secondEntered });

    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, provider, core);
      core.setResponses([
        fauxAssistantMessage("first complete", { stopReason: "stop" }),
        fauxAssistantMessage("second complete", { stopReason: "stop" }),
      ]);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: registry,
        providerMiddlewareExtensions: ["binding-isolation-adapter"],
      });
      const privateAgent = agent as unknown as WorkflowAgentPrivates;
      const firstManager = privateAgent.createSessionManager("first", cwd);
      const secondManager = privateAgent.createSessionManager("second", cwd);
      const firstSessionId = firstManager.getSessionId();
      const secondSessionId = secondManager.getSessionId();
      const created: string[] = [];

      const first = agent.run("first task", {
        thread: "first",
        model: `${provider}/faux-model`,
        onSessionCreated: ({ sessionId }) => created.push(sessionId),
      });
      await waitForBarrier(barrier.firstEntered, "first middleware hook");

      const second = agent.run("second task", {
        thread: "second",
        model: `${provider}/faux-model`,
        onSessionCreated: ({ sessionId }) => created.push(sessionId),
      });
      await waitForBarrier(barrier.secondEntered, "second middleware hook");
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(
        barrier.shutdowns.sort(),
        [firstSessionId, secondSessionId].sort(),
        "each child shuts down once",
      );

      assert.deepEqual(
        created.sort(),
        [firstSessionId, secondSessionId].sort(),
        "runs must use distinct session managers",
      );
      assert.deepEqual(
        { first: probes(firstManager), second: probes(secondManager) },
        {
          first: [{ expectedSession: firstSessionId }],
          second: [{ expectedSession: secondSessionId }],
        },
      );
    });
  } finally {
    releaseFirst();
    delete (globalThis as Record<symbol, unknown>)[barrierSymbol];
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
