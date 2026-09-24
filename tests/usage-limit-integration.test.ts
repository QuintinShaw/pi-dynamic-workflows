/**
 * Real-session integration test for issue #26 — provider usage-limit handling.
 *
 * Every other test injects a fake agent runner; this one drives the REAL
 * `WorkflowAgent.run` → `createAgentSession` path and uses the pi SDK's built-in
 * faux stream to end a turn in a "usage limit reached" error (stopReason
 * "error" + errorMessage), exactly as a real provider buries a quota exhaustion.
 * It is the contract guard for the load-bearing SDK assumption behind the fix:
 * a usage limit surfaces as an error-status assistant message, not a thrown error.
 * No network call is made and NO provider quota is consumed.
 *
 * pi >= 0.80.8: sessions stream through a ModelRuntime, and a builtin provider
 * with no overlays bypasses the compat api registry entirely — so the old
 * registerFauxProvider() global-registry hook is invisible to the session.
 * Instead, register the faux core as an extension provider on an explicit
 * ModelRuntime (its streamSimple is closure-scripted, no registry involved)
 * and hand that runtime to the subagent session.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installHostCreateAgentSession, WorkflowAgent } from "../src/agent.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";
const UPSTREAM_ERROR_MSG = "402 Insufficient account funds";

/**
 * Run `fn` with an isolated HOME and a scripted faux provider registered on a
 * test-scoped ModelRuntime — no real credentials are touched and no network
 * call can happen; `setResponses` queues the scripted turns.
 */
async function withFauxSession(
  fn: (ctx: {
    cwd: string;
    model: unknown;
    modelRuntime: ModelRuntime;
    setResponses: (msgs: unknown[]) => void;
    fauxAssistantMessage: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
  }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-i26-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-i26-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      // Created inside the fake home so every default path stays isolated.
      const modelRuntime = await ModelRuntime.create({
        authPath: join(home, "auth.json"),
        modelsPath: null,
      });
      modelRuntime.registerProvider("fauxtest", {
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
      const model = modelRuntime.getModel("fauxtest", "faux-model") ?? core.getModel();
      await fn({
        cwd,
        model,
        modelRuntime,
        setResponses: (msgs) => core.setResponses(msgs as never),
        fauxAssistantMessage,
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("a real subagent session that hits a usage limit surfaces PROVIDER_USAGE_LIMIT (not SCHEMA_NONCOMPLIANCE/EMPTY)", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
    await assert.rejects(
      () => agent.run("do the task", { label: "probe" }),
      (err: unknown) => {
        const e = err as { code?: string; recoverable?: boolean; message?: string; resetHint?: string };
        assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, `got ${e.code}`);
        assert.equal(e.recoverable, false, "must halt so the run can checkpoint, not retry-into-the-wall");
        assert.ok(e.message?.includes("usage limit reached"), "carries the real provider message");
        assert.equal(e.resetHint, "Resets in ~3h", "extracts the provider reset hint");
        return true;
      },
    );
  }));

test("a successful real turn whose text merely mentions 'rate limit' is NOT misclassified", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("Done. I handled the rate limit gracefully.", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
    const text = await agent.run("do the task", { label: "ok" });
    assert.ok(typeof text === "string" && text.includes("Done."), `expected normal text, got ${String(text)}`);
  }));

for (const schema of [undefined, Type.Object({ word: Type.String() })]) {
  test(`a terminal upstream error preserves its message (${schema ? "schema" : "text"})`, () =>
    withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
      setResponses([fauxAssistantMessage("partial output", { stopReason: "error", errorMessage: UPSTREAM_ERROR_MSG })]);
      const agent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
      await assert.rejects(agent.run("do the task", { label: "upstream", schema }), {
        code: WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        message: UPSTREAM_ERROR_MSG,
        recoverable: true,
        agentLabel: "upstream",
      });
    }));
}

test("a real schema repair preserves upstream errors instead of extracting stale prose", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
    setResponses([
      fauxAssistantMessage('{"word":"stale"}', { stopReason: "stop" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: UPSTREAM_ERROR_MSG }),
    ]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
    await assert.rejects(agent.run("do the task", { schema: Type.Object({ word: Type.String() }) }), {
      code: WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      message: UPSTREAM_ERROR_MSG,
    });
  }));

test("historical assistant errors do not leak into an empty current turn or schema repair", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, fauxAssistantMessage }) => {
    installHostCreateAgentSession(async (options) => {
      const created = await createAgentSession(options);
      created.session.messages.push(
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "historical provider failure" }),
      );
      created.session.prompt = async () => {};
      return created;
    });
    try {
      const agent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
      await assert.rejects(agent.run("empty turn"), { code: WorkflowErrorCode.AGENT_EMPTY_OUTPUT });
      for (const maxSchemaRetries of [0, 1]) {
        await assert.rejects(
          agent.run("empty schema turn", { schema: Type.Object({ word: Type.String() }), maxSchemaRetries }),
          { code: WorkflowErrorCode.SCHEMA_NONCOMPLIANCE },
        );
      }
    } finally {
      installHostCreateAgentSession(createAgentSession);
    }
  }));

test("the manager persists the original upstream error in the run log", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: UPSTREAM_ERROR_MSG })]);
    const manager = new WorkflowManager({
      cwd,
      agent: new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } }),
    });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(
      `export const meta = { name: 'upstream_error', description: 'preserve upstream failures' }; return await agent('task', { retries: 0 });`,
    );
    await promise.catch(() => {});
    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.agents[0]?.status, "error");
    assert.equal(persisted?.agents[0]?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.ok(persisted?.logs.some((line) => line.includes(UPSTREAM_ERROR_MSG)));
    assert.ok(!persisted?.logs.some((line) => line.includes("AGENT_EMPTY_OUTPUT")));
  }));

test("through the manager: a usage limit pauses the run (not fails) and resume replays the journal", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
    const managerAgent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
    const manager = new WorkflowManager({ cwd, agent: managerAgent });
    const pausedReasons: Array<string | undefined> = [];
    manager.on("paused", (e: { reason?: string }) => pausedReasons.push(e.reason));
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'i26_integration', description: 'two agents' }
const a = await agent('first step', { label: 'first' })
const b = await agent('second step', { label: 'second' })
return { a, b }`;

    // Agent 1 succeeds (journaled); agent 2 hits the usage limit.
    setResponses([
      fauxAssistantMessage("first-result-text", { stopReason: "stop" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG }),
    ]);
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise.catch(() => {});

    assert.equal(manager.getRun(runId)?.status, "paused", "run is checkpointed as paused, not failed");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1's result is journaled");
    assert.ok(pausedReasons.includes("usage_limit"), "a usage_limit 'paused' event fired");

    // Budget refills: agent 2 now succeeds. Resume replays agent 1 from the journal.
    setResponses([fauxAssistantMessage("second-result-text", { stopReason: "stop" })]);
    assert.equal(await manager.resume(runId), true, "the paused run is resumable");
    await new Promise((r) => setTimeout(r, 100));

    const done = manager.getRun(runId);
    assert.equal(done?.status, "completed", "resumed run completes once the limit clears");
    assert.equal((done?.result?.result as { a?: string })?.a, "first-result-text", "agent 1 replayed from journal");
    assert.equal((done?.result?.result as { b?: string })?.b, "second-result-text", "agent 2 ran live after refill");
  }));
