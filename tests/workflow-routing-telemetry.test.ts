import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions, ResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  type AgentTelemetry,
  resolveModelAlias,
  WorkflowAgent,
  type WorkflowResourceLoaderOptions,
} from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { saveModelTierConfig } from "../src/model-tier-config.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { formatWorkflowReport } from "../src/workflow-report.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const targetModel = { provider: "mock", id: "target", name: "Target" } as Model<any>;
const fallbackModel = { provider: "mock", id: "fallback", name: "Fallback" } as Model<any>;

function registry(...models: Model<any>[]) {
  return {
    getAll: () => models,
    getAvailable: () => models,
    find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
  } as any;
}

function fakeLoader(
  skills = ["skill-a"],
  context = [{ path: "AGENTS.md", content: "project context" }],
): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: {} }) as any,
    getSkills: () =>
      ({
        skills: skills.map((name) => ({ name })),
        diagnostics: [],
      }) as any,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: context }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function fakeSessionFactory(captured: CreateAgentSessionOptions[], sessionModel: Model<any> = fallbackModel) {
  return async (options: CreateAgentSessionOptions) => {
    captured.push(options);
    const session = {
      model: options.model ?? sessionModel,
      thinkingLevel: options.thinkingLevel ?? "high",
      systemPrompt: "system prompt",
      messages: [] as unknown[],
      prompt: async () => {
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
      },
      abort: async () => {},
      subscribe: () => () => {},
      getActiveToolNames: () => ["read", "context_search"],
      getSessionStats: () => ({
        tokens: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, total: 37 },
        cost: 0.0123,
      }),
      dispose: () => {},
    };
    return { session, extensionsResult: fakeLoader().getExtensions() } as any;
  };
}

test("resolveModelAlias uses exact case-insensitive aliases and leaves concrete/non-aliased specs unchanged", () => {
  const aliases = { haiku: "openai-codex/gpt-5.6-luna" };
  assert.equal(resolveModelAlias("haiku", aliases), "openai-codex/gpt-5.6-luna");
  assert.equal(resolveModelAlias(" HAIKU ", aliases), "openai-codex/gpt-5.6-luna");
  assert.equal(resolveModelAlias("openai-codex/gpt-5.6-luna", aliases), "openai-codex/gpt-5.6-luna");
  assert.equal(resolveModelAlias("sonnet", aliases), "sonnet");
});

test("WorkflowAgent resolves aliases before model parsing and captures exact live telemetry", async () => {
  const sessions: CreateAgentSessionOptions[] = [];
  const loaderOptions: WorkflowResourceLoaderOptions[] = [];
  const telemetry: AgentTelemetry[] = [];
  const agent = new WorkflowAgent({
    cwd: "/tmp",
    modelRegistry: registry(targetModel, fallbackModel),
    modelAliases: { haiku: "mock/target" },
    sessionFactory: fakeSessionFactory(sessions),
    resourceLoaderFactory: (options) => {
      loaderOptions.push(options);
      return fakeLoader();
    },
  });

  const result = await agent.run("do it", {
    model: "HAIKU",
    effort: "medium",
    onTelemetry: (value) => telemetry.push(value),
  });

  assert.equal(result, "done");
  assert.equal(sessions[0].model, targetModel, "alias target must resolve before fuzzy matching the alias name");
  assert.equal(loaderOptions[0].noSkills, undefined, "default behavior keeps skills enabled");
  assert.deepEqual(telemetry, [
    {
      execution: "live",
      requestedModelSpec: "HAIKU",
      resolvedModel: "mock/target",
      effectiveThinkingLevel: "medium",
      skillsEnabled: true,
      loadedSkillCount: 1,
      activeToolNames: ["read", "context_search"],
      activeToolCount: 2,
      systemPromptChars: 13,
      projectContextFileCount: 1,
      projectContextChars: 15,
      usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, total: 37, cost: 0.0123 },
    },
  ]);
});

