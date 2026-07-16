import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { backgroundStartedText, createWorkflowTool, modelRoutingGuideline } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Minimal fake ModelRegistry, matching the shape the PR's existing tests use. */
function fakeRegistry(models: Array<{ provider: string; id: string }>) {
  return {
    getAvailable: () => models,
    find: () => undefined,
    getAll: () => models,
  } as any;
}

// ─── backgroundStartedText ─────────────────────────────────────────────────────

test("backgroundStartedText tells the user it auto-continues and they can wait", () => {
  const text = backgroundStartedText("audit", "abc-123");
  assert.match(text, /audit/);
  assert.match(text, /abc-123/);
  assert.match(text, /wait here/i);
  assert.match(text, /continues automatically|resume the conversation/i);
  assert.match(text, /other things/i);
  assert.match(text, /\/workflows status abc-123/);
});

// ─── createWorkflowTool ────────────────────────────────────────────────────────

test("createWorkflowTool has correct name and label", () => {
  const tool = createWorkflowTool();
  assert.equal(tool.name, "workflow");
  assert.equal(tool.label, "Workflow");
});

test("createWorkflowTool has description", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.description.length > 20, "tool.description should be more than 20");
});

test("createWorkflowTool has parameters defined", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.parameters, "should have parameters schema");
});

test("createWorkflowTool has execute function", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWorkflowTool has renderCall and renderResult", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("createWorkflowTool has promptSnippet", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.promptSnippet.includes("workflow"), "should contain workflow");
});

test("createWorkflowTool has promptGuidelines array", () => {
  const tool = createWorkflowTool();
  assert.ok(Array.isArray(tool.promptGuidelines), "tool.promptGuidelines should be an array");
  assert.ok(tool.promptGuidelines.length > 5, "should have several guidelines");
});

test("createWorkflowTool routes normal work through tiers and reserves exact models for user requests", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");

  assert.match(all, /opts\.tier/);
  assert.match(all, /small.+medium.+big/s);
  assert.match(all, /opts\.model only when the user names/i);
});

test("createWorkflowTool promptGuidelines keep budget and timeout unbounded by default", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");
  assert.match(all, /do not set tokenBudget or agentTimeoutMs/i);
  assert.match(all, /defaults are unbounded/i);
});

test("createWorkflowTool schema describes unbounded default timeout", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };
  const description = parameters.properties?.agentTimeoutMs?.description ?? "";
  assert.match(description, /Omit for no hard timeout/i);
  assert.match(description, /only when the user asks/i);
});

test("createWorkflowTool schema exposes concurrency and agentRetries", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };

  assert.match(parameters.properties?.concurrency?.description ?? "", /Maximum concurrent agents/i);
  assert.match(parameters.properties?.agentRetries?.description ?? "", /Retry attempts/i);
});

test("createWorkflowTool promptGuidelines mention retry and concurrency controls", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");

  assert.match(all, /low concurrency/i);
  assert.match(all, /agentRetries/i);
  assert.match(all, /null handling/i);
});

// ─── modelRoutingGuideline ──────────────────────────────────────────────────────

test("modelRoutingGuideline mentions all three tier names", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("small"), "should mention small tier");
  assert.ok(text.includes("medium"), "should mention medium tier");
  assert.ok(text.includes("big"), "should mention big tier");
});

test("modelRoutingGuideline describes each tier purpose", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("lightweight"), "should contain lightweight");
  assert.ok(text.includes("balanced"), "should contain balanced");
  assert.ok(text.includes("synthesis"), "should contain synthesis");
});

test("modelRoutingGuideline explains tier vs model priority", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("opts.tier"), "should mention opts.tier");
  assert.ok(text.includes("opts.model"), "should mention opts.model");
  assert.ok(
    /opts\.(tier|model).+opts\.(model|tier)/.test(text),
    "should explain ordering / relationship between tier and model",
  );
});

test("modelRoutingGuideline explains when to use each option", () => {
  const text = modelRoutingGuideline();
  assert.ok(/small.*(exploration|search|inventory|agents)/i.test(text), "small tier should mention light workloads");
  assert.ok(/big.*(synthesis|judgment|decision)/i.test(text), "big tier should mention heavy reasoning");
});

test("createWorkflowTool invalid args throws descriptive error", () => {
  const tool = createWorkflowTool();
  // We can test prepareArguments through the tool definition
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => unknown;
    assert.throws(() => prepare({ script: 123 }), /script.*string/);
    assert.throws(() => prepare("not-an-object"), /object argument/);
  }
});

test("createWorkflowTool with custom cwd creates tool", () => {
  const tool = createWorkflowTool({ cwd: "/tmp" });
  assert.equal(tool.name, "workflow");
});

test("createWorkflowTool does not add configured model IDs to promptGuidelines", () => {
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "private-model" }]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });

  assert.doesNotMatch(tool.promptGuidelines.join(" "), /router\/private-model/);

  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "later-private-model" }]));
  assert.doesNotMatch(tool.promptGuidelines.join(" "), /router\/later-private-model/);
});

test("modelRoutingGuideline output is non-empty and well-formed", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.length > 50, "should be a substantial instruction");
  assert.ok(text.endsWith(".") || text.endsWith("") || text.endsWith("`"), "should end properly");
  assert.ok(!text.includes("undefined"), "no undefined interpolation");
  assert.ok(!text.includes("[object Object]"), "no object serialization leaks");
});

