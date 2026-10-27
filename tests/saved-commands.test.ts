import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PI_RESERVED_COMMAND_NAMES } from "../src/command-registry.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

async function load() {
  return import("../src/saved-commands.js");
}

describe("parseCommandArgs", () => {
  it("parses key=value pairs", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar count=42");
    assert.equal(result.foo, "bar");
    assert.equal(result.count, "42");
  });

  it("collects positional args into _", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello world");
    assert.equal(result._, "hello world");
  });

  it("handles mixed positional and key=value", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("task=test hello world");
    assert.equal(result.task, "test");
    assert.equal(result._, "hello world");
  });

  it("sets _raw to the trimmed input", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("  foo=bar  ");
    assert.equal(result._raw, "foo=bar");
  });

  it("returns empty when input is empty", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("");
    assert.equal(result._, "");
    assert.equal(result._raw, "");
  });

  it("fills parameter defaults for missing keys", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar", { foo: {}, limit: { default: 10 }, label: { default: "test" } });
    assert.equal(result.foo, "bar");
    assert.equal(result.limit, 10);
    assert.equal(result.label, "test");
  });

  it("does NOT override explicit values with defaults", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("limit=5", { limit: { default: 10 } });
    assert.equal(result.limit, "5");
  });

  it("handles value-only token as positional", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello key=value world");
    assert.equal(result._, "hello world");
    assert.equal(result.key, "value");
  });

  it("handles URLs as positional arguments", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("https://example.com");
    assert.equal(result._, "https://example.com");
  });
});

