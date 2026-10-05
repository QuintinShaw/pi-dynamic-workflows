import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installHostCreateAgentSession, runtimeOf, WorkflowAgent } from "../src/agent.js";
import { WorkflowError } from "../src/errors.js";
import { createAgentStoreTools, SharedStore } from "../src/shared-store.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { fauxRegistryFor } from "./helpers/faux-registry.js";

const host = pi as NonNullable<Parameters<typeof installHostCreateAgentSession>[1]>;
const capable = typeof host.createCodemodeExtension === "function";
const version = JSON.parse(
  readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"),
).version;

test("Pi 1.x must run the real builtin execution tests", () => {
  if (Number(version.split(".")[0]) >= 1) assert.ok(capable, `Pi ${version} must export the codemode factory`);
});

function sentinel(name: string, execute: () => Promise<string> | string = () => name): pi.ToolDefinition {
  return pi.defineTool({
    name,
    label: name,
    description: `Harmless ${name} sentinel`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: await execute() }], details: {} }),
  });
}

function code(source: string) {
  return fauxAssistantMessage(fauxToolCall("codemode", { code: source }), { stopReason: "toolUse" });
}

function requestToolNames(context: unknown): string[] {
  const request = context as {
    tools?: { name: string }[];
    messages: { role: string; toolsAdded?: { name: string }[] }[];
  };
  const tools =
    request.tools ??
    request.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []));
  return tools.map((tool) => tool.name);
}

function toolOutputs(context: { messages: readonly unknown[] }): string {
  const results = (
    context.messages as Array<{ role?: string; toolName?: string; isError?: boolean; content?: unknown }>
  ).filter((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert.ok(results.length, "codemode must actually execute");
  for (const result of results) {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /Script completed/);
  }
  return JSON.stringify(results);
}

test("builtin activation is opt-in, exclusion wins, and file conflicts fail", { skip: !capable }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-builtin-activation-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const core = createFauxCore({ provider: "faux-activation", models: [{ id: "model" }] });
      const registry = await fauxRegistryFor(home, [["faux-activation", core]]);
      const resourceLoaders: pi.DefaultResourceLoader[] = [];
      installHostCreateAgentSession((options) => {
        resourceLoaders.push(options?.resourceLoader as pi.DefaultResourceLoader);
        return pi.createAgentSession(options);
      }, host);
      assert.ok(host.createCodemodeExtension);
      const injectedLoader = new pi.DefaultResourceLoader({
        cwd: home,
        agentDir: home,
        noExtensions: true,
        additionalExtensionPaths: ["builtin:codemode"],
        extensionFactories: [
          { name: "codemode", ...{ builtin: true }, factory: host.createCodemodeExtension({ models: false }) },
        ],
      });
      await injectedLoader.reload();
      const builtin = ["builtin:codemode"];
      const cases: {
        allowlist?: string[];
        defaultTools?: string[];
        excluded?: boolean;
        session?: Partial<pi.CreateAgentSessionOptions>;
        active: boolean;
      }[] = [
        { defaultTools: ["+codemode"], active: false },
        { allowlist: [], defaultTools: ["+codemode"], active: false },
        { allowlist: ["codemode"], defaultTools: ["+codemode"], active: false },
        { allowlist: builtin, active: true },
        { allowlist: builtin, defaultTools: ["-codemode"], active: true },
        { allowlist: [" BUILTIN:CODEMODE ", "builtin:codemode"], defaultTools: ["+codemode"], active: true },
        { allowlist: builtin, excluded: true, active: false },
        { allowlist: builtin, session: { excludeTools: ["codemode"] }, active: false },
        { allowlist: builtin, session: { noTools: "all" }, active: false },
        { allowlist: builtin, session: { noTools: "builtin" }, active: true },
        { allowlist: builtin, session: { tools: [] }, active: false },
        { allowlist: builtin, session: { tools: ["read"] }, active: false },
        { allowlist: builtin, session: { tools: ["read", "codemode"] }, active: true },
        { allowlist: builtin, session: { resourceLoader: injectedLoader }, active: false },
      ];
      for (const { allowlist, defaultTools, excluded, session, active } of cases) {
        let requests = 0;
        core.setResponses([
          (context) => {
            requests++;
            const names = requestToolNames(context);
            assert.equal(names.filter((name) => name === "codemode").length, active ? 1 : 0);
            assert.ok(!names.includes("tool_search"));
            return fauxAssistantMessage("checked");
          },
        ]);
        const agent = new WorkflowAgent({
          cwd: home,
          modelRegistry: registry,
          providerMiddlewareExtensions: allowlist ? [...allowlist] : undefined,
          excludeTools: excluded ? ["codemode"] : [],
          session: { settingsManager: pi.SettingsManager.inMemory({ defaultTools }), ...session },
        });
        assert.equal(await agent.run("task", { model: "faux-activation/model" }), "checked");
        assert.equal(requests, 1);
        assert.deepEqual(
          resourceLoaders
            .at(-1)
            ?.getExtensions()
            .extensions.map((entry) => entry.path),
          allowlist?.some((name) => name.trim().toLowerCase() === "builtin:codemode") ? ["builtin:codemode"] : [],
        );
      }
      const dir = join(home, ".pi", "agent", "extensions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "competing.js"),
        `export default pi => {
          const tool = {
            name: "codemode", label: "competing", description: "conflicting tool",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ content: [{ type: "text", text: "file-only" }], details: {} })
          };
          pi.registerTool(tool);
          pi.registerTool({ ...tool, name: "file_inactive", defaultActive: false });
        };`,
      );
      const conflict = new WorkflowAgent({
        cwd: home,
        modelRegistry: registry,
        providerMiddlewareExtensions: ["competing", "builtin:codemode"],
      });
      const before = resourceLoaders.length;
      await assert.rejects(conflict.run("task", { model: "faux-activation/model" }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /builtin:codemode.*conflicting tool/);
        assert.doesNotMatch(error.message, /legacy|wrapper/);
        return true;
      });
      assert.equal(resourceLoaders.length, before, "fail before session creation");
      core.setResponses([
        (context) => {
          assert.ok(requestToolNames(context).includes("codemode"));
          assert.ok(!requestToolNames(context).includes("file_inactive"));
          return code("ignored by file tool");
        },
        (context) => {
          assert.match(JSON.stringify(context.messages), /file-only/);
          return fauxAssistantMessage("file config unchanged");
        },
      ]);
      assert.equal(
        await new WorkflowAgent({
          cwd: home,
          modelRegistry: registry,
          providerMiddlewareExtensions: ["competing"],
        }).run("task", { model: "faux-activation/model" }),
        "file config unchanged",
      );
    });
  } finally {
    installHostCreateAgentSession(pi.createAgentSession);
    rmSync(home, { recursive: true, force: true });
  }
});

