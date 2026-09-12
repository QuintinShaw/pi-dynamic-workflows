import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };

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
