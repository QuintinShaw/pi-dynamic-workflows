import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import packageJson from "../package.json" with { type: "json" };
import type { DeliveryRetry, DeliveryState, SessionDeliveryEndpoint } from "../src/delivery-state.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  pauseStrandedWorkflowRuntime,
  WORKFLOW_EXTENSION_VERSION,
} from "../src/extension-reload.js";
import { createRunPersistence, type RunPersistence } from "../src/run-persistence.js";
import type * as Panel from "../src/task-panel.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

type Message = { customType: string; content: string; display: boolean; details?: { deliveryId?: string } };

async function graph() {
  const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = await import(
    new URL("lib/jiti-static.mjs", pathToFileURL(require.resolve("jiti/package.json"))).href
  );
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    virtualModules: {
      "@earendil-works/pi-coding-agent": hostSdk,
      "@earendil-works/pi-tui": hostTui,
    },
  });
  return jiti;
}

async function generation(version = WORKFLOW_EXTENSION_VERSION): Promise<typeof Panel> {
  const jiti = await graph();
  const filename = new URL("../src/task-panel.ts", import.meta.url).pathname;
  if (version !== WORKFLOW_EXTENSION_VERSION) {
    // Only the manifest import changes in this isolated executable fixture.
    // Do not edit the tracked package version or merely relabel the reload slot.
    const source = readFileSync(filename, "utf8");
    const manifestImport = /import packageJson from "\.\.\/package\.json" with \{ type: "json" \};/;
    assert.match(source, manifestImport);
    return await jiti.evalModule(
      source.replace(manifestImport, `const packageJson = ${JSON.stringify({ ...packageJson, version })};`),
      { filename, async: true },
    );
  }
  return await jiti.import(filename);
}

function api() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    handlers,
    pi: {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      events: { emit() {} },
      sendMessage() {
        throw new Error("no shared-runtime delivery allowed");
      },
    } as unknown as hostSdk.ExtensionAPI,
  };
}

function host(root: string, sid: string, beforeSend: () => void = () => {}) {
  const branch: Array<{ id: string; type: string; customType: string; details?: unknown }> = [];
  const file = join(root, `${sid}.jsonl`);
  writeFileSync(file, "\n");
  const sent: Message[] = [];
  const session = {
    isIdle: true,
    isStreaming: false,
    sessionManager: {
      persist: true,
      getSessionId: () => sid,
      getBranch: () => branch,
      getSessionFile: () => file,
    },
    subscribe: () => () => {},
    async sendCustomMessage(message: Message) {
      beforeSend();
      sent.push(message);
      const entry = {
        id: `${sid}-${branch.length}`,
        type: "custom_message",
        customType: message.customType,
        details: message.details,
      };
      branch.push(entry);
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    },
  };
  return { session, sent, branch, file };
}

const script = `export const meta = { name: 'generation_delivery', description: 'isolated generation regression' }
return await agent('deferred fixture')`;

