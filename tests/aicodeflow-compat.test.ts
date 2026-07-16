import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { AgentDefinition, AgentRegistry } from "../src/agent-registry.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";

const childScript = `export const meta = { name: 'child', description: 'child workflow' }
return { args }`;

function parentScript(call: string): string {
  return `export const meta = { name: 'parent', description: 'parent workflow' }
return await ${call}`;
}

function withTempRoot(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dw-compat-root-"));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function expectScriptValidation(script: string, cwd: string, message: string): Promise<void> {
  await assert.rejects(
    () => runWorkflow(script, { cwd, persistLogs: false }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.message, message);
      return true;
    },
  );
}

test(
  "workflow({ scriptPath }) resolves relative and absolute paths inside the workflow cwd",
  withTempRoot(async (root) => {
    const path = join(root, "child.js");
    writeFileSync(path, childScript);

    const relativeRun = await runWorkflow<{ args: { mode: string } }>(
      parentScript("workflow({ scriptPath: 'child.js' }, { mode: 'relative' })"),
      { cwd: root, persistLogs: false },
    );
    assert.equal(relativeRun.result.args.mode, "relative");

    const absoluteRun = await runWorkflow<{ args: { mode: string } }>(
      parentScript(`workflow({ scriptPath: ${JSON.stringify(path)} }, { mode: 'absolute' })`),
      { cwd: root, persistLogs: false },
    );
    assert.equal(absoluteRun.result.args.mode, "absolute");
  }),
);

test(
  "workflow({ scriptPath }) rejects traversal and symlink escapes with stable errors",
  withTempRoot(async (root) => {
    const outside = mkdtempSync(join(tmpdir(), "pi-dw-compat-outside-"));
    try {
      const outsidePath = join(outside, "outside.js");
      writeFileSync(outsidePath, childScript);
      const traversal = relative(root, outsidePath);
      await expectScriptValidation(
        parentScript(`workflow({ scriptPath: ${JSON.stringify(traversal)} })`),
        root,
        "workflow() scriptPath escapes workflow cwd",
      );

      const linkPath = join(root, "linked.js");
      symlinkSync(outsidePath, linkPath);
      await expectScriptValidation(
        parentScript("workflow({ scriptPath: 'linked.js' })"),
        root,
        "workflow() scriptPath escapes workflow cwd",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }),
);

test(
  "workflow({ scriptPath }) rejects missing paths, directories, and invalid descriptors",
  withTempRoot(async (root) => {
    mkdirSync(join(root, "child-dir"));
    await expectScriptValidation(
      parentScript("workflow({ scriptPath: 'missing.js' })"),
      root,
      "workflow() scriptPath does not exist",
    );
    await expectScriptValidation(
      parentScript("workflow({ scriptPath: 'child-dir' })"),
      root,
      "workflow() scriptPath must reference a file",
    );

    for (const descriptor of [
      "null",
      "[]",
      "{}",
      "{ scriptPath: 1 }",
      "{ scriptPath: '' }",
      "{ scriptPath: '   ' }",
      "{ scriptPath: 'x', extra: true }",
    ]) {
      await expectScriptValidation(
        parentScript(`workflow(${descriptor})`),
        root,
        "workflow() descriptor must contain exactly one string scriptPath",
      );
    }
  }),
);

test("workflow() preserves saved-name and raw-source strings", async () => {
  const saved = await runWorkflow(parentScript("workflow('saved-child', { source: 'saved' })"), {
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "saved-child" ? childScript : undefined),
  });
  assert.equal(JSON.stringify(saved.result), JSON.stringify({ args: { source: "saved" } }));

  const raw = await runWorkflow(parentScript(`workflow(${JSON.stringify(childScript)}, { source: 'raw' })`), {
    persistLogs: false,
  });
  assert.equal(JSON.stringify(raw.result), JSON.stringify({ args: { source: "raw" } }));
});

test(
  "workflow() allows exactly one nesting level for path descriptors too",
  withTempRoot(async (root) => {
    writeFileSync(
      join(root, "grandchild.js"),
      `export const meta = { name: 'grandchild', description: 'grandchild' }\nreturn true`,
    );
    writeFileSync(
      join(root, "child.js"),
      `export const meta = { name: 'child', description: 'child' }\nreturn await workflow({ scriptPath: 'grandchild.js' })`,
    );
    await assert.rejects(
      () => runWorkflow(parentScript("workflow({ scriptPath: 'child.js' })"), { cwd: root, persistLogs: false }),
      /one level deep/,
    );
  }),
);

test("workflow() rejects every non-JSON child-args form and still allows omitted args", async () => {
  const invalidExpressions = [
    "undefined",
    "1n",
    "() => 1",
    "Symbol('x')",
    "({ value: () => 1 })",
    "({ value: Symbol('x') })",
    "[undefined]",
    "NaN",
    "Infinity",
    "(() => { const x = {}; x.self = x; return x })()",
  ];
  for (const expression of invalidExpressions) {
    await expectScriptValidation(
      parentScript(`workflow('child', ${expression})`),
      process.cwd(),
      "workflow() child args must be deterministic JSON-serializable values",
    );
  }

  const omitted = await runWorkflow(parentScript("workflow('child')"), {
    persistLogs: false,
    loadSavedWorkflow: () => childScript,
  });
  assert.equal(JSON.stringify(omitted.result), JSON.stringify({}));
});

interface StoreTool {
  name: string;
  execute(id: string, params: unknown): Promise<{ details?: { found?: boolean; value?: unknown } }>;
}

function storeAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string, options: { systemTools?: StoreTool[] }) {
        state.calls++;
        const [operation, key, value] = prompt.split(":");
        if (operation === "put") {
          await options.systemTools?.find((tool) => tool.name === "store_put")?.execute("", { key, value });
          return `put:${key}`;
        }
        if (operation === "get") {
          const read = await options.systemTools?.find((tool) => tool.name === "store_get")?.execute("", { key });
          return { found: read?.details?.found, value: read?.details?.value };
        }
        return prompt;
      },
    },
  };
}

