/**
 * Real-session integration test for issue #26 — provider usage-limit handling.
 *
 * Every other test injects a fake agent runner; this one drives the REAL
 * `WorkflowAgent.run` → `createAgentSession` path and uses the pi SDK's built-in
 * FAUX provider to end a turn in a "usage limit reached" error (stopReason
 * "error" + errorMessage), exactly as a real provider buries a quota exhaustion.
 * It is the contract guard for the load-bearing SDK assumption behind the fix:
 * a usage limit surfaces as an error-status assistant message, not a thrown error.
 * No network call is made and NO provider quota is consumed.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WorkflowAgent } from "../src/agent.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";

/**
 * Load the faux provider from the SAME pi-ai instance that pi-coding-agent's
 * createAgentSession dispatches through. pi-coding-agent ships its own nested
 * pi-ai copy; registering on a different instance would be invisible to the
 * session ("No API provider registered"). Prefer the nested copy when present,
 * else fall back to the bare specifier — which, when npm has deduped to a single
 * copy, resolves to that same shared instance. Robust to both layouts.
 */
async function loadFaux(): Promise<typeof import("@earendil-works/pi-ai")> {
  const nested = fileURLToPath(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
      import.meta.url,
    ),
  );
  const entry = existsSync(nested) ? nested : "@earendil-works/pi-ai";
  return import(entry) as Promise<typeof import("@earendil-works/pi-ai")>;
}

/**
 * Run `fn` with an isolated HOME and a dummy provider key so hasConfiguredAuth()
 * passes via env — no real credentials are touched, and the faux api means the
 * key is never actually used. A faux "deepseek" provider is registered/torn down
 * around `fn`; `setResponses` queues the scripted turns.
 */
async function withFauxSession(
  fn: (ctx: {
    cwd: string;
    model: unknown;
    setResponses: (msgs: unknown[]) => void;
    fauxAssistantMessage: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
  }) => Promise<void>,
): Promise<void> {
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  const home = mkdtempSync(join(tmpdir(), "pi-dw-i26-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-i26-cwd-"));
  const prevKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "faux-dummy-key-not-used";
  const faux = registerFauxProvider({
    provider: "deepseek",
    models: [{ id: "faux-deepseek", name: "Faux DeepSeek", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, () =>
      fn({
        cwd,
        model: faux.getModel(),
        setResponses: (msgs) => faux.setResponses(msgs as never),
        fauxAssistantMessage,
      }),
    );
  } finally {
    faux.unregister();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("a real subagent session that hits a usage limit surfaces PROVIDER_USAGE_LIMIT (not SCHEMA_NONCOMPLIANCE/EMPTY)", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });
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
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("Done. I handled the rate limit gracefully.", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });
    const text = await agent.run("do the task", { label: "ok" });
    assert.ok(typeof text === "string" && text.includes("Done."), `expected normal text, got ${String(text)}`);
  }));

test("through the manager: a usage limit pauses the run (not fails) and resume replays the journal", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    const managerAgent = new WorkflowAgent({ cwd, session: { model: model as never } });
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
