import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const strictScript = `export const meta = { name: 'strict-resume', description: 'strict resume' }
return await agent('work', { agentType: 'missing' })`;

test("cold resume restores execution limits and counts already-consumed token budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-limits-resume-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-limits-resume-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      let firstCalls = 0;
      const firstManager = new WorkflowManager({
        cwd,
        concurrency: 8,
        defaultAgentRetries: 0,
        agent: {
          async run(_prompt: string, options: any) {
            firstCalls++;
            if (firstCalls === 1) {
              options.onUsage?.({ input: 3, output: 3, cacheRead: 0, cacheWrite: 0, total: 6, cost: 0 });
              return "first";
            }
            options.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
            throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          },
        },
      });
      firstManager.on("error", () => {});
      await assert.rejects(() =>
        firstManager.runSync(
          `export const meta = { name: 'limit-resume', description: 'limits' }
await agent('first')
await agent('second')
return await agent('third')`,
          undefined,
          {
            maxAgents: 3,
            agentTimeoutMs: 1234,
            tokenBudget: 10,
            concurrency: 1,
            agentRetries: 2,
            agentTypePolicy: "error",
          },
        ),
      );
      const persisted = firstManager.listRuns().find((run) => run.workflowName === "limit-resume");
      assert.ok(persisted);
      assert.deepEqual(persisted.executionPolicy, {
        cwd,
        maxAgents: 3,
        agentTimeoutMs: 1234,
        tokenBudget: 10,
        concurrency: 1,
        agentRetries: 2,
        agentTypePolicy: "error",
      });
      assert.equal(persisted.tokenUsage?.total, 7);

      let resumedCalls = 0;
      const resumedManager = new WorkflowManager({
        cwd,
        concurrency: 9,
        defaultAgentRetries: 0,
        agent: {
          async run(_prompt: string, options: any) {
            resumedCalls++;
            options.onUsage?.({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0 });
            return "second";
          },
        },
      });
      const failed = new Promise<WorkflowError>((resolve) => {
        resumedManager.on("error", (event: { runId: string; error: WorkflowError }) => {
          if (event.runId === persisted.runId) resolve(event.error);
        });
      });
      assert.equal(await resumedManager.resume(persisted.runId), true);
      const error = await failed;
      assert.equal(error.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
      assert.equal(resumedCalls, 1, "the third agent is blocked by 7 persisted + 5 resumed tokens");
      assert.equal(resumedManager.getPersistence().load(persisted.runId)?.tokenUsage?.total, 12);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("per-run cwd is used for execution and restored by cold resume", async () => {
  const storageCwd = mkdtempSync(join(tmpdir(), "pi-dw-storage-cwd-"));
  const executionCwd = mkdtempSync(join(tmpdir(), "pi-dw-execution-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-cwd-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const prompts: string[] = [];
      const manager = new WorkflowManager({
        cwd: storageCwd,
        agent: {
          async run(prompt: string) {
            prompts.push(prompt);
            return "ok";
          },
        },
      });
      const script = `export const meta = { name: 'cwd-policy', description: 'cwd policy' }
return await agent(cwd)`;
      await manager.runSync(script, undefined, { cwd: executionCwd });
      assert.equal(prompts[0], executionCwd);
      const first = manager.listRuns()[0];
      manager.getPersistence().save({ ...first, status: "paused", agents: [], journal: [] });

      const coldPrompts: string[] = [];
      const cold = new WorkflowManager({
        cwd: storageCwd,
        agent: {
          async run(prompt: string) {
            coldPrompts.push(prompt);
            return "ok";
          },
        },
      });
      const completed = new Promise<void>((resolve) => {
        cold.on("complete", (event: { runId: string }) => event.runId === first.runId && resolve());
      });
      assert.equal(await cold.resume(first.runId), true);
      await completed;
      assert.equal(coldPrompts[0], executionCwd);
      assert.equal(cold.getPersistence().load(first.runId)?.cwd, executionCwd);
    });
  } finally {
    rmSync(storageCwd, { recursive: true, force: true });
    rmSync(executionCwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a strict per-execution agentTypePolicy remains strict after cold resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-policy-resume-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-policy-resume-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const firstManager = new WorkflowManager({
        cwd,
        agentTypePolicy: "fallback",
        agent: {
          async run() {
            return "ok";
          },
        },
      });
      firstManager.on("error", () => {});
      await assert.rejects(
        () => firstManager.runSync(strictScript, undefined, { agentTypePolicy: "error" }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
          assert.equal(error.message, 'Unknown agentType "missing"');
          return true;
        },
      );

      const persisted = firstManager.listRuns().find((run) => run.workflowName === "strict-resume");
      assert.ok(persisted);
      assert.equal(
        (persisted as typeof persisted & { agentTypePolicy?: string }).agentTypePolicy,
        "error",
        "the effective execution policy is durable",
      );

      let calls = 0;
      const resumedManager = new WorkflowManager({
        cwd,
        agentTypePolicy: "fallback",
        agent: {
          async run() {
            calls++;
            return "must-not-run";
          },
        },
      });
      const outcome = new Promise<{ type: "complete" | "error"; error?: WorkflowError }>((resolve) => {
        resumedManager.on("complete", (event: { runId: string }) => {
          if (event.runId === persisted.runId) resolve({ type: "complete" });
        });
        resumedManager.on("error", (event: { runId: string; error: WorkflowError }) => {
          if (event.runId === persisted.runId) resolve({ type: "error", error: event.error });
        });
      });

      assert.equal(await resumedManager.resume(persisted.runId), true);
      const resumed = await outcome;
      assert.equal(resumed.type, "error");
      assert.equal(resumed.error?.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(resumed.error?.message, 'Unknown agentType "missing"');
      assert.equal(calls, 0, "resume must not fall back to the new manager's permissive policy");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