const atomicChild = `export const meta = { name: 'atomic-child', description: 'atomic child' }
await agent('put:child:key-from-child', { label: 'child-put' })
return { child: args.version }`;

const atomicParent = `export const meta = { name: 'atomic-parent', description: 'atomic parent' }
await agent('put:parent:key-from-parent', { label: 'parent-put' })
const child = await workflow('atomic-child', { version: 1 })
const observed = await agent('get:child', { label: 'parent-read' })
return { child, observed }`;

test("a successful child workflow is one atomic parent journal entry and replays its state", async () => {
  const firstAgent = storeAgent();
  const journal: JournalEntry[] = [];
  const first = await runWorkflow(atomicParent, {
    agent: firstAgent.runner,
    persistLogs: false,
    loadSavedWorkflow: () => atomicChild,
    onAgentJournal: (entry) => journal.push(entry),
  });

  assert.equal(firstAgent.state.calls, 3);
  assert.deepEqual(
    journal.map((entry) => entry.index),
    [0, 1, 2],
  );
  assert.equal(journal[1].agentCount, 1, "the atomic child entry records its logical child-agent count");
  assert.deepEqual(journal[1].storeDelta, { child: "key-from-child" });

  const replayAgent = storeAgent();
  const replay = await runWorkflow(atomicParent, {
    agent: replayAgent.runner,
    persistLogs: false,
    loadSavedWorkflow: () => atomicChild,
    resumeJournal: new Map(journal.slice(0, 2).map((entry) => [entry.index, entry])),
  });

  assert.equal(replayAgent.state.calls, 1, "parent put and the entire child replay; only the uncached read runs");
  assert.equal(replay.agentCount, 3, "replay restores the logical child-agent count without counting the child twice");
  assert.equal(JSON.stringify(replay.result), JSON.stringify(first.result));
});

