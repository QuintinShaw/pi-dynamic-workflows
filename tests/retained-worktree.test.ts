import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { AgentRunOptions } from "../src/agent.js";
import type { AgentRegistry } from "../src/agent-registry.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow, type SharedRuntime } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import {
  activeCheckoutProofsForTesting,
  createWorktree as createWorktreeLive,
  createWorktreeOperationsForTesting,
  DEFAULT_WORKTREE_OPERATIONS,
  RetainedWorktreeRegistry,
  type Worktree,
  type WorktreeCleanupFailure,
  type WorktreeOperations,
} from "../src/worktree.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function createGitRepo(prefix = "pi-retained-wt-"): { repo: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise<void>((resolve) => setImmediate(resolve));
}

function assertNoWorktreeLeaks(repo: string): void {
  const worktrees = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.equal(
    worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length,
    1,
    "only the base worktree remains registered",
  );
  const branches = execFileSync("git", ["-C", repo, "branch", "--list", "pi/wf/*"], { encoding: "utf8" });
  assert.equal(branches.trim(), "", "temporary branches are deleted");
}

const RETAIN_AND_CONSUME = `export const meta = { name: 'retain_consume', description: 'retained worktree handoff' }
const produced = await agent('produce', { label: 'producer', isolation: 'worktree', retainWorktree: true, schema: { type: 'object', properties: { schemaValidated: { type: 'boolean' } }, required: ['schemaValidated'] } })
const consumed = await agent('consume', { label: 'consumer', worktree: produced.worktree })
await releaseWorktree(produced.worktree)
return { produced: produced.result, consumed }`;

test("root terminal cleanup retries marker-write rollback for ordinary and retained creation", async () => {
  for (const retainWorktree of [false, true]) {
    const { repo, cleanup } = createGitRepo(`pi-marker-terminal-${retainWorktree ? "retained" : "ordinary"}-`);
    const baseline = activeCheckoutProofsForTesting();
    let agentRuns = 0;
    const operations: WorktreeOperations = {
      createWorktree: (cwd, name) =>
        createWorktreeLive(cwd, name, {
          beforeRegistrationRecordWrite() {
            throw new Error("injected marker write failure");
          },
          creationCleanupHooks: {
            afterIdentityVerification() {
              throw new Error("injected immediate rollback failure");
            },
          },
        } as never),
      removeWorktree: DEFAULT_WORKTREE_OPERATIONS.removeWorktree,
      disposeWorktreeProofs: DEFAULT_WORKTREE_OPERATIONS.disposeWorktreeProofs,
    };
    try {
      await assert.rejects(
        runWorkflow(
          `export const meta = { name: 'marker_terminal_retry', description: 'marker failure recovery' }
return agent('never runs', { isolation: 'worktree', retainWorktree: ${retainWorktree} })`,
          {
            cwd: repo,
            persistLogs: false,
            worktreeOperations: operations,
            agent: {
              async run() {
                agentRuns += 1;
                return "unexpected";
              },
            },
          },
        ),
        /Worktree creation recovery failed/,
      );
      assert.equal(agentRuns, 0, "an unfinalized checkout is never handed to an agent");
      assertNoWorktreeLeaks(repo);
      assert.deepEqual(activeCheckoutProofsForTesting(), baseline);
    } finally {
      cleanup();
    }
  }
});

test("retained producer returns an envelope and a consumer sees the same cwd and uncommitted files", async () => {
  const { repo, cleanup } = createGitRepo();
  const seenCwds: string[] = [];
  try {
    const result = await runWorkflow(RETAIN_AND_CONSUME, {
      cwd: repo,
      persistLogs: false,
      agent: {
        async run(prompt: string, options: AgentRunOptions) {
          assert.ok(options.cwd, "retained producer and consumer receive an isolated cwd");
          seenCwds.push(options.cwd);
          if (prompt === "produce") {
            writeFileSync(join(options.cwd, "uncommitted.txt"), "visible to consumer\n");
            return { schemaValidated: true };
          }
          return readFileSync(join(options.cwd, "uncommitted.txt"), "utf8");
        },
      },
    });

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      produced: { schemaValidated: true },
      consumed: "visible to consumer\n",
    });
    assert.equal(seenCwds.length, 2);
    assert.equal(seenCwds[0], seenCwds[1]);
    assert.notEqual(seenCwds[0], repo);
    assert.equal(existsSync(seenCwds[0]), false, "explicit release removes the worktree");
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("consumer accepts option-spread retainWorktree false and runs in the retained cwd", async () => {
  const { repo, cleanup } = createGitRepo("pi-retained-false-default-");
  const seenCwds: string[] = [];
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'retain_false_default', description: 'consumer option defaults' }
const defaults = { retainWorktree: false }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
const consumed = await agent('consume', { ...defaults, worktree: produced.worktree })
return consumed`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(prompt: string, options: AgentRunOptions) {
            assert.ok(options.cwd);
            seenCwds.push(options.cwd);
            if (prompt === "produce") {
              writeFileSync(join(options.cwd, "spread-default.txt"), "visible with false default\n");
              return "ready";
            }
            return readFileSync(join(options.cwd, "spread-default.txt"), "utf8");
          },
        },
      },
    );

    assert.equal(result.result, "visible with false default\n");
    assert.equal(seenCwds.length, 2);
    assert.equal(seenCwds[0], seenCwds[1]);
    assert.notEqual(seenCwds[0], repo);
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("retained producer snapshots lifecycle options before caller mutation", async () => {
  const { repo, cleanup } = createGitRepo("pi-retained-producer-options-snapshot-");
  let retainedCwd = "";
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'retained_producer_snapshot', description: 'snapshot producer lifecycle options' }
const lifecycle = { isolation: 'worktree', retainWorktree: true }
const pending = agent('produce', lifecycle)
delete lifecycle.isolation
delete lifecycle.retainWorktree
const produced = await pending
const consumed = await agent('consume', { worktree: produced.worktree })
await releaseWorktree(produced.worktree)
return { produced: produced.result, consumed, hasHandle: produced.worktree !== undefined }`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(prompt: string, options: AgentRunOptions) {
            assert.ok(options.cwd);
            if (prompt === "produce") {
              retainedCwd = options.cwd;
              writeFileSync(join(options.cwd, "snapshot.txt"), "retained after mutation\n");
              return "ready";
            }
            assert.equal(options.cwd, retainedCwd);
            assert.equal(existsSync(retainedCwd), true, "the retained checkout survives until explicit release");
            return readFileSync(join(options.cwd, "snapshot.txt"), "utf8");
          },
        },
      },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      produced: "ready",
      consumed: "retained after mutation\n",
      hasHandle: true,
    });
    assert.equal(existsSync(retainedCwd), false, "explicit release removes the snapshotted producer checkout");
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("agent options reject malformed values before budget, runner, manager, or worktree side effects", async () => {
  const malformed = [
    { name: "null", expression: "null" },
    { name: "array", expression: "[]" },
    { name: "number", expression: "42" },
    { name: "string", expression: "'invalid'" },
    { name: "boolean", expression: "true" },
    { name: "function", expression: "function invalid() {}" },
    { name: "numeric label", expression: "{ label: 1 }" },
    { name: "invalid isolation", expression: "{ isolation: 'shared' }" },
    { name: "string retainWorktree", expression: "{ retainWorktree: 'yes' }" },
    { name: "primitive worktree", expression: "{ worktree: 'forged' }" },
    { name: "string timeout", expression: "{ timeoutMs: 'soon' }" },
    { name: "string retries", expression: "{ retries: 'many' }" },
    { name: "array schema", expression: "{ schema: [] }" },
  ];

  for (const invalid of malformed) {
    const sharedRuntime: SharedRuntime = {
      limiter: async (fn) => fn(),
      agentCount: 0,
      spent: 0,
      tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
      depth: 0,
    };
    let runnerCalls = 0;
    let worktreeCalls = 0;
    let starts = 0;
    let journals = 0;

    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'invalid_agent_options', description: 'reject malformed agent options' }
return await agent('invalid', ${invalid.expression})`,
        {
          sharedRuntime,
          persistLogs: false,
          agent: {
            async run() {
              runnerCalls += 1;
              return "unexpected";
            },
          },
          worktreeOperations: {
            async createWorktree(cwd) {
              worktreeCalls += 1;
              return { isolated: false, cwd, reason: "unexpected" };
            },
            async removeWorktree() {
              return [];
            },
          },
          onAgentStart: () => {
            starts += 1;
          },
          onAgentJournal: () => {
            journals += 1;
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError, invalid.name);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, invalid.name);
        assert.match(error.message, /agent.*options/i, invalid.name);
        return true;
      },
    );
    assert.equal(sharedRuntime.agentCount, 0, `${invalid.name} does not consume agent budget`);
    assert.equal(runnerCalls, 0, `${invalid.name} does not run an agent`);
    assert.equal(worktreeCalls, 0, `${invalid.name} does not create a worktree`);
    assert.equal(starts, 0, `${invalid.name} does not emit manager start state`);
    assert.equal(journals, 0, `${invalid.name} does not journal`);
  }
});

test("agent options preserve inherited lifecycle fields for retained producers and consumers", async () => {
  const { repo, cleanup } = createGitRepo("pi-inherited-agent-options-");
  const seenCwds: string[] = [];
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'inherited_agent_options', description: 'preserve inherited options' }
const producerOptions = Object.create({ isolation: 'worktree', retainWorktree: true })
const produced = await agent('produce', producerOptions)
const consumerOptions = Object.create({ worktree: produced.worktree, retainWorktree: false })
const consumed = await agent('consume', consumerOptions)
await releaseWorktree(produced.worktree)
return { produced: produced.result, consumed }`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(prompt, options) {
            assert.ok(options.cwd);
            seenCwds.push(options.cwd);
            return prompt;
          },
        },
      },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { produced: "produce", consumed: "consume" });
    assert.equal(seenCwds.length, 2);
    assert.equal(seenCwds[0], seenCwds[1]);
    assert.notEqual(seenCwds[0], repo);
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("agent options snapshot every recognized non-enumerable field before caller mutation", async () => {
  const { repo, cleanup } = createGitRepo("pi-non-enumerable-agent-options-");
  const starts: Array<{ label: string; phase?: string }> = [];
  const seenOptions: AgentRunOptions[] = [];
  let attempts = 0;
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'non_enumerable_agent_options', description: 'snapshot recognized fields' }
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
const options = {}
for (const [key, value] of Object.entries({
  label: 'hidden label', phase: 'Hidden phase', schema, model: 'provider/hidden', tier: 'small',
  isolation: 'worktree', retainWorktree: false, agentType: 'hidden-role', timeoutMs: 5000, retries: 1,
})) Object.defineProperty(options, key, { value, configurable: true })
const pending = agent('hidden', options)
for (const key of ['label', 'phase', 'schema', 'model', 'tier', 'isolation', 'retainWorktree', 'agentType', 'timeoutMs', 'retries']) delete options[key]
return await pending`,
      {
        cwd: repo,
        persistLogs: false,
        onAgentStart: ({ label, phase }) => starts.push({ label, phase }),
        agent: {
          async run(_prompt, options) {
            attempts += 1;
            seenOptions.push(options);
            if (attempts === 1)
              throw new WorkflowError("retry", WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true });
            return { ok: true };
          },
        },
      },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { ok: true });
    assert.equal(attempts, 2, "the non-enumerable retry count is preserved");
    const captured = seenOptions[0];
    assert.ok(captured?.cwd);
    assert.equal(captured.label, "hidden label");
    assert.equal(captured.model, "provider/hidden");
    assert.equal(captured.tier, "small");
    assert.deepEqual(JSON.parse(JSON.stringify(captured.schema)), {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    });
    assert.match(captured.instructions ?? "", /hidden-role/);
    assert.deepEqual(starts, [{ label: "hidden label", phase: "Hidden phase" }]);
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("throwing own and inherited agent option getters become side-effect-free script validation", async () => {
  for (const inherited of [false, true]) {
    const sharedRuntime: SharedRuntime = {
      limiter: async (fn) => fn(),
      agentCount: 0,
      spent: 0,
      tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
      depth: 0,
    };
    let runnerCalls = 0;
    let starts = 0;
    let worktreeCalls = 0;
    const setup = inherited
      ? `const prototype = {}
Object.defineProperty(prototype, 'isolation', { get() { throw new Error('GETTER_EXECUTED') } })
const options = Object.create(prototype)`
      : `const options = {}
Object.defineProperty(options, 'isolation', { enumerable: true, get() { throw new Error('GETTER_EXECUTED') } })`;

    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'throwing_agent_getter', description: 'getter validation' }
${setup}
return await agent('invalid getter', options)`,
        {
          sharedRuntime,
          persistLogs: false,
          agent: {
            async run() {
              runnerCalls += 1;
              return "unexpected";
            },
          },
          worktreeOperations: {
            async createWorktree(cwd) {
              worktreeCalls += 1;
              return { isolated: false, cwd };
            },
            async removeWorktree() {
              return [];
            },
          },
          onAgentStart: () => {
            starts += 1;
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.match(error.message, /agent.*options.*isolation/i);
        assert.doesNotMatch(error.message, /GETTER_EXECUTED/);
        return true;
      },
    );
    assert.equal(sharedRuntime.agentCount, 0);
    assert.equal(runnerCalls, 0);
    assert.equal(worktreeCalls, 0);
    assert.equal(starts, 0);
  }
});

