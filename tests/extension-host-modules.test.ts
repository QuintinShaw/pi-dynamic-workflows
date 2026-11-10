import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };

test("published extension loads through the unbundled host aliases and captures the actual host", () => {
  // Run without tsx/source-runtime hooks: the production Node host uses aliases,
  // not the embedded virtualModules path covered by the test below.
  const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const entry = new URL(`../${packageJson.pi.extensions[0]}`, import.meta.url).pathname;
  const script = `
    import assert from "node:assert/strict";
    const sdkUrl = ${JSON.stringify(sdkEntry)};
    const sdk = await import(sdkUrl);
    const { loadExtensions, createExtensionRuntime } = await import(new URL("core/extensions/loader.js", sdkUrl));
    const { createEventBus } = await import(new URL("core/event-bus.js", sdkUrl));
    const original = sdk.AgentSession.prototype.sendCustomMessage;
    const result = await loadExtensions([${JSON.stringify(entry)}], process.cwd(), createEventBus(), createExtensionRuntime());
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.notEqual(sdk.AgentSession.prototype.sendCustomMessage, original);
    const receiver = Object.create(sdk.AgentSession.prototype);
    receiver.sessionManager = { getSessionId: () => "node-host-test" };
    await receiver.sendCustomMessage(
      { customType: "workflow-delivery-probe", content: "", display: false },
      { triggerTurn: false },
    );
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    timeout: 60_000,
    stdio: "pipe",
  });
});

test("published extension patches the host SDK even when a native sibling peer is resolvable", async () => {
  // Deliberately distinct from the natively importable peer. This models the
  // embedded host's virtual modules without hiding/removing the sibling SDK.
  class HostSession extends hostSdk.AgentSession {}
  class HostRunner extends hostSdk.ExtensionRunner {}
  const originalSend = HostSession.prototype.sendCustomMessage;
  assert.equal(originalSend, hostSdk.AgentSession.prototype.sendCustomMessage);
  const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const jitiPackage = pathToFileURL(require.resolve("jiti/package.json"));
  const { createJiti } = await import(new URL("lib/jiti-static.mjs", jitiPackage).href);
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    virtualModules: {
      "@earendil-works/pi-coding-agent": { ...hostSdk, AgentSession: HostSession, ExtensionRunner: HostRunner },
    },
  });
  const entry = new URL(`../${packageJson.pi.extensions[0]}`, import.meta.url).pathname;
  const factory = await jiti.import(entry, { default: true });
  assert.equal(typeof factory, "function");
  assert.notEqual(HostSession.prototype.sendCustomMessage, originalSend, "host class must receive the capture hook");
  assert.equal(hostSdk.AgentSession.prototype.sendCustomMessage, originalSend, "must not patch the sibling peer");

  // The capture-only probe must never reach the real implementation, which
  // would access agent state and append a custom message on this receiver.
  const receiver = Object.create(HostSession.prototype);
  receiver.sessionManager = { getSessionId: () => "host-module-test" };
  await receiver.sendCustomMessage(
    { customType: "workflow-delivery-probe", content: "", display: false },
    { triggerTurn: false },
  );
});

for (const bundled of [false, true]) {
  const nativeSdk = import.meta.resolve("@earendil-works/pi-coding-agent");
  const sdkUrl = bundled ? new URL("bundle/index.js", nativeSdk).href : nativeSdk;
  const version = JSON.parse(readFileSync(new URL("../package.json", nativeSdk), "utf8")).version;
  test(`actual extension entry retains deferred SDK worker across real Pi reload (${bundled ? "bundled" : "unbundled"})`, {
    skip: version !== "1.4.0" || !existsSync(new URL(sdkUrl)) ? "bounded Pi 1.4.0 host-resolution leg" : false,
    timeout: 30_000,
  }, () => {
    const entry = new URL(`../${packageJson.pi.extensions[0]}`, import.meta.url).pathname;
    const aiUrl = import.meta.resolve("@earendil-works/pi-ai");
    const script = `
      import assert from "node:assert/strict";
      import { mkdtempSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { setTimeout as delay } from "node:timers/promises";
      const home = mkdtempSync(join(tmpdir(), "pi-entry-reload-"));
      process.env.HOME = process.env.USERPROFILE = home;
      delete process.env.PI_CODING_AGENT_DIR;
      const sdk = await import(${JSON.stringify(sdkUrl)});
      const { createFauxCore, fauxAssistantMessage } = await import(${JSON.stringify(aiUrl)});
      let release;
      const released = new Promise(resolve => { release = resolve; });
      let childStarted = false;
      let session;
      let manager;
      let run;
      async function until(check, label) {
        for (let i = 0; i < 600; i++) { if (check()) return; await delay(5); }
        throw new Error("Timed out: " + label);
      }
      try {
        const provider = "faux-entry-reload";
        const workflowScript = "export const meta = { name: 'entry_reload_fixture', description: 'harmless local fixture' }; return await agent('CONTROLLED_CHILD', { model: 'faux-entry-reload/faux' });";
        const core = createFauxCore({ provider, models: [{ id: "faux", contextWindow: 128000, maxTokens: 4096 }] });
        const responder = async (context) => {
          const last = context.messages.at(-1);
          if (last?.role === "toolResult") return fauxAssistantMessage("Background worker started.");
          const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map(p => p.text ?? "").join("");
          if (text.includes("CONTROLLED_CHILD") && !text.includes("Background workflow")) {
            childStarted = true;
            await released;
            return fauxAssistantMessage("Controlled local child result");
          }
          if (text.includes("Background workflow")) return fauxAssistantMessage("Result received automatically.");
          return fauxAssistantMessage([{ type: "toolCall", id: "start-fixture", name: "workflow", arguments: { script: workflowScript, background: true } }], { stopReason: "toolUse" });
        };
        core.setResponses(Array.from({ length: 8 }, () => responder));
        const runtime = await sdk.ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
        runtime.registerProvider(provider, {
          name: "Local faux fixture", baseUrl: "http://127.0.0.1:9/faux", apiKey: "faux-not-used", api: core.api,
          streamSimple: core.streamSimple,
          models: [{ id: "faux", name: "Faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
        });
        const registry = new sdk.ModelRegistry(runtime);
        const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager: settings,
          additionalExtensionPaths: [${JSON.stringify(entry)}], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        assert.equal(loader.getExtensions().extensions.length, 1);
        session = (await sdk.createAgentSession({ cwd: home, agentDir: home, model: registry.find(provider, "faux"), modelRuntime: runtime,
          resourceLoader: loader, sessionManager: sdk.SessionManager.create(home, join(home, "sessions")), settingsManager: settings })).session;
        const extensionErrors = [];
        await session.bindExtensions({ onError: error => extensionErrors.push(error) });
        assert.deepEqual(extensionErrors, []);
        await session.prompt("Start the controlled workflow fixture");
        await until(() => childStarted && session.isIdle, "child running and parent idle");
        const state = globalThis[Symbol.for("@quintinshaw/pi-dynamic-workflows:delivery-state")];
        const endpoint = state.sessionEndpoints.get(session.sessionId);
        assert.ok(endpoint?.send, "actual host capture must be available");
        manager = endpoint.manager;
        run = manager.listLiveRuns().find(r => r.status === "running");
        assert.ok(run);
        assert.equal(run.pendingDelivery, undefined);
        const listenerCount = manager.listenerCount("complete");
        const wrapper = sdk.AgentSession.prototype.sendCustomMessage;
        await session.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        assert.deepEqual(extensionErrors, []);
        const replacement = state.sessionEndpoints.get(session.sessionId);
        assert.notEqual(replacement, endpoint);
        assert.equal(replacement.manager, manager, "real reload must retain exact manager");
        assert.equal(replacement.suspended, false);
        assert.equal(manager.listenerCount("complete"), listenerCount);
        assert.equal(sdk.AgentSession.prototype.sendCustomMessage, wrapper, "no stacked prototype wrappers");
        assert.equal(run.pendingDelivery, undefined, "nothing pending at initial replacement bind");
        release();
        await until(() => manager.getRun(run.runId)?.status === "completed" && !manager.getPersistence().load(run.runId)?.pendingDelivery && session.isIdle, "automatic delivery and durable ACK after reload");
        const results = session.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === "workflow-result");
        assert.equal(results.length, 1);
        assert.match(String(results[0].content), /Controlled local child result/);
        assert.ok(results[0].details?.deliveryId);
        const { readFileSync } = await import("node:fs");
        assert.ok(readFileSync(session.sessionFile, "utf8").includes(JSON.stringify(results[0])), "active branch input must be on disk");
        assert.equal(core.state.callCount, 4, "one parent tool request, parent continuation, child and automatic result turn");
        console.log("PASS real SDK/faux-provider reload; no remote model; host=" + ${JSON.stringify(bundled ? "bundled" : "unbundled")});
      } finally {
        release();
        if (manager && run) await until(() => manager.getRun(run.runId)?.status !== "running", "cleanup drains worker");
        if (session) { await session.abort(); session.dispose(); }
        rmSync(home, { recursive: true, force: true });
      }
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      timeout: 25_000,
      encoding: "utf8",
      stdio: "pipe",
    });
    assert.match(output, /PASS real SDK\/faux-provider reload/);
  });
}