test("child workflow source and args participate in the atomic journal hash", async () => {
  const journal: JournalEntry[] = [];
  const firstAgent = storeAgent();
  await runWorkflow(parentScript("workflow('child', { version: 1 })"), {
    agent: firstAgent.runner,
    persistLogs: false,
    loadSavedWorkflow: () => atomicChild,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(journal.length, 1);

  const sameAgent = storeAgent();
  await runWorkflow(parentScript("workflow('child', { version: 1 })"), {
    agent: sameAgent.runner,
    persistLogs: false,
    loadSavedWorkflow: () => atomicChild,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(sameAgent.state.calls, 0, "same source and args replay the atomic child");

  const changedArgsAgent = storeAgent();
  await runWorkflow(parentScript("workflow('child', { version: 2 })"), {
    agent: changedArgsAgent.runner,
    persistLogs: false,
    loadSavedWorkflow: () => atomicChild,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(changedArgsAgent.state.calls, 1, "changed args rerun the whole child");

  const changedSourceAgent = storeAgent();
  await runWorkflow(parentScript("workflow('child', { version: 1 })"), {
    agent: changedSourceAgent.runner,
    persistLogs: false,
    loadSavedWorkflow: () => atomicChild.replace("key-from-child", "changed-source"),
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(changedSourceAgent.state.calls, 1, "changed child source reruns the whole child");
});

test("a failed/interrupted child creates no parent entry and reruns entirely", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const failingChild = `export const meta = { name: 'failing-child', description: 'failing child' }
await agent('first')
await agent('second')
return true`;
  await assert.rejects(
    () =>
      runWorkflow(parentScript("workflow('child')"), {
        persistLogs: false,
        loadSavedWorkflow: () => failingChild,
        onAgentJournal: (entry) => journal.push(entry),
        agent: {
          async run(prompt: string) {
            calls++;
            if (prompt === "second") {
              throw new WorkflowError("interrupted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: false });
            }
            return "ok";
          },
        },
      }),
    /interrupted/,
  );
  assert.equal(calls, 2);
  assert.equal(journal.length, 0, "partial child progress is not visible in the parent journal");

  const rerunAgent = storeAgent();
  await runWorkflow(parentScript("workflow('child')"), {
    persistLogs: false,
    loadSavedWorkflow: () => failingChild,
    agent: rerunAgent.runner,
    resumeJournal: new Map(),
  });
  assert.equal(rerunAgent.state.calls, 2, "the interrupted child reruns from its first agent");
});

test("agentTypePolicy defaults to fallback and strict mode fails unknown explicit types before runner start", async () => {
  let calls = 0;
  let starts = 0;
  const runner = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const script = `export const meta = { name: 'agent-policy', description: 'agent policy' }
return await agent('work', { agentType: 'missing' })`;

  const fallback = await runWorkflow(script, { agent: runner, agentRegistry: new Map(), persistLogs: false });
  assert.equal(fallback.result, "ok");
  assert.equal(calls, 1);

  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: runner,
        agentRegistry: new Map(),
        agentTypePolicy: "error",
        persistLogs: false,
        onAgentStart: () => starts++,
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.message, 'Unknown agentType "missing"');
      return true;
    },
  );
  assert.equal(calls, 1, "strict rejection happens before the runner/session");
  assert.equal(starts, 0, "strict rejection happens before onAgentStart");
});

test("agentTypePolicy error still permits registered and untyped agents", async () => {
  let calls = 0;
  const definition: AgentDefinition = {
    name: "known",
    prompt: "known role",
    source: "project",
  };
  const registry: AgentRegistry = new Map([["known", definition]]);
  const result = await runWorkflow(
    `export const meta = { name: 'strict-known', description: 'strict known' }
const typed = await agent('typed', { agentType: 'known' })
const untyped = await agent('untyped')
return { typed, untyped }`,
    {
      agentTypePolicy: "error",
      agentRegistry: registry,
      persistLogs: false,
      agent: {
        async run() {
          calls++;
          return "ok";
        },
      },
    },
  );
  assert.equal(JSON.stringify(result.result), JSON.stringify({ typed: "ok", untyped: "ok" }));
  assert.equal(calls, 2);
});

test("AgentOptions.effort forwards every Pi thinking level and participates in replay hashing", async () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const observed: string[] = [];
  for (const effort of levels) {
    await runWorkflow(parentScript(`agent('work', { model: 'provider/model:xhigh', effort: '${effort}' })`), {
      persistLogs: false,
      agent: {
        async run(_prompt: string, options: { effort?: string }) {
          observed.push(options.effort ?? "missing");
          return "ok";
        },
      },
    });
  }
  assert.deepEqual(observed, levels);

  const journal: JournalEntry[] = [];
  await runWorkflow(parentScript("agent('work', { effort: 'low' })"), {
    persistLogs: false,
    agent: {
      async run() {
        return "first";
      },
    },
    onAgentJournal: (entry) => journal.push(entry),
  });
  let calls = 0;
  await runWorkflow(parentScript("agent('work', { effort: 'high' })"), {
    persistLogs: false,
    agent: {
      async run() {
        calls++;
        return "second";
      },
    },
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(calls, 1, "changing effort invalidates the journal entry");
});
