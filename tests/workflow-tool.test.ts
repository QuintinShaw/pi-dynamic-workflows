import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { BUILTIN_WORKFLOW_NAMES } from "../src/builtin-workflows.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { backgroundStartedText, createWorkflowTool, WORKFLOW_GATE_GUIDELINE } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Minimal fake ModelRegistry, matching the shape used by workflow manager tests. */
function fakeRegistry(models: Array<{ provider: string; id: string }>) {
  return {
    getAvailable: () => models,
    find: () => undefined,
    getAll: () => models,
  } as any;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parameterDescription(tool: ReturnType<typeof createWorkflowTool>, name: string): string {
  const parameters = tool.parameters;
  const properties = isRecord(parameters) && isRecord(parameters.properties) ? parameters.properties : {};
  const parameter = properties[name];
  return isRecord(parameter) && typeof parameter.description === "string" ? parameter.description : "";
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

test("createWorkflowTool description states its delegation capability", () => {
  const description = createWorkflowTool().description;

  assert.match(description, /JavaScript workflow.*delegates work to subagents/i);
  assert.match(description, /agent\(\).*optionally composing calls.*parallel\(\).*pipeline\(\)/i);
  assert.doesNotMatch(description, /deterministic|required raw JavaScript|export const meta/i);
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

test("createWorkflowTool promptSnippet describes delegation and optional composition", () => {
  const snippet = createWorkflowTool().promptSnippet;

  assert.match(snippet, /delegate substantive .* work to subagents/i);
  assert.match(snippet, /optionally composing agent calls/i);
  assert.match(snippet, /parallel\(\)/);
  assert.match(snippet, /pipeline\(\)/);
  assert.match(snippet, /or both/i);
  assert.doesNotMatch(snippet, /required script header|export const meta/i);
});

test("createWorkflowTool keeps permanent guidance to the single upstream gate", () => {
  const guidance = createWorkflowTool().promptGuidelines;

  assert.deepEqual(guidance, [WORKFLOW_GATE_GUIDELINE]);
  assert.match(guidance[0], /ONLY call it when the user explicitly opts in/i);
  assert.match(guidance[0], /you may briefly offer it \(with a rough cost\)/i);
  assert.doesNotMatch(guidance[0], /export const meta|parallel\(\) requires functions/i);
});

test("createWorkflowTool permanent guidance omits conditional catalogs and recipes", () => {
  const all = createWorkflowTool().promptGuidelines.join(" ");

  assert.doesNotMatch(all, /Available agentTypes:/i);
  assert.doesNotMatch(all, /currently available models/i);
  assert.doesNotMatch(all, /verify\(|judgePanel\(|loopUntilDry\(|completenessCheck\(/i);
  assert.doesNotMatch(all, /tokenBudget|agentTimeoutMs|agentRetries/i);
});

test("createWorkflowTool keeps script syntax in the parameter schema", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "script");

  assert.match(description, /raw JavaScript workflow script.*no Markdown fences/i);
  assert.match(description, /First statement: export const meta = \{ name:.*description:.*\}\. Add phases:/i);
  assert.doesNotMatch(
    description,
    /First statement: export const meta = \{ name: '[^']+', description: '[^']+', phases:/i,
  );
  assert.match(description, /phases.*only when.*named phases.*declare only phases it will use/i);
  assert.match(description, /multiple phases.*phase\('Exact Title'\).*agent options/i);
  assert.match(description, /await workflow\(savedName, childArgs\).*saved workflow inline/i);
  assert.match(description, /nesting.*one level.*parent run's concurrency, agent, and token limits/i);
  assert.match(
    description,
    /Optional quality helpers include verify\(\), judgePanel\(\), loopUntilDry\(\), and completenessCheck\(\)/i,
  );
  assert.match(description, /Optional control helpers include retry\(\) and gate\(\)/i);
  assert.match(description, /budget exposes total, spent\(\), and remaining\(\)/i);
  assert.match(description, /phase\('Name', \{ budget: N \}\).*phase token limit/i);
  assert.match(description, /optional `agentType` option.*named user or project definition/i);
  assert.match(description, /bind tools, a model, and role instructions/i);
  assert.match(description, /name and purpose.*provided in context/i);
  assert.match(description, /bound model overrides `tier`.*explicit `model` overrides both/i);
  assert.match(description, /plain JavaScript only.*imports.*require\(\).*filesystem modules/i);
  assert.match(description, /Date\.now\(\).*Math\.random\(\).*new Date\(\).*unavailable/i);
  assert.match(description, /args, cwd, process\.cwd\(\), and budget/i);
  assert.match(description, /must call agent\(\) at least once/i);
  assert.match(description, /parallel\(\) requires functions, not promises.*results in input order/i);
  assert.match(description, /pipeline\(items, \.\.\.stages\).*stages sequentially.*items proceed concurrently/i);
  assert.match(description, /each stage receives.*previousValue.*originalItem.*index/i);

  const guidance = tool.promptGuidelines.join(" ");
  assert.doesNotMatch(guidance, /Markdown fences|First statement: export const meta/i);
  assert.doesNotMatch(guidance, /Date\.now\(\)|Math\.random\(\)|new Date\(\)/i);
  assert.doesNotMatch(guidance, /parallel\(\) requires functions, not promises|results in input order/i);
  assert.doesNotMatch(guidance, /each stage receives.*previousValue.*originalItem.*index/i);
});

test("createWorkflowTool keeps background behavior in the parameter schema", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "background");

  assert.match(description, /Default: true/i);
  assert.match(description, /result is delivered back.*when it finishes/i);
  assert.match(description, /false only when.*result inline.*same turn/i);
  assert.doesNotMatch(tool.promptGuidelines.join(" "), /runs are background by default/i);
});

test("createWorkflowTool schema describes the configured or unbounded timeout", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "agentTimeoutMs");

  assert.match(description, /Omit to use configured `defaultAgentTimeoutMs`/i);
  assert.match(description, /without one.*no hard timeout/i);
  assert.match(description, /only when the user asks/i);
});

test("createWorkflowTool schema describes the configured or unlimited token budget", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "tokenBudget");

  assert.match(description, /soft pre-call token gate/i);
  assert.match(description, /concurrent in-flight work can overshoot/i);
  assert.match(description, /Omit to use configured `defaultTokenBudget`/i);
  assert.match(description, /without one.*unlimited/i);
  assert.match(description, /only when the user asks/i);
});

test("createWorkflowTool schema exposes resource controls and large-fan-out authority", () => {
  const tool = createWorkflowTool();

  assert.match(parameterDescription(tool, "concurrency"), /Maximum concurrent agents/i);
  assert.match(parameterDescription(tool, "agentRetries"), /Retry attempts/i);
  assert.match(parameterDescription(tool, "maxAgents"), /1000.*safety ceiling, not a target/i);
  assert.match(parameterDescription(tool, "maxAgents"), /lower limit.*dynamic or exploratory fan-out/i);
  assert.match(parameterDescription(tool, "maxAgents"), /large fan-outs.*explicit user intent/i);
});

test("createWorkflowTool invalid args throws descriptive error", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => unknown;
    assert.throws(() => prepare({ script: 123 }), /script.*string/);
    assert.throws(() => prepare("not-an-object"), /object argument/);
    assert.throws(() => prepare({}), /script.*name/i, "neither `script` nor `name` should throw clearly");
    // A malformed `script` alongside `name` must not be silently coerced away
    // — it should throw the same way a malformed script-only call does.
    assert.throws(() => prepare({ name: "deep-research", script: 123 }), /script.*string/i);
  }
});