test("WorkflowAgent strict resolution fails non-recoverably while non-strict mode falls back", async () => {
  const strictSessions: CreateAgentSessionOptions[] = [];
  const strictAgent = new WorkflowAgent({
    cwd: "/tmp",
    modelRegistry: registry(targetModel),
    strictModelResolution: true,
    sessionFactory: fakeSessionFactory(strictSessions),
    resourceLoaderFactory: () => fakeLoader(),
  });
  await assert.rejects(
    () => strictAgent.run("do it", { model: "missing-symbol" }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      error.recoverable === false,
  );
  await assert.rejects(
    () => strictAgent.run("do it", { model: "mock/not-configured" }),
    (error) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    "strict mode must reject the parser's synthetic custom-model fallback too",
  );
  assert.equal(strictSessions.length, 0, "strict failure must happen before session creation");

  const fallbackSessions: CreateAgentSessionOptions[] = [];
  const fallbackTelemetry: AgentTelemetry[] = [];
  const fallbackAgent = new WorkflowAgent({
    cwd: "/tmp",
    modelRegistry: registry(targetModel),
    sessionFactory: fakeSessionFactory(fallbackSessions, fallbackModel),
    resourceLoaderFactory: () => fakeLoader(),
  });
  assert.equal(
    await fallbackAgent.run("do it", {
      model: "missing-symbol",
      onTelemetry: (value) => fallbackTelemetry.push(value),
    }),
    "done",
  );
  assert.equal(fallbackSessions[0].model, undefined, "non-strict fallback leaves the session model unset");
  assert.equal(fallbackTelemetry[0].requestedModelSpec, "missing-symbol");
  assert.equal(fallbackTelemetry[0].resolvedModel, "mock/fallback");
});

test("skills:false creates and reloads a noSkills loader without disabling tools/extensions", async () => {
  const sessions: CreateAgentSessionOptions[] = [];
  const loaderOptions: WorkflowResourceLoaderOptions[] = [];
  let reloads = 0;
  const loader = fakeLoader([], [{ path: "AGENTS.md", content: "ctx" }]);
  loader.reload = async () => {
    reloads++;
  };
  const telemetry: AgentTelemetry[] = [];
  const agent = new WorkflowAgent({
    cwd: "/tmp",
    modelRegistry: registry(targetModel),
    sessionFactory: fakeSessionFactory(sessions, targetModel),
    resourceLoaderFactory: (options) => {
      loaderOptions.push(options);
      return loader;
    },
  });

  await agent.run("do it", { skills: false, onTelemetry: (value) => telemetry.push(value) });

  assert.equal(loaderOptions[0].noSkills, true);
  assert.equal(loaderOptions[0].noExtensions, undefined);
  assert.equal(loaderOptions[0].noContextFiles, undefined);
  assert.equal(reloads, 1);
  assert.equal(sessions[0].resourceLoader, loader);
  assert.equal(telemetry[0].skillsEnabled, false);
  assert.equal(telemetry[0].loadedSkillCount, 0);
  assert.deepEqual(telemetry[0].activeToolNames, ["read", "context_search"]);
});

test("default skills behavior preserves an explicitly injected resource loader", async () => {
  const loader = fakeLoader();
  const sessions: CreateAgentSessionOptions[] = [];
  let factoryCalls = 0;
  const agent = new WorkflowAgent({
    cwd: "/tmp",
    modelRegistry: registry(targetModel),
    session: { resourceLoader: loader },
    sessionFactory: fakeSessionFactory(sessions),
    resourceLoaderFactory: () => {
      factoryCalls++;
      return fakeLoader();
    },
  });

  await agent.run("do it", { skills: true });
  assert.equal(factoryCalls, 0);
  assert.equal(sessions[0].resourceLoader, loader);
});

test("skills:false rejects an explicitly injected resource loader instead of claiming enforcement", async () => {
  const agent = new WorkflowAgent({
    cwd: "/tmp",
    modelRegistry: registry(targetModel),
    session: { resourceLoader: fakeLoader() },
    sessionFactory: fakeSessionFactory([]),
  });

  await assert.rejects(
    () => agent.run("do it", { skills: false }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      /resourceLoader/.test(error.message),
  );
});

test("an unrelated alias change does not invalidate resume while the used alias still replays", async () => {
  const script = `export const meta = { name: 'alias_resume_unrelated', description: 'routing identity' }
return await agent('task', { label: 'worker', model: 'haiku' })`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };

  await runWorkflow(script, {
    agent: runner,
    modelAliases: { haiku: "mock/one", sonnet: "mock/sonnet" },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  await runWorkflow(script, {
    agent: runner,
    modelAliases: { haiku: "mock/one", sonnet: "mock/changed" },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(calls, 1, "unrelated alias changes must not invalidate the used call");
});

test("an alias target change invalidates resume while unchanged aliases replay", async () => {
  const script = `export const meta = { name: 'alias_resume', description: 'routing identity' }
return await agent('task', { label: 'worker', model: 'haiku' })`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };

  await runWorkflow(script, {
    agent: runner,
    modelAliases: { haiku: "mock/one" },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  await runWorkflow(script, {
    agent: runner,
    modelAliases: { haiku: "mock/one" },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(calls, 1, "unchanged alias configuration replays the journal");

  await runWorkflow(script, {
    agent: runner,
    modelAliases: { haiku: "mock/two" },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(calls, 2, "changed alias target must force a live rerun");
});

test("configured tier and implicit medium route changes invalidate replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-route-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      let calls = 0;
      const runner = {
        async run() {
          calls++;
          return `result-${calls}`;
        },
      };
      for (const [name, options] of [
        ["explicit-tier", ", { tier: 'small' }"],
        ["implicit-medium", ""],
      ] as const) {
        saveModelTierConfig({ tiers: { small: "mock/small-one", medium: "mock/medium-one" } });
        const script = `export const meta = { name: '${name}', description: 'route identity' }
return await agent('constant prompt'${options})`;
        const journal: JournalEntry[] = [];
        await runWorkflow(script, {
          agent: runner,
          persistLogs: false,
          onAgentJournal: (entry) => journal.push(entry),
        });
        saveModelTierConfig({ tiers: { small: "mock/small-two", medium: "mock/medium-two" } });
        await runWorkflow(script, {
          agent: runner,
          persistLogs: false,
          resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
        });
      }
      assert.equal(calls, 4, "each changed effective tier target must rerun live");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("untagged agents invalidate replay when the session main model changes without tier config", async () => {
  const script = `export const meta = { name: 'main-model-route', description: 'main model identity' }
return await agent('constant prompt')`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };

  await runWorkflow(script, {
    agent: runner,
    mainModel: "mock/a",
    modelTierConfig: null,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  await runWorkflow(script, {
    agent: runner,
    mainModel: "mock/b",
    modelTierConfig: null,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.equal(calls, 2, "the changed session default route must rerun the untagged agent");
});

test("untagged agents invalidate replay when the effective host session model changes", async () => {
  const script = `export const meta = { name: 'session-model-route', description: 'session model identity' }
return await agent('constant prompt')`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };
  const firstModel = { provider: "mock", id: "session-a", name: "Session A" } as Model<any>;
  const secondModel = { provider: "mock", id: "session-b", name: "Session B" } as Model<any>;

  await runWorkflow(script, {
    agent: runner,
    session: { model: firstModel, thinkingLevel: "low" },
    modelTierConfig: null,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  await runWorkflow(script, {
    agent: runner,
    session: { model: secondModel, thinkingLevel: "low" },
    modelTierConfig: null,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.equal(calls, 2, "changing the actual session default model must invalidate replay");
});

test("untagged replay uses the host session model instead of the mainModel tier fallback", async () => {
  const script = `export const meta = { name: 'host-session-route', description: 'host session route identity' }
return await agent('constant prompt')`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };
  const firstModel = { provider: "mock", id: "session-a", name: "Session A" } as Model<any>;
  const secondModel = { provider: "mock", id: "session-b", name: "Session B" } as Model<any>;

  await runWorkflow(script, {
    agent: runner,
    mainModel: "mock/tier-fallback",
    session: { model: firstModel },
    modelTierConfig: null,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  await runWorkflow(script, {
    agent: runner,
    mainModel: "mock/tier-fallback",
    session: { model: secondModel },
    modelTierConfig: null,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.equal(calls, 2, "the changed host session default must rerun an untagged agent");
});

test("tier fallback replay remains bound to mainModel when the host session model changes", async () => {
  const script = `export const meta = { name: 'tier-fallback-route', description: 'tier fallback identity' }
return await agent('constant prompt', { tier: 'custom' })`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };
  const firstModel = { provider: "mock", id: "session-a", name: "Session A" } as Model<any>;
  const secondModel = { provider: "mock", id: "session-b", name: "Session B" } as Model<any>;
  const tierConfig = { tiers: { medium: "mock/medium" } };

  await runWorkflow(script, {
    agent: runner,
    mainModel: "mock/tier-fallback",
    session: { model: firstModel },
    modelTierConfig: tierConfig,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  await runWorkflow(script, {
    agent: runner,
    mainModel: "mock/tier-fallback",
    session: { model: secondModel },
    modelTierConfig: tierConfig,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.equal(calls, 1, "an unconfigured explicit tier must keep using the stable mainModel fallback");
});

test("args and inherited thinking, retry, and timeout policy participate in replay identity", async () => {
  const script = `export const meta = { name: 'policy-hash', description: 'policy identity' }
return await agent('constant prompt')`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `result-${calls}`;
    },
  };
  await runWorkflow(script, {
    agent: runner,
    args: { version: 1 },
    agentRetries: 0,
    agentTimeoutMs: 100,
    session: { thinkingLevel: "low" },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  const replayJournal = new Map(journal.map((entry) => [entry.index, entry]));
  await runWorkflow(script, {
    agent: runner,
    args: { version: 2 },
    agentRetries: 0,
    agentTimeoutMs: 100,
    session: { thinkingLevel: "low" },
    persistLogs: false,
    resumeJournal: replayJournal,
  });
  await runWorkflow(script, {
    agent: runner,
    args: { version: 1 },
    agentRetries: 1,
    agentTimeoutMs: 100,
    session: { thinkingLevel: "low" },
    persistLogs: false,
    resumeJournal: replayJournal,
  });
  await runWorkflow(script, {
    agent: runner,
    args: { version: 1 },
    agentRetries: 0,
    agentTimeoutMs: 200,
    session: { thinkingLevel: "low" },
    persistLogs: false,
    resumeJournal: replayJournal,
  });
  await runWorkflow(script, {
    agent: runner,
    args: { version: 1 },
    agentRetries: 0,
    agentTimeoutMs: 100,
    session: { thinkingLevel: "high" },
    persistLogs: false,
    resumeJournal: replayJournal,
  });
  assert.equal(calls, 5, "every result-affecting execution identity change must rerun live");
});

test("WorkflowManager persists live telemetry and replay telemetry from the journal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-telemetry-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-telemetry-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      let calls = 0;
      const runner = {
        async run(_prompt: string, options: any) {
          calls++;
          options.onTelemetry?.({
            execution: "live",
            requestedModelSpec: options.model,
            resolvedModel: "mock/target",
            effectiveThinkingLevel: "high",
            skillsEnabled: false,
            loadedSkillCount: 0,
            activeToolNames: ["read"],
            activeToolCount: 1,
            systemPromptChars: 200,
            projectContextFileCount: 1,
            projectContextChars: 50,
            usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, total: 35, cost: 0.01 },
          });
          options.onUsage?.({ input: 10, output: 5, cacheRead: 20, cacheWrite: 0, total: 35, cost: 0.01 });
          return "ok";
        },
      };
      const manager = new WorkflowManager({
        cwd,
        modelAliases: { haiku: "mock/target" },
        agent: runner,
      });
      const script = `export const meta = { name: 'telemetry', description: 'persist it' }
return await agent('task', { label: 'worker', model: 'haiku' })`;
      await manager.runSync(script);
      const first = manager.listRuns()[0];
      assert.equal(first.agents[0].telemetry?.execution, "live");
      assert.equal(first.agents[0].telemetry?.usage.cacheRead, 20);
      assert.equal(first.journal?.[0].telemetry?.resolvedModel, "mock/target");

      const replayEvents: AgentTelemetry[] = [];
      await runWorkflow(script, {
        cwd,
        concurrency: 8,
        agent: runner,
        modelAliases: { haiku: "mock/target" },
        persistLogs: false,
        resumeJournal: new Map((first.journal ?? []).map((entry) => [entry.index, entry])),
        onAgentEnd: (event) => {
          if (event.telemetry) replayEvents.push(event.telemetry);
        },
      });
      assert.equal(calls, 1);
      assert.equal(replayEvents[0].execution, "replay");
      assert.equal(replayEvents[0].usage?.total, 35, "replay uses persisted exact usage rather than fabricating zero");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("timeout retries wait for delayed abort settlement and keep exact attempt telemetry isolated", async () => {
  let attempts = 0;
  const events: any[] = [];
  const runner = {
    run(_prompt: string, options: any) {
      attempts++;
      if (attempts === 1) {
        return new Promise<string>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                const usage = { input: 7, output: 4, cacheRead: 0, cacheWrite: 0, total: 11, cost: 0.001 };
                options.onUsage?.(usage);
                options.onTelemetry?.({ execution: "live", resolvedModel: "mock/first", usage });
                reject(new Error("first attempt aborted"));
              }, 15);
            },
            { once: true },
          );
        });
      }
      return new Promise<string>((resolve) => {
        setTimeout(() => {
          const usage = { input: 13, output: 10, cacheRead: 0, cacheWrite: 0, total: 23, cost: 0.002 };
          options.onUsage?.(usage);
          options.onTelemetry?.({ execution: "live", resolvedModel: "mock/second", usage });
          resolve("ok");
        }, 30);
      });
    },
  };
  const script = `export const meta = { name: 'retry-telemetry', description: 'attempt isolation' }
return await agent('task', { label: 'worker', timeoutMs: 5, retries: 1 })`;

  const result = await runWorkflow(script, {
    agent: runner,
    persistLogs: false,
    onAgentEnd: (event) => events.push(event),
  });

  assert.equal(attempts, 2);
  assert.equal(result.tokenUsage.total, 34, "both settled attempts must be accounted exactly once");
  assert.equal(events[0].telemetry.resolvedModel, "mock/second", "the retry owns final route telemetry");
  assert.equal(events[0].telemetry.usage.total, 34, "per-agent usage includes both isolated attempts");
  assert.equal(events[0].telemetry.accountingStatus, "exact");
  assert.equal(events[0].telemetry.accountingIncompleteAttempts, undefined);
});

test("timeout retries persist incomplete accounting and ignore callbacks after bounded cleanup grace", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-incomplete-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-incomplete-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      let attempts = 0;
      const runner = {
        run(_prompt: string, options: any) {
          attempts++;
          if (attempts === 1) {
            return new Promise<string>((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => {
                  setTimeout(() => {
                    const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 1 };
                    options.onModelResolved?.("mock/late-display");
                    options.onUsage?.(usage);
                    options.onTelemetry?.({ execution: "live", resolvedModel: "mock/late", usage });
                    reject(new Error("late abort settlement"));
                  }, 75);
                },
                { once: true },
              );
            });
          }
          options.onModelResolved?.("mock/retry-display");
          return new Promise<string>((resolve) => {
            setTimeout(() => {
              const usage = { input: 13, output: 10, cacheRead: 0, cacheWrite: 0, total: 23, cost: 0.002 };
              options.onUsage?.(usage);
              options.onTelemetry?.({ execution: "live", resolvedModel: "mock/retry", usage });
              resolve("ok");
            }, 90);
          });
        },
      };
      const script = `export const meta = { name: 'incomplete-telemetry', description: 'bounded cleanup' }
return await agent('task', { label: 'worker', timeoutMs: 100, retries: 1 })`;
      const manager = new WorkflowManager({ cwd, agent: runner });

      await manager.runSync(script);
      const runId = manager.listRuns()[0].runId;
      const captured = manager.getRunForReport(runId)?.agents[0].telemetry;
      assert.equal(captured?.resolvedModel, "mock/retry");
      assert.equal(manager.getRunForReport(runId)?.agents[0].model, "mock/retry-display");
      assert.equal(captured?.usage?.total, 23, "late timed-out usage must not be attributed to the retry");
      assert.equal(captured?.accountingStatus, "incomplete");
      assert.equal(captured?.accountingIncompleteAttempts, 1);

      await new Promise((resolve) => setTimeout(resolve, 25));
      const persisted = manager.getRunForReport(runId);
      assert.equal(
        persisted?.agents[0].telemetry?.resolvedModel,
        "mock/retry",
        "late callbacks cannot overwrite persisted telemetry",
      );
      assert.equal(persisted?.agents[0].telemetry?.usage?.total, 23, "late callbacks cannot change persisted usage");

      assert.ok(persisted);
      const report = formatWorkflowReport(persisted);
      assert.match(report, /Usage: partial \(accounting incomplete for 1 agent\)/);
      assert.match(report, /accounting incomplete \(1 attempt\)/);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("resume identity distinguishes omitted or undefined args from explicit null", async () => {
  const script = `export const meta = { name: 'args-identity', description: 'args identity' }
return await agent(args === undefined ? 'undefined' : 'null')`;
  const journal: JournalEntry[] = [];
  const prompts: string[] = [];
  const runner = {
    async run(prompt: string) {
      prompts.push(prompt);
      return prompt;
    },
  };

  await runWorkflow(script, {
    agent: runner,
    args: undefined,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  await runWorkflow(script, {
    agent: runner,
    args: null,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.deepEqual(prompts, ["undefined", "null"]);
});

test("resume hashes the canonical resolved registry route and ignores irrelevant registry additions", async () => {
  const script = `export const meta = { name: 'registry-route', description: 'registry route' }
return await agent('task', { model: 'target' })`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return `call-${calls}`;
    },
  };
  const alpha = { provider: "mock", id: "target-alpha", name: "Target Alpha" } as Model<any>;
  const zeta = { provider: "mock", id: "target-zeta", name: "Target Zeta" } as Model<any>;
  const unrelated = { provider: "other", id: "unrelated", name: "Unrelated" } as Model<any>;

  await runWorkflow(script, {
    agent: runner,
    modelRegistry: registry(alpha),
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  const replayJournal = new Map(journal.map((entry) => [entry.index, entry]));
  await runWorkflow(script, {
    agent: runner,
    modelRegistry: registry(alpha, unrelated),
    persistLogs: false,
    resumeJournal: replayJournal,
  });
  assert.equal(calls, 1, "irrelevant registry entries must not invalidate the route");

  await runWorkflow(script, {
    agent: runner,
    modelRegistry: registry(alpha, zeta),
    persistLogs: false,
    resumeJournal: replayJournal,
  });
  assert.equal(calls, 2, "a fuzzy route resolving to a different registered model must invalidate");
});

test("exact registered model ids ending in a thinking token are hashed as model ids", async () => {
  const script = `export const meta = { name: 'colon-route', description: 'colon route' }
return await agent('task', { model: 'mock/model:high' })`;
  const journal: JournalEntry[] = [];
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const exact = { provider: "mock", id: "model:high", name: "Colon Model" } as Model<any>;
  const base = { provider: "mock", id: "model", name: "Base Model" } as Model<any>;

  await runWorkflow(script, {
    agent: runner,
    modelRegistry: registry(exact, base),
    session: { thinkingLevel: "high" },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  await runWorkflow(script, {
    agent: runner,
    modelRegistry: registry(base),
    session: { thinkingLevel: "high" },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(calls, 2, "an exact colon-id route must differ from a base model plus thinking suffix");
});

test("formatWorkflowReport prefers larger persisted cumulative usage over latest-generation telemetry", () => {
  const run = {
    runId: "resumed-cumulative",
    workflowName: "resumed",
    script: "",
    status: "completed",
    phases: [],
    logs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    tokenUsage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 1, total: 23, cost: 0.03 },
    agents: [
      {
        id: 1,
        label: "rerun agent",
        prompt: "x",
        status: "done",
        telemetry: {
          execution: "live",
          accountingStatus: "incomplete",
          accountingIncompleteAttempts: 1,
          usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0.005 },
        },
      },
    ],
  } satisfies PersistedRunState;

  const report = formatWorkflowReport(run);
  assert.match(
    report,
    /Usage: partial \(accounting incomplete for 1 agent\).* input 12 .* output 8 .* total 23 .*\$0\.0300/,
  );
  assert.match(report, /accounting incomplete \(1 attempt\)/);
  assert.doesNotMatch(report.split("\n")[1], /total 5 .*\$0\.0050/);
});

test("formatWorkflowReport renders aggregate breakdown, replay/live details, tools, and zero cache denominator", () => {
  const run = {
    runId: "run-report",
    workflowName: "report-demo",
    script: "",
    status: "completed",
    phases: ["Work"],
    logs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    agents: [
      {
        id: 1,
        label: "live agent",
        phase: "Work",
        prompt: "x",
        status: "done",
        telemetry: {
          execution: "live",
          requestedModelSpec: "haiku",
          resolvedModel: "mock/target",
          effectiveThinkingLevel: "high",
          skillsEnabled: false,
          loadedSkillCount: 0,
          activeToolNames: ["read", "context_search"],
          activeToolCount: 2,
          systemPromptChars: 1200,
          projectContextFileCount: 2,
          projectContextChars: 300,
          usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0.001 },
        },
      },
      {
        id: 2,
        label: "replayed agent",
        phase: "Work",
        prompt: "y",
        status: "done",
        telemetry: {
          execution: "replay",
          requestedModelSpec: "sonnet",
          resolvedModel: "mock/other",
          effectiveThinkingLevel: "medium",
          skillsEnabled: true,
          loadedSkillCount: 3,
          activeToolNames: ["read"],
          activeToolCount: 1,
          systemPromptChars: 2400,
          projectContextFileCount: 1,
          projectContextChars: 100,
          usage: { input: 10, output: 10, cacheRead: 30, cacheWrite: 2, total: 52, cost: 0.02 },
        },
      },
      { id: 3, label: "legacy agent", phase: "Work", prompt: "z", status: "done" },
    ],
  } satisfies PersistedRunState;

  const report = formatWorkflowReport(run);
  assert.match(
    report,
    /Usage: partial \(1 agent missing usage\) .* input 10 .* output 15 .* cache read 30 .* cache write 2 .* total 57 .*\$0\.0210/,
  );
  assert.match(report, /live agent .* live .* haiku -> mock\/target .* thinking high .* skills off \(0\)/);
  assert.match(report, /cache n\/a/, "zero input+cacheRead denominator must not render NaN or Infinity");
  assert.match(report, /replayed agent .* replay .* sonnet -> mock\/other/);
  assert.match(report, /tools: read, context_search/);
  assert.match(report, /legacy agent .* telemetry unavailable/);
});

test("formatWorkflowReport marks terminal timeout usage as incomplete when usage is missing", () => {
  const run = {
    runId: "timeout-run",
    workflowName: "timeout",
    script: "",
    status: "failed",
    phases: [],
    logs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    tokenUsage: { input: 4, output: 2, total: 6, cost: 0.01 },
    agents: [
      {
        id: 1,
        label: "timed out",
        prompt: "x",
        status: "error",
        telemetry: {
          execution: "live",
          requestedModelSpec: "haiku",
          accountingStatus: "incomplete",
          accountingIncompleteAttempts: 1,
        },
      },
    ],
  } satisfies PersistedRunState;

  const report = formatWorkflowReport(run);
  assert.match(report, /Usage: unavailable \(accounting incomplete for 1 agent; 1 agent missing usage\)/);
  assert.doesNotMatch(report, /input 4 .* output 2/);
});

test("formatWorkflowReport marks all-usage-missing telemetry as incomplete instead of exact", () => {
  const run = {
    runId: "missing-usage-run",
    workflowName: "missing",
    script: "",
    status: "completed",
    phases: [],
    logs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    tokenUsage: { input: 4, output: 2, total: 6, cost: 0.01 },
    agents: [
      {
        id: 1,
        label: "missing usage",
        prompt: "x",
        status: "done",
        telemetry: { execution: "live", accountingStatus: "incomplete" },
      },
    ],
  } satisfies PersistedRunState;

  const report = formatWorkflowReport(run);
  assert.match(report, /Usage: unavailable \(accounting incomplete for 1 agent; 1 agent missing usage\)/);
  assert.doesNotMatch(report, /input 4 .* output 2/);
});

test("manager persists finalized usage when the agent journal save fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-journal-usage-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-journal-usage-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const usage = { input: 6, output: 4, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.01 };
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(_prompt: string, options: any) {
            options.onUsage?.(usage);
            options.onTelemetry?.({ execution: "live", usage });
            return "ok";
          },
        },
      });
      const persistence = manager.getPersistence();
      const save = persistence.save.bind(persistence);
      let saves = 0;
      persistence.save = (state) => {
        saves++;
        if (saves === 2) throw new Error("journal save failed");
        save(state);
      };

      await assert.rejects(
        () =>
          manager.runSync(`export const meta = { name: 'journal-usage', description: 'usage durability' }
return await agent('task', { label: 'worker' })`),
        /journal save failed/,
      );

      const persisted = manager.listAllRuns()[0];
      assert.equal(persisted.status, "failed");
      assert.equal(persisted.tokenUsage?.total, 10);
      assert.equal(persisted.tokenUsage?.input, 6);
      assert.equal(persisted.tokenUsage?.output, 4);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("manager persists cumulative usage from recoverable retries", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-retry-usage-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-retry-usage-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      let attempts = 0;
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(_prompt: string, options: any) {
            attempts++;
            const usage =
              attempts === 1
                ? { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.01 }
                : { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0.005 };
            options.onUsage?.(usage);
            options.onTelemetry?.({ execution: "live", usage });
            if (attempts === 1) {
              throw new WorkflowError("retry me", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
            }
            return "ok";
          },
        },
      });

      await manager.runSync(
        `export const meta = { name: 'retry-usage', description: 'retry usage durability' }
return await agent('task', { label: 'worker' })`,
        undefined,
        { agentRetries: 1 },
      );

      const persisted = manager.listAllRuns()[0];
      assert.equal(attempts, 2);
      assert.equal(persisted.tokenUsage?.total, 15);
      assert.equal(persisted.tokenUsage?.input, 10);
      assert.equal(persisted.tokenUsage?.output, 5);
      assert.equal(persisted.agents[0].telemetry?.usage?.total, 15);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("formatWorkflowReport renders legacy telemetry without a literal undefined execution marker", () => {
  const run = {
    runId: "legacy-execution-run",
    workflowName: "legacy-execution",
    script: "",
    status: "completed",
    phases: [],
    logs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    agents: [
      {
        id: 1,
        label: "old telemetry",
        prompt: "x",
        status: "done",
        telemetry: { requestedModelSpec: "haiku" } as AgentTelemetry,
      },
    ],
  } satisfies PersistedRunState;

  const report = formatWorkflowReport(run);
  assert.match(report, /old telemetry .* legacy .* requested haiku/);
  assert.doesNotMatch(report, /undefined/);
});

test("formatWorkflowReport does not fabricate missing legacy or replay telemetry", () => {
  const run = {
    runId: "legacy-run",
    workflowName: "legacy",
    script: "",
    status: "completed",
    phases: [],
    logs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    tokenUsage: { input: 4, output: 2, total: 6 },
    agents: [
      {
        id: 1,
        label: "old replay",
        prompt: "x",
        status: "done",
        telemetry: { execution: "replay", requestedModelSpec: "haiku" },
      },
    ],
  } satisfies PersistedRunState;

  const report = formatWorkflowReport(run);
  assert.match(report, /cache unavailable/);
  assert.match(report, /cost unavailable/);
  assert.match(report, /old replay .* replay .* requested haiku .* telemetry unavailable/);
  assert.doesNotMatch(report, /system 0|context .*0 chars|\$0\.0000/);
});