test("D01: retained completion automatically delivers after independent G2 initially-empty bind", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-delivery-generations-"));
  const g1 = await generation();
  g1._resetDeliveryRegistriesForTests();
  let finish!: (value: string) => void;
  let execution: Promise<unknown> | undefined;
  let manager: WorkflowManager | undefined;
  try {
    await withFakeHomeAsync(root, async () => {
      manager = new WorkflowManager({
        cwd: root,
        agent: {
          run: () =>
            new Promise<string>((resolve) => {
              finish = resolve;
            }),
        },
      });
      const m = manager;
      const a = api();
      const b = api();
      const h1 = host(root, "S1");
      let runId = "";
      let durableDeliveryId: string | undefined;
      const h2 = host(root, "S2", () => {
        const marker = m.getPersistence().load(runId)?.pendingDelivery;
        assert.ok(marker, "pending must be durable before physical send");
        durableDeliveryId = marker.deliveryId;
        assert.ok(durableDeliveryId);
      });
      m.setSessionId("S1");
      g1.installResultDelivery(a.pi, m);
      g1._registerHostSessionForTests(h1.session);
      g1.bindSessionDelivery("S1", a.pi, { manager: m });
      const started = m.startInBackground(script);
      runId = started.runId;
      execution = started.promise;
      for (let n = 0; !finish && n < 100; n++) await tick();
      assert.ok(finish, "real manager must have dispatched its deferred worker");
      const listeners = m.listenerCount("complete");
      g1.suspendResultDelivery(m);
      handoffWorkflowRuntime({
        cwd: root,
        manager: m,
        extensionVersion: WORKFLOW_EXTENSION_VERSION,
        effort: { level: "off" },
      });
      const g2 = await generation();
      assert.notEqual(g1.installResultDelivery, g2.installResultDelivery, "must independently evaluate exports");
      assert.equal(claimWorkflowRuntime().compatible?.manager, m, "compatible handoff retains exact manager");
      g2.installResultDelivery(b.pi, m);
      m.adoptLiveRunsToSession("S2", "S1");
      m.setSessionId("S2");
      assert.equal(m.getRun(runId)?.pendingDelivery, undefined, "initial G2 bind must have nothing to recover");
      g2._registerHostSessionForTests(h2.session);
      g2.bindSessionDelivery("S2", b.pi, { manager: m });
      g2.dropSessionDelivery("S1");
      assert.equal(g2._getSessionDeliveryEndpointForTests("S2")?.hasSend, true);
      assert.equal(g2._getSessionDeliveryEndpointForTests("S2")?.suspended, false);
      finish("complete only after G2 bind");
      await execution;
      for (let n = 0; n < 5; n++) await tick();
      console.log(
        "D01 endpoint evidence",
        JSON.stringify({
          distinctExports: g1.installResultDelivery !== g2.installResultDelivery,
          g1: g1._getSessionDeliveryEndpointForTests("S2") ?? null,
          g2: g2._getSessionDeliveryEndpointForTests("S2") ?? null,
          pending: m.getPersistence().load(runId)?.pendingDelivery ?? null,
          sends: h2.sent.length,
        }),
      );
      assert.equal(h1.sent.length, 0, "never deliver to outgoing session");
      assert.equal(
        h2.sent.length,
        1,
        "retained G1 completion must automatically reach G2 S2 endpoint without turn_end",
      );
      assert.ok(h2.branch[0]?.details, "ACK requires durable active-branch history");
      assert.equal(h2.sent[0].details?.deliveryId, durableDeliveryId);
      assert.equal((h2.branch[0].details as { deliveryId?: string }).deliveryId, durableDeliveryId);
      assert.equal(g2.sessionFileContainsEntry(h2.file, h2.branch[0]), true);
      assert.equal(m.getRun(runId)?.pendingDelivery, undefined);
      assert.equal(m.getPersistence().load(runId)?.pendingDelivery, undefined);
      assert.equal(m.listenerCount("complete"), listeners, "no accumulated result/lifecycle listeners");
      assert.equal(b.handlers.get("turn_end")?.length, 1);
    });
  } finally {
    finish?.("cleanup");
    await execution;
    discardWorkflowRuntime();
    await tick();
    g1._resetDeliveryRegistriesForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

function state(): DeliveryState {
  return (globalThis as unknown as Record<symbol, DeliveryState>)[
    Symbol.for("@quintinshaw/pi-dynamic-workflows:delivery-state")
  ];
}

test("version fixture evaluates distinct delivery executable ownership without changing package.json", async () => {
  const g1 = await generation("fixture-old");
  const g2 = await generation("fixture-new");
  const root = mkdtempSync(join(tmpdir(), "pi-delivery-version-"));
  try {
    await withFakeHomeAsync(root, async () => {
      const m1 = new WorkflowManager({ cwd: root });
      const m2 = new WorkflowManager({ cwd: root });
      g1.installResultDelivery(api().pi, m1);
      g2.installResultDelivery(api().pi, m2);
      assert.equal(state().managerVersions.get(m1), "fixture-old");
      assert.equal(state().managerVersions.get(m2), "fixture-new");
      assert.throws(() => g2.installResultDelivery(api().pi, m1), /different package version/);
    });
  } finally {
    await tick();
    g2._resetDeliveryRegistriesForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlledHost(root: string, sid: string) {
  const h = host(root, sid);
  const listeners = new Set<(event: { type: string }) => void>();
  const turns: Array<ReturnType<typeof deferred>> = [];
  const idle = deferred();
  const session = {
    ...h.session,
    waitForIdle: () => idle.promise,
    subscribe(listener: (event: { type: string }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendCustomMessage(message: Message) {
      assert.equal(session.isIdle, true, "no physical enqueue while busy");
      h.sent.push(message);
      const turn = deferred();
      turns.push(turn);
      return turn.promise;
    },
  };
  return {
    ...h,
    session,
    listeners,
    turns,
    persist(index = 0) {
      const message = h.sent[index];
      assert.ok(message);
      const entry = {
        id: `${sid}-${h.branch.length}`,
        type: "custom_message",
        customType: message.customType,
        details: message.details,
      };
      h.branch.push(entry);
      appendFileSync(h.file, `${JSON.stringify(entry)}\n`);
      for (const listener of listeners) listener({ type: "message_end" });
    },
    idle() {
      session.isIdle = true;
      session.isStreaming = false;
      idle.resolve();
      for (const listener of listeners) listener({ type: "agent_settled" });
    },
  };
}

async function drain() {
  for (let n = 0; n < 6; n++) await tick();
}

async function fixture(
  fn: (f: {
    root: string;
    g1: typeof Panel;
    g2: typeof Panel;
    manager: () => WorkflowManager;
    host: (sid: string) => ReturnType<typeof controlledHost>;
    start: (m: WorkflowManager) => Promise<string>;
  }) => Promise<void>,
  versions?: [string, string],
) {
  const root = mkdtempSync(join(tmpdir(), "pi-delivery-matrix-"));
  const g1 = await generation(versions?.[0]);
  g1._resetDeliveryRegistriesForTests();
  const g2 = await generation(versions?.[1]);
  assert.notEqual(g1.bindSessionDelivery, g2.bindSessionDelivery);
  const hosts: Array<ReturnType<typeof controlledHost>> = [];
  try {
    await withFakeHomeAsync(root, async () => {
      await fn({
        root,
        g1,
        g2,
        manager: () =>
          new WorkflowManager({
            cwd: root,
            agent: {
              async run() {
                return "fixture result";
              },
            },
          }),
        host(sid) {
          const h = controlledHost(root, sid);
          hosts.push(h);
          return h;
        },
        async start(m) {
          const r = m.startInBackground(script);
          await r.promise;
          await drain();
          return r.runId;
        },
      });
    });
  } finally {
    // Retire endpoints first; settle every started send before clearing fixtures.
    for (const sid of state().sessionEndpoints.keys()) g2.dropSessionDelivery(sid);
    for (const h of hosts) {
      h.idle();
      for (const turn of h.turns) turn.resolve();
    }
    await drain();
    assert.equal(state().activeStreamingWaiters.size, 0, "all fixture waiters must settle");
    assert.equal(state().inFlightDeliveries.size, 0, "all fixture finalizers must drain");
    g2._resetDeliveryRegistriesForTests();
    discardWorkflowRuntime();
    rmSync(root, { recursive: true, force: true });
  }
}

function bind(
  g: typeof Panel,
  pi: hostSdk.ExtensionAPI,
  m: WorkflowManager,
  h: ReturnType<typeof controlledHost>,
  sid: string,
) {
  m.setSessionId(sid);
  g.installResultDelivery(pi, m);
  g._registerHostSessionForTests(h.session);
  g.bindSessionDelivery(sid, pi, { manager: m });
}

test("same-ID independent reload preserves suspension until bind, then completion uses current endpoint", async () => {
  await fixture(async ({ g1, g2, manager, host, start }) => {
    const m = manager();
    const a = api();
    const b = api();
    const old = host("same");
    const fresh = host("same");
    bind(g1, a.pi, m, old, "same");
    g1.suspendResultDelivery(m);
    g2.installResultDelivery(b.pi, m);
    assert.equal(g2._getSessionDeliveryEndpointForTests("same")?.suspended, true);
    bind(g2, b.pi, m, fresh, "same");
    const id = await start(m);
    assert.equal(old.sent.length, 0);
    assert.equal(fresh.sent.length, 1);
    assert.ok(m.getPersistence().load(id)?.pendingDelivery);
    fresh.persist();
    fresh.turns[0].resolve();
    await drain();
    assert.equal(m.getPersistence().load(id)?.pendingDelivery, undefined);
  });
});

test("G2 cancels G1 unsent busy waiter; old idle cannot send after replacement", async () => {
  await fixture(async ({ g1, g2, manager, host, start }) => {
    const m = manager();
    const a = api();
    const b = api();
    const old = host("busy");
    old.session.isIdle = false;
    old.session.isStreaming = true;
    bind(g1, a.pi, m, old, "busy");
    const id = await start(m);
    assert.equal(old.sent.length, 0);
    assert.equal(old.listeners.size, 1);
    const fresh = host("busy");
    g2.suspendSessionDelivery("busy");
    bind(g2, b.pi, m, fresh, "busy");
    await drain();
    old.idle();
    await drain();
    assert.equal(old.sent.length, 0);
    assert.equal(old.listeners.size, 0);
    assert.equal(fresh.sent.length, 1);
    fresh.persist();
    fresh.turns[0].resolve();
    await drain();
    assert.equal(m.getRun(id)?.pendingDelivery, undefined);
  });
});

for (const outcome of ["success", "failure"] as const) {
  test(`started G1 send crossing G2 bind: delayed ${outcome}, no duplicate, automatic current-owner handoff`, async () => {
    await fixture(async ({ g1, g2, manager, host, start }) => {
      const m = manager();
      const a = api();
      const b = api();
      const h = host("started");
      g1._setStreamingAckTimeoutForTests(10);
      bind(g1, a.pi, m, h, "started");
      const id = await start(m);
      const oldToken = state().inFlightDeliveries.get(id)?.token;
      assert.ok(oldToken);
      g2.suspendSessionDelivery("started");
      bind(g2, b.pi, m, h, "started");
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(h.sent.length, 1, "rebind and timeout must not break old started ownership");
      assert.equal(state().inFlightDeliveries.get(id)?.token, oldToken);
      let wakeups = 0;
      const endpoint = state().sessionEndpoints.get("started");
      assert.ok(endpoint);
      const flush = endpoint.flushPending;
      endpoint.flushPending = (runId) => {
        wakeups++;
        flush(runId);
      };
      if (outcome === "success") {
        h.persist();
        h.turns[0].resolve();
      } else h.turns[0].reject(new Error("old send failed"));
      await drain();
      assert.ok(wakeups > 0, "old finalizer must notify current operation");
      if (outcome === "success") {
        assert.equal(h.sent.length, 1, "durable active-branch history prevents physical duplicate");
        assert.equal(m.getRun(id)?.pendingDelivery, undefined);
      } else {
        assert.equal(h.sent.length, 2, "failure retries without turn_end");
        const token = state().inFlightDeliveries.get(id)?.token;
        assert.ok(token && token > oldToken);
        g1.resumeSessionDelivery("started");
        await drain();
        assert.equal(state().inFlightDeliveries.get(id)?.token, token, "old finally cannot release current token");
        assert.equal(h.sent.length, 2, "no third send");
        h.persist(1);
        h.turns[1].resolve();
        await drain();
        assert.equal(m.getPersistence().load(id)?.pendingDelivery, undefined);
      }
    });
  });
}

test("new delivery ID rejects old ACK and stale finally cannot unlock its successor", async () => {
  await fixture(async ({ root, g1, g2, host }) => {
    let calls = 0;
    const m = new WorkflowManager({
      cwd: root,
      agent: {
        async run() {
          if (calls++ === 0)
            throw new WorkflowError("fixture quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          return "resumed result";
        },
      },
    });
    const a = api();
    const h = host("new-id");
    bind(g1, a.pi, m, h, "new-id");
    const first = m.startInBackground(script);
    const id = first.runId;
    await assert.rejects(first.promise, /fixture quota/);
    await drain();
    assert.equal(m.getRun(id)?.status, "paused");
    assert.equal(m.getRun(id)?.pendingDelivery?.kind, "text");
    const oldId = m.getRun(id)?.pendingDelivery?.deliveryId;
    const token1 = state().inFlightDeliveries.get(id)?.token;
    assert.ok(token1);
    // Supported sequence: quota notice is still sending when explicit resume completes.
    assert.equal(await m.resume(id), true);
    await drain();
    assert.equal(m.getRun(id)?.status, "completed");
    assert.equal(m.getRun(id)?.pendingDelivery?.kind, "complete");
    assert.notEqual(m.getRun(id)?.pendingDelivery?.deliveryId, oldId);
    bind(g2, api().pi, m, h, "new-id");
    h.persist();
    h.turns[0].resolve();
    await drain();
    assert.equal(h.sent.length, 2);
    const token2 = state().inFlightDeliveries.get(id)?.token;
    assert.ok(token2 && token2 > token1);
    assert.ok(m.getPersistence().load(id)?.pendingDelivery, "old ACK cannot clear new marker");
    g1.resumeSessionDelivery("new-id");
    await drain();
    assert.equal(h.sent.length, 2);
    assert.equal(state().inFlightDeliveries.get(id)?.token, token2);
    h.persist(1);
    h.turns[1].resolve();
    await drain();
    assert.equal(m.getRun(id)?.pendingDelivery, undefined);
  });
});

for (const rebind of [false, true]) {
  test(`failed clear across evaluation ${rebind ? "with replacement deduplicates history" : "without replacement retries clear only"}`, async () => {
    await fixture(async ({ g1, g2, manager, host, start }) => {
      const m = manager();
      const a = api();
      const h = host("clear");
      bind(g1, a.pi, m, h, "clear");
      const id = await start(m);
      const p = m.getPersistence();
      const update = p.updateMetadata.bind(p);
      let failures = 1;
      p.updateMetadata = ((runId, patch, deliveryId) => {
        if (deliveryId && failures-- > 0) throw new Error("clear failed");
        return update(runId, patch, deliveryId);
      }) as typeof p.updateMetadata;
      h.persist();
      h.turns[0].resolve();
      await drain();
      assert.ok(m.getRun(id)?.pendingDelivery);
      assert.ok(state().deliveredAwaitingClear.get(id));
      if (rebind) bind(g2, api().pi, m, h, "clear");
      else await new Promise((resolve) => setTimeout(resolve, 300));
      await drain();
      assert.equal(h.sent.length, 1, "clear retry/replacement must not physically resend");
      assert.equal(m.getRun(id)?.pendingDelivery, undefined);
      assert.equal(p.load(id)?.pendingDelivery, undefined);
    });
  });
}

test("pending persistence failure schedules reachable current-generation retry, never sends early", async () => {
  await fixture(async ({ g1, g2, manager, host, start }) => {
    const m = manager();
    const h = host("persist");
    bind(g1, api().pi, m, h, "persist");
    const p = m.getPersistence();
    const save = p.save.bind(p);
    const update = p.updateMetadata.bind(p);
    let blocked = true;
    p.save = ((...args) => {
      if (blocked && args[0].pendingDelivery) throw new Error("persist blocked");
      return save(...args);
    }) as typeof p.save;
    p.updateMetadata = ((...args) => {
      if (blocked && args[1].pendingDelivery) throw new Error("persist blocked");
      return update(...args);
    }) as typeof p.updateMetadata;
    const id = await start(m);
    assert.equal(h.sent.length, 0);
    assert.ok(state().deliveryRetries.get(id));
    // Re-evaluation alone must see the retry and allocator, not reset them.
    assert.equal(state().deliveryRetries.get(id)?.ownerVersion, WORKFLOW_EXTENSION_VERSION);
    g2.installResultDelivery(api().pi, m);
    blocked = false;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await drain();
    assert.equal(h.sent.length, 1);
    assert.ok(p.load(id)?.pendingDelivery);
    h.persist();
    h.turns[0].resolve();
    await drain();
    assert.equal(p.load(id)?.pendingDelivery, undefined);
  });
});

for (const started of [false, true]) {
  test(`quit/drop ${started ? "started" : "unsent"} ownership cannot resurrect endpoint or falsely ACK`, async () => {
    await fixture(async ({ g1, g2, manager, host, start }) => {
      const m = manager();
      const h = host("drop");
      h.session.isIdle = started;
      bind(g1, api().pi, m, h, "drop");
      const id = await start(m);
      g2.dropSessionDelivery("drop");
      if (started) {
        h.persist();
        h.turns[0].resolve();
      } else h.idle();
      await drain();
      assert.equal(h.sent.length, started ? 1 : 0);
      assert.equal(g1._getSessionDeliveryEndpointForTests("drop"), undefined);
      assert.ok(m.getPersistence().load(id)?.pendingDelivery, "no current endpoint may ACK");
      assert.equal(state().inFlightDeliveries.size, 0);
    });
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`B01-1: protocol-compatible version replacement retains old terminal send through delayed ${outcome}`, async () => {
    await fixture(
      async ({ root, g1, g2, manager, host, start }) => {
        const old = manager();
        const a = api();
        const b = api();
        const h = host("version");
        bind(g1, a.pi, old, h, "version");
        const id = await start(old);
        assert.equal(old.getRun(id)?.status, "completed");
        const first = state().inFlightDeliveries.get(id);
        assert.ok(first);
        assert.equal(first.ownerVersion, "fixture-old");
        g1.suspendResultDelivery(old);
        handoffWorkflowRuntime({ cwd: root, manager: old, extensionVersion: "fixture-old", effort: { level: "off" } });
        const claim = claimWorkflowRuntime();
        assert.equal(claim.compatible, undefined);
        assert.equal(claim.versionMismatch?.manager, old);
        assert.ok(claim.versionMismatch);
        assert.equal(
          pauseStrandedWorkflowRuntime(claim.versionMismatch),
          0,
          "terminal send is not paused workflow execution",
        );
        const fresh = manager();
        assert.notEqual(fresh, old);
        g2.installResultDelivery(b.pi, fresh);
        assert.equal(
          state().sessionEndpoints.get("version")?.manager,
          old,
          "foreign-version install cannot mutate old endpoint manager",
        );
        bind(g2, b.pi, fresh, h, "version");
        assert.equal(state().managerVersions.get(fresh), "fixture-new");
        assert.equal(h.sent.length, 1);
        assert.equal(state().inFlightDeliveries.get(id), first, "new manager cannot steal old token");
        const endpoint = state().sessionEndpoints.get("version");
        assert.ok(endpoint);
        const flush = endpoint.flushPending;
        let wakeups = 0;
        endpoint.flushPending = (runId) => {
          wakeups++;
          flush(runId);
        };
        const p = fresh.getPersistence();
        const update = p.updateMetadata.bind(p);
        let currentClears = 0;
        p.updateMetadata = ((runId, patch, deliveryId) => {
          if (deliveryId) {
            currentClears++;
            assert.equal(
              state().inFlightDeliveries.get(id)?.ownerVersion,
              "fixture-new",
              "only current executable may ACK through fresh manager",
            );
            assert.equal(state().inFlightDeliveries.get(id)?.endpoint, endpoint);
          }
          return update(runId, patch, deliveryId);
        }) as typeof p.updateMetadata;
        if (outcome === "success") {
          h.persist();
          h.turns[0].resolve();
        } else h.turns[0].reject(new Error("old version send failed"));
        await drain();
        assert.ok(wakeups > 0, "old version must call current-owned operation, not its own flush with fresh manager");
        if (outcome === "failure") {
          assert.equal(h.sent.length, 2);
          assert.equal(state().inFlightDeliveries.get(id)?.ownerVersion, "fixture-new");
          h.persist(1);
          h.turns[1].resolve();
          await drain();
        } else assert.equal(h.sent.length, 1, "same-session durable history deduplicates across versions");
        assert.equal(currentClears, 1);
        assert.equal(p.load(id)?.pendingDelivery, undefined);
        // Fresh-manager recovery owns disk, not the nonadopted old live run.
        assert.ok(old.getRun(id)?.pendingDelivery);
      },
      ["fixture-old", "fixture-new"],
    );
  });
}

// Seam-only ordering coverage: no mismatch pause is applied here. Ordinary success
// after real mismatch pause is suppressed by the manager; terminal started sends
// above and the nullable-read regression below exercise the reachable lifecycle.
test("seam-only cross-version terminal notification waits for synchronous terminal persistence", async () => {
  await fixture(
    async ({ root, g1, g2, manager, host }) => {
      const worker = deferred<string>();
      const old = new WorkflowManager({ cwd: root, agent: { run: () => worker.promise } });
      const h = host("late-terminal");
      bind(g1, api().pi, old, h, "late-terminal");
      const run = old.startInBackground(script);
      await drain();
      g1.suspendResultDelivery(old);
      const fresh = manager();
      bind(g2, api().pi, fresh, h, "late-terminal");
      let synchronousCompleteEnded = false;
      old.on("complete", () => {
        synchronousCompleteEnded = true;
      });
      const endpoint = state().sessionEndpoints.get("late-terminal");
      assert.ok(endpoint);
      const flush = endpoint.flushPending;
      let notified = 0;
      endpoint.flushPending = (runId) => {
        assert.equal(synchronousCompleteEnded, true);
        assert.equal(old.getPersistence().load(run.runId)?.status, "completed");
        notified++;
        flush(runId);
      };
      try {
        worker.resolve("done");
        await run.promise;
        await drain();
        assert.ok(notified > 0);
        assert.equal(h.sent.length, 1);
        assert.equal(state().inFlightDeliveries.get(run.runId)?.ownerVersion, "fixture-new");
        h.persist();
        h.turns[0].resolve();
        await drain();
        assert.equal(fresh.getPersistence().load(run.runId)?.pendingDelivery, undefined);
      } finally {
        worker.resolve("cleanup");
        await run.promise;
      }
    },
    ["fixture-old", "fixture-new"],
  );
});

test("different-version different-session fresh manager does not fabricate old disk-owner adoption", async () => {
  await fixture(
    async ({ g1, g2, manager, host, start }) => {
      const old = manager();
      const h1 = host("old-session");
      bind(g1, api().pi, old, h1, "old-session");
      const id = await start(old);
      g1.suspendResultDelivery(old);
      const fresh = manager();
      const h2 = host("new-session");
      bind(g2, api().pi, fresh, h2, "new-session");
      h1.persist();
      h1.turns[0].resolve();
      await drain();
      assert.equal(h2.sent.length, 0);
      assert.equal(fresh.getPersistence().load(id)?.sessionId, "old-session");
      assert.ok(fresh.getPersistence().load(id)?.pendingDelivery);
    },
    ["fixture-old", "fixture-new"],
  );
});

test("independent A/B/A API installs and same-API new manager use one mutable current recovery cell", async () => {
  await fixture(async ({ g1, g2, manager, host, start }) => {
    const a = api();
    const b = api();
    const ma = manager();
    const mb = manager();
    const ha = host("A");
    const hb = host("B");
    bind(g1, a.pi, ma, ha, "A");
    bind(g2, b.pi, mb, hb, "B");
    g2.installResultDelivery(a.pi, ma);
    assert.equal(a.handlers.get("turn_end")?.length, 1);
    assert.equal(b.handlers.get("turn_end")?.length, 1);
    const aid = await start(ma);
    const bid = await start(mb);
    assert.equal(ha.sent.length, 1);
    assert.equal(hb.sent.length, 1);
    ha.persist();
    ha.turns[0].resolve();
    hb.persist();
    hb.turns[0].resolve();
    await drain();
    assert.equal(ma.getRun(aid)?.pendingDelivery, undefined);
    assert.equal(mb.getRun(bid)?.pendingDelivery, undefined);
    const fresh = manager();
    fresh.setSessionId("A");
    const before = g1._getSessionDeliveryEndpointForTests("A");
    g2.installResultDelivery(a.pi, fresh);
    assert.deepEqual(
      g2._getSessionDeliveryEndpointForTests("A"),
      before,
      "transport/generation/suspension unchanged until bind",
    );
    let oldReads = 0;
    const oldList = ma.listLiveRuns.bind(ma);
    ma.listLiveRuns = () => {
      oldReads++;
      return oldList();
    };
    let freshReads = 0;
    const freshList = fresh.listLiveRuns.bind(fresh);
    fresh.listLiveRuns = () => {
      freshReads++;
      return freshList();
    };
    const handler = a.handlers.get("turn_end")?.[0];
    assert.ok(handler);
    handler({}, { sessionManager: { getSessionId: () => "A" } });
    assert.ok(freshReads > 0);
    assert.equal(oldReads, 0);
    assert.equal(a.handlers.get("turn_end")?.length, 1);
  });
});

test("disk-only migrated pending owner wakes after old generation settlement", async () => {
  await fixture(async ({ g1, g2, manager, host, start }) => {
    const old = manager();
    const h1 = host("disk-old");
    bind(g1, api().pi, old, h1, "disk-old");
    const id = await start(old);
    const fresh = manager();
    fresh.setSessionId("disk-old");
    // Existing adoption path needs an explicit previous owner; no new migration protocol.
    fresh.adoptLiveRunsToSession("disk-new", "disk-old");
    fresh.setSessionId("disk-new");
    const h2 = host("disk-new");
    bind(g2, api().pi, fresh, h2, "disk-new");
    g2.dropSessionDelivery("disk-old");
    // Model eviction: the old finalizer must resolve the persisted owner, not a stale live pointer.
    const getRun = old.getRun.bind(old);
    old.getRun = (runId) => (runId === id ? undefined : getRun(runId));
    h1.turns[0].reject(new Error("outgoing host failed"));
    await drain();
    assert.equal(h2.sent.length, 1);
    h2.persist();
    h2.turns[0].resolve();
    await drain();
    assert.equal(fresh.getPersistence().load(id)?.pendingDelivery, undefined);
  });
});

test("repeated evaluation reuses live-receiver wrappers, current capture delegate and explicitly selected host", async () => {
  await fixture(async ({ g1, g2, host }) => {
    const h = host("capture");
    const receiverChecks: unknown[] = [];
    class Host {
      sendCustomMessage(message: Message) {
        receiverChecks.push(this);
        return h.session.sendCustomMessage(message);
      }
      _bindExtensionCore(..._args: unknown[]) {
        receiverChecks.push(this);
      }
    }
    const fallback = state().hostAgentSession;
    try {
      g1.installHostSessionCapture(Host as unknown as typeof hostSdk.AgentSession);
      const send = Host.prototype.sendCustomMessage;
      const core = Host.prototype._bindExtensionCore;
      const g3 = await generation("fixture-capture");
      assert.equal(state().hostAgentSession, Host, "fresh evaluation must not reset explicitly selected host");
      g3.installHostSessionCapture(Host as unknown as typeof hostSdk.AgentSession);
      assert.equal(Host.prototype.sendCustomMessage, send);
      assert.equal(Host.prototype._bindExtensionCore, core);
      class Derived extends Host {}
      g3.installHostSessionCapture(Derived as unknown as typeof hostSdk.AgentSession);
      assert.equal(Derived.prototype.sendCustomMessage, send, "inherited owned wrapper must not be wrapped again");
      const { sendCustomMessage: _ownSend, ...shape } = h.session;
      const receiver = Object.assign(Object.create(Derived.prototype), shape) as Host;
      receiver._bindExtensionCore();
      assert.equal(receiverChecks[0], receiver, "bindCore original gets live receiver");
      assert.equal(
        state().senderVersions.get("capture"),
        "fixture-capture",
        "inherited wrapper uses current implementation",
      );
      await receiver.sendCustomMessage({ customType: g3.DELIVERY_PROBE_CUSTOM_TYPE, content: "", display: false });
      assert.equal(receiverChecks.length, 1, "probe swallowed before original send");
      const pending = receiver.sendCustomMessage({ customType: "ordinary", content: "receiver", display: false });
      assert.equal(receiverChecks[1], receiver);
      h.turns[0].resolve();
      await pending;
      // Do not replace unrelated third-party patches, even if they wrap ours.
      const thirdParty = function (this: Host, message: Message) {
        return send.call(this, message);
      };
      Host.prototype.sendCustomMessage = thirdParty;
      g2.installHostSessionCapture(Host as unknown as typeof hostSdk.AgentSession);
      assert.equal(Host.prototype.sendCustomMessage, thirdParty);
      await receiver.sendCustomMessage({ customType: g2.DELIVERY_PROBE_CUSTOM_TYPE, content: "", display: false });
      assert.equal(state().senderVersions.get("capture"), WORKFLOW_EXTENSION_VERSION);
    } finally {
      g2.installHostSessionCapture(fallback);
    }
  });
});

test("different-version bind recaptures sender provenance even after successful old probe", async () => {
  await fixture(
    async ({ g1, g2, manager, host }) => {
      const h = host("recapture");
      const a = api();
      let probe = g1;
      a.pi.sendMessage = (() => {
        probe._registerHostSessionForTests(h.session);
      }) as typeof a.pi.sendMessage;
      const old = manager();
      old.setSessionId("recapture");
      g1.installResultDelivery(a.pi, old);
      g1.bindSessionDelivery("recapture", a.pi, { manager: old });
      assert.equal(g1._isProbedForTests("recapture"), true);
      const oldSend = g1._getStealMapForTests().get("recapture");
      probe = g2;
      const fresh = manager();
      fresh.setSessionId("recapture");
      g2.installResultDelivery(a.pi, fresh);
      g2.bindSessionDelivery("recapture", a.pi, { manager: fresh });
      assert.notEqual(g2._getStealMapForTests().get("recapture"), oldSend);
      assert.equal(state().senderVersions.get("recapture"), "fixture-new");
      assert.equal(g2._getSessionDeliveryEndpointForTests("recapture")?.hasSend, true);
      assert.equal(a.handlers.get("turn_end")?.length, 1);
    },
    ["fixture-old", "fixture-new"],
  );
});

test("incompatible schema fails actual extension graph before claim or capture patch, preserving live ownership", async () => {
  await fixture(async ({ root, g1, manager, host, start }) => {
    const m = manager();
    const h = host("schema");
    bind(g1, api().pi, m, h, "schema");
    const id = await start(m);
    const shared = state();
    const lock = shared.inFlightDeliveries.get(id);
    assert.ok(lock);
    const wrapper = hostSdk.AgentSession.prototype.sendCustomMessage;
    const runtime = {
      cwd: root,
      manager: m,
      extensionVersion: WORKFLOW_EXTENSION_VERSION,
      effort: { level: "off" as const },
    };
    handoffWorkflowRuntime(runtime);
    const mutable = shared as unknown as { schemaVersion: number };
    mutable.schemaVersion = 999;
    try {
      const loader = await graph();
      await assert.rejects(
        loader.import(new URL("../src/pi-extension.ts", import.meta.url).pathname),
        /incompatible.*restart Pi/,
      );
      assert.equal(state(), shared);
      assert.equal(shared.inFlightDeliveries.get(id), lock);
      assert.equal(hostSdk.AgentSession.prototype.sendCustomMessage, wrapper);
      assert.equal(claimWorkflowRuntime().compatible, runtime, "failed graph must not claim staged manager");
      assert.equal(h.sent.length, 1);
    } finally {
      mutable.schemaVersion = 1;
    }
    h.persist();
    h.turns[0].resolve();
    await drain();
    assert.equal(m.getRun(id)?.pendingDelivery, undefined);
  });
});

type GenerationFixture = Parameters<Parameters<typeof fixture>[0]>[0];

/** Reachable mismatch: terminal workflow, but its old host send is still started. */
async function terminalReplacement(f: GenerationFixture) {
  const old = f.manager();
  const h = f.host("nullable-read");
  bind(f.g1, api().pi, old, h, "nullable-read");
  const id = await f.start(old);
  assert.equal(old.getRun(id)?.status, "completed");
  assert.ok(old.getPersistence().load(id)?.pendingDelivery);
  const lock = state().inFlightDeliveries.get(id);
  assert.ok(lock);
  assert.equal(lock.ownerVersion, "fixture-old");
  f.g1.suspendResultDelivery(old);
  handoffWorkflowRuntime({ cwd: f.root, manager: old, extensionVersion: "fixture-old", effort: { level: "off" } });
  const claim = claimWorkflowRuntime();
  assert.equal(claim.compatible, undefined);
  assert.equal(claim.versionMismatch?.manager, old);
  assert.ok(claim.versionMismatch);
  assert.equal(pauseStrandedWorkflowRuntime(claim.versionMismatch), 0, "terminal workflow is not paused");
  const fresh = f.manager();
  assert.notEqual(fresh, old);
  bind(f.g2, api().pi, fresh, h, "nullable-read");
  assert.equal(fresh.getRun(id), undefined, "replacement must be disk-only, not adopt the old manager's run");
  assert.equal(h.sent.length, 1);
  assert.equal(state().inFlightDeliveries.get(id), lock);
  const endpoint = state().sessionEndpoints.get("nullable-read");
  assert.ok(endpoint);
  assert.equal(endpoint.ownerVersion, "fixture-new");
  return { old, fresh, h, id, lock, endpoint, p: fresh.getPersistence() };
}

/** Fault the actual filesystem layer; load itself retains its real nullable contract. */
function nullableReader(root: string, p: RunPersistence, id: string) {
  let blocked = true;
  let loads = 0;
  let nulls = 0;
  const denied = new Set<string>();
  const io = createRunPersistence(root, {
    readFileSync: ((...args: Parameters<typeof readFileSync>) => {
      const path = String(args[0]);
      if (blocked && path.includes(id)) {
        denied.add(path);
        throw Object.assign(new Error("F01 filesystem read denied"), { code: "EACCES" });
      }
      return readFileSync(...args);
    }) as typeof readFileSync,
  });
  p.list = io.list.bind(io);
  p.load = (runId) => {
    loads++;
    const record = io.load(runId);
    if (record === null) nulls++;
    return record;
  };
  return {
    restore() {
      blocked = false;
    },
    get loads() {
      return loads;
    },
    get nulls() {
      return nulls;
    },
    denied,
  };
}

function observeWrites(p: RunPersistence) {
  const calls: Array<{ kind: string; deliveryId?: string }> = [];
  const save = p.save.bind(p);
  const update = p.updateMetadata?.bind(p);
  assert.ok(update);
  p.save = (record) => {
    calls.push({ kind: "save" });
    return save(record);
  };
  p.updateMetadata = (id, patch, deliveryId) => {
    calls.push({ kind: "metadata", deliveryId });
    return update(id, patch, deliveryId);
  };
  return calls;
}

async function until(check: () => boolean, label: string, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), label);
  await drain();
}

async function exhaustRetries(id: string, endpoint: SessionDeliveryEndpoint, reads: { readonly loads: number }) {
  for (const attempt of [1, 2, 3]) {
    const retry = state().deliveryRetries.get(id);
    assert.ok(retry?.timer, `attempt ${attempt} must be armed, not just bookkeeping`);
    assert.equal(retry.attempt, attempt);
    assert.equal(retry.endpoint, endpoint);
    assert.equal(retry.ownerVersion, "fixture-new");
    endpoint.flushPending(id);
    assert.equal(state().deliveryRetries.get(id), retry, "duplicate notification coalesces without resetting delay");
    const before = reads.loads;
    await until(() => reads.loads > before, `retry ${attempt} must actually reread`, [0, 1_000, 2_000, 5_000][attempt]);
    assert.equal(reads.loads, before + 1, "one reread per timer");
  }
  const exhausted = state().deliveryRetries.get(id);
  assert.equal(exhausted?.attempt, 3);
  assert.equal(exhausted?.timer, undefined, "no fourth timer after exhaustion");
  endpoint.flushPending(id);
  assert.equal(state().deliveryRetries.get(id), exhausted, "later notification cannot reset exhausted sequence");
  const before = reads.loads;
  await delay(300);
  assert.equal(reads.loads, before, "exhaustion is quiescent, not indefinite polling");
}

test("R01-1/R02-1: both nullable settlement reads recover automatically with one bounded current-owned retry", async () => {
  await fixture(
    async (f) => {
      const { old, fresh, h, id, endpoint, p } = await terminalReplacement(f);
      const reader = nullableReader(f.root, p, id);
      const writes = observeWrites(p);
      const flush = endpoint.flushPending;
      const retrySnapshots: Array<DeliveryRetry | undefined> = [];
      endpoint.flushPending = (runId) => {
        flush(runId);
        retrySnapshots.push(state().deliveryRetries.get(id));
      };
      h.turns[0].reject(new Error("old host failed before acceptance"));
      await drain();
      assert.equal(reader.nulls, 2, "outage must span BOTH settlement notifications");
      assert.equal(reader.loads, 2);
      assert.ok([...reader.denied].some((path) => path.endsWith(".json")));
      assert.ok(
        [...reader.denied].some((path) => path.endsWith(".json.bak")),
        "backup must also encounter real EACCES",
      );
      assert.deepEqual(writes, [], "null cannot synthesize, save or ACK");
      assert.equal(state().inFlightDeliveries.has(id), false);
      const retry = state().deliveryRetries.get(id);
      const armedAfterSettlement = !!retry?.timer;
      reader.restore(); // No input, turn_end, rebind, resume or explicit recovery after this point.
      await delay(350); // Real-timer integration, deliberately not a manual timer callback.
      await drain();
      console.log(
        "F01 nullable recovery",
        JSON.stringify({
          nullReads: reader.nulls,
          physicalSends: h.sent.length,
          retryAttempt: retry?.attempt,
          armedAfterSettlement,
        }),
      );
      assert.equal(h.sent.length, 2, "current-owner notification must retry a transient null read, without user input");
      assert.ok(retry, "both notifications must leave one owned retry");
      assert.equal(armedAfterSettlement, true, "attempt one was actually armed before storage recovered");
      assert.equal(retry.attempt, 1);
      assert.equal(retry.endpoint, endpoint);
      assert.equal(retry.ownerVersion, "fixture-new");
      assert.equal(retrySnapshots.length, 3, "two settlement notifications plus the timer dispatch");
      assert.equal(retrySnapshots[0], retry);
      assert.equal(retrySnapshots[1], retry, "second notification must coalesce into attempt one");
      assert.equal(state().inFlightDeliveries.get(id)?.ownerVersion, "fixture-new");
      assert.equal(state().inFlightDeliveries.get(id)?.endpoint, endpoint);
      const marker = p.load(id)?.pendingDelivery;
      assert.ok(marker, "pending remains durable before host acceptance");
      assert.equal(h.sent[1].details?.deliveryId, marker.deliveryId);
      assert.deepEqual(writes, []);
      endpoint.flushPending(id);
      await delay(300);
      assert.equal(h.sent.length, 2, "no third physical send while current owner is started");
      h.persist(1);
      assert.equal(
        f.g2.sessionFileContainsEntry(h.file, h.branch[0]),
        true,
        "ACK input is on active-branch disk history",
      );
      h.turns[1].resolve();
      await drain();
      assert.equal(h.sent.length, 2);
      assert.equal(p.load(id)?.pendingDelivery, undefined);
      assert.equal(
        writes.filter((call) => call.deliveryId === marker.deliveryId).length,
        1,
        "one delivery-ID-conditional durable ACK",
      );
      assert.ok(old.getRun(id)?.pendingDelivery, "no foreign-manager ACK transfer");
      assert.equal(fresh.getRun(id), undefined);
      assert.equal(state().inFlightDeliveries.has(id), false);
      assert.equal(state().activeStreamingWaiters.size, 0);
      assert.equal(state().deliveryRetries.has(id), false);
    },
    ["fixture-old", "fixture-new"],
  );
});

for (const absent of [false, true]) {
  test(`nullable notification exhausts attempts 1/2/3 without fourth: ${absent ? "real deletion cannot resurrect" : "persistent filesystem EACCES"}`, async () => {
    await fixture(
      async (f) => {
        const { old, h, id, endpoint, p } = await terminalReplacement(f);
        const reader = nullableReader(f.root, p, id);
        const writes = observeWrites(p);
        if (absent) {
          assert.equal(old.getPersistence().delete(id), true);
          reader.restore();
          // Persistence deletion removes recoverable state, but not the human-readable
          // execution log. Retire that non-recovery fixture artifact before snapshotting.
          rmSync(join(p.getRunsDir(), `${id}.log`), { force: true });
          assert.equal(p.load(id), null, "no surviving backup/log/result may recover deleted work");
        }
        const files = readdirSync(p.getRunsDir()).sort();

        h.turns[0].reject(new Error("old send failed"));
        await drain();
        await exhaustRetries(id, endpoint, reader);
        reader.restore();
        assert.equal(h.sent.length, 1);
        assert.equal(h.branch.length, 0, "no acceptance or ACK");
        assert.deepEqual(writes, [], "ambiguous absence never authorizes a write");
        assert.equal(state().inFlightDeliveries.has(id), false);
        assert.equal(state().deliveredAwaitingClear.has(id), false);
        assert.equal(state().activeStreamingWaiters.size, 0);
        assert.deepEqual(readdirSync(p.getRunsDir()).sort(), files, "no recreated head, log, backup, result or marker");
        if (absent) {
          assert.equal(p.load(id), null);
          assert.equal(
            readdirSync(p.getRunsDir()).some((name) => name.startsWith(id)),
            false,
          );
        } else assert.ok(p.load(id)?.pendingDelivery, "exhaustion preserves the original pending marker");
      },
      ["fixture-old", "fixture-new"],
    );
  });
}

for (const negative of ["cleared", "foreign", "null-owner"] as const) {
  for (const initiallyNull of [false, true]) {
    test(`readable ${negative} stops targeted retry${initiallyNull ? " after null" : " immediately"}`, async () => {
      await fixture(
        async (f) => {
          const { old, h, id, endpoint, p } = await terminalReplacement(f);
          const reader = nullableReader(f.root, p, id);
          const writes = observeWrites(p);
          const patch =
            negative === "cleared"
              ? { pendingDelivery: undefined }
              : { sessionId: negative === "foreign" ? "other-session" : null };
          if (!initiallyNull) {
            const record = old.getPersistence().load(id);
            assert.ok(record);
            old.getPersistence().save({ ...record, ...patch });
            assert.equal(
              old.getPersistence().load(id)?.sessionId,
              patch.sessionId ?? (negative === "cleared" ? "nullable-read" : null),
            );
            reader.restore();
          }
          h.turns[0].reject(new Error("old send failed"));
          await drain();
          if (initiallyNull) {
            const retry = state().deliveryRetries.get(id);
            assert.equal(retry?.attempt, 1);
            assert.ok(retry?.timer);
            const record = old.getPersistence().load(id);
            assert.ok(record);
            old.getPersistence().save({ ...record, ...patch });
            assert.equal(
              old.getPersistence().load(id)?.sessionId,
              patch.sessionId ?? (negative === "cleared" ? "nullable-read" : null),
            );
            reader.restore();
            await until(() => !state().deliveryRetries.get(id)?.timer, "definitive readable negative must stop retry");
            assert.equal(state().deliveryRetries.get(id), retry, "timerless bookkeeping need not be deleted");
          } else assert.equal(state().deliveryRetries.has(id), false);
          const before = reader.loads;
          await delay(300);
          assert.equal(reader.loads, before, "negative cannot rearm");
          assert.equal(state().deliveryRetries.get(id)?.timer, undefined);
          assert.equal(h.sent.length, 1);
          assert.equal(h.branch.length, 0);
          assert.deepEqual(writes, []);
          assert.equal(state().inFlightDeliveries.has(id), false);
          assert.equal(state().deliveredAwaitingClear.has(id), false);
          const record = p.load(id);
          assert.ok(record);
          if (negative === "cleared") assert.equal(record.pendingDelivery, undefined);
          else {
            assert.equal(record.sessionId, patch.sessionId);
            assert.ok(record.pendingDelivery);
          }
          assert.equal(state().sessionEndpoints.get("nullable-read"), endpoint);
        },
        ["fixture-old", "fixture-new"],
      );
    });
  }
}

for (const lifetime of ["suspend", "drop", "replace"] as const) {
  test(`nullable queued retry is rejected after endpoint ${lifetime}`, async () => {
    await fixture(
      async (f) => {
        const { h, id, endpoint, fresh, p } = await terminalReplacement(f);
        const reader = nullableReader(f.root, p, id);
        const writes = observeWrites(p);
        h.turns[0].reject(new Error("old send failed"));
        await drain();
        const retry = state().deliveryRetries.get(id);
        assert.ok(retry?.timer);
        if (lifetime === "suspend") f.g2.suspendSessionDelivery("nullable-read");
        else if (lifetime === "drop") f.g2.dropSessionDelivery("nullable-read");
        else bind(f.g2, api().pi, fresh, h, "nullable-read"); // Reads remain blocked during replacement bind.
        const before = reader.loads;
        reader.restore();
        endpoint.flushPending(id); // Retained old endpoint closure must reject dispatch too.
        await delay(350);
        await drain();
        assert.equal(reader.loads, before, "cancelled/stale timer and operation must not read or send");
        assert.equal(state().deliveryRetries.get(id)?.timer, undefined);
        assert.equal(h.sent.length, 1);
        assert.equal(h.branch.length, 0);
        assert.deepEqual(writes, []);
        assert.equal(state().inFlightDeliveries.has(id), false);
        assert.ok(p.load(id)?.pendingDelivery);
      },
      ["fixture-old", "fixture-new"],
    );
  });
}

test("duplicate targeted notifications preserve old/current started token and do not read or retry", async () => {
  await fixture(
    async (f) => {
      const { h, id, lock, endpoint, p } = await terminalReplacement(f);
      const reader = nullableReader(f.root, p, id);
      endpoint.flushPending(id);
      endpoint.flushPending(id);
      assert.equal(reader.loads, 0, "old started ownership must short-circuit before persistence reads");
      assert.equal(state().inFlightDeliveries.get(id), lock);
      assert.equal(state().deliveryRetries.has(id), false);
      reader.restore();
      h.turns[0].reject(new Error("old failed"));
      await drain();
      assert.equal(h.sent.length, 2);
      const current = state().inFlightDeliveries.get(id);
      assert.ok(current && current.token > lock.token);
      assert.equal(current.ownerVersion, "fixture-new");
      const before = reader.loads;
      endpoint.flushPending(id);
      endpoint.flushPending(id);
      assert.equal(reader.loads, before);
      assert.equal(state().inFlightDeliveries.get(id), current);
      assert.equal(state().deliveryRetries.has(id), false);
      assert.equal(h.sent.length, 2);
      h.persist(1);
      h.turns[1].resolve();
      await drain();
      assert.equal(p.load(id)?.pendingDelivery, undefined);
    },
    ["fixture-old", "fixture-new"],
  );
});

test("targeted notification without persistence stays fail-closed, not a nullable-read retry", async () => {
  await fixture(
    async (f) => {
      const { fresh, h, id, p } = await terminalReplacement(f);
      const writes = observeWrites(p);
      fresh.getPersistence = (() => undefined) as unknown as typeof fresh.getPersistence;
      h.turns[0].reject(new Error("old failed"));
      await drain();
      await delay(300);
      assert.equal(state().deliveryRetries.has(id), false);
      assert.equal(state().inFlightDeliveries.has(id), false);
      assert.equal(h.sent.length, 1);
      assert.equal(h.branch.length, 0);
      assert.deepEqual(writes, []);
      assert.ok(p.load(id)?.pendingDelivery);
    },
    ["fixture-old", "fixture-new"],
  );
});

test("escaping targeted load exception retains bounded retry and normal durable recovery", async () => {
  await fixture(
    async (f) => {
      const { h, id, p } = await terminalReplacement(f);
      const load = p.load.bind(p);
      p.load = () => {
        throw new Error("separate escaping exception case, not the nullable API regression");
      };
      h.turns[0].reject(new Error("old failed"));
      await drain();
      assert.equal(state().deliveryRetries.get(id)?.attempt, 1);
      assert.ok(state().deliveryRetries.get(id)?.timer);
      p.load = load;
      await until(() => h.sent.length === 2, "escaping exception still recovers automatically");
      assert.ok(load(id)?.pendingDelivery);
      h.persist(1);
      h.turns[1].resolve();
      await drain();
      assert.equal(load(id)?.pendingDelivery, undefined);
      assert.equal(state().deliveryRetries.has(id), false);
    },
    ["fixture-old", "fixture-new"],
  );
});