test("retained consumer snapshots its handle before caller deletion", async () => {
  const { repo, cleanup } = createGitRepo("pi-retained-consumer-options-snapshot-");
  let retainedCwd = "";
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'retained_consumer_snapshot', description: 'snapshot consumer lifecycle options' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
const lifecycle = { worktree: produced.worktree }
const pending = agent('consume-first', lifecycle)
delete lifecycle.worktree
const first = await pending
const second = await agent('consume-second', { worktree: produced.worktree })
await releaseWorktree(produced.worktree)
return { first, second }`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(prompt: string, options: AgentRunOptions) {
            assert.ok(options.cwd);
            if (prompt === "produce") {
              retainedCwd = options.cwd;
              writeFileSync(join(options.cwd, "consumer-snapshot.txt"), "producer\n");
              return "ready";
            }
            assert.equal(options.cwd, retainedCwd, "every consumer uses the registered checkout");
            assert.equal(existsSync(options.cwd), true, "consumer mutation must not ordinary-clean the checkout");
            if (prompt === "consume-first") {
              writeFileSync(join(options.cwd, "consumer-snapshot.txt"), "first consumer\n");
              return "first";
            }
            return readFileSync(join(options.cwd, "consumer-snapshot.txt"), "utf8");
          },
        },
      },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      first: "first",
      second: "first consumer\n",
    });
    assert.equal(existsSync(retainedCwd), false, "release remains valid after the mutated consumer call");
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("retainWorktree false cannot be mutated into a retained producer after invocation", async () => {
  const { repo, cleanup } = createGitRepo("pi-ordinary-options-snapshot-");
  let isolatedCwd = "";
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'ordinary_snapshot', description: 'snapshot ordinary lifecycle options' }
const lifecycle = { isolation: 'worktree', retainWorktree: false }
const pending = agent('ordinary', lifecycle)
lifecycle.retainWorktree = true
const ordinary = await pending
return { ordinary, hasEnvelope: ordinary !== null && typeof ordinary === 'object' && 'worktree' in ordinary }`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(_prompt: string, options: AgentRunOptions) {
            isolatedCwd = options.cwd ?? "";
            return "plain-result";
          },
        },
      },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      ordinary: "plain-result",
      hasEnvelope: false,
    });
    assert.equal(existsSync(isolatedCwd), false, "ordinary cleanup follows the invocation-time lifecycle options");
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("ordinary isolation keeps its result shape and removes the worktree immediately", async () => {
  const { repo, cleanup } = createGitRepo("pi-default-wt-");
  let isolatedCwd = "";
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'default_isolation', description: 'compatibility' }
const ordinary = await agent('ordinary', { isolation: 'worktree' })
await agent('after')
return ordinary`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(prompt: string, options: AgentRunOptions) {
            if (prompt === "ordinary") {
              isolatedCwd = options.cwd ?? "";
              return "plain-result";
            }
            assert.equal(options.cwd, undefined);
            assert.equal(existsSync(isolatedCwd), false, "ordinary isolation is removed before the next step");
            return "after";
          },
        },
      },
    );
    assert.equal(result.result, "plain-result");
    assert.equal(existsSync(isolatedCwd), false);
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("ordinary isolation bypasses an external symlink at the obsolete shared root", async () => {
  const { repo, cleanup } = createGitRepo("pi-ordinary-symlink-root-");
  const external = mkdtempSync(join(tmpdir(), "pi-ordinary-external-root-"));
  const prompts: string[] = [];
  try {
    mkdirSync(join(repo, ".pi"));
    symlinkSync(external, join(repo, ".pi", "worktrees"), "dir");

    const result = await runWorkflow(
      `export const meta = { name: 'ordinary_symlink_root', description: 'fail closed isolation root' }
return await agent('ordinary', { isolation: 'worktree' })`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(prompt, options) {
            prompts.push(prompt);
            assert.ok(options.cwd, "ordinary isolation still receives a worktree cwd");
            const commonRoot = execFileSync(
              "git",
              ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
              { encoding: "utf8" },
            ).trim();
            assert.equal(join(options.cwd, ".."), commonRoot, "the checkout is a direct Git-common-dir child");
            assert.match(options.cwd, /pi-workflow-checkout-/);
            return "safe isolated result";
          },
        },
      },
    );

    assert.equal(result.result, "safe isolated result");
    assert.deepEqual(prompts, ["ordinary"]);
    assert.deepEqual(readdirSync(external), []);
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
    rmSync(external, { recursive: true, force: true });
  }
});

test("ordinary and retained workflow cleanup fall back when proc descriptors are unavailable", async () => {
  const { repo, cleanup } = createGitRepo("pi-portable-workflow-cleanup-");
  const isolatedCwds: string[] = [];
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'portable_cleanup', description: 'portable cleanup fallback' }
await agent('ordinary', { isolation: 'worktree' })
const retained = await agent('retained', { isolation: 'worktree', retainWorktree: true })
await releaseWorktree(retained.worktree)
return retained.result`,
      {
        cwd: repo,
        persistLogs: false,
        worktreeOperations: createWorktreeOperationsForTesting({
          procDescriptorRoot: join(repo, "unavailable-proc"),
        }),
        agent: {
          async run(prompt, options) {
            assert.ok(options.cwd);
            isolatedCwds.push(options.cwd);
            return prompt;
          },
        },
      },
    );

    assert.equal(result.result, "retained");
    assert.equal(isolatedCwds.length, 2);
    assert.equal(
      isolatedCwds.every((cwd) => !existsSync(cwd)),
      true,
      "both cleanup lifecycles remove their checkout",
    );
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("throwing onAgentStart cleans an ordinary isolated worktree without emitting a terminal event", async () => {
  const { repo, cleanup } = createGitRepo("pi-start-failure-ordinary-");
  let created: Worktree | undefined;
  const ended: string[] = [];
  try {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'ordinary_start_failure', description: 'start callback cleanup' }
return await agent('ordinary', { label: 'ordinary', isolation: 'worktree' })`,
        {
          cwd: repo,
          persistLogs: false,
          agent: {
            async run() {
              assert.fail("agent runner must not start when onAgentStart fails");
            },
          },
          worktreeOperations: {
            async createWorktree(baseCwd, name) {
              created = await DEFAULT_WORKTREE_OPERATIONS.createWorktree(baseCwd, name);
              return created;
            },
            removeWorktree: DEFAULT_WORKTREE_OPERATIONS.removeWorktree,
          },
          onAgentStart() {
            throw new Error("injected start failure");
          },
          onAgentEnd(event) {
            ended.push(event.label);
          },
        },
      ),
      /injected start failure/,
    );

    assert.equal(created?.isolated, true);
    assert.equal(existsSync(created?.cwd ?? ""), false, "ordinary checkout path is removed");
    assert.deepEqual(ended, [], "no terminal event is emitted when start did not complete");
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("throwing onAgentStart releases a retained consumer lease and root cleanup settles", async () => {
  const { repo, cleanup } = createGitRepo("pi-start-failure-retained-");
  let retainedCwd = "";
  const ended: string[] = [];
  let timeout: NodeJS.Timeout | undefined;
  try {
    const run = runWorkflow(
      `export const meta = { name: 'retained_start_failure', description: 'retained lease cleanup' }
const produced = await agent('produce', { label: 'producer', isolation: 'worktree', retainWorktree: true })
return await agent('consume', { label: 'consumer', worktree: produced.worktree })`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(prompt, options) {
            if (prompt === "produce") retainedCwd = options.cwd ?? "";
            return "ready";
          },
        },
        onAgentStart(event) {
          if (event.label === "consumer") throw new Error("injected consumer start failure");
        },
        onAgentEnd(event) {
          ended.push(event.label);
        },
      },
    );
    const outcome = await Promise.race([
      run.then(
        () => ({ status: "resolved" as const, error: undefined }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "timeout"; error: undefined }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout", error: undefined }), 5_000);
      }),
    ]);

    assert.notEqual(outcome.status, "timeout", "root cleanup must not hang on an unreleased consumer lease");
    assert.equal(outcome.status, "rejected");
    assert.match(
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      /consumer start failure/,
    );
    assert.deepEqual(ended, ["producer"], "the consumer has no terminal event because its start did not complete");
    assert.equal(existsSync(retainedCwd), false, "retained checkout path is removed at root terminal cleanup");
    assertNoWorktreeLeaks(repo);
  } finally {
    if (timeout) clearTimeout(timeout);
    cleanup();
  }
});

test("release cleans a retained Git registration after the agent deletes its checkout", async () => {
  const { repo, cleanup } = createGitRepo("pi-retained-missing-checkout-");
  let retainedCwd = "";
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'retained_missing_checkout', description: 'stale registration cleanup' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
await releaseWorktree(produced.worktree)
return produced.result`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(_prompt, options) {
            retainedCwd = options.cwd ?? "";
            rmSync(retainedCwd, { recursive: true, force: true });
            return "finished";
          },
        },
      },
    );

    assert.equal(result.result, "finished");
    assert.equal(existsSync(retainedCwd), false);
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("release is idempotent while malformed, cross-run, and released bindings reject", async () => {
  const { repo, cleanup } = createGitRepo("pi-release-wt-");
  try {
    const released = await runWorkflow(
      `export const meta = { name: 'release_rules', description: 'release validation' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
let combinationError = ''
try { await agent('invalid-combination', { worktree: produced.worktree, isolation: 'worktree' }) } catch (error) { combinationError = error.message }
await releaseWorktree(produced.worktree)
await releaseWorktree(produced.worktree)
let bindError = ''
try { await agent('late', { worktree: produced.worktree }) } catch (error) { bindError = error.message }
return { handle: produced.worktree, bindError, combinationError }`,
      {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run() {
            return "ok";
          },
        },
      },
    );
    assert.match((released.result as { bindError: string }).bindError, /released/i);
    assert.match((released.result as { combinationError: string }).combinationError, /cannot be combined/i);
    const opaqueHandle = (released.result as { handle: object }).handle;
    assert.deepEqual(Object.keys(opaqueHandle), [], "the handle exposes no path or identity fields");
    assert.equal(JSON.stringify(opaqueHandle), "{}");

    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'invalid_release', description: 'invalid handle' }
await releaseWorktree({ cwd: args.arbitraryPath })`,
        {
          cwd: repo,
          args: { arbitraryPath: repo },
          persistLogs: false,
          agent: {
            async run() {
              return "unused";
            },
          },
        },
      ),
      /malformed|unknown/i,
    );
    assert.equal(existsSync(repo), true, "a path-shaped forged handle cannot remove caller-selected paths");

    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'retain_requires_isolation', description: 'invalid producer options' }
await agent('invalid-producer', { retainWorktree: true })`,
        {
          cwd: repo,
          persistLogs: false,
          agent: {
            async run() {
              return "unused";
            },
          },
        },
      ),
      /requires isolation/i,
    );

    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'cross_run', description: 'cross run handle' }
await releaseWorktree(args.handle)`,
        {
          cwd: repo,
          args: { handle: (released.result as { handle: object }).handle },
          persistLogs: false,
          agent: {
            async run() {
              return "unused";
            },
          },
        },
      ),
      /cross-run/i,
    );
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("ordinary terminal cleanup failures dispose proofs without growing global handle maps", async () => {
  const baseline = activeCheckoutProofsForTesting();
  for (let round = 0; round < 3; round++) {
    const { repo, cleanup } = createGitRepo(`pi-ordinary-terminal-proof-${round}-`);
    try {
      const result = await runWorkflow(
        `export const meta = { name: 'ordinary_terminal_proof', description: 'terminal proof disposal' }