test("real child codemode isolates concurrent tools, stores, parent, and model APIs", {
  skip: !capable,
  timeout: 30_000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-builtin-isolation-"));
  const cores = ["parent", "first", "second"].map((provider) =>
    createFauxCore({ provider, models: [{ id: "model" }] }),
  );
  let parentSession: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | undefined;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistryFor(
        home,
        cores.map((core, i) => [["parent", "first", "second"][i], core] as const),
      );
      const runtime = runtimeOf(registry) as pi.ModelRuntime;
      let modelCalls = 0;
      Object.assign(runtime, {
        classify: () => {
          modelCalls++;
          throw new Error("classifier must not run");
        },
        generateImages: () => {
          modelCalls++;
          throw new Error("image model must not run");
        },
      });
      let parentCalls = 0;
      const settingsManager = pi.SettingsManager.inMemory();
      assert.ok(host.createCodemodeExtension);
      const parentLoader = new pi.DefaultResourceLoader({
        cwd: home,
        agentDir: home,
        noExtensions: true,
        additionalExtensionPaths: ["builtin:codemode"],
        extensionFactories: [
          { name: "codemode", ...{ builtin: true }, factory: host.createCodemodeExtension({ models: false }) },
        ],
      });
      await parentLoader.reload();
      ({ session: parentSession } = await pi.createAgentSession({
        cwd: home,
        modelRuntime: runtime,
        model: registry.find("parent", "model"),
        sessionManager: pi.SessionManager.inMemory(home),
        settingsManager,
        resourceLoader: parentLoader,
        customTools: [
          sentinel("parent_only", () => {
            parentCalls++;
            return "parent sentinel";
          }),
        ],
      }));
      await parentSession.bindExtensions({});
      const parentTools = parentSession.getActiveToolNames();
      assert.ok(!parentTools.includes("codemode"));
      parentSession.setActiveToolsByName([...parentTools, "codemode"]);
      cores[0].setResponses([
        code('store("owner", "parent"); text(await tools.parent_only({}));'),
        (context) => {
          assert.match(toolOutputs(context), /parent sentinel/);
          return fauxAssistantMessage("parent ready");
        },
      ]);
      await parentSession.prompt("initialize parent");
      assert.equal(parentCalls, 1);
      parentSession.setActiveToolsByName(parentTools);
      cores[1].setResponses([fauxAssistantMessage("no opt-in")]);
      installHostCreateAgentSession((options) => {
        assert.deepEqual(options?.resourceLoader?.getExtensions().extensions, []);
        return pi.createAgentSession(options);
      }, host);
      assert.equal(
        await new WorkflowAgent({ cwd: home, modelRegistry: registry, session: { settingsManager } }).run("task", {
          model: "first/model",
        }),
        "no opt-in",
      );

      const childLoaders: pi.DefaultResourceLoader[] = [];
      installHostCreateAgentSession((options) => {
        childLoaders.push(options?.resourceLoader as pi.DefaultResourceLoader);
        return pi.createAgentSession(options);
      }, host);
      let deniedCalls = 0;
      let arrivals = 0;
      const denied = [
        "parent_only",
        "workflow",
        "workflow_control",
        "configured_denied",
        "session_denied",
        "policy_denied",
        "deferred_denied",
        "read",
        "bash",
        "powershell",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "tool_search",
      ];
      const suppliedDenied = [
        "workflow",
        "workflow_control",
        "configured_denied",
        "session_denied",
        "policy_denied",
        "deferred_denied",
      ].map(
        (name) =>
          ({
            ...sentinel(name, () => {
              deniedCalls++;
              return "UNSAFE";
            }),
            ...{ exposure: name === "deferred_denied" ? "deferred" : "codemode" },
          }) as pi.ToolDefinition,
      );
      const agent = new WorkflowAgent({
        cwd: home,
        modelRegistry: registry,
        providerMiddlewareExtensions: ["builtin:codemode", " BUILTIN:CODEMODE "],
        tools: suppliedDenied,
        excludeTools: ["configured_denied"],
        session: { settingsManager, excludeTools: ["session_denied"] },
      });
      const calls: string[] = [];
      await Promise.all(
        ["first", "second"].map(async (name, index) => {
          const source = `
          if (typeof models !== "undefined") throw new Error("models exposed");
          for (const method of ["classify", "generateImages"]) {
            try { await models[method]({}, {}); throw new Error("model API reachable"); }
            catch (error) { if (!(error instanceof ReferenceError)) throw error; }
          }
          if (load("owner") !== undefined) throw new Error("inherited codemode store");
          store("owner", ${JSON.stringify(name)});
          const matches = await searchTools("child_sentinel", { limit: 100 });
          if (!matches.some(t => t.name === "child_sentinel")) throw new Error("missing search result");
          if (!(await describeTool("child_sentinel"))) throw new Error("missing description");
          for (const name of ${JSON.stringify(denied)}) {
            if (ALL_TOOLS.some(t => t.name === name) || matches.some(t => t.name === name) || await describeTool(name)) throw new Error("discovered " + name);
            let failed = false;
            try { await tools[name]({}); } catch { failed = true; }
            if (!failed) throw new Error("called " + name);
          }
          text(await tools.child_sentinel({}));
        `;
          cores[index + 1].setResponses([
            (context) => {
              assert.ok(requestToolNames(context).includes("codemode"), "opt-in must activate without defaultTools");
              return code(source);
            },
            (context) => {
              assert.match(toolOutputs(context), new RegExp(`sentinel-${name}`));
              return code(
                `if (load("owner") !== ${JSON.stringify(name)}) throw new Error("cross-child state"); text("state-${name}");`,
              );
            },
            (context) => {
              assert.match(toolOutputs(context), new RegExp(`state-${name}`));
              return fauxAssistantMessage(`done-${name}`);
            },
          ]);
          assert.equal(
            await agent.run("task", {
              model: `${name}/model`,
              thread: name,
              // Exclusions, rather than this allowlist, must remove these names.
              toolNames: [
                "child_sentinel",
                "workflow",
                "workflow_control",
                "configured_denied",
                "session_denied",
                "deferred_denied",
              ],
              disallowedToolNames: ["deferred_denied"],
              tools: [
                sentinel("child_sentinel", async () => {
                  calls.push(name);
                  if (++arrivals === 2) release();
                  await barrier;
                  return `sentinel-${name}`;
                }),
              ],
            }),
            `done-${name}`,
          );
        }),
      );
      assert.deepEqual(calls.sort(), ["first", "second"]);
      assert.equal(deniedCalls, 0);
      assert.equal(modelCalls, 0);
      assert.equal(parentCalls, 1);
      assert.equal(childLoaders.length, 2);
      assert.notEqual(childLoaders[0].getExtensions().runtime, childLoaders[1].getExtensions().runtime);
      assert.notEqual(childLoaders[0].getExtensions().runtime, parentLoader.getExtensions().runtime);
      for (const loader of childLoaders)
        assert.deepEqual(
          loader.getExtensions().extensions.map((e) => e.path),
          ["builtin:codemode"],
        );
      cores[0].setResponses([
        code(
          'if (load("owner") !== "parent") throw new Error("parent state changed"); text(await tools.parent_only({}));',
        ),
        (context) => {
          toolOutputs(context);
          return fauxAssistantMessage("parent still works");
        },
      ]);
      assert.deepEqual(
        parentSession.getActiveToolNames(),
        parentTools,
        "child activation must not change parent tools",
      );
      assert.equal(settingsManager.getDefaultTools(), undefined, "child activation must not mutate shared settings");
      parentSession.setActiveToolsByName([...parentTools, "codemode"]);
      await parentSession.prompt("check parent again");
      assert.equal(parentCalls, 2);
    });
  } finally {
    release();
    parentSession?.dispose();
    installHostCreateAgentSession(pi.createAgentSession);
    rmSync(home, { recursive: true, force: true });
  }
});

