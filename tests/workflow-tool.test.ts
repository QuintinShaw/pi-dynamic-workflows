import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { resolveWorkflowScriptPath } from "../src/workflow.js";
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

test("workflow tool accepts exactly one fresh, cwd-contained scriptPath source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-tool-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-dw-tool-outside-"));
  try {
    const script = "export const meta = { name: 'path-workflow', description: 'path workflow' }\nreturn args";
    const scriptPath = join(root, "workflow.js");
    writeFileSync(scriptPath, script);
    const captured: Array<{ script: string; args: unknown; cwd?: string }> = [];
    const manager = {
      getModelRegistry: () => undefined,
      startInBackground(source: string, args: unknown, options?: { cwd?: string }) {
        captured.push({ script: source, args, cwd: options?.cwd });
        return { runId: "run-path", promise: Promise.resolve({}) };
      },
    } as any;
    const tool = createWorkflowTool({ cwd: root, manager });
    const execute = tool.execute as any;

    await execute("call", { scriptPath: "workflow.js", args: { fresh: true } }, undefined, undefined, { cwd: root });
    assert.deepEqual(captured, [{ script, args: { fresh: true }, cwd: root }]);
    writeFileSync(scriptPath, script.replace("path-workflow", "updated-workflow"));
    await execute("call", { scriptPath: "workflow.js", args: { fresh: false } }, undefined, undefined, { cwd: root });
    assert.equal(captured[1]?.script, script.replace("path-workflow", "updated-workflow"));

    const outsidePath = join(outside, "outside.js");
    writeFileSync(outsidePath, script);
    const invalid = [
      [{ script: script, scriptPath: "workflow.js" }, /exactly one/],
      [{}, /exactly one/],
      [{ scriptPath: "   " }, /non-empty/],
      [{ scriptPath: "missing.js" }, /does not exist/],
      [{ scriptPath: relative(root, outsidePath) }, /escapes workflow cwd/],
    ] as const;
    for (const [params, message] of invalid) {
      await assert.rejects(() => execute("call", params, undefined, undefined, { cwd: root }), message);
    }

    mkdirSync(join(root, "directory"));
    await assert.rejects(
      () => execute("call", { scriptPath: "directory" }, undefined, undefined, { cwd: root }),
      /must reference a file/,
    );
    symlinkSync(outsidePath, join(root, "linked.js"));
    await assert.rejects(
      () => execute("call", { scriptPath: "linked.js" }, undefined, undefined, { cwd: root }),
      /escapes workflow cwd/,
    );
    symlinkSync(scriptPath, join(root, "internal-link.js"));
    await assert.rejects(
      () => execute("call", { scriptPath: "internal-link.js" }, undefined, undefined, { cwd: root }),
      /symlink/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("scriptPath rejects deterministic path replacement between validation and open", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-script-race-"));
  try {
    const scriptPath = join(root, "workflow.js");
    const replacementPath = join(root, "replacement.js");
    const originalPath = join(root, "original.js");
    writeFileSync(scriptPath, "original");
    writeFileSync(replacementPath, "replacement");

    assert.throws(
      () =>
        (resolveWorkflowScriptPath as any)("workflow.js", root, {
          openSync(path: string, flags: number) {
            renameSync(scriptPath, originalPath);
            renameSync(replacementPath, scriptPath);
            return openSync(path, flags);
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.match(error.message, /changed during secure open/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scriptPath closes its descriptor after a successful secure read", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-script-close-"));
  try {
    writeFileSync(join(root, "workflow.js"), "contents");
    let closes = 0;
    const resolved = (resolveWorkflowScriptPath as any)("workflow.js", root, {
      closeSync(fd: number) {
        closes++;
        closeSync(fd);
      },
    });
    assert.equal(resolved.script, "contents");
    assert.equal(closes, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow tool reports SCRIPT_VALIDATION_ERROR when its cwd was deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-tool-deleted-cwd-"));
  const manager = {
    getModelRegistry: () => undefined,
    startInBackground() {
      assert.fail("manager must not start for an invalid cwd");
    },
  } as any;
  const execute = createWorkflowTool({ cwd: root, manager }).execute as any;
  rmSync(root, { recursive: true, force: true });

  await assert.rejects(
    () => execute("call", { scriptPath: "workflow.js" }, undefined, undefined, { cwd: root }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /workflow cwd does not exist/);
      return true;
    },
  );
});

test("workflow tool passes exact scriptPath source and args to foreground manager.runSync", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-tool-foreground-"));
  try {
    const script =
      "export const meta = { name: 'foreground-path', description: 'foreground path' }\n" +
      "await agent('preserve this source')\n  \n";
    writeFileSync(join(root, "workflow.js"), script);
    const args = { unchanged: true, nested: { value: "keep" } };
    const calls: Array<{ script: string; args: unknown; cwd?: string }> = [];
    const manager = {
      getModelRegistry: () => undefined,
      runSync(source: string, receivedArgs: unknown, options?: { cwd?: string }) {
        calls.push({ script: source, args: receivedArgs, cwd: options?.cwd });
        return Promise.resolve({
          meta: { name: "foreground-path", description: "foreground path" },
          result: { ok: true },
          logs: [],
          phases: [],
          agentCount: 1,
          durationMs: 1,
        });
      },
    } as any;
    const tool = createWorkflowTool({ cwd: root, manager });

    await (tool.execute as any)("call", { scriptPath: "workflow.js", args, background: false }, undefined, undefined, {
      cwd: root,
    });

    assert.deepEqual(calls, [{ script, args, cwd: root }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("createWorkflowTool schema exposes assistant resume and status controls", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };

  assert.match(parameters.properties?.action?.description ?? "", /run.*resume.*status/i);
  assert.match(parameters.properties?.runId?.description ?? "", /resume.*status/i);
});

test("workflow tool action arguments enforce run, resume, and status shapes", () => {
  const tool = createWorkflowTool();
  const prepare = tool.prepareArguments as (args: unknown) => unknown;

  assert.deepEqual(prepare({ action: "resume", runId: "paused-123", args: { riskAccepted: true } }), {
    action: "resume",
    runId: "paused-123",
    args: { riskAccepted: true },
  });
  assert.deepEqual(prepare({ action: "status", runId: "paused-123" }), {
    action: "status",
    runId: "paused-123",
  });
  assert.throws(
    () => prepare({ action: "resume", runId: "paused-123", script: "return 1" }),
    /must not include.*script/i,
  );
  assert.throws(() => prepare({ action: "status", runId: "paused-123", args: {} }), /must not include.*args/i);
  assert.throws(() => prepare({ action: "resume" }), /runId/i);
  assert.throws(() => prepare({ action: "run", runId: "paused-123", script: "return 1" }), /runId/i);
});

test("workflow tool resumes a persisted run with an optional args patch", async () => {
  const calls: unknown[][] = [];
  const manager = {
    getModelRegistry: () => undefined,
    async resume(...args: unknown[]) {
      calls.push(args);
      return true;
    },
    getRunForReport: () => ({ runId: "paused-123", workflowName: "audit", status: "paused" }),
  } as any;
  const tool = createWorkflowTool({ manager });

  const result = await (tool.execute as any)(
    "call",
    { action: "resume", runId: "paused-123", args: { riskAccepted: true } },
    undefined,
    undefined,
    {},
  );

  assert.deepEqual(calls, [["paused-123", { argsPatch: { riskAccepted: true } }]]);
  assert.match(result.content[0].text, /paused-123.*resumed/i);
  assert.deepEqual(result.details, { runId: "paused-123", background: true, resumed: true });
});

test("workflow tool reports why a run cannot be resumed", async () => {
  const manager = {
    getModelRegistry: () => undefined,
    resume: async () => false,
    getRunForReport: () => ({ runId: "done-123", workflowName: "audit", status: "completed" }),
  } as any;
  const tool = createWorkflowTool({ manager });

  await assert.rejects(
    () => (tool.execute as any)("call", { action: "resume", runId: "done-123" }, undefined, undefined, {}),
    /not resumable.*completed/i,
  );
});

test("workflow tool cold-resumes a persisted manager run end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-tool-resume-"));
  try {
    const runId = "cold-resume-123";
    const script = `export const meta = { name: 'cold-resume', description: 'cold resume' }
return await agent(JSON.stringify(args), { label: 'capture' })`;
    let prompt = "";
    const manager = new WorkflowManager({
      cwd: root,
      agent: {
        async run(value: string) {
          prompt = value;
          return "ok";
        },
      },
    });
    const now = new Date().toISOString();
    manager.getPersistence().save({
      runId,
      workflowName: "cold-resume",
      script,
      args: { keep: true },
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: now,
      updatedAt: now,
    });
    const completed = new Promise<void>((resolve) => {
      manager.on("complete", (event: { runId: string }) => {
        if (event.runId === runId) resolve();
      });
    });
    const tool = createWorkflowTool({ cwd: root, manager });

    await (tool.execute as any)("call", { action: "resume", runId, args: { added: 1 } }, undefined, undefined, {
      cwd: root,
    });
    await completed;

    assert.deepEqual(JSON.parse(prompt), { keep: true, added: 1 });
    const status = await (tool.execute as any)("call", { action: "status", runId }, undefined, undefined, {
      cwd: root,
    });
    assert.equal(status.details.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow tool rejects unsafe resume, status, and edit-resume run IDs before manager access", async () => {
  let accesses = 0;
  const manager = {
    getModelRegistry: () => undefined,
    getRun: () => {
      accesses++;
      return undefined;
    },
    getRunForReport: () => {
      accesses++;
      return null;
    },
    resume: async () => {
      accesses++;
      return false;
    },
  } as any;
  const tool = createWorkflowTool({ manager });
  const execute = tool.execute as any;

  for (const params of [
    { action: "resume", runId: "../escape" },
    { action: "status", runId: "a/b" },
    {
      script: "export const meta = { name: 'edit', description: 'edit' }\nreturn await agent('x')",
      resumeFromRunId: "bad\\id",
    },
  ]) {
    await assert.rejects(() => execute("call", params, undefined, undefined, {}), /Invalid workflow run ID/);
  }
  assert.equal(accesses, 0);
});

test("workflow tool status rejects an unknown run ID", async () => {
  const manager = {
    getModelRegistry: () => undefined,
    getRun: () => undefined,
    getRunForReport: () => null,
  } as any;
  const tool = createWorkflowTool({ manager });

  await assert.rejects(
    () => (tool.execute as any)("call", { action: "status", runId: "missing-123" }, undefined, undefined, {}),
    /missing-123.*not found/i,
  );
});

test("workflow tool reports persisted run status without requiring a script", async () => {
  const manager = {
    getModelRegistry: () => undefined,
    getRunForReport: () => ({
      runId: "paused-123",
      workflowName: "audit",
      status: "paused",
      currentPhase: "Review",
      phases: ["Plan", "Review"],
      agents: [{ status: "done" }, { status: "running" }],
      startedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:01:00.000Z",
    }),
  } as any;
  const tool = createWorkflowTool({ manager });

  const result = await (tool.execute as any)(
    "call",
    { action: "status", runId: "paused-123" },
    undefined,
    undefined,
    {},
  );

  assert.match(result.content[0].text, /audit.*paused/i);
  assert.deepEqual(result.details, {
    runId: "paused-123",
    workflowName: "audit",
    status: "paused",
    currentPhase: "Review",
    phases: ["Plan", "Review"],
    agentCount: 2,
    startedAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:01:00.000Z",
  });
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

test("workflowToolSchema exposes resumeFromRunId while action controls keep source fields optional", () => {
  const tool = createWorkflowTool();
  const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.resumeFromRunId, "resumeFromRunId should be a schema property");
  assert.ok(!(schema.required ?? []).includes("script"), "resume and status actions do not require a script");
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