return await agent('ordinary', { isolation: 'worktree' })`,
        {
          cwd: repo,
          persistLogs: false,
          agent: {
            async run() {
              return "ok";
            },
          },
          worktreeOperations: createWorktreeOperationsForTesting({
            afterIdentityVerification() {
              throw new Error("permanent ordinary cleanup failure");
            },
          }),
        },
      );
      assert.equal(result.worktreeCleanupFailures?.length, 1);
      assert.deepEqual(
        activeCheckoutProofsForTesting(),
        baseline,
        `terminal round ${round} disposes process-global proof handles`,
      );
    } finally {
      cleanup();
    }
  }
});

test("failed explicit release keeps admission closed and a later release retries cleanup", async () => {
  const cleanupFailures: WorktreeCleanupFailure[] = [];
  let attempts = 0;
  const worktree: Worktree = {
    isolated: true,
    cwd: "/runtime-created/retry-explicit",
    repoRoot: "/runtime-created",
    branch: "pi/wf/retry-explicit",
    branchRef: "refs/heads/pi/wf/retry-explicit",
    baseSha: "a".repeat(40),
  };
  const result = await runWorkflow(
    `export const meta = { name: 'retry_release', description: 'retry failed cleanup' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
await releaseWorktree(produced.worktree)
let consumerError = ''
try { await agent('closed-consumer', { worktree: produced.worktree }) } catch (error) { consumerError = error.message }
await releaseWorktree(produced.worktree)
await releaseWorktree(produced.worktree)
return consumerError`,
    {
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree(candidate) {
          attempts++;
          if (attempts === 1) {
            return [
              {
                stage: "worktree_remove",
                message: "transient cleanup failure",
                identity: {
                  repoRoot: candidate.repoRoot ?? "",
                  worktreePath: candidate.cwd,
                  branchRef: candidate.branchRef ?? "",
                  baseSha: candidate.baseSha ?? "",
                },
              },
            ];
          }
          return [];
        },
      },
      onWorktreeCleanupFailure: (failure) => cleanupFailures.push(failure),
    },
  );

  assert.match(String(result.result), /release.*progress|released/i);
  assert.equal(attempts, 2, "one failed attempt is retried once and success becomes idempotent");
  assert.equal(cleanupFailures.length, 1);
});

test("root terminal cleanup retries an earlier failed explicit release", async () => {
  let attempts = 0;
  const worktree: Worktree = {
    isolated: true,
    cwd: "/runtime-created/retry-at-root",
    repoRoot: "/runtime-created",
    branch: "pi/wf/retry-at-root",
    branchRef: "refs/heads/pi/wf/retry-at-root",
    baseSha: "b".repeat(40),
  };
  await runWorkflow(
    `export const meta = { name: 'root_retry_release', description: 'terminal retry' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
await releaseWorktree(produced.worktree)
return 'done'`,
    {
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree(candidate) {
          attempts++;
          return attempts === 1
            ? [
                {
                  stage: "cleanup_dispatch",
                  message: "transient root cleanup failure",
                  identity: {
                    repoRoot: candidate.repoRoot ?? "",
                    worktreePath: candidate.cwd,
                    branchRef: candidate.branchRef ?? "",
                    baseSha: candidate.baseSha ?? "",
                  },
                },
              ]
            : [];
        },
      },
    },
  );

  assert.equal(attempts, 2, "root cleanup retries the failed, unreleased entry exactly once");
});

test("concurrent duplicate releases share one attempt and permanent failure does not spin", async () => {
  let attempts = 0;
  const failures: WorktreeCleanupFailure[] = [];
  const worktree: Worktree = {
    isolated: true,
    cwd: "/runtime-created/permanent-release-failure",
    repoRoot: "/runtime-created",
    branch: "pi/wf/permanent-release-failure",
    branchRef: "refs/heads/pi/wf/permanent-release-failure",
    baseSha: "c".repeat(40),
  };
  await runWorkflow(
    `export const meta = { name: 'bounded_release_failure', description: 'bounded retries' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
await Promise.all([releaseWorktree(produced.worktree), releaseWorktree(produced.worktree)])
return 'done'`,
    {
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree(candidate) {
          attempts++;
          return [
            {
              stage: "worktree_remove",
              message: "permanent cleanup failure",
              identity: {
                repoRoot: candidate.repoRoot ?? "",
                worktreePath: candidate.cwd,
                branchRef: candidate.branchRef ?? "",
                baseSha: candidate.baseSha ?? "",
              },
            },
          ];
        },
      },
      onWorktreeCleanupFailure: (failure) => failures.push(failure),
    },
  );

  assert.equal(attempts, 2, "duplicates share the explicit attempt and terminal cleanup performs one bounded retry");
  assert.equal(failures.length, 1, "the terminal retry duplicate is not dispatched twice");
  assert.ok(failures.every((failure) => failure.message.length <= 1024));
});

test("consumers serialize FIFO; release closes admission and waits for admitted consumers", async () => {
  const { repo, cleanup } = createGitRepo("pi-exclusive-wt-");
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  let active = 0;
  let maxActive = 0;
  const consumerEvents: string[] = [];
  let consumerCwd = "";
  try {
    const run = runWorkflow(
      `export const meta = { name: 'exclusive', description: 'exclusive retained consumers' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
const first = agent('consumer-1', { worktree: produced.worktree })
const second = agent('consumer-2', { worktree: produced.worktree })
const release = releaseWorktree(produced.worktree)
let lateError = ''
try { await agent('consumer-late', { worktree: produced.worktree }) } catch (error) { lateError = error.message }
const values = await Promise.all([first, second])
await release
return { values, lateError }`,
      {
        cwd: repo,
        concurrency: 1,
        persistLogs: false,
        agent: {
          async run(prompt: string, options: AgentRunOptions) {
            if (prompt === "produce") return "ready";
            consumerEvents.push(`start:${prompt}`);
            active++;
            maxActive = Math.max(maxActive, active);
            consumerCwd = options.cwd ?? "";
            await (prompt === "consumer-1" ? firstGate.promise : secondGate.promise);
            active--;
            consumerEvents.push(`end:${prompt}`);
            return prompt;
          },
        },
      },
    );

    await waitFor(() => consumerEvents.includes("start:consumer-1"));
    assert.equal(existsSync(consumerCwd), true, "release waits while the first admitted consumer is running");
    firstGate.resolve();
    await waitFor(() => consumerEvents.includes("start:consumer-2"));
    assert.equal(existsSync(consumerCwd), true, "release also waits for the globally queued admitted consumer");
    secondGate.resolve();
    const result = await run;
    assert.equal(maxActive, 1);
    assert.deepEqual(consumerEvents, ["start:consumer-1", "end:consumer-1", "start:consumer-2", "end:consumer-2"]);
    assert.deepEqual(Array.from((result.result as { values: string[] }).values), ["consumer-1", "consumer-2"]);
    assert.match((result.result as { lateError: string }).lateError, /release|released/i);
    assert.equal(existsSync(consumerCwd), false);
    assertNoWorktreeLeaks(repo);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    cleanup();
  }
});

test("root terminal cleanup removes unreleased worktrees on success and thrown script errors", async () => {
  for (const shouldThrow of [false, true]) {
    const { repo, cleanup } = createGitRepo(`pi-terminal-${shouldThrow ? "throw" : "success"}-`);
    let worktreeCwd = "";
    try {
      const run = runWorkflow(
        `export const meta = { name: 'terminal_cleanup', description: 'root cleanup' }
await agent('produce', { isolation: 'worktree', retainWorktree: true })
${shouldThrow ? "throw new Error('script failed')" : "return 'done'"}`,
        {
          cwd: repo,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: AgentRunOptions) {
              worktreeCwd = options.cwd ?? "";
              return "ok";
            },
          },
        },
      );
      if (shouldThrow) await assert.rejects(run, /script failed/);
      else assert.equal((await run).result, "done");
      assert.equal(existsSync(worktreeCwd), false);
      assertNoWorktreeLeaks(repo);
    } finally {
      cleanup();
    }
  }
});

test("a top-level legacy SharedRuntime depth does not suppress root retained cleanup", async () => {
  const removals: string[] = [];
  const sharedRuntime: SharedRuntime = {
    limiter: async (fn) => fn(),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 7,
  };
  const worktree: Worktree = {
    isolated: true,
    cwd: "/runtime-created/legacy-depth-root",
    repoRoot: "/runtime-created",
    branch: "pi/wf/legacy-depth-root",
    branchRef: "refs/heads/pi/wf/legacy-depth-root",
    baseSha: "d".repeat(40),
  };

  const result = await runWorkflow(
    `export const meta = { name: 'legacy_depth_root', description: 'root context ownership' }
await agent('producer', { isolation: 'worktree', retainWorktree: true })
return 'done'`,
    {
      sharedRuntime,
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree(candidate) {
          removals.push(candidate.cwd);
          return [];
        },
      },
    },
  );

  assert.equal(result.result, "done");
  assert.deepEqual(removals, [worktree.cwd]);
});

test("manager-created root execution context owns terminal retained cleanup", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-manager-root-owner-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-manager-root-owner-cwd-"));
  const removals: string[] = [];
  const worktree: Worktree = {
    isolated: true,
    cwd: join(cwd, ".retained"),
    repoRoot: cwd,
    branch: "pi/wf/manager-root-owner",
    branchRef: "refs/heads/pi/wf/manager-root-owner",
    baseSha: "e".repeat(40),
  };
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            return "ok";
          },
        },
        worktreeOperations: {
          async createWorktree() {
            return worktree;
          },
          async removeWorktree(candidate) {
            removals.push(candidate.cwd);
            return [];
          },
        },
      });
      const result = await manager.runSync(
        `export const meta = { name: 'manager_root_owner', description: 'manager root cleanup owner' }
await agent('producer', { isolation: 'worktree', retainWorktree: true })
return 'done'`,
      );
      assert.equal(result.result, "done");
      assert.deepEqual(removals, [worktree.cwd]);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("root abort cleanup waits for the active retained consumer to settle", async () => {
  const { repo, cleanup } = createGitRepo("pi-abort-wt-");
  const controller = new AbortController();
  const gate = deferred<string>();
  let consumerStarted = false;
  let worktreeCwd = "";
  try {
    const run = runWorkflow(
      `export const meta = { name: 'abort_cleanup', description: 'abort cleanup' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
return await agent('consumer', { worktree: produced.worktree })`,
      {
        cwd: repo,
        signal: controller.signal,
        persistLogs: false,
        agent: {
          async run(prompt: string, options: AgentRunOptions) {
            worktreeCwd = options.cwd ?? "";
            if (prompt === "produce") return "ready";
            consumerStarted = true;
            return gate.promise;
          },
        },
      },
    );
    await waitFor(() => consumerStarted);
    controller.abort();
    assert.equal(existsSync(worktreeCwd), true);
    gate.resolve("settled");
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      return error.code === WorkflowErrorCode.WORKFLOW_ABORTED;
    });
    assert.equal(existsSync(worktreeCwd), false);
    assertNoWorktreeLeaks(repo);
  } finally {
    gate.resolve("settled");
    cleanup();
  }
});

test("terminal admission rejects late producers, consumers, and nested wrappers before side effects", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const gate = deferred<void>();
  const records: Array<{ kind: string; message: string }> = [];
  const prompts: string[] = [];
  const starts: string[] = [];
  const removals: string[] = [];
  let created = 0;
  const child = `export const meta = { name: 'late_child', description: 'must not enter after root settlement' }
return await agent('late-nested-agent')`;
  const operations: WorktreeOperations = {
    async createWorktree(_baseCwd, name) {
      created++;
      return {
        isolated: true,
        cwd: `/runtime/terminal-admission-${created}`,
        repoRoot: "/runtime",
        branch: `pi/wf/${name}`,
        branchRef: `refs/heads/pi/wf/${name}`,
        baseSha: String(created).padStart(40, "0"),
      };
    },
    async removeWorktree(worktree) {
      removals.push(worktree.cwd);
      return [];
    },
  };
  const sharedRuntime: SharedRuntime = {
    limiter: async (fn) => fn(),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
  };
  const result = await runWorkflow(
    `export const meta = { name: 'terminal_admission', description: 'reject detached worktree operations' }
const produced = await agent('producer', { label: 'producer', isolation: 'worktree', retainWorktree: true })
args.gate.then(() => agent('late-producer', { isolation: 'worktree', retainWorktree: true }).then(
  () => args.record('producer', 'unexpected success'),
  (error) => args.record('producer', error.message),
))
args.gate.then(() => agent('late-consumer', { worktree: produced.worktree }).then(
  () => args.record('consumer', 'unexpected success'),
  (error) => args.record('consumer', error.message),
))
args.gate.then(() => workflow(${JSON.stringify(child)}).then(
  () => args.record('workflow', 'unexpected success'),
  (error) => args.record('workflow', error.message),
))
args.gate.then(() => releaseWorktree(produced.worktree).then(
  () => args.record('release', 'unexpected success'),
  (error) => args.record('release', error.message),
))
return 'root result'`,
    {
      args: {
        gate: gate.promise,
        record(kind: string, message: string) {
          records.push({ kind, message });
        },
      },
      sharedRuntime,
      worktreeOperations: operations,
      persistLogs: false,
      agent: {
        async run(prompt: string) {
          prompts.push(prompt);
          return prompt;
        },
      },
      onAgentStart: (event) => starts.push(event.label),
    },
  );

  assert.equal(result.result, "root result");
  assert.equal(created, 1);
  assert.deepEqual(removals, ["/runtime/terminal-admission-1"]);
  gate.resolve();
  for (let turn = 0; turn < 20 && records.length < 4; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(records.length, 4, "every detached rejection settles safely");
  assert.deepEqual(records.map((record) => record.kind).sort(), ["consumer", "producer", "release", "workflow"]);
  for (const record of records) assert.match(record.message, /admission|settled|closed/i);
  assert.deepEqual(prompts, ["producer"]);
  assert.deepEqual(starts, ["producer"]);
  assert.equal(sharedRuntime.agentCount, 1, "late calls do not consume agent budget");
  assert.equal(created, 1, "late calls do not create another worktree");
  assert.deepEqual(removals, ["/runtime/terminal-admission-1"], "terminal cleanup snapshots every admitted tree");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test("pre-close releases settle while late releases and concurrent roots stay isolated", async () => {
  const lateGate = deferred<void>();
  const activeGate = deferred<void>();
  const lateRecords: string[] = [];
  const removals: string[] = [];
  let created = 0;
  const operations: WorktreeOperations = {
    async createWorktree(_baseCwd, name) {
      created++;
      return {
        isolated: true,
        cwd: `/runtime/release-root-${created}`,
        repoRoot: "/runtime",
        branch: `pi/wf/${name}`,
        branchRef: `refs/heads/pi/wf/${name}`,
        baseSha: String(created).padStart(40, "0"),
      };
    },
    async removeWorktree(worktree) {
      removals.push(worktree.cwd);
      return [];
    },
  };
  const common = {
    worktreeOperations: operations,
    persistLogs: false,
    agent: {
      async run(prompt: string) {
        return prompt;
      },
    },
  } as const;

  const lateRun = runWorkflow(
    `export const meta = { name: 'late_release_root', description: 'late release admission' }
const produced = await agent('late-root', { isolation: 'worktree', retainWorktree: true })
args.gate.then(() => releaseWorktree(produced.worktree).then(
  () => args.record('unexpected success'),
  (error) => args.record(error.message),
))
return 'late-root-done'`,
    { ...common, args: { gate: lateGate.promise, record: (message: string) => lateRecords.push(message) } },
  );
  const activeRun = runWorkflow(
    `export const meta = { name: 'active_release_root', description: 'pre-close release admission' }
const produced = await agent('active-root', { isolation: 'worktree', retainWorktree: true })
await args.gate
await releaseWorktree(produced.worktree)
return 'active-root-done'`,
    { ...common, args: { gate: activeGate.promise } },
  );

  assert.equal((await lateRun).result, "late-root-done");
  assert.deepEqual(removals, ["/runtime/release-root-1"]);
  activeGate.resolve();
  assert.equal((await activeRun).result, "active-root-done");
  assert.deepEqual(removals.sort(), ["/runtime/release-root-1", "/runtime/release-root-2"]);
  lateGate.resolve();
  for (let turn = 0; turn < 20 && lateRecords.length === 0; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(lateRecords.length, 1);
  assert.match(lateRecords[0] ?? "", /admission|settled|closed/i);
  assert.equal(removals.length, 2, "the late root cannot retry cleanup owned by either root");
});

test("a late detached checkpoint rejects before manager, confirm, or journal side effects", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-late-checkpoint-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-late-checkpoint-home-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const gate = deferred<void>();
  const records: Array<{ outcome: string; message?: string }> = [];
  let confirmCalls = 0;
  let progressCalls = 0;

  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd });
      const result = await manager.runSync(
        `export const meta = { name: 'late_checkpoint', description: 'reject detached checkpoint' }
args.gate.then(() => checkpoint('late prompt?', { default: true }).then(
  () => args.record('resolved'),
  (error) => args.record('rejected', error.message),
))
return 'root result'`,
        {
          gate: gate.promise,
          record(outcome: string, message?: string) {
            records.push({ outcome, message });
          },
        },
        {
          confirm: async () => {
            confirmCalls++;
            return true;
          },
          onProgress: () => {
            progressCalls++;
          },
        },
      );

      assert.equal(result.result, "root result");
      assert.equal(result.agentCount, 0);
      assert.equal(manager.getRun(result.runId ?? "")?.status, "completed");
      assert.equal(manager.getRun(result.runId ?? "")?.journal.length, 0);
      const settledProgressCalls = progressCalls;

      gate.resolve();
      await waitFor(() => records.length === 1);
      assert.deepEqual(
        records.map((record) => record.outcome),
        ["rejected"],
      );
      assert.match(records[0]?.message ?? "", /admission|settled|closed/i);
      assert.equal(confirmCalls, 0, "late admission fails before opening confirm UI");
      assert.equal(manager.getRun(result.runId ?? "")?.journal.length, 0, "late rejection cannot journal");
      assert.equal(manager.getRun(result.runId ?? "")?.snapshot.agentCount, 0, "late rejection cannot change counters");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(progressCalls, settledProgressCalls, "no manager callbacks run after terminal settlement");
      assert.deepEqual(unhandled, []);
    });
  } finally {
    gate.resolve();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("a detached pre-close checkpoint is tracked until confirmation and journals before manager settlement", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-inflight-checkpoint-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-inflight-checkpoint-home-"));
  const confirmStarted = deferred<void>();
  const confirmGate = deferred<string>();
  let confirmCalls = 0;
  let progressCalls = 0;

  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd });
      let settled = false;
      const run = manager
        .runSync(
          `export const meta = { name: 'inflight_checkpoint', description: 'track detached checkpoint' }
checkpoint('approve before settlement?')
return 'script result'`,
          undefined,
          {
            confirm: async () => {
              confirmCalls++;
              confirmStarted.resolve();
              return confirmGate.promise;
            },
            onProgress: () => {
              progressCalls++;
            },
          },
        )
        .then((result) => {
          settled = true;
          return result;
        });

      await confirmStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const liveRun = manager.listRuns().find((candidate) => candidate.workflowName === "inflight_checkpoint");
      assert.equal(settled, false, "the manager waits for the admitted checkpoint");
      assert.equal(liveRun?.status, "running");
      assert.equal(confirmCalls, 1);

      confirmGate.resolve("approved");
      const result = await run;
      assert.equal(result.result, "script result");
      assert.equal(result.agentCount, 1, "the admitted checkpoint consumes one bounded slot");
      assert.equal(manager.getRun(result.runId ?? "")?.status, "completed");
      assert.equal(manager.getRun(result.runId ?? "")?.journal.length, 1, "the checkpoint journals before completion");
      const settledProgressCalls = progressCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(confirmCalls, 1);
      assert.equal(manager.getRun(result.runId ?? "")?.journal.length, 1);
      assert.equal(progressCalls, settledProgressCalls, "no manager callbacks run after settlement");
    });
  } finally {
    confirmGate.resolve("approved");
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("retained registry closure rejects tokenless register and acquire before snapshot cleanup", async () => {
  const removals: string[] = [];
  const first: Worktree = {
    isolated: true,
    cwd: "/runtime/registry-close-first",
    repoRoot: "/runtime",
    branch: "pi/wf/registry-close-first",
    branchRef: "refs/heads/pi/wf/registry-close-first",
    baseSha: "1".repeat(40),
  };
  const second: Worktree = {
    ...first,
    cwd: "/runtime/registry-close-second",
    branch: "pi/wf/registry-close-second",
    branchRef: "refs/heads/pi/wf/registry-close-second",
    baseSha: "2".repeat(40),
  };
  const registry = new RetainedWorktreeRegistry({
    async createWorktree() {
      return first;
    },
    async removeWorktree(worktree) {
      removals.push(worktree.cwd);
      return [];
    },
  });
  const handle = registry.register(first);
  registry.closeAdmission();

  assert.throws(() => registry.acquire(handle), /admission is closed/i);
  assert.throws(() => registry.register(second), /admission is closed/i);
  await registry.cleanupAll();
  assert.deepEqual(removals, [first.cwd]);
});

test("a pre-close in-flight producer retains admission through root settlement", async () => {
  const creationGate = deferred<void>();
  const creationStarted = deferred<void>();
  const removals: string[] = [];
  const worktree: Worktree = {
    isolated: true,
    cwd: "/runtime/pre-close-producer",
    repoRoot: "/runtime",
    branch: "pi/wf/pre-close-producer",
    branchRef: "refs/heads/pi/wf/pre-close-producer",
    baseSha: "a".repeat(40),
  };
  let settled = false;
  const run = runWorkflow(
    `export const meta = { name: 'pre_close_producer', description: 'drain admitted producer' }
agent('producer', { isolation: 'worktree', retainWorktree: true })
return 'script settled'`,
    {
      persistLogs: false,
      worktreeOperations: {
        async createWorktree() {
          creationStarted.resolve();
          await creationGate.promise;
          return worktree;
        },
        async removeWorktree(candidate) {
          removals.push(candidate.cwd);
          return [];
        },
      },
      agent: {
        async run() {
          return "produced";
        },
      },
    },
  ).then((result) => {
    settled = true;
    return result;
  });

  await creationStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "root waits for the synchronously admitted producer");
  creationGate.resolve();
  const result = await run;
  assert.equal(result.result, "script settled");
  assert.deepEqual(removals, [worktree.cwd]);
});

test("terminal admission closure is isolated between concurrent roots", async () => {
  const lateGate = deferred<void>();
  const secondGate = deferred<void>();
  const lateErrors: string[] = [];
  const prompts: string[] = [];
  const operations: WorktreeOperations = {
    async createWorktree(_baseCwd, name) {
      return {
        isolated: true,
        cwd: `/runtime/concurrent-admission-${name}`,
        repoRoot: "/runtime",
        branch: `pi/wf/${name}`,
        branchRef: `refs/heads/pi/wf/${name}`,
        baseSha: "b".repeat(40),
      };
    },
    async removeWorktree() {
      return [];
    },
  };
  const sharedRuntime: SharedRuntime = {
    limiter: async (fn) => fn(),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
  };
  const first = await runWorkflow(
    `export const meta = { name: 'closed_first_root', description: 'close only this root' }
args.gate.then(() => agent('late-first', { isolation: 'worktree', retainWorktree: true }).catch((error) => args.record(error.message)))
return 'first done'`,
    {
      args: { gate: lateGate.promise, record: (message: string) => lateErrors.push(message) },
      sharedRuntime,
      worktreeOperations: operations,
      persistLogs: false,
      agent: {
        async run(prompt: string) {
          prompts.push(prompt);
          return prompt;
        },
      },
    },
  );
  const secondRun = runWorkflow(
    `export const meta = { name: 'open_second_root', description: 'remain independently open' }
await args.gate
return await agent('second-producer', { isolation: 'worktree', retainWorktree: true })`,
    {
      args: { gate: secondGate.promise },
      sharedRuntime,
      worktreeOperations: operations,
      persistLogs: false,
      agent: {
        async run(prompt: string) {
          prompts.push(prompt);
          return prompt;
        },
      },
    },
  );

  assert.equal(first.result, "first done");
  lateGate.resolve();
  secondGate.resolve();
  const second = await secondRun;
  for (let turn = 0; turn < 20 && lateErrors.length < 1; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(lateErrors.length, 1);
  assert.match(lateErrors[0] ?? "", /admission|settled|closed/i);
  assert.equal((second.result as { result: string }).result, "second-producer");
  assert.deepEqual(prompts, ["second-producer"]);
  assert.equal(sharedRuntime.agentCount, 1);
});

test("nested workflow settlement does not clean a shared retained handle owned by the root", async () => {
  const { repo, cleanup } = createGitRepo("pi-nested-wt-");
  const child = `export const meta = { name: 'child', description: 'consume retained worktree' }
return await agent('child-consumer', { worktree: args.handle })`;
  const parent = `export const meta = { name: 'parent', description: 'retain across child' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
const childResult = await workflow(${JSON.stringify(child)}, { handle: produced.worktree })
const parentResult = await agent('parent-consumer', { worktree: produced.worktree })
return { childResult, parentResult }`;
  const seen: string[] = [];
  try {
    const result = await runWorkflow(parent, {
      cwd: repo,
      persistLogs: false,
      agent: {
        async run(prompt: string, options: AgentRunOptions) {
          assert.ok(options.cwd);
          seen.push(options.cwd);
          if (prompt === "produce") writeFileSync(join(options.cwd, "nested.txt"), "still here");
          return prompt === "produce" ? "ready" : readFileSync(join(options.cwd, "nested.txt"), "utf8");
        },
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      childResult: "still here",
      parentResult: "still here",
    });
    assert.equal(new Set(seen).size, 1);
    assert.equal(existsSync(seen[0]), false, "root terminal cleanup owns final removal");
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("identical nested workflows receive distinct implicit identities for distinct retained handles", async () => {
  const { repo, cleanup } = createGitRepo("pi-nested-distinct-handles-");
  const child = `export const meta = { name: 'child_handle', description: 'identify one retained handle' }
return 'child-result'`;
  const parent = `export const meta = { name: 'parent_handles', description: 'distinct retained identities' }
const first = await agent('produce-first', { isolation: 'worktree', retainWorktree: true })
const second = await agent('produce-second', { isolation: 'worktree', retainWorktree: true })
return await Promise.all([
  workflow(${JSON.stringify(child)}, { handle: first.worktree }),
  workflow(${JSON.stringify(child)}, { handle: second.worktree })
])`;
  const producedCwds: string[] = [];
  const journal: JournalEntry[] = [];
  try {
    const result = await runWorkflow(parent, {
      cwd: repo,
      persistLogs: false,
      agent: {
        async run(prompt: string, options: AgentRunOptions) {
          assert.ok(options.cwd);
          if (prompt.startsWith("produce-")) {
            producedCwds.push(options.cwd);
            writeFileSync(join(options.cwd, "owner.txt"), `${prompt}\n`);
            return prompt;
          }
          return readFileSync(join(options.cwd, "owner.txt"), "utf8").trim();
        },
      },
      onAgentJournal: (entry) => journal.push(entry),
    });

    assert.deepEqual(Array.from(result.result as string[]), ["child-result", "child-result"]);
    assert.equal(new Set(producedCwds).size, 2);
    assert.deepEqual(journal, [], "handle-bearing calls and retained producers remain noncacheable");
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("concurrent roots sharing SharedRuntime isolate handles and terminal cleanup", async () => {
  const rootGate = deferred<void>();
  const removals: string[] = [];
  const handles: object[] = [];
  let sequence = 0;
  const operations: WorktreeOperations = {
    async createWorktree(_baseCwd, name) {
      sequence++;
      return {
        isolated: true,
        cwd: `/runtime/root-${sequence}`,
        repoRoot: "/runtime",
        branch: `pi/wf/${name}`,
        branchRef: `refs/heads/pi/wf/${name}`,
        baseSha: String(sequence).padStart(40, "0"),
      };
    },
    async removeWorktree(worktree) {
      removals.push(worktree.cwd);
      return [];
    },
  };
  const sharedRuntime: SharedRuntime = {
    limiter: async (fn) => fn(),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
  };
  const first = runWorkflow(
    `export const meta = { name: 'first_root', description: 'first root owner' }
const produced = await agent('first-producer', { label: 'first-producer', isolation: 'worktree', retainWorktree: true })
await args.gate
return produced.worktree`,
    {
      args: { gate: rootGate.promise },
      sharedRuntime,
      worktreeOperations: operations,
      persistLogs: false,
      agent: {
        async run() {
          return "first";
        },
      },
      onAgentEnd(event) {
        if (event.label === "first-producer") handles.push((event.result as { worktree: object }).worktree);
      },
    },
  );

  try {
    await waitFor(() => handles.length === 1);
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'cross_root', description: 'reject foreign handle' }
return await agent('foreign-consumer', { worktree: args.handle })`,
        {
          args: { handle: handles[0] },
          sharedRuntime,
          worktreeOperations: operations,
          persistLogs: false,
          agent: {
            async run() {
              return "must not run";
            },
          },
        },
      ),
      /cross-run/i,
    );

    const second = await runWorkflow(
      `export const meta = { name: 'second_root', description: 'second root cleanup' }
await agent('second-producer', { isolation: 'worktree', retainWorktree: true })
return 'second done'`,
      {
        sharedRuntime,
        worktreeOperations: operations,
        persistLogs: false,
        agent: {
          async run() {
            return "second";
          },
        },
      },
    );
    assert.equal(second.result, "second done");
    assert.deepEqual(removals, ["/runtime/root-2"], "second root cleanup cannot remove the first root checkout");
  } finally {
    rootGate.resolve();
    await first;
  }
  assert.deepEqual(removals, ["/runtime/root-2", "/runtime/root-1"]);
});

test("direct roots use collision-resistant default run and worktree identities with a frozen clock", async () => {
  const { repo, cleanup } = createGitRepo("pi-frozen-direct-roots-");
  const originalDateNow = Date.now;
  const branches: string[] = [];
  const checkouts: string[] = [];
  const operations: WorktreeOperations = {
    async createWorktree(baseCwd, name) {
      const worktree = await createWorktreeLive(baseCwd, name);
      if (worktree.branch) branches.push(worktree.branch);
      if (worktree.isolated) checkouts.push(worktree.cwd);
      return worktree;
    },
    removeWorktree: (worktree) => DEFAULT_WORKTREE_OPERATIONS.removeWorktree(worktree),
  };
  Date.now = () => 1_700_000_000_000;
  try {
    const script = `export const meta = { name: 'frozen_direct_root', description: 'unique direct root identity' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
return produced.worktree`;
    const [first, second] = await Promise.all(
      [0, 1].map(() =>
        runWorkflow(script, {
          cwd: repo,
          persistLogs: false,
          worktreeOperations: operations,
          agent: {
            async run() {
              return "ready";
            },
          },
        }),
      ),
    );

    assert.notEqual(first.runId, second.runId);
    assert.equal(new Set(branches).size, 2);
    assert.equal(new Set(checkouts).size, 2);
    assert.notEqual(first.result, second.result, "retained capabilities remain root-unique");
    for (const checkout of checkouts) assert.equal(existsSync(checkout), false);
    assertNoWorktreeLeaks(repo);
  } finally {
    Date.now = originalDateNow;
    cleanup();
  }
});

test("concurrent roots settle only their own tracked operations and clean independently", async () => {
  const blockedConsumerStarted = deferred<void>();
  const blockedConsumerGate = deferred<void>();
  const removals: string[] = [];
  let sequence = 0;
  const operations: WorktreeOperations = {
    async createWorktree(_baseCwd, name) {
      sequence++;
      return {
        isolated: true,
        cwd: `/runtime/settlement-root-${sequence}`,
        repoRoot: "/runtime",
        branch: `pi/wf/${name}`,
        branchRef: `refs/heads/pi/wf/${name}`,
        baseSha: String(sequence).padStart(40, "0"),
      };
    },
    async removeWorktree(worktree) {
      removals.push(worktree.cwd);
      return [];
    },
  };
  const sharedRuntime: SharedRuntime = {
    limiter: async (fn) => fn(),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
  };
  const rootB = runWorkflow(
    `export const meta = { name: 'blocked_root_b', description: 'foreign blocked consumer' }
const produced = await agent('root-b-producer', { isolation: 'worktree', retainWorktree: true })
return await agent('root-b-consumer', { worktree: produced.worktree })`,
    {
      sharedRuntime,
      worktreeOperations: operations,
      persistLogs: false,
      agent: {
        async run(prompt: string) {
          if (prompt === "root-b-consumer") {
            blockedConsumerStarted.resolve();
            await blockedConsumerGate.promise;
            throw new WorkflowError("root B consumer rejected", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
              recoverable: false,
            });
          }
          return "root B produced";
        },
      },
    },
  );

  await blockedConsumerStarted.promise;
  let rootASettled = false;
  const rootA = runWorkflow(
    `export const meta = { name: 'independent_root_a', description: 'independent successful root' }
await agent('root-a-producer', { isolation: 'worktree', retainWorktree: true })
return 'root A succeeded'`,
    {
      sharedRuntime,
      worktreeOperations: operations,
      persistLogs: false,
      agent: {
        async run() {
          return "root A produced";
        },
      },
    },
  ).then(
    (result) => {
      rootASettled = true;
      return result;
    },
    (error) => {
      rootASettled = true;
      throw error;
    },
  );

  for (let turn = 0; turn < 10 && !rootASettled; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const rootASettledWhileRootBBlocked = rootASettled;
  const removalsWhileRootBBlocked = [...removals];
  blockedConsumerGate.resolve();
  const [rootAOutcome, rootBOutcome] = await Promise.allSettled([rootA, rootB]);

  assert.equal(rootASettledWhileRootBBlocked, true, "root A does not wait for root B's tracked consumer");
  assert.deepEqual(removalsWhileRootBBlocked, ["/runtime/settlement-root-2"], "root A runs terminal cleanup");
  assert.equal(rootAOutcome.status, "fulfilled", "root B's rejection cannot replace root A's successful outcome");
  if (rootAOutcome.status === "fulfilled") assert.equal(rootAOutcome.value.result, "root A succeeded");
  assert.equal(rootBOutcome.status, "rejected");
  if (rootBOutcome.status === "rejected") assert.match(String(rootBOutcome.reason), /root B consumer rejected/);
  assert.deepEqual(removals, ["/runtime/settlement-root-2", "/runtime/settlement-root-1"]);
});

test("nested retained producer makes the parent wrapper noncacheable on resume", async () => {
  const { repo, cleanup } = createGitRepo("pi-nested-resume-wt-");
  const journal: JournalEntry[] = [];
  const prompts: string[] = [];
  const child = `export const meta = { name: 'nested_producer', description: 'produce retained worktree' }
return await agent('nested-produce', { label: 'nested-producer', isolation: 'worktree', retainWorktree: true })`;
  const parent = `export const meta = { name: 'nested_resume_parent', description: 'resume nested retained producer' }
const prefix = await agent('prefix')
const produced = await workflow(${JSON.stringify(child)})
const consumed = await agent('parent-consume', { worktree: produced.worktree })
return { prefix, produced: produced.result, consumed }`;
  const runner = {
    async run(prompt: string, options: AgentRunOptions) {
      prompts.push(prompt);
      if (prompt === "nested-produce") {
        assert.ok(options.cwd);
        writeFileSync(join(options.cwd, "nested-resume.txt"), "fresh nested state");
        return "produced";
      }
      if (prompt === "parent-consume") {
        assert.ok(options.cwd);
        return readFileSync(join(options.cwd, "nested-resume.txt"), "utf8");
      }
      return prompt;
    },
  };
  try {
    await runWorkflow(parent, {
      cwd: repo,
      runId: "nested-retained-resume",
      persistLogs: false,
      agent: runner,
      onAgentJournal: (entry) => journal.push(entry),
    });
    assert.equal(journal.length, 1, "only the ordinary prefix is journaled");
    assert.equal(journal[0]?.runId, "nested-retained-resume");

    prompts.length = 0;
    const resumed = await runWorkflow(parent, {
      cwd: repo,
      runId: "nested-retained-resume",
      resumeFromRunId: "nested-retained-resume",
      resumeJournal: new Map(
        journal.map((entry) => [`${entry.runId ?? "nested-retained-resume"}:${entry.index}`, entry]),
      ),
      persistLogs: false,
      agent: runner,
    });

    assert.deepEqual(prompts, ["nested-produce", "parent-consume"]);
    assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), {
      prefix: "prefix",
      produced: "produced",
      consumed: "fresh nested state",
    });
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("a cached nested wrapper carrying a fresh retained handle reruns its child and dependent suffix", async () => {
  const child = `export const meta = { name: 'cached_handle_child', description: 'read current retained checkout' }
return await agent('child-read', { worktree: args.handle })`;
  const parent = `export const meta = { name: 'cached_handle_parent', description: 'invalidate stale wrapper replay' }
const childValue = await workflow(${JSON.stringify(child)}, { handle: args.handle })
const suffix = await agent('suffix')
return { childValue, suffix }`;
  const root = mkdtempSync(join(tmpdir(), "pi-cached-wrapper-handle-"));
  const calls = new Map<string, number>();
  const operations: WorktreeOperations = {
    async createWorktree() {
      assert.fail("the retained checkout is provided explicitly");
    },
    async removeWorktree() {
      return [];
    },
  };
  const runner = {
    async run(prompt: string, options: AgentRunOptions) {
      calls.set(prompt, (calls.get(prompt) ?? 0) + 1);
      if (prompt === "child-read") {
        assert.ok(options.cwd);
        return readFileSync(join(options.cwd, "current.txt"), "utf8");
      }
      return `suffix-${calls.get(prompt)}`;
    },
  };
  const worktree = (cwd: string): Worktree => ({
    isolated: true,
    cwd,
    repoRoot: root,
    branch: "pi/wf/stable-current-checkout",
    branchRef: "refs/heads/pi/wf/stable-current-checkout",
    baseSha: "a".repeat(40),
  });
  const context = (registry: RetainedWorktreeRegistry, scopes: Set<string>) => {
    const admissions = new WeakSet<object>();
    return {
      retainedWorktrees: registry,
      admitOperation(parent?: object) {
        if (parent && !admissions.has(parent)) throw new Error("inactive test admission");
        const admission = Object.freeze({ owner: Symbol("test-admission") });
        admissions.add(admission);
        return admission;
      },
      completeOperationAdmission(admission: object) {
        admissions.delete(admission);
      },
      closeOperationAdmission() {},
      retainedWorktreeUseScopes: scopes,
      worktreeCleanupFailures: [],
      liveOperations: new Set<Promise<unknown>>(),
    } as NonNullable<Parameters<typeof runWorkflow>[1]["executionContext"]>;
  };
  class HistoricalUntrackedScopes extends Set<string> {
    override add(_value: string): this {
      return this;
    }
  }

  try {
    const staleCwd = join(root, "stale");
    mkdirSync(staleCwd);
    writeFileSync(join(staleCwd, "current.txt"), "stale checkout");
    const staleRegistry = new RetainedWorktreeRegistry(operations);
    const staleHandle = staleRegistry.register(worktree(staleCwd));
    const historicalJournal: JournalEntry[] = [];
    const stale = await runWorkflow(parent, {
      args: { handle: staleHandle },
      runId: "cached-handle-wrapper",
      executionContext: context(staleRegistry, new HistoricalUntrackedScopes()),
      persistLogs: false,
      agent: runner,
      onAgentJournal: (entry) => historicalJournal.push(entry),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(stale.result)), {
      childValue: "stale checkout",
      suffix: "suffix-1",
    });
    assert.equal(historicalJournal.length, 1, "only the ordinary suffix is journaled by the upstream API");
    await staleRegistry.cleanupAll();

    const currentCwd = join(root, "current");
    mkdirSync(currentCwd);
    writeFileSync(join(currentCwd, "current.txt"), "current uncommitted checkout");
    const currentRegistry = new RetainedWorktreeRegistry(operations);
    const currentHandle = currentRegistry.register(worktree(currentCwd));
    const resumed = await runWorkflow(parent, {
      args: { handle: currentHandle },
      runId: "cached-handle-wrapper",
      executionContext: context(currentRegistry, new Set()),
      resumeJournal: new Map(
        historicalJournal.map((entry) => [`${entry.runId ?? "cached-handle-wrapper"}:${entry.index}`, entry]),
      ),
      resumeFromRunId: "cached-handle-wrapper",
      persistLogs: false,
      agent: runner,
    });

    assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), {
      childValue: "current uncommitted checkout",
      suffix: "suffix-2",
    });
    assert.deepEqual(Object.fromEntries(calls), { "child-read": 2, suffix: 2 });
    await currentRegistry.cleanupAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agentType-provided worktree isolation supports retained producers", async () => {
  const { repo, cleanup } = createGitRepo("pi-agent-type-retained-wt-");
  const agentRegistry: AgentRegistry = new Map([
    [
      "retained-editor",
      {
        name: "retained-editor",
        isolation: "worktree",
        prompt: "Edit in an isolated worktree.",
        source: "project",
      },
    ],
  ]);
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'agent_type_retained', description: 'resolved worktree isolation' }
const produced = await agent('produce', { agentType: 'retained-editor', retainWorktree: true })
let invalidCombination = ''
try { await agent('invalid', { agentType: 'retained-editor', worktree: produced.worktree }) } catch (error) { invalidCombination = error.message }
const consumed = await agent('consume', { worktree: produced.worktree })
await releaseWorktree(produced.worktree)
return { produced: produced.result, consumed, invalidCombination }`,
      {
        cwd: repo,
        persistLogs: false,
        agentRegistry,
        agent: {
          async run(prompt: string, options: AgentRunOptions) {
            assert.ok(options.cwd);
            if (prompt === "produce") {
              writeFileSync(join(options.cwd, "agent-type.txt"), "resolved isolation");
              return "ready";
            }
            return readFileSync(join(options.cwd, "agent-type.txt"), "utf8");
          },
        },
      },
    );

    const value = JSON.parse(JSON.stringify(result.result)) as {
      produced: string;
      consumed: string;
      invalidCombination: string;
    };
    assert.equal(value.produced, "ready");
    assert.equal(value.consumed, "resolved isolation");
    assert.match(value.invalidCombination, /including agentType isolation/i);
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("retained producer and consumer calls are noncacheable so resume reruns the dependent suffix", async () => {
  const { repo, cleanup } = createGitRepo("pi-resume-wt-");
  const journal: JournalEntry[] = [];
  const prompts: string[] = [];
  const script = `export const meta = { name: 'resume_retained', description: 'resume invalidation' }
const prefix = await agent('prefix')
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
const consumed = await agent('consume', { worktree: produced.worktree })
return { prefix, consumed }`;
  const runner = {
    async run(prompt: string, options: AgentRunOptions) {
      prompts.push(prompt);
      if (prompt === "produce") {
        assert.ok(options.cwd);
        writeFileSync(join(options.cwd, "resume.txt"), "live suffix");
      }
      if (prompt === "consume") {
        assert.ok(options.cwd);
        return readFileSync(join(options.cwd, "resume.txt"), "utf8");
      }
      return prompt;
    },
  };
  try {
    await runWorkflow(script, {
      cwd: repo,
      runId: "resume-retained",
      persistLogs: false,
      agent: runner,
      onAgentJournal: (entry) => journal.push(entry),
    });
    assert.equal(journal.length, 1, "only the ordinary prefix is cacheable");
    prompts.length = 0;
    const resumed = await runWorkflow(script, {
      cwd: repo,
      runId: "resume-retained",
      resumeFromRunId: "resume-retained",
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId ?? "resume-retained"}:${entry.index}`, entry])),
      persistLogs: false,
      agent: runner,
    });
    assert.deepEqual(prompts, ["produce", "consume"]);
    assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), { prefix: "prefix", consumed: "live suffix" });
    assertNoWorktreeLeaks(repo);
  } finally {
    cleanup();
  }
});