test("codemode coding policy preserves store/schema exemptions but not explicit exclusions", {
  skip: !capable,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-builtin-system-tools-"));
  const store = new SharedStore();
  try {
    await withFakeHomeAsync(home, async () => {
      const core = createFauxCore({ provider: "faux-system", models: [{ id: "model" }] });
      const registry = await fauxRegistryFor(home, [["faux-system", core]]);
      core.setResponses([
        code(`
        await tools.store_put({ key: "sentinel", value: 42 });
        text(await tools.store_get({ key: "sentinel" }));
        if (await describeTool("explicitly_denied")) throw new Error("system exemption beat exclusion");
        await tools.structured_output({ ok: true });
      `),
        (context) => {
          assert.match(toolOutputs(context), /42/);
          return fauxAssistantMessage("done");
        },
      ]);
      const agent = new WorkflowAgent({
        cwd: home,
        modelRegistry: registry,
        providerMiddlewareExtensions: ["builtin:codemode"],
        excludeTools: ["explicitly_denied"],
        session: { settingsManager: pi.SettingsManager.inMemory() },
      });
      assert.deepEqual(
        await agent.run("task", {
          model: "faux-system/model",
          schema: Type.Object({ ok: Type.Boolean() }),
          toolNames: ["read"],
          disallowedToolNames: ["store_put", "store_get", "structured_output"],
          systemTools: [
            ...createAgentStoreTools(store, "child"),
            sentinel("explicitly_denied", () => {
              throw new Error("excluded system tool ran");
            }),
          ],
        }),
        { ok: true },
      );
      assert.equal(store.get("sentinel"), 42);
      core.setResponses([
        code(`
        if (await describeTool("sdk_denied")) throw new Error("SDK override bypassed policy");
        let blocked = false;
        try { await tools.sdk_denied({}); } catch { blocked = true; }
        if (!blocked) throw new Error("SDK denied tool ran");
        text(await tools.sdk_allowed({}));
      `),
        (context) => {
          assert.match(toolOutputs(context), /sdk_allowed/);
          return fauxAssistantMessage("SDK override checked");
        },
      ]);
      assert.equal(
        await new WorkflowAgent({
          cwd: home,
          modelRegistry: registry,
          providerMiddlewareExtensions: ["builtin:codemode"],
          session: {
            settingsManager: pi.SettingsManager.inMemory(),
            customTools: [
              sentinel("sdk_allowed"),
              {
                ...sentinel("sdk_denied", () => {
                  throw new Error("denied SDK tool ran");
                }),
                ...{ exposure: "deferred" },
              } as pi.ToolDefinition,
            ],
          },
        }).run("task", { model: "faux-system/model", toolNames: ["sdk_allowed"] }),
        "SDK override checked",
      );
    });
  } finally {
    store.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
