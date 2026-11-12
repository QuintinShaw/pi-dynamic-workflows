import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";
import { findBuiltinWorkflow } from "../src/builtin-workflows.js";
import { createBuiltinWebTools, createWebTools } from "../src/web-tools.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { fauxRegistry } from "./helpers/faux-registry.js";

test("built-in web fallbacks yield only to opted-in child extension tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-precedence-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-precedence-cwd-"));
  const extensionDir = join(home, ".pi", "agent", "extensions");
  const log = join(home, "calls.log");
  const provider = "fauxtest-web-precedence";
  const core = createFauxCore({
    provider,
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, "web-adapter.js"),
      `
      import { appendFileSync } from "node:fs";
      export default function (pi) {
        pi.on("tool_call", (event) => { appendFileSync(${JSON.stringify(log)}, "hook:" + event.toolName + "\\n"); });
        pi.registerTool({
          name: "web_search", label: "Extension Search", description: "Extension search sentinel",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          async execute() { appendFileSync(${JSON.stringify(log)}, "extension\\n"); return { content: [{ type: "text", text: "extension result" }] }; }
        });
        pi.registerTool({
          name: "extra_web_tool", label: "Extra", description: "Extra extension tool",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "extra" }] }; }
        });
      }
    `,
    );
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, provider, core);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = String(input);
        return new Response(
          url.includes("bing.com")
            ? '<h2><a href="https://example.com/">Built-in result</a></h2>'
            : "<p>Built-in fetch result</p>",
        );
      };
      try {
        const run = async (tools: ToolDefinition[], optedIn: boolean, excluded: string[] = []) => {
          const contexts: unknown[] = [];
          core.setResponses([
            (context) => {
              contexts.push(context);
              return fauxAssistantMessage(fauxToolCall("web_search", { query: "test" }), { stopReason: "toolUse" });
            },
            (context) => {
              contexts.push(context);
              return fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.com/" }), {
                stopReason: "toolUse",
              });
            },
            (context) => {
              contexts.push(context);
              return fauxAssistantMessage("done", { stopReason: "stop" });
            },
          ]);
          const agent = new WorkflowAgent({
            cwd,
            tools,
            modelRegistry: registry,
            providerMiddlewareExtensions: optedIn ? ["web-adapter"] : [],
            excludeTools: excluded,
          });
          await agent.run("test web tools", { model: `${provider}/faux-model` });
          return contexts;
        };
        const initial = await run(createBuiltinWebTools(), false);
        assert.match(JSON.stringify(initial), /Built-in result/);
        assert.match(JSON.stringify(initial), /Built-in fetch result/);
        assert.doesNotMatch(JSON.stringify(initial), /extra_web_tool/);

        const invocation = findBuiltinWorkflow("deep-research")?.resolve(cwd, { question: "test" });
        assert.equal(invocation?.toolset, "web-research");
        assert.ok(invocation?.tools);
        for (const tools of [invocation.tools, createBuiltinWebTools()]) {
          writeFileSync(log, "");
          const contexts = await run(tools, true);
          const serialized = JSON.stringify(contexts);
          assert.match(serialized, /extension result/);
          assert.match(serialized, /Built-in fetch result/);
          assert.match(serialized, /extra_web_tool/);
          assert.match(readFileSync(log, "utf8"), /hook:web_search\nextension/);
        }
        writeFileSync(log, "");
        const explicit = await run(createWebTools(), true);
        assert.match(JSON.stringify(explicit), /Built-in result/);
        assert.doesNotMatch(readFileSync(log, "utf8"), /extension\n/);

        const contexts: unknown[] = [];
        core.setResponses([
          (context) => {
            contexts.push(context);
            return fauxAssistantMessage("done", { stopReason: "stop" });
          },
        ]);
        const excludedAgent = new WorkflowAgent({
          cwd,
          tools: createBuiltinWebTools(),
          modelRegistry: registry,
          providerMiddlewareExtensions: ["web-adapter"],
          excludeTools: ["web_search"],
        });
        await excludedAgent.run("inspect available tools", { model: `${provider}/faux-model` });
        assert.doesNotMatch(JSON.stringify(contexts), /web_search/);
        assert.match(JSON.stringify(contexts), /web_fetch/);
        assert.match(JSON.stringify(contexts), /extra_web_tool/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cold resume re-resolves the built-in web toolset and runs the extension search", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-resume-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-resume-cwd-"));
  const extensionDir = join(home, ".pi", "agent", "extensions");
  const log = join(home, "calls.log");
  const provider = "fauxtest-web-resume";
  const core = createFauxCore({
    provider,
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, "web-adapter.js"),
      `
      import { appendFileSync } from "node:fs";
      export default function (pi) {
        pi.on("tool_call", (event) => { appendFileSync(${JSON.stringify(log)}, "hook:" + event.toolName + "\\n"); });
        pi.registerTool({
          name: "web_search", label: "Extension Search", description: "Extension search sentinel",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          async execute() { appendFileSync(${JSON.stringify(log)}, "extension\\n"); return { content: [{ type: "text", text: "cold resume search result" }] }; }
        });
      }
    `,
    );
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, provider, core);
      const invocation = findBuiltinWorkflow("deep-research")?.resolve(cwd, { question: "test" });
      assert.ok(invocation?.tools);
      assert.equal(invocation.toolset, "web-research");
      const child = new WorkflowAgent({
        cwd,
        tools: invocation.tools,
        modelRegistry: registry,
        providerMiddlewareExtensions: ["web-adapter"],
      });
      const script = `export const meta = { name: 'resume_web_test', description: 'cold resume' }
const first = await agent('first', { label: 'first', model: '${provider}/faux-model' })
const second = await agent('second', { label: 'second', model: '${provider}/faux-model' })
return { first, second }`;
      let signalSecondStarted: () => void = () => {};
      const secondStarted = new Promise<void>((resolve) => {
        signalSecondStarted = resolve;
      });
      let firstCalls = 0;
      const firstManager = new WorkflowManager({
        cwd,
        agent: {
          async run(prompt, options) {
            if (prompt === "first") {
              firstCalls++;
              return child.run(prompt, options);
            }
            signalSecondStarted();
            return new Promise((_resolve, reject) => {
              if (options?.signal?.aborted) reject(new Error("paused"));
              else options?.signal?.addEventListener("abort", () => reject(new Error("paused")), { once: true });
            });
          },
        },
      });
      core.setResponses([fauxAssistantMessage("first complete", { stopReason: "stop" })]);
      const { runId, promise } = firstManager.startInBackground(script, undefined, {
        tools: invocation.tools,
        toolset: invocation.toolset,
      });
      await secondStarted;
      assert.equal(firstManager.pause(runId), true);
      await promise.catch(() => {});
      const paused = firstManager.getPersistence().load(runId);
      assert.equal(paused?.status, "paused");
      assert.equal(paused?.toolset, "web-research");
      assert.equal(paused?.agents.find((agent) => agent.prompt === "first")?.status, "done");

      const contexts: unknown[] = [];
      core.setResponses([
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage(fauxToolCall("web_search", { query: "resumed" }), { stopReason: "toolUse" });
        },
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("second complete", { stopReason: "stop" });
        },
      ]);
      let toolsetResolutions = 0;
      const freshManager = new WorkflowManager({
        cwd,
        modelRegistry: registry,
        providerMiddlewareExtensions: ["web-adapter"],
        toolsets: {
          "web-research": () => {
            toolsetResolutions++;
            return createBuiltinWebTools();
          },
        },
      });
      assert.equal(await freshManager.resume(runId), true);
      for (let i = 0; i < 500 && freshManager.getRun(runId)?.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const resumed = freshManager.getPersistence().load(runId);
      assert.equal(resumed?.status, "completed");
      assert.equal(toolsetResolutions, 1);
      assert.equal(firstCalls, 1);
      assert.match(JSON.stringify(contexts), /Task label: second/);
      assert.doesNotMatch(JSON.stringify(contexts), /Task label: first/);
      assert.match(JSON.stringify(contexts), /cold resume search result/);
      assert.match(readFileSync(log, "utf8"), /hook:web_search\nextension/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