test("a rejected retained consumer does not consume the maxAgents allowance", async () => {
  await withFakeHomeAsync(mkdtempSync(join(tmpdir(), "pi-retained-limit-home-")), async () => {
    const { repo, cleanup } = createGitRepo("pi-retained-limit-manager-");
    const prompts: string[] = [];
    try {
      const manager = new WorkflowManager({
        cwd: repo,
        agent: {
          async run(prompt) {
            prompts.push(prompt);
            return prompt;
          },
        },
      });
      const result = await manager.runSync(
        `export const meta = { name: 'invalid_binding_limit', description: 'invalid consumers do not charge' }
const produced = await agent('producer', { isolation: 'worktree', retainWorktree: true })
await releaseWorktree(produced.worktree)
let invalidError = ''
try { await agent('invalid-consumer', { worktree: produced.worktree }) } catch (error) { invalidError = error.message }
const ordinary = await agent('ordinary')
return { invalidError, ordinary }`,
        undefined,
        { maxAgents: 2 },
      );

      assert.deepEqual(prompts, ["producer", "ordinary"]);
      assert.match((result.result as { invalidError: string }).invalidError, /released/i);
      assert.equal((result.result as { ordinary: string }).ordinary, "ordinary");
      assert.equal(result.agentCount, 2);
      assertNoWorktreeLeaks(repo);
    } finally {
      cleanup();
    }
  });
});

