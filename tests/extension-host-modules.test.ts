import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