describe("registerSavedWorkflow", () => {
  it("rejects every Pi 1.4.0 host-reserved command name, including stale saved ownership", async () => {
    const { savedWorkflowCommandAvailability } = await load();
    const { pi } = makeCommandRegistryPi();
    const owners = new Map([["model", "saved"]]);
    Object.defineProperty(pi, Symbol.for("pi-dynamic-workflows.command-owners"), {
      configurable: false,
      enumerable: false,
      value: owners,
      writable: false,
    });

    assert.equal(PI_RESERVED_COMMAND_NAMES.size, 27);
    for (const name of PI_RESERVED_COMMAND_NAMES) {
      const availability = savedWorkflowCommandAvailability(pi, name);
      assert.equal(availability.ok, false, `/${name} must remain unavailable to saved workflows`);
      if (availability.ok) assert.fail(`/${name} unexpectedly remained available`);
      assert.match(availability.message, new RegExp(`/${name}.*reserved by Pi`));
    }
  });

  it("registers a command with the workflow name", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const wf = {
      name: "test-workflow",
      script: "export const meta = { name: 't', description: 't' };",
      description: "A test",
    };

    registerSavedWorkflow(pi, "/cwd", wf);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "test-workflow");
  });

  it("is idempotent — second registration is skipped", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi(["test-workflow"]);
    const wf = { name: "test-workflow", script: "export const meta = { name: 't', description: 't' };" };

    registerSavedWorkflow(pi, "/cwd", wf);
    assert.equal(commands.length, 0, "should not re-register when already present");
  });

  it("registers multiple saved workflows", async () => {
    const { registerAllSavedWorkflows } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const storage = {
      list: () => [
        { name: "wf1", script: "export..." },
        { name: "wf2", script: "export..." },
      ],
    };

    registerAllSavedWorkflows(pi, "/cwd", storage as never);
    assert.deepEqual(
      commands.map((c) => c.name),
      ["wf1", "wf2"],
    );
  });

  it("runs through WorkflowManager when provided — without blocking or duplicating delivery (#104)", async () => {
    const { registerSavedWorkflow } = await load();
    let startedBackground = false;
    let startedScript: string | undefined;
    const manager = {
      startInBackground: (script: string, _args: unknown) => {
        startedBackground = true;
        startedScript = script;
        // Never resolves: if the handler awaited the run (the old blocking
        // behavior), this test would hang instead of passing.
        return { runId: "test-run", promise: new Promise(() => {}) };
      },
    };

    const { pi, commands, sent } = makeCommandRegistryPi();
    const wf = { name: "run-via-manager", script: "export SOURCE" };
    registerSavedWorkflow(pi, "/cwd", wf, manager as never);

    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(startedBackground, true, "should use startInBackground when manager provided");
    assert.equal(startedScript, "export SOURCE");
    // Result delivery for managed background runs is installResultDelivery's job;
    // the handler sending its own copy too was the double-delivery bug.
    assert.equal(sent.length, 0, "handler must not send its own result message on the manager path");
    assert.equal(notified.length, 1);
    assert.equal(notified[0].type, "info");
    assert.ok(notified[0].message.includes("test-run"), "start notice should include the run id");
  });

  it("re-loads the workflow by name at invocation so a project switch picks up the target script", async () => {
    const { registerSavedWorkflow } = await load();
    let startedScript: string | undefined;
    const manager = {
      startInBackground: (script: string) => {
        startedScript = script;
        return { runId: "r1", promise: new Promise(() => {}) };
      },
    };
    const { pi, commands } = makeCommandRegistryPi();
    const source = { name: "same", script: "export SOURCE_A", description: "a" };
    let current: typeof source | null = source;
    registerSavedWorkflow(
      pi,
      "/cwd",
      source,
      manager as never,
      () => current != null,
      () => current,
    );

    const { ctx } = makeNotifyCtx();
    // Project switch: same command name now resolves to the target project's script.
    current = { name: "same", script: "export TARGET_B", description: "b" };
    await commands[0].handler("", ctx);
    assert.equal(
      startedScript,
      "export TARGET_B",
      "must execute the live storage script, not the registration snapshot",
    );
  });

  it("notifies and does not run when the live loader returns null after a project switch", async () => {
    const { registerSavedWorkflow } = await load();
    let started = false;
    const manager = {
      startInBackground: () => {
        started = true;
        return { runId: "r1", promise: new Promise(() => {}) };
      },
    };
    const { pi, commands, sent } = makeCommandRegistryPi();
    const sourceOnly = { name: "source-only", script: "export A", description: "a" };
    registerSavedWorkflow(
      pi,
      "/cwd",
      sourceOnly,
      manager as never,
      () => false,
      () => null,
    );
    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);
    assert.equal(started, false);
    assert.equal(sent.length, 0);
    assert.match(notified[0]?.message ?? "", /not available/i);
  });

  it("falls back to runWorkflow (inline) when no manager is provided", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    // A script with no agent() calls runs to completion inline without a manager.
    const wf = {
      name: "run-inline",
      script: "export const meta = { name: 't', description: 't' };\nreturn { report: 'done' };",
    };
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      registerSavedWorkflow(pi, "/cwd", wf); // no manager

      const { ctx } = makeNotifyCtx();
      await withFakeHomeAsync(fakeHome, () => commands[0].handler("", ctx));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }

    // The inline fallback ran to completion and delivered the report — proving it
    // did not crash on the missing manager and actually executed runWorkflow().
    assert.equal(sent.length, 1, "fallback should deliver exactly one result message");
    assert.equal(sent[0].customType, "workflow:run-inline");
    assert.ok(sent[0].content?.includes("done"), "delivered content should include the workflow's report");
  });

  it("a deleted workflow's lingering command notifies and does not run", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    const wf = { name: "gone", script: "export const meta = { name: 't', description: 't' };\nreturn 1;" };
    // exists() reports the workflow has been deleted from storage.
    registerSavedWorkflow(pi, "/cwd", wf, undefined, () => false);

    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(sent.length, 0, "a deleted workflow should not run or deliver a result");
    assert.equal(notified.length, 1, "the user should be told the command is stale");
    assert.match(notified[0].message, /not available|deleted/i);
  });
});