test("manager has no running agent row when a caught retained binding acquisition fails", async () => {
  await withFakeHomeAsync(mkdtempSync(join(tmpdir(), "pi-retained-invalid-home-")), async () => {
    const { repo, cleanup } = createGitRepo("pi-retained-invalid-manager-");
    try {
      const manager = new WorkflowManager({
        cwd: repo,
        agent: {
          async run() {
            return "ok";
          },
        },
      });
      const result = await manager.runSync(
        `export const meta = { name: 'caught_invalid_binding', description: 'manager lifecycle terminal state' }
const produced = await agent('produce', { label: 'producer', isolation: 'worktree', retainWorktree: true })
await releaseWorktree(produced.worktree)
let error = ''
try { await agent('late-consumer', { label: 'late-consumer', worktree: produced.worktree }) } catch (caught) { error = caught.message }
return error`,
      );

      assert.match(String(result.result), /released/i);
      const run = manager.getRun(result.runId ?? "");
      assert.equal(run?.status, "completed");
      assert.equal(
        run?.snapshot.agents.some((agent) => agent.status === "running"),
        false,
      );
      assert.equal(run?.snapshot.runningCount, 0);
      assertNoWorktreeLeaks(repo);
    } finally {
      cleanup();
    }
  });
});

test("ordinary cleanup failures preserve outcomes with bounded path-free diagnostics", async () => {
  for (const agentFails of [false, true]) {
    const failures: WorktreeCleanupFailure[] = [];
    const posixSecret = join(
      tmpdir(),
      `ordinary private-fragment [repo],; 'quoted' "double"`,
      "mixed\\separator checkout",
    );
    const windowsSecret = "C:\\Users\\ordinary private-fragment [repo],; 'quoted' \"double\"\\mixed/separator checkout";
    const worktree: Worktree = {
      isolated: true,
      cwd: `/runtime-created/ordinary-${agentFails ? "failure" : "success"}`,
      repoRoot: "/runtime-created/repo",
      branch: `pi/wf/ordinary-${agentFails ? "failure" : "success"}`,
      branchRef: `refs/heads/pi/wf/ordinary-${agentFails ? "failure" : "success"}`,
      baseSha: "d".repeat(40),
    };
    const run = runWorkflow(
      `export const meta = { name: 'ordinary_cleanup_failure', description: 'preserve ordinary outcome' }
return await agent('ordinary', { isolation: 'worktree' })`,
      {
        persistLogs: false,
        agent: {
          async run() {
            if (agentFails) {
              throw new WorkflowError("original agent failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
                recoverable: false,
              });
            }
            return "successful result";
          },
        },
        worktreeOperations: {
          async createWorktree() {
            return worktree;
          },
          async removeWorktree() {
            throw new Error(`cleanup failed at ${posixSecret} and ${windowsSecret} ${"x".repeat(5000)}`);
          },
        },
        onWorktreeCleanupFailure: (failure) => failures.push(failure),
      },
    );

    if (agentFails) {
      await assert.rejects(run, /original agent failure/);
    } else {
      const completed = await run;
      assert.equal(completed.result, "successful result");
      assert.equal(completed.worktreeCleanupFailures?.length, 1);
      assert.match(completed.logs.join("\n"), /worktree cleanup failed/i);
    }
    assert.equal(failures.length, 1, "the callback receives each ordinary failure exactly once");
    assert.equal(failures[0]?.stage, "cleanup_dispatch");
    assert.ok((failures[0]?.message.length ?? Infinity) <= 1024);
    assert.match(failures[0]?.identity.recoveryId ?? "", /^[0-9a-f]{64}$/);
    const diagnostics = JSON.stringify(failures);
    for (const secret of [
      posixSecret,
      windowsSecret,
      "ordinary private-fragment",
      "mixed\\separator checkout",
      "mixed/separator checkout",
      "Users",
      `cleanup failed at ${posixSecret}`,
    ]) {
      assert.equal(diagnostics.includes(secret), false, `callback diagnostics omit raw prose/path fragment ${secret}`);
    }
    assert.match(failures[0]?.message ?? "", /cleanup failed.*cleanup_dispatch.*recovery ID/i);
  }
});