// ─── prepareArguments / normalizeWorkflowScript ─────────────────────────────────

test("createWorkflowTool prepareArguments strips markdown fences from script", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```js\nconst x = 1\n```",
    });
    assert.equal(result.script, "const x = 1");
  }
});

test("createWorkflowTool prepareArguments strips javascript fences", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```\nexport const meta = { name: 't', description: 't' }\n```",
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
  }
});

test("createWorkflowTool prepareArguments passes through args", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => {
      script: string;
      args?: unknown;
      maxAgents?: number;
      concurrency?: number;
      agentRetries?: number;
    };
    const result = prepare({
      script: "export const meta = { name: 't', description: 't' }",
      args: { question: "test" },
      maxAgents: 5,
      concurrency: 2,
      agentRetries: 1,
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
    assert.deepEqual(result.args, { question: "test" });
    assert.equal(result.maxAgents, 5);
    assert.equal(result.concurrency, 2);
    assert.equal(result.agentRetries, 1);
  }
});

// ─── resumeFromRunId (edited-script iteration) ─────────────────────────────────

const resumeToolScript = `export const meta = { name: 'resume_tool', description: 'one agent' }
const a = await agent('do it', { label: 'a' })
return { a }`;

function toolFakeAgent(result: unknown = "ok") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      return result;
    },
  };
}

function deferredToolAgent() {
  let resolveFn: ((v: unknown) => void) | null = null;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  return {
    resolve: (v: unknown = "done") => resolveFn?.(v),
    runner: {
      async run() {
        return promise;
      },
    },
  };
}

function withToolTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tool-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-tool-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test("workflowToolSchema exposes resumeFromRunId as optional; script stays required", () => {
  const tool = createWorkflowTool();
  const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.resumeFromRunId, "resumeFromRunId should be a schema property");
  assert.ok((schema.required ?? []).includes("script"), "script stays required");
  assert.ok(!(schema.required ?? []).includes("resumeFromRunId"), "resumeFromRunId is optional");
});

test(
  "workflow tool: resumeFromRunId pointing at a nonexistent run errors and creates no new run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () =>
        tool.execute(
          "t1",
          { script: resumeToolScript, resumeFromRunId: "no-such-run" },
          undefined,
          undefined,
          undefined,
        ),
      /no run with that ID|not found/i,
    );
    assert.equal(manager.listRuns().length, 0, "no new run should be created on a failed resume");
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a completed run errors clearly",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    // Create + complete a run.
    const { runId, promise } = manager.startInBackground(resumeToolScript);
    await promise;
    assert.equal(manager.getRun(runId)?.status, "completed");
    await assert.rejects(
      () => tool.execute("t2", { script: resumeToolScript, resumeFromRunId: runId }, undefined, undefined, undefined),
      /already completed/i,
    );
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a running run errors clearly",
  withToolTempCwd(async (cwd) => {
    const da = deferredToolAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const { runId, promise } = manager.startInBackground(resumeToolScript);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager.getRun(runId)?.status, "running");
    await assert.rejects(
      () => tool.execute("t3", { script: resumeToolScript, resumeFromRunId: runId }, undefined, undefined, undefined),
      /still running/i,
    );
    da.resolve("ok");
    await promise.catch(() => {});
  }),
);

test(
  "workflow tool: omitting resumeFromRunId preserves new-run background behavior",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute("t4", { script: resumeToolScript }, undefined, undefined, undefined);
    const details = res.details as { runId?: string; background?: boolean; resumedFrom?: string };
    assert.ok(details.runId, "a new run id should be returned");
    assert.equal(details.background, true);
    assert.equal(details.resumedFrom, undefined, "a fresh run is not a resume");
    assert.equal(manager.listRuns().length, 1, "exactly one new run created");
    // The returned text advertises the revise/iterate path.
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.match(text, /resumeFromRunId/, "background text tells the model how to iterate");
  }),
);

test(
  "workflow tool: resumeFromRunId resumes a paused run with the edited script",
  withToolTempCwd(async (cwd) => {
    const seen: string[] = [];
    let failSecond = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          seen.push(prompt);
          if (prompt.includes("SECOND-ORIG") && failSecond) {
            throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
              recoverable: false,
              resetHint: "soon",
            });
          }
          return `ran:${prompt}`;
        },
      },
    });
    manager.on("paused", () => {});
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });

    const v1 = `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-ORIG', { label: 'second' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(v1);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    failSecond = false;
    const v2 = `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-EDITED', { label: 'second' })
return { a, b }`;
    const seenBefore = seen.length;
    const res = await tool.execute("t5", { script: v2, resumeFromRunId: runId }, undefined, undefined, undefined);
    const details = res.details as { runId?: string; resumedFrom?: string };
    assert.equal(details.runId, runId, "resumed run keeps the same run id");
    assert.equal(details.resumedFrom, runId);
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.match(text, new RegExp(`resumed from run ${runId}`), "text names the resumed run");

    await new Promise((r) => setTimeout(r, 80));
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed");
    assert.equal(finalRun?.result?.result?.b, "ran:SECOND-EDITED");
    const during = seen.slice(seenBefore);
    assert.ok(!during.includes("FIRST"), "unchanged agent 1 replays from journal");
    assert.ok(during.includes("SECOND-EDITED"), "edited agent 2 re-runs live");
    // No extra run created — resume reuses the same id.
    assert.equal(manager.listRuns().length, 1, "resume does not create a second run");
  }),
);