test("createWorkflowTool with custom cwd creates tool", () => {
  const tool = createWorkflowTool({ cwd: "/tmp" });
  assert.equal(tool.name, "workflow");
});

test("createWorkflowTool does not add configured model IDs to permanent guidance", () => {
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "private-model" }]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });

  assert.doesNotMatch(tool.promptGuidelines.join(" "), /router\/private-model/);

  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "later-private-model" }]));
  assert.doesNotMatch(tool.promptGuidelines.join(" "), /router\/later-private-model/);
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

test("workflowToolSchema exposes resumeFromRunId, script, and name as optional at the schema level", () => {
  const tool = createWorkflowTool();
  const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.resumeFromRunId, "resumeFromRunId should be a schema property");
  assert.ok(schema.properties.name, "name should be a schema property");
  // Neither `script` nor `name` is in the schema's `required` list — exactly one
  // is required at runtime (normalizeWorkflowToolArgs enforces it), because
  // TypeBox's flat object schema can't express an either/or constraint.
  assert.ok(!(schema.required ?? []).includes("script"), "script is schema-optional (name is the alternative)");
  assert.ok(!(schema.required ?? []).includes("name"), "name is schema-optional (script is the alternative)");
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

// ─── `name`: reach a saved or built-in workflow without writing a script ───────

const validArgsByBuiltinName: Record<string, unknown> = {
  "deep-research": { question: "what is pi?" },
  "adversarial-review": { task: "investigate this" },
  "code-review": { diff: "some diff" },
  "multi-perspective": { topic: "a topic" },
  "codebase-audit": { scope: "src/", checks: ["security"] },
};

test(
  "workflow tool: `name` resolves each of the 5 built-in patterns and starts a run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });

    for (const name of BUILTIN_WORKFLOW_NAMES) {
      const res = await tool.execute(
        `name-${name}`,
        { name, args: validArgsByBuiltinName[name] },
        undefined,
        undefined,
        undefined,
      );
      const details = res.details as { runId?: string; background?: boolean };
      const runId = details.runId;
      assert.ok(runId, `${name} should start a run`);
      assert.equal(details.background, true);
      const managed = manager.getRun(runId);
      assert.ok(managed, `${name} run should be tracked by the manager`);
    }
    // Let the fire-and-forget background runs settle before the test tears down.
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: `name` carries deep-research's web-research exec context through the run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute(
      "name-deep-research",
      { name: "deep-research", args: { question: "what is pi?" } },
      undefined,
      undefined,
      undefined,
    );
    const details = res.details as { runId?: string };
    const runId = details.runId;
    assert.ok(runId, "deep-research should start a run");
    const managed = manager.getRun(runId);
    assert.equal(managed?.toolset, "web-research", "the run should carry the web-research toolset tag");
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: a saved workflow of the same name takes precedence over a built-in",
  withToolTempCwd(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const customScript = "export const meta = { name: 'custom_deep_research', description: 'override' }\nreturn 1";
    storage.save({ name: "deep-research", description: "custom override", script: customScript });
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager, storage });

    const res = await tool.execute(
      "name-precedence",
      { name: "deep-research", args: { question: "irrelevant here" } },
      undefined,
      undefined,
      undefined,
    );
    const details = res.details as { runId?: string };
    const runId = details.runId;
    assert.ok(runId, "the run should start");
    const managed = manager.getRun(runId);
    assert.equal(managed?.snapshot.name, "custom_deep_research", "the saved workflow should win, not the built-in");
    assert.equal(managed?.toolset, undefined, "the saved workflow does not carry the built-in's exec context");
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: an unknown `name` throws a clear error naming the built-ins",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("bad-name", { name: "not-a-real-workflow" }, undefined, undefined, undefined),
      /no saved or built-in workflow named "not-a-real-workflow"/,
    );
  }),
);

test(
  "workflow tool: invalid args for a built-in surface a descriptive error",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("bad-args", { name: "deep-research", args: {} }, undefined, undefined, undefined),
      /question/,
    );
  }),
);

test(
  "workflow tool: `name` cannot be combined with `resumeFromRunId`",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () =>
        tool.execute(
          "bad-combo",
          { name: "deep-research", args: { question: "q" }, resumeFromRunId: "some-run" },
          undefined,
          undefined,
          undefined,
        ),
      /cannot be combined with `resumeFromRunId`/,
    );
  }),
);