test("rejecting async cleanup callbacks never mask successful or original-error outcomes", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  let callbackCalls = 0;

  for (const agentFails of [false, true]) {
    const worktree: Worktree = {
      isolated: true,
      cwd: `/runtime-created/rejecting-cleanup-callback-${agentFails}`,
      repoRoot: "/runtime-created",
      branch: `pi/wf/rejecting-cleanup-callback-${agentFails}`,
      branchRef: `refs/heads/pi/wf/rejecting-cleanup-callback-${agentFails}`,
      baseSha: (agentFails ? "b" : "a").repeat(40),
    };
    const run = runWorkflow(
      `export const meta = { name: 'rejecting_cleanup_callback', description: 'consume callback rejection' }
return await agent('ordinary', { isolation: 'worktree' })`,
      {
        persistLogs: false,
        agent: {
          async run() {
            if (agentFails) {
              throw new WorkflowError("original agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
                recoverable: false,
              });
            }
            return "successful result";
          },
        },
        worktreeOperations: {
          async createWorktree() {
            return worktree;
          },
          async removeWorktree() {
            throw new Error("ordinary cleanup failed");
          },
        },
        onWorktreeCleanupFailure: async () => {
          callbackCalls++;
          throw new Error("async cleanup callback rejected");
        },
      },
    );

    if (agentFails) {
      await assert.rejects(run, /original agent error/);
    } else {
      const result = await run;
      assert.equal(result.result, "successful result");
      assert.equal(result.worktreeCleanupFailures?.length, 1);
    }
  }

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(callbackCalls, 2);
  assert.deepEqual(unhandled, []);
});

test("managed ordinary cleanup failures are bounded and deduplicated for successful and failed runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-managed-ordinary-cleanup-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-managed-ordinary-cleanup-home-"));
  let sequence = 0;
  const operations: WorktreeOperations = {
    async createWorktree() {
      sequence++;
      return {
        isolated: true,
        cwd: join(cwd, `checkout-${sequence}`),
        repoRoot: cwd,
        branch: `pi/wf/managed-ordinary-${sequence}`,
        branchRef: `refs/heads/pi/wf/managed-ordinary-${sequence}`,
        baseSha: String(sequence).padStart(40, "0"),
      };
    },
    async removeWorktree(worktree) {
      return [
        {
          stage: "worktree_remove",
          message: "ordinary managed cleanup failed",
          identity: {
            repoRoot: cwd,
            worktreePath: worktree.cwd,
            branchRef: worktree.branchRef ?? "",
            baseSha: worktree.baseSha ?? "",
          },
        },
      ];
    },
  };
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      let failAgent = false;
      const manager = new WorkflowManager({
        cwd,
        worktreeOperations: operations,
        agent: {
          async run() {
            if (failAgent) {
              throw new WorkflowError("managed primary failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
                recoverable: false,
              });
            }
            return "ok";
          },
        },
      });
      const script = `export const meta = { name: 'managed_ordinary_cleanup', description: 'ordinary diagnostics' }
return await agent('work', { isolation: 'worktree' })`;
      const successful = await manager.runSync(script);
      assert.equal(successful.worktreeCleanupFailures?.length, 1);
      assert.equal(manager.getRun(successful.runId ?? "")?.worktreeCleanupFailures?.length, 1);
      assert.equal(manager.getPersistence().load(successful.runId ?? "")?.worktreeCleanupFailures?.length, 1);

      failAgent = true;
      const failed = manager.startInBackground(script);
      await assert.rejects(failed.promise, /managed primary failure/);
      assert.equal(manager.getRun(failed.runId)?.worktreeCleanupFailures?.length, 1);
      assert.equal(manager.getPersistence().load(failed.runId)?.worktreeCleanupFailures?.length, 1);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("cleanup warnings omit hostile caller labels from direct logs and manager persistence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hostile-cleanup-label-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-hostile-cleanup-label-home-"));
  const hostileLabel = `${cwd}/customer-secret\ncontrol\u0001 C:\\Users\\private\\checkout api-key=label-secret`;
  const worktree: Worktree = {
    isolated: true,
    cwd: join(cwd, "checkout"),
    repoRoot: cwd,
    branch: "pi/wf/hostile-label",
    branchRef: "refs/heads/pi/wf/hostile-label",
    baseSha: "d".repeat(40),
  };
  const creationNames: string[] = [];
  const operations: WorktreeOperations = {
    async createWorktree(_baseCwd, name) {
      creationNames.push(name);
      return worktree;
    },
    async removeWorktree() {
      return [
        {
          stage: "worktree_remove",
          message: "injected cleanup failure",
          identity: {
            repoRoot: cwd,
            worktreePath: worktree.cwd,
            branchRef: worktree.branchRef ?? "",
            baseSha: worktree.baseSha ?? "",
          },
        },
      ];
    },
  };
  const script = `export const meta = { name: 'hostile_cleanup_label', description: 'label-free cleanup warning' }
return await agent('work', { label: ${JSON.stringify(hostileLabel)}, isolation: 'worktree' })`;
  const forbidden = [cwd, "customer-secret", "control", "Users", "private", "api-key", "label-secret"];
  try {
    const direct = await runWorkflow(script, {
      cwd,
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: operations,
    });
    const directCleanupSurface = JSON.stringify({
      logs: direct.logs,
      failures: direct.worktreeCleanupFailures,
    });
    for (const fragment of forbidden) {
      assert.equal(directCleanupSurface.includes(fragment), false, `direct cleanup diagnostics omit ${fragment}`);
      assert.equal(creationNames[0]?.includes(fragment), false, `internal worktree call identity omits ${fragment}`);
    }

    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            return "ok";
          },
        },
        worktreeOperations: operations,
      });
      const managed = await manager.runSync(script);
      const persisted = manager.getPersistence().load(managed.runId ?? "");
      const managerCleanupSurface = JSON.stringify({
        resultLogs: managed.logs,
        resultFailures: managed.worktreeCleanupFailures,
        persistedLogs: persisted?.logs,
        persistedFailures: persisted?.worktreeCleanupFailures,
      });
      for (const fragment of forbidden) {
        assert.equal(managerCleanupSurface.includes(fragment), false, `manager cleanup persistence omits ${fragment}`);
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("direct retained cleanup failures are returned and logged without an explicit callback", async () => {
  const absoluteRoot = join(tmpdir(), `pi direct-cleanup [private],; 'quoted' "double"`, "repo mixed\\checkout");
  const windowsRoot = "D:\\workflow private-fragment [repo],; 'quoted' \"double\"\\mixed/separator checkout";
  const worktree: Worktree = {
    isolated: true,
    cwd: join(absoluteRoot, "checkout"),
    repoRoot: absoluteRoot,
    branch: "pi/wf/direct-cleanup",
    branchRef: "refs/heads/pi/wf/direct-cleanup",
    baseSha: "e".repeat(40),
  };
  const result = await runWorkflow(
    `export const meta = { name: 'direct_cleanup_result', description: 'public retained cleanup diagnostics' }
await agent('produce', { isolation: 'worktree', retainWorktree: true })
return 'successful value'`,
    {
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree() {
          return [
            {
              stage: "worktree_remove",
              message: `cannot remove ${absoluteRoot} or ${windowsRoot} ${"x".repeat(5000)}`,
              identity: {
                repoRoot: absoluteRoot,
                worktreePath: worktree.cwd,
                branchRef: worktree.branchRef ?? "",
                baseSha: worktree.baseSha ?? "",
              },
            },
          ];
        },
      },
    },
  );

  assert.equal(result.result, "successful value");
  assert.equal(result.worktreeCleanupFailures?.length, 1);
  assert.ok((result.worktreeCleanupFailures?.[0]?.message.length ?? Infinity) <= 1024);
  assert.match(result.worktreeCleanupFailures?.[0]?.identity.recoveryId ?? "", /^[0-9a-f]{64}$/);
  const warning = result.logs.find((entry) => entry.includes("retained worktree cleanup failed"));
  assert.ok(warning);
  const diagnostics = JSON.stringify({ failures: result.worktreeCleanupFailures, logs: result.logs });
  for (const secret of [
    absoluteRoot,
    windowsRoot,
    "pi direct-cleanup",
    "workflow private-fragment",
    "repo mixed\\checkout",
    "mixed/separator checkout",
    "cannot remove",
  ]) {
    assert.equal(diagnostics.includes(secret), false, `result and logs omit raw prose/path fragment ${secret}`);
  }
  assert.match(result.worktreeCleanupFailures?.[0]?.message ?? "", /cleanup failed.*worktree_remove.*recovery ID/i);
});

test("hostile custom cleanup stages map to unknown on callback, log, result, and persistence surfaces", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hostile-stage-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-hostile-stage-home-"));
  const hostileStage = `${cwd}/private\ncontrol\u0000stage`;
  const worktree: Worktree = {
    isolated: true,
    cwd: join(cwd, "checkout"),
    repoRoot: cwd,
    branch: "pi/wf/hostile-stage",
    branchRef: "refs/heads/pi/wf/hostile-stage",
    baseSha: "a".repeat(40),
  };
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const hostileOperations: WorktreeOperations = {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree() {
          return [
            {
              stage: hostileStage,
              message: `hostile ${hostileStage}`,
              identity: {
                repoRoot: cwd,
                worktreePath: worktree.cwd,
                branchRef: worktree.branchRef ?? "",
                baseSha: worktree.baseSha ?? "",
              },
            } as unknown as WorktreeCleanupFailure,
          ];
        },
      };
      const callbackFailures: WorktreeCleanupFailure[] = [];
      await runWorkflow(
        `export const meta = { name: 'hostile_callback_stage', description: 'callback runtime stage allowlist' }
await agent('producer', { isolation: 'worktree', retainWorktree: true })
return 'done'`,
        {
          cwd,
          persistLogs: false,
          agent: {
            async run() {
              return "ok";
            },
          },
          worktreeOperations: hostileOperations,
          onWorktreeCleanupFailure: (failure) => callbackFailures.push(failure),
        },
      );
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            return "ok";
          },
        },
        worktreeOperations: hostileOperations,
      });
      const result = await manager.runSync(
        `export const meta = { name: 'hostile_stage', description: 'runtime stage allowlist' }
await agent('producer', { isolation: 'worktree', retainWorktree: true })
return 'done'`,
      );
      const persisted = manager.getPersistence().load(result.runId ?? "");
      const surfaces = JSON.stringify({
        callbackFailures,
        result: result.worktreeCleanupFailures,
        logs: result.logs,
        live: manager.getRunMetadata(result.runId ?? ""),
        persisted,
      });

      assert.deepEqual(
        result.worktreeCleanupFailures?.map((failure) => failure.stage),
        ["unknown"],
      );
      assert.deepEqual(callbackFailures, result.worktreeCleanupFailures);
      assert.equal(persisted?.worktreeCleanupFailures?.[0]?.stage, "unknown");
      assert.match(result.worktreeCleanupFailures?.[0]?.message ?? "", /cleanup failed at unknown/i);
      assert.equal(surfaces.includes(hostileStage), false);
      assert.equal(surfaces.includes("private"), false);
      assert.equal(surfaces.includes("control"), false);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("hostile cleanup callbacks cannot mutate canonical diagnostics or any logged/result surface", async () => {
  const hostile = "/callback/injected/private-path\ncontrol-stage";
  const worktree: Worktree = {
    isolated: true,
    cwd: "/runtime-created/callback-mutation",
    repoRoot: "/runtime-created",
    branch: "pi/wf/callback-mutation",
    branchRef: "refs/heads/pi/wf/callback-mutation",
    baseSha: "c".repeat(40),
  };
  let callbackValue: WorktreeCleanupFailure | undefined;
  const result = await runWorkflow(
    `export const meta = { name: 'hostile_cleanup_callback', description: 'detached callback diagnostics' }
await agent('producer', { isolation: 'worktree', retainWorktree: true })
return { status: 'original result' }`,
    {
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree() {
          return [
            {
              stage: "worktree_remove",
              message: "canonical cleanup failure",
              identity: {
                repoRoot: worktree.repoRoot ?? "",
                worktreePath: worktree.cwd,
                branchRef: worktree.branchRef ?? "",
                baseSha: worktree.baseSha ?? "",
              },
            },
          ];
        },
      },
      onWorktreeCleanupFailure(failure) {
        callbackValue = failure;
        (failure as { stage: string }).stage = hostile;
        failure.message = hostile;
        failure.identity.branchRef = hostile;
        failure.identity.baseSha = hostile;
        failure.identity.recoveryId = hostile;
        (failure.identity as { nested?: { path: string } }).nested = { path: hostile };
      },
    },
  );

  assert.equal(callbackValue?.message, hostile, "the callback may mutate only its detached delivery value");
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { status: "original result" });
  assert.equal(result.worktreeCleanupFailures?.length, 1);
  assert.equal(result.worktreeCleanupFailures?.[0]?.stage, "worktree_remove");
  assert.equal(result.worktreeCleanupFailures?.[0]?.identity.branchRef, worktree.branchRef);
  assert.equal(result.worktreeCleanupFailures?.[0]?.identity.baseSha, worktree.baseSha);
  assert.match(result.worktreeCleanupFailures?.[0]?.identity.recoveryId ?? "", /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify({ result, logs: result.logs }).includes(hostile), false);
  assert.equal(
    result.logs.filter((entry) => entry.includes("retained worktree cleanup failed at worktree_remove")).length,
    1,
  );
});

test("cleanup callback dispatch and logs share the bounded deduplicated canonical order", async () => {
  const callbackFailures: WorktreeCleanupFailure[] = [];
  let created = 0;
  const operations: WorktreeOperations = {
    async createWorktree(_baseCwd, name) {
      const index = created++;
      return {
        isolated: true,
        cwd: `/runtime-created/bounded-callback-${index}`,
        repoRoot: "/runtime-created",
        branch: `pi/wf/${name}`,
        branchRef: `refs/heads/pi/wf/bounded-callback-${index}`,
        baseSha: index.toString(16).padStart(40, "0"),
      };
    },
    async removeWorktree(worktree) {
      const failure: WorktreeCleanupFailure = {
        stage: "worktree_remove",
        message: `unique cleanup failure for ${worktree.branchRef}`,
        identity: {
          repoRoot: worktree.repoRoot ?? "",
          worktreePath: worktree.cwd,
          branchRef: worktree.branchRef ?? "",
          baseSha: worktree.baseSha ?? "",
        },
      };
      return [failure, structuredClone(failure)];
    },
  };
  const agents = Array.from(
    { length: 25 },
    (_, index) => `await agent('producer-${index}', { isolation: 'worktree', retainWorktree: true })`,
  ).join("\n");
  const result = await runWorkflow(
    `export const meta = { name: 'bounded_cleanup_callbacks', description: 'bounded callback dispatch' }
${agents}
return 'stable result'`,
    {
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: operations,
      onWorktreeCleanupFailure(failure) {
        callbackFailures.push(failure);
      },
    },
  );
  const expectedBranchRefs = Array.from({ length: 20 }, (_, index) => `refs/heads/pi/wf/bounded-callback-${index}`);

  assert.equal(result.result, "stable result");
  assert.equal(callbackFailures.length, 20, "duplicates and overflow do not dispatch callbacks");
  assert.equal(result.worktreeCleanupFailures?.length, 20);
  assert.deepEqual(
    callbackFailures.map((failure) => failure.identity.branchRef),
    expectedBranchRefs,
  );
  assert.deepEqual(
    result.worktreeCleanupFailures?.map((failure) => failure.identity.branchRef),
    expectedBranchRefs,
  );
  assert.equal(
    result.logs.filter((entry) => entry.includes("retained worktree cleanup failed at worktree_remove")).length,
    20,
    "terminal logs preserve the bounded canonical collection",
  );
});

test("successful retained cleanup leaves public diagnostics empty", async () => {
  const worktree: Worktree = {
    isolated: true,
    cwd: "/runtime-created/successful-cleanup",
    repoRoot: "/runtime-created",
    branch: "pi/wf/successful-cleanup",
    branchRef: "refs/heads/pi/wf/successful-cleanup",
    baseSha: "f".repeat(40),
  };
  const result = await runWorkflow(
    `export const meta = { name: 'successful_cleanup', description: 'empty cleanup diagnostics' }
await agent('produce', { isolation: 'worktree', retainWorktree: true })
return 'ok'`,
    {
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree() {
          return [];
        },
      },
    },
  );

  assert.equal(result.worktreeCleanupFailures, undefined);
  assert.equal(
    result.logs.some((entry) => entry.includes("retained worktree cleanup failed")),
    false,
  );
});

test("cleanup failure diagnostics do not mask the original workflow error", async () => {
  const failures: WorktreeCleanupFailure[] = [];
  const worktree: Worktree = {
    isolated: true,
    cwd: "/runtime-created/worktree",
    repoRoot: "/runtime-created/repo",
    branch: "pi/wf/error",
    branchRef: "refs/heads/pi/wf/error",
    baseSha: "b".repeat(40),
  };
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'cleanup_error', description: 'preserve original error' }
await agent('produce', { isolation: 'worktree', retainWorktree: true })
throw new Error('original workflow failure')`,
      {
        persistLogs: false,
        agent: {
          async run() {
            return "ok";
          },
        },
        worktreeOperations: {
          async createWorktree() {
            return worktree;
          },
          async removeWorktree() {
            throw new Error("cleanup failed");
          },
        },
        onWorktreeCleanupFailure: (failure) => failures.push(failure),
        onLog(message) {
          if (message.includes("retained worktree cleanup failed")) throw new Error("warning sink failed");
        },
      },
    ),
    /original workflow failure/,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.stage, "cleanup_dispatch");
});

test("sync and async proof-disposal failures are diagnostic-only for ordinary and retained cleanup", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const lifecycle of ["ordinary", "retained"] as const) {
      for (const disposal of ["sync", "async"] as const) {
        for (const primary of ["success", "script-failure", "agent-failure"] as const) {
          const suffix = `${lifecycle}-${disposal}-${primary}`;
          const worktree: Worktree = {
            isolated: true,
            cwd: `/runtime/disposal-${suffix}`,
            repoRoot: "/runtime",
            branch: `pi/wf/disposal-${suffix}`,
            branchRef: `refs/heads/pi/wf/disposal-${suffix}`,
            baseSha: "d".repeat(40),
          };
          const failures: WorktreeCleanupFailure[] = [];
          const operations: WorktreeOperations = {
            async createWorktree() {
              return worktree;
            },
            async removeWorktree(candidate) {
              return [
                {
                  stage: "worktree_remove",
                  message: `terminal remove failure ${suffix}`,
                  identity: {
                    repoRoot: candidate.repoRoot ?? "",
                    worktreePath: candidate.cwd,
                    branchRef: candidate.branchRef ?? "",
                    baseSha: candidate.baseSha ?? "",
                  },
                },
              ];
            },
            disposeWorktreeProofs:
              disposal === "sync"
                ? () => {
                    throw new Error(`sync proof disposal failure ${suffix} ${"x".repeat(5000)}`);
                  }
                : async () => {
                    throw new Error(`async proof disposal failure ${suffix} ${"x".repeat(5000)}`);
                  },
          };
          const run = runWorkflow(
            `export const meta = { name: 'proof_disposal_failure', description: 'non-masking proof disposal' }
${
  primary === "script-failure"
    ? `await agent('work', { isolation: 'worktree'${lifecycle === "retained" ? ", retainWorktree: true" : ""} })\nthrow new Error('original script failure')`
    : `return await agent('work', { isolation: 'worktree'${lifecycle === "retained" ? ", retainWorktree: true" : ""} })`
}`,
            {
              persistLogs: false,
              worktreeOperations: operations,
              agent: {
                async run() {
                  if (primary === "agent-failure") {
                    throw new WorkflowError("original agent failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
                      recoverable: false,
                    });
                  }
                  return "successful result";
                },
              },
              onWorktreeCleanupFailure: (failure) => failures.push(failure),
            },
          );

          if (primary === "script-failure") {
            await assert.rejects(run, /original script failure/);
          } else if (primary === "agent-failure") {
            await assert.rejects(run, /original agent failure/);
          } else {
            const result = await run;
            assert.equal(
              lifecycle === "retained" ? (result.result as { result: string }).result : result.result,
              "successful result",
            );
            assert.equal(result.worktreeCleanupFailures?.length, 2);
          }
          assert.deepEqual(
            failures.map((failure) => failure.stage),
            ["worktree_remove", "cleanup_dispatch"],
          );
          assert.ok(failures.every((failure) => failure.message.length <= 1024));
          assert.match(failures[1]?.message ?? "", /cleanup failed.*cleanup_dispatch.*recovery ID/i);
        }
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("manager stop and provider-limit pause clean retained worktrees after settlement", async () => {
  await withFakeHomeAsync(mkdtempSync(join(tmpdir(), "pi-retained-home-")), async () => {
    for (const mode of ["stop", "provider-limit"] as const) {
      const { repo, cleanup } = createGitRepo(`pi-manager-${mode}-`);
      const gate = deferred<string>();
      let consumerStarted = false;
      let worktreeCwd = "";
      try {
        const manager = new WorkflowManager({
          cwd: repo,
          agent: {
            async run(prompt: string, options: AgentRunOptions) {
              worktreeCwd = options.cwd ?? worktreeCwd;
              if (prompt === "produce") return "ready";
              consumerStarted = true;
              if (mode === "provider-limit") {
                throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
              }
              return gate.promise;
            },
          },
        });
        const { runId, promise } = manager.startInBackground(
          `export const meta = { name: 'managed_cleanup', description: 'managed terminal cleanup' }
const produced = await agent('produce', { isolation: 'worktree', retainWorktree: true })
return await agent('consumer', { worktree: produced.worktree })`,
        );
        await waitFor(() => consumerStarted);
        if (mode === "stop") {
          assert.equal(manager.stop(runId), true);
          assert.equal(existsSync(worktreeCwd), true);
          gate.resolve("settled");
        }
        await assert.rejects(promise);
        assert.equal(manager.getRun(runId)?.status, mode === "stop" ? "aborted" : "paused");
        assert.equal(existsSync(worktreeCwd), false);
        assertNoWorktreeLeaks(repo);
      } finally {
        gate.resolve("settled");
        cleanup();
      }
    }
  });
});

test("failed retained git worktree add rollback is terminal and persists bounded recovery identity", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-create-recovery-home-"));
  const { repo, cleanup } = createGitRepo("pi-create-recovery-manager-");
  let leakedPath = "";
  let leakedBranch = "";
  let agentStarted = false;
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd: repo,
        agent: {
          async run() {
            agentStarted = true;
            return "must not run";
          },
        },
        worktreeOperations: {
          async createWorktree(baseCwd, name) {
            const windowsSecret = "C:\\Users\\creation-private-fragment\\checkout";
            const worktree = await createWorktreeLive(baseCwd, name, {
              async execGit(args) {
                if (args.includes("worktree") && args.includes("add")) {
                  execFileSync("git", args, { stdio: "pipe" });
                  throw new Error(`injected git worktree add failure ${"f".repeat(5000)}`);
                }
                return { stdout: execFileSync("git", args, { encoding: "utf8" }) };
              },
              creationCleanupHooks: {
                afterBranchClaim() {
                  throw new Error(
                    `injected retained creation cleanup failure at ${baseCwd}/creation-private-fragment and ${windowsSecret} ${"w".repeat(5000)}`,
                  );
                },
              },
            });
            const recoveryIdentity = worktree.recoveryFailures?.[0]?.identity;
            leakedBranch = recoveryIdentity?.branchRef.replace(/^refs\/heads\//, "") ?? "";
            leakedPath =
              execFileSync("git", ["-C", baseCwd, "worktree", "list", "--porcelain"], { encoding: "utf8" })
                .split("\n")
                .find((line) => line.startsWith("worktree ") && line.slice("worktree ".length) !== baseCwd)
                ?.slice("worktree ".length) ?? "";
            return worktree;
          },
          removeWorktree: DEFAULT_WORKTREE_OPERATIONS.removeWorktree,
        },
      });
      manager.on("error", () => {});
      const { runId, promise } = manager.startInBackground(
        `export const meta = { name: 'creation_recovery_failure', description: 'persist leaked identity' }
return await agent('retained', { isolation: 'worktree', retainWorktree: true })`,
      );

      await assert.rejects(promise, /rollback|recovery|worktree add/i);
      const persisted = manager.getPersistence().load(runId);
      assert.equal(persisted?.status, "failed");
      assert.equal(agentStarted, false);
      assert.deepEqual(
        persisted?.worktreeCleanupFailures?.map((failure) => failure.stage),
        ["cleanup_dispatch"],
      );
      for (const failure of persisted?.worktreeCleanupFailures ?? []) {
        assert.match(failure.identity.recoveryId ?? "", /^[0-9a-f]{64}$/);
        assert.equal(failure.identity.branchRef, `refs/heads/${leakedBranch}`);
        assert.equal(
          failure.identity.baseSha,
          execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        );
        assert.ok(failure.message.length <= 1024);
      }
      const publicDiagnostics = JSON.stringify({
        failures: persisted?.worktreeCleanupFailures,
        logs: persisted?.logs,
        live: manager.getRun(runId)?.worktreeCleanupFailures,
      });
      for (const secret of [repo, leakedPath, basename(repo), "creation-private-fragment", "Users"]) {
        assert.equal(publicDiagnostics.includes(secret), false, `creation diagnostics omit ${secret}`);
      }
      assert.equal(manager.getRun(runId)?.result, undefined, "no retained result or reusable handle is exposed");
      assert.equal(publicDiagnostics.includes("worktreeHandle"), false);
    });
  } finally {
    if (leakedPath && existsSync(leakedPath)) {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", leakedPath], { stdio: "pipe" });
    }
    if (leakedBranch) {
      execFileSync("git", ["-C", repo, "branch", "-D", leakedBranch], { stdio: "ignore" });
    }
    cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("identity-verification cleanup failures persist with the terminal run status", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-identity-failure-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-identity-failure-home-"));
  const worktree: Worktree = {
    isolated: true,
    cwd: join(cwd, ".fake-identity-worktree"),
    repoRoot: cwd,
    branch: "pi/wf/identity-failure",
    branchRef: "refs/heads/pi/wf/identity-failure",
    baseSha: "c".repeat(40),
  };
  const hostilePosixPath = `${cwd}/customer project [draft],; 'single' "double"/mixed\\separator checkout`;
  const hostileWindowsPath = "C:\\Users\\customer project [draft],; 'single' \"double\"\\mixed/separator checkout";
  const identityFailure: WorktreeCleanupFailure = {
    stage: "identity_verification",
    message: `registered marker failed at ${hostilePosixPath}; then ${hostileWindowsPath}`,
    identity: {
      repoRoot: cwd,
      worktreePath: worktree.cwd,
      branchRef: worktree.branchRef ?? "",
      baseSha: worktree.baseSha ?? "",
    },
  };
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            return "ok";
          },
        },
        worktreeOperations: {
          async createWorktree() {
            return worktree;
          },
          async removeWorktree() {
            return [identityFailure];
          },
        },
      });
      const result = await manager.runSync(
        `export const meta = { name: 'identity_failure', description: 'durable cleanup failure' }
await agent('producer', { isolation: 'worktree', retainWorktree: true })
return 'completed result'`,
      );

      assert.equal(result.result, "completed result");
      const expectedPublicFailure = result.worktreeCleanupFailures?.[0];
      assert.ok(expectedPublicFailure);
      assert.match(expectedPublicFailure.identity.recoveryId ?? "", /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(expectedPublicFailure).includes(cwd), false);
      assert.equal(expectedPublicFailure.identity.repoRoot, undefined);
      assert.equal(expectedPublicFailure.identity.worktreePath, undefined);
      assert.match(expectedPublicFailure.message, /cleanup failed.*identity_verification.*recovery ID/i);
      const everyLiveSurface = JSON.stringify({
        result: result.worktreeCleanupFailures,
        logs: result.logs,
        callback: manager.getRun(result.runId ?? "")?.worktreeCleanupFailures,
      });
      for (const fragment of [
        hostilePosixPath,
        hostileWindowsPath,
        "customer project",
        "mixed\\separator checkout",
        "mixed/separator checkout",
        "registered marker failed",
      ]) {
        assert.equal(everyLiveSurface.includes(fragment), false, `live public surfaces omit ${fragment}`);
      }
      assert.deepEqual(result.worktreeCleanupFailures, [expectedPublicFailure]);
      assert.equal(
        result.logs.some((entry) => entry.includes("retained worktree cleanup failed")),
        true,
      );
      assert.doesNotMatch(result.logs.join("\n"), new RegExp(cwd));
      assert.deepEqual(manager.getRun(result.runId ?? "")?.worktreeCleanupFailures, [expectedPublicFailure]);
      assert.deepEqual(manager.getRun(result.runId ?? "")?.result?.worktreeCleanupFailures, [expectedPublicFailure]);
      const persisted = manager.getPersistence().load(result.runId ?? "");
      assert.equal(persisted?.status, "completed", "terminal status is durably saved");
      assert.deepEqual(persisted?.worktreeCleanupFailures, [expectedPublicFailure]);
      assert.deepEqual(manager.listRuns().find((run) => run.runId === result.runId)?.worktreeCleanupFailures, [
        expectedPublicFailure,
      ]);
      assert.deepEqual(manager.getRunMetadata(result.runId ?? "")?.worktreeCleanupFailures, [expectedPublicFailure]);
      assert.deepEqual(manager.listRunMetadata().find((run) => run.runId === result.runId)?.worktreeCleanupFailures, [
        expectedPublicFailure,
      ]);

      const coldManager = new WorkflowManager({ cwd });
      assert.equal(
        coldManager.getRun(result.runId ?? ""),
        undefined,
        "getRun remains live/in-memory only after restart",
      );
      assert.deepEqual(coldManager.getRunMetadata(result.runId ?? "")?.worktreeCleanupFailures, [
        expectedPublicFailure,
      ]);
      assert.deepEqual(
        coldManager.listRunMetadata().find((run) => run.runId === result.runId)?.worktreeCleanupFailures,
        [expectedPublicFailure],
      );
      assert.deepEqual(coldManager.listRuns().find((run) => run.runId === result.runId)?.worktreeCleanupFailures, [
        expectedPublicFailure,
      ]);
      const everyColdSurface = JSON.stringify({
        persisted: coldManager.listRuns(),
        status: coldManager.getRunMetadata(result.runId ?? ""),
      });
      for (const fragment of [hostilePosixPath, hostileWindowsPath, "customer project", "registered marker failed"]) {
        assert.equal(everyColdSurface.includes(fragment), false, `cold public/persisted surfaces omit ${fragment}`);
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("warm resume returns and persists the bounded stable union of prior and new cleanup failures", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cleanup-union-warm-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-cleanup-union-warm-home-"));
  let failAgent = true;
  let cleanupGeneration = 0;
  const worktree: Worktree = {
    isolated: true,
    cwd: join(cwd, "checkout"),
    repoRoot: cwd,
    branch: "pi/wf/cleanup-union-warm",
    branchRef: "refs/heads/pi/wf/cleanup-union-warm",
    baseSha: "a".repeat(40),
  };
  const failure = (stage: WorktreeCleanupFailure["stage"], marker: string): WorktreeCleanupFailure => ({
    stage,
    message: `raw ${marker} at ${cwd}/private project [x],; 'quoted'/checkout`,
    identity: {
      repoRoot: cwd,
      worktreePath: worktree.cwd,
      branchRef: worktree.branchRef ?? "",
      baseSha: worktree.baseSha ?? "",
    },
  });
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            if (failAgent) throw new Error("first generation fails");
            return "resumed-success";
          },
        },
        worktreeOperations: {
          async createWorktree() {
            return worktree;
          },
          async removeWorktree() {
            cleanupGeneration++;
            if (cleanupGeneration === 1) return [failure("worktree_remove", "prior")];
            return [failure("worktree_remove", "prior duplicate"), failure("branch_delete", "new")];
          },
        },
      });
      manager.on("error", () => {});
      const { runId, promise } = manager.startInBackground(
        `export const meta = { name: 'cleanup_union_warm', description: 'cleanup union' }
const value = await agent('work', { isolation: 'worktree' })
if (value === null) throw new Error('first generation fails')
return value`,
      );
      await assert.rejects(promise, /first generation fails/);
      assert.equal(manager.getRun(runId)?.worktreeCleanupFailures?.length, 1);

      failAgent = false;
      const completed = new Promise<void>((resolve) => manager.once("complete", () => resolve()));
      assert.equal(await manager.resume(runId), true);
      await completed;

      const live = manager.getRun(runId);
      assert.equal(live?.status, "completed");
      assert.deepEqual(
        live?.result?.worktreeCleanupFailures?.map((entry) => entry.stage),
        ["worktree_remove", "branch_delete"],
      );
      assert.deepEqual(live?.worktreeCleanupFailures, live?.result?.worktreeCleanupFailures);
      assert.deepEqual(
        manager.getPersistence().load(runId)?.worktreeCleanupFailures,
        live?.result?.worktreeCleanupFailures,
      );
      assert.deepEqual(manager.getRunMetadata(runId)?.worktreeCleanupFailures, live?.result?.worktreeCleanupFailures);
      assert.match(live?.snapshot.logs.join("\n") ?? "", /2 retained worktree cleanup failure/i);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("cold background resume delivers prior persisted cleanup failures after a clean successful execution", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cleanup-union-cold-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-cleanup-union-cold-home-"));
  const runId = "cold-cleanup-union";
  const prior: WorktreeCleanupFailure = {
    stage: "cleanup_dispatch",
    message: `raw prior failure at ${cwd}/private project [x],; 'quoted'/checkout`,
    identity: {
      repoRoot: cwd,
      worktreePath: join(cwd, "checkout"),
      branchRef: "refs/heads/pi/wf/cold-cleanup-union",
      baseSha: "b".repeat(40),
    },
  };
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const seed = new WorkflowManager({ cwd });
      seed.getPersistence().save({
        runId,
        workflowName: "cold_cleanup_union",
        script: `export const meta = { name: 'cold_cleanup_union', description: 'cold cleanup union' }
return await agent('work')`,
        status: "failed",
        phases: [],
        agents: [],
        logs: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        worktreeCleanupFailures: [prior],
      });

      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            return "clean-success";
          },
        },
      });
      assert.equal(manager.getRun(runId), undefined);
      let delivered: WorktreeCleanupFailure[] | undefined;
      const completed = new Promise<void>((resolve) => {
        manager.once("complete", ({ result }: { result: { worktreeCleanupFailures?: WorktreeCleanupFailure[] } }) => {
          delivered = result.worktreeCleanupFailures;
          resolve();
        });
      });
      assert.equal(await manager.resume(runId), true);
      await completed;

      assert.equal(delivered?.length, 1);
      assert.deepEqual(manager.getRun(runId)?.result?.worktreeCleanupFailures, delivered);
      assert.deepEqual(manager.getRun(runId)?.worktreeCleanupFailures, delivered);
      assert.deepEqual(manager.getPersistence().load(runId)?.worktreeCleanupFailures, delivered);
      assert.deepEqual(manager.getRunMetadata(runId)?.worktreeCleanupFailures, delivered);
      assert.match(manager.getRun(runId)?.snapshot.logs.join("\n") ?? "", /1 retained worktree cleanup failure/i);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("cleanup failures are bounded and persisted without a reusable handle", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cleanup-failure-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-cleanup-failure-home-"));
  let created = 0;
  const createdBranchRefs: string[] = [];
  const operations: WorktreeOperations = {
    async createWorktree(_baseCwd: string, name: string): Promise<Worktree> {
      created++;
      const branchRef = `refs/heads/pi/wf/${name}`;
      createdBranchRefs.push(branchRef);
      return {
        isolated: true,
        cwd: join(cwd, `.fake-worktree-${created}`),
        repoRoot: cwd,
        branch: `pi/wf/${name}`,
        branchRef,
        baseSha: "a".repeat(40),
      };
    },
    async removeWorktree(worktree: Worktree): Promise<WorktreeCleanupFailure[]> {
      const failure: WorktreeCleanupFailure = {
        stage: "worktree_remove",
        message: `cannot remove ${"x".repeat(5000)}`,
        identity: {
          repoRoot: worktree.repoRoot ?? "",
          worktreePath: worktree.cwd,
          branchRef: worktree.branchRef ?? "",
          baseSha: worktree.baseSha ?? "",
        },
      };
      return [failure, structuredClone(failure)];
    },
  };
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            return "ok";
          },
        },
        worktreeOperations: operations,
      });
      const agents = Array.from(
        { length: 25 },
        (_, index) => `await agent('producer-${index}', { isolation: 'worktree', retainWorktree: true })`,
      ).join("\n");
      const result = await manager.runSync(
        `export const meta = { name: 'cleanup_failures', description: 'bounded cleanup metadata' }
${agents}
return 'original result'`,
      );
      assert.equal(result.result, "original result", "cleanup failure does not mask workflow success");
      const persisted = manager.getPersistence().load(result.runId ?? "");
      assert.equal(persisted?.worktreeCleanupFailures?.length, 20);
      assert.equal(result.worktreeCleanupFailures?.length, 20);
      assert.equal(manager.getRun(result.runId ?? "")?.worktreeCleanupFailures?.length, 20);
      assert.deepEqual(persisted?.worktreeCleanupFailures, result.worktreeCleanupFailures);
      assert.deepEqual(
        persisted?.worktreeCleanupFailures?.map((failure) => failure.identity.branchRef),
        createdBranchRefs.slice(0, 20),
      );
      assert.ok((persisted?.worktreeCleanupFailures?.[0]?.message.length ?? 0) <= 1024);
      const serialized = JSON.stringify(persisted?.worktreeCleanupFailures);
      assert.equal(serialized.includes("retain_consume"), false);
      assert.equal(serialized.includes("worktreeHandle"), false);
      assert.match(serialized, /worktree_remove/);
      assert.match(serialized, /"recoveryId":"[0-9a-f]{64}"/);
      assert.equal(serialized.includes(cwd), false);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
