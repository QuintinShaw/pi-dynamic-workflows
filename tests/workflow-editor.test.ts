import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Pure-function tests — import from source (tsx compiles on the fly)
async function load() {
  return import("../src/workflow-editor.js");
}

function testSettingsOptions(keywordTriggerEnabled = true, keywordTriggerWord?: string) {
  return {
    settingsStore: {
      load: () => ({ keywordTriggerEnabled, ...(keywordTriggerWord ? { keywordTriggerWord } : {}) }),
      save: () => {},
    },
  };
}

function memorySettingsOptions(keywordTriggerEnabled = true, keywordTriggerWord?: string) {
  let settings: { keywordTriggerEnabled?: boolean; keywordTriggerWord?: string } = {
    keywordTriggerEnabled,
    ...(keywordTriggerWord ? { keywordTriggerWord } : {}),
  };
  const saved: Array<{ keywordTriggerEnabled?: boolean; keywordTriggerWord?: string }> = [];
  return {
    options: {
      settingsStore: {
        load: () => ({ ...settings }),
        save: (next: { keywordTriggerEnabled?: boolean; keywordTriggerWord?: string }) => {
          settings = { ...settings, ...next };
          saved.push(next);
        },
      },
    },
    get settings() {
      return settings;
    },
    saved,
  };
}

describe("hasTrigger", () => {
  it('returns true for "workflow"', async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("run a workflow test"), true);
  });

  it('returns true for "workflows"', async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("use workflows mode"), true);
  });

  it("returns true for trigger at start", async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("workflow something"), true);
  });

  it("returns true for trigger at end", async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("test workflow"), true);
  });

  it("returns true case-insensitively", async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("WORKFLOW now"), true);
    assert.equal(hasTrigger("WorkFlows are cool"), true);
  });

  it('returns false for "/workflows" (slash command)', async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("/workflows list"), false);
  });

  it('returns false for "/workflow"', async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("/workflow"), false);
  });

  it("requires token boundaries for the built-in trigger", async () => {
    const { hasTrigger } = await load();
    for (const text of [
      "myworkflow",
      "workflows2",
      "workflow_name",
      "workflow-based",
      "src/workflow-editor.ts",
      "src\\workflow-editor.ts",
    ]) {
      assert.equal(hasTrigger(text), false, `${text} should not trigger`);
    }
    for (const text of ["workflow, please", "(workflows)", "WORKFLOW!", "Discuss workflows."]) {
      assert.equal(hasTrigger(text), true, `${text} should trigger`);
    }
  });

  it("rejects Unicode identifier and dollar boundaries on either side", async () => {
    const { hasTrigger } = await load();
    for (const text of [
      "$workflow",
      "workflow$",
      "caféworkflow",
      "workflowcafé",
      "变量workflow变量",
      "变量workflow",
      "workflow变量",
    ]) {
      assert.equal(hasTrigger(text), false, `${text} should not trigger`);
    }
    for (const text of ["¿workflow?", "café, workflow!", "变量：workflow。", "workflow—please"]) {
      assert.equal(hasTrigger(text), true, `${text} should trigger`);
    }
  });

  it("applies path and Unicode identifier boundaries to custom triggers", async () => {
    const { hasTrigger } = await load();
    for (const text of ["xpi-workflow", "pi-workflow变量", "src/pi-workflow", "src\\pi-workflow"]) {
      assert.equal(hasTrigger(text, "pi-workflow"), false, `${text} should not trigger`);
    }
    assert.equal(hasTrigger("run pi-workflow, please", "pi-workflow"), true);
  });

  it("returns false for unrelated text", async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("hello world"), false);
  });

  it("returns false for empty string", async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger(""), false);
  });

  it('returns false for "working flow" (space in middle)', async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("working flow"), false);
  });

  it("works with non-ASCII characters around the trigger", async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("zrób workflow test"), true);
    assert.equal(hasTrigger("uruchom workflows"), true);
  });

  it("uses a configured trigger word exactly", async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("run pi-workflow now", "pi-workflow"), true);
    assert.equal(hasTrigger("run workflow now", "pi-workflow"), false);
    assert.equal(hasTrigger("run pi-workflows now", "pi-workflow"), false);
    assert.equal(hasTrigger("/pi-workflow status", "pi-workflow"), false);
  });

  it("escapes regex characters in configured trigger words", async () => {
    const { hasTrigger } = await load();
    assert.equal(hasTrigger("run pi.workflow", "pi.workflow"), true);
    assert.equal(hasTrigger("run pixworkflow", "pi.workflow"), false);
  });
});

// Regression corpus (#88): the lexical arm must not fire on identifiers, paths,
// URLs, or hyphen/camelCase compounds that merely embed the letters "workflow".
// Two layers matter, so we test both (as the redesign intends):
//  (1) hasTrigger — the LEXICAL arm. It fires ONLY on the bounded standalone word.
//  (2) the armed DIRECTIVE — for the one case that legitimately IS the bare word in
//      a sentence ("the workflow tool is slow"), the lexical arm does fire, but the
//      banner LEADS with "if it's just talk about the tool, answer directly", so the
//      model is not pushed into a workflow. That layered behavior is the whole point.
describe("trigger regression corpus (#88 boundaries)", () => {
  const NON_ARMING = [
    "https://github.com/x/pi-dynamic-workflows", // URL: preceded by "-", inside a path
    "see github.com/x/pi-dynamic-workflows for docs",
    "the workflowRunner class handles this", // camelCase compound
    "add my-workflow-helper to the plugin list", // hyphen compound
    "open src/workflow-editor.ts and fix the bug", // file path
    "/workflows list", // slash command
  ];

  it("does NOT lexically arm on identifiers, paths, URLs, or compounds", async () => {
    const { hasTrigger } = await load();
    for (const text of NON_ARMING) {
      assert.equal(hasTrigger(text), false, `${text} must NOT arm`);
    }
  });

  const ARMING = [
    "run a workflow to audit the repo",
    "workflow: audit the auth module",
    "帮我跑一个 workflow 审计整个仓库", // CJK context, space-delimited literal word
  ];

  it("lexically arms on the bounded standalone word (incl. CJK context)", async () => {
    const { hasTrigger } = await load();
    for (const text of ARMING) {
      assert.equal(hasTrigger(text), true, `${text} should arm`);
    }
  });

  it("natural English 'the workflow tool is slow' arms lexically but the banner routes it to a direct answer", async () => {
    const { hasTrigger, buildArmedWorkflowPrompt } = await load();
    // Honest: the bare word IS a standalone token here, so the lexical arm fires.
    assert.equal(hasTrigger("the workflow tool is slow"), true);
    // But the armed banner leads with the decision boundary, so a "talk about the
    // tool" turn is answered directly rather than forced into a workflow.
    const armed = buildArmedWorkflowPrompt("the workflow tool is slow", { reason: "keyword" });
    assert.match(armed, /answer it directly and stay/i);
    assert.match(armed, /arming authorizes the tool, it does not force it/i);
    assert.ok(!/\bMUST\b/.test(armed));
  });
});

describe("endsWithTrigger", () => {
  it('returns true when text ends with "workflow"', async () => {
    const { endsWithTrigger } = await load();
    assert.equal(endsWithTrigger("run a workflow"), true);
  });

  it('returns true when text ends with "workflows"', async () => {
    const { endsWithTrigger } = await load();
    assert.equal(endsWithTrigger("see workflows"), true);
  });

  it("returns false when trigger is not at end", async () => {
    const { endsWithTrigger } = await load();
    assert.equal(endsWithTrigger("workflow test"), false);
  });

  it('returns false for "/workflows"', async () => {
    const { endsWithTrigger } = await load();
    assert.equal(endsWithTrigger("/workflows"), false);
  });

  it("returns false for empty string", async () => {
    const { endsWithTrigger } = await load();
    assert.equal(endsWithTrigger(""), false);
  });

  it("returns true with trailing non-ASCII prefix", async () => {
    const { endsWithTrigger } = await load();
    assert.equal(endsWithTrigger("zrób workflow"), true);
  });

  it("uses a configured trigger word exactly", async () => {
    const { endsWithTrigger } = await load();
    assert.equal(endsWithTrigger("run pi-workflow", "pi-workflow"), true);
    assert.equal(endsWithTrigger("run workflow", "pi-workflow"), false);
    assert.equal(endsWithTrigger("run pi-workflows", "pi-workflow"), false);
    assert.equal(endsWithTrigger("/pi-workflow", "pi-workflow"), false);
  });
});

describe("buildArmedWorkflowPrompt", () => {
  it("includes the original text", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    const result = buildArmedWorkflowPrompt("hello world");
    assert.ok(result.startsWith("hello world"), "should start with hello world");
  });

  it("arms (authorizes) rather than forces — no MUST/ONLY/'Do NOT answer' language", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    const result = buildArmedWorkflowPrompt("test");
    assert.ok(result.includes("workflows mode armed"), "should announce armed mode");
    assert.ok(result.includes("`workflow` tool"), "should still name the workflow tool");
    assert.ok(!/\bMUST\b/.test(result), "must not force with MUST");
    assert.ok(!/ONLY acceptable/i.test(result), "must not force with 'ONLY acceptable'");
    assert.ok(!/Do NOT (instead|answer)/i.test(result), "must not forbid answering directly");
    assert.ok(
      result.includes("answer it directly") || result.includes("does not force"),
      "should permit answering a question directly",
    );
  });

  it("leads with the decision boundary, not with 'call the tool' (#P3)", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    const result = buildArmedWorkflowPrompt("test");
    const bannerStart = result.indexOf("[workflows mode armed");
    assert.ok(bannerStart >= 0, "should have the armed banner");
    const decideIdx = result.indexOf("Decide first");
    const callToolIdx = result.indexOf("calling the `workflow` tool");
    assert.ok(decideIdx >= 0, "should state the decision boundary");
    assert.ok(callToolIdx >= 0, "should still tell it how to call the tool");
    assert.ok(decideIdx < callToolIdx, "the decision boundary must come BEFORE the call-the-tool instruction");
  });

  it("carries the #89 background/deliver-back reassurance (no idle-at-prompt worry)", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    const result = buildArmedWorkflowPrompt("test");
    assert.match(result, /runs in the background by default/i);
    assert.match(result, /delivered back into the conversation automatically/i);
    assert.match(result, /that's expected, not a stall/i);
    assert.match(result, /pass background:false if the user is waiting for the result inline/i);
  });

  it("states the truthful opt-in reason per path (keyword vs effort) (#P3)", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    const keyword = buildArmedWorkflowPrompt("test", { reason: "keyword" });
    assert.match(keyword, /you typed the workflow trigger word/i);
    assert.doesNotMatch(keyword, /standing effort mode/i);

    const effort = buildArmedWorkflowPrompt("test", { reason: "effort" });
    assert.match(effort, /standing effort mode armed this turn/i);
    assert.match(effort, /you did not explicitly ask for a workflow/i);
    // The effort path must NOT falsely claim the user typed the trigger word.
    assert.doesNotMatch(effort, /you typed the workflow trigger word/i);
  });

  it("defaults the reason to keyword when none is given", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    assert.equal(buildArmedWorkflowPrompt("test"), buildArmedWorkflowPrompt("test", { reason: "keyword" }));
  });

  it("does NOT carry the how-to mechanics — those live in the tool description now (#P2)", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    const result = buildArmedWorkflowPrompt("test");
    assert.ok(!result.includes("export const meta = {"), "meta how-to must not be in the armed message");
    assert.ok(!result.includes("parallel() takes functions"), "mechanics how-to must not be in the armed message");
    assert.ok(!result.includes("follow this guidance"), "no how-to preamble in the armed message");
  });

  it("appends the extra directive only when provided", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    const base = buildArmedWorkflowPrompt("do X", { reason: "effort" });
    const withExtra = buildArmedWorkflowPrompt("do X", { reason: "effort", extraDirective: "SENTINEL-DIRECTIVE" });
    assert.ok(!base.includes("SENTINEL-DIRECTIVE"));
    assert.ok(withExtra.includes("SENTINEL-DIRECTIVE"));
  });

  it("is a multi-line string", async () => {
    const { buildArmedWorkflowPrompt } = await load();
    const result = buildArmedWorkflowPrompt("test");
    assert.ok(result.includes("\n"), "should contain \n");
    assert.ok(result.includes("---"), "should contain ---");
  });
});

describe("buildForcedWorkflowPrompt (/workflows run)", () => {
  it("forces — no 'if it's a question just answer' escape (#P5)", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    const result = buildForcedWorkflowPrompt("audit the repo");
    assert.ok(result.startsWith("audit the repo"), "starts with the original prompt");
    assert.match(result, /\/workflows run/, "identifies the explicit command");
    assert.match(result, /Call the `workflow` tool now/i, "tells the model to run the workflow");
    // The forcing directive must NOT offer the question-answer escape the armed banner has.
    assert.doesNotMatch(result, /just talk \(about workflows/i);
    assert.doesNotMatch(result, /answer it directly and stay/i);
    assert.match(result, /do not answer in prose instead of running the workflow/i);
  });

  it("still carries the #89 background/deliver-back reassurance", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    const result = buildForcedWorkflowPrompt("audit the repo");
    assert.match(result, /runs in the background by default/i);
    assert.match(result, /delivered back into the conversation automatically/i);
  });

  it("does NOT reintroduce the MUST/ONLY forcing language that caused #88/#89", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    const result = buildForcedWorkflowPrompt("audit the repo");
    assert.ok(!/\bMUST\b/.test(result), "no MUST");
    assert.ok(!/ONLY acceptable/i.test(result), "no 'ONLY acceptable'");
  });

  it("appends the extra directive when provided", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    assert.ok(!buildForcedWorkflowPrompt("do X").includes("SENTINEL"));
    assert.ok(buildForcedWorkflowPrompt("do X", "SENTINEL").includes("SENTINEL"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  installWorkflowKeywordArming — integration tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("installWorkflowKeywordArming", () => {
  it("registers input and turn_end event hooks", async () => {
    const mod = await load();
    const registered: Array<{ event: string }> = [];
    const pi = {
      on: (event: string, _handler: unknown) => {
        registered.push({ event });
      },
      getActiveTools: () => [],
      setActiveTools: (_tools: string[]) => {},
    } as unknown as ExtensionAPI;

    mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions());

    const events = registered.map((r) => r.event);
    assert.ok(events.includes("input"), 'should register "input" hook');
    assert.ok(events.includes("turn_end"), 'should register "turn_end" hook');
  });

  it("registers /workflows-trigger and toggles the keyword trigger", async () => {
    const mod = await load();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sent: Array<{ content?: string }> = [];
    const store = memorySettingsOptions();
    const pi = {
      on: () => {},
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: (message: { content?: string }) => {
        sent.push(message);
      },
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI;

    const state = mod.installWorkflowKeywordArming(pi, undefined, store.options);
    assert.equal(state.keywordTriggerEnabled, true, "keyword trigger should default on");
    assert.equal(state.keywordTriggerWord, "workflow", "keyword trigger word should default to workflow");

    const command = commands.get("workflows-trigger");
    assert.ok(command, "should register /workflows-trigger");

    await command.handler("off", {});
    assert.equal(state.keywordTriggerEnabled, false);
    assert.equal(state.active, false);
    assert.deepEqual(store.settings, { keywordTriggerEnabled: false });
    assert.match(sent.at(-1)?.content ?? "", /keyword trigger off/i);
    assert.match(sent.at(-1)?.content ?? "", /saved for new sessions/i);

    await command.handler("on", {});
    assert.equal(state.keywordTriggerEnabled, true);
    assert.deepEqual(store.settings, { keywordTriggerEnabled: true });
    assert.match(sent.at(-1)?.content ?? "", /keyword trigger on/i);
    assert.match(sent.at(-1)?.content ?? "", /saved for new sessions/i);
  });

  it("/workflows-trigger sets and reports the keyword trigger word", async () => {
    const mod = await load();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sent: Array<{ content?: string }> = [];
    const store = memorySettingsOptions();
    const pi = {
      on: () => {},
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: (message: { content?: string }) => {
        sent.push(message);
      },
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI;

    const state = mod.installWorkflowKeywordArming(pi, undefined, store.options);
    const command = commands.get("workflows-trigger");
    assert.ok(command, "should register /workflows-trigger");

    await command.handler("set pi-workflow", {});
    assert.equal(state.keywordTriggerWord, "pi-workflow");
    assert.deepEqual(store.settings, { keywordTriggerEnabled: true, keywordTriggerWord: "pi-workflow" });
    assert.match(sent.at(-1)?.content ?? "", /pi-workflow/);

    await command.handler("status", {});
    assert.match(sent.at(-1)?.content ?? "", /pi-workflow/);

    await command.handler("reset", {});
    assert.equal(state.keywordTriggerWord, "workflow");
    assert.deepEqual(store.settings, { keywordTriggerEnabled: true, keywordTriggerWord: "workflow" });
  });

  it("supports legacy WorkflowModeState objects without keywordTriggerWord", async () => {
    const mod = await load();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sent: Array<{ content?: string }> = [];
    const state = { active: false, keywordTriggerEnabled: true };
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: (message: { content?: string }) => {
        sent.push(message);
      },
    } as unknown as ExtensionAPI;

    mod.registerWorkflowTriggerCommand(pi, state, {
      load: () => ({}),
      save: () => {},
    });

    const command = commands.get("workflows-trigger");
    assert.ok(command, "should register /workflows-trigger");

    await command.handler("status", {});
    assert.match(sent.at(-1)?.content ?? "", /trigger word is "workflow"/);

    await command.handler("on", {});
    assert.match(sent.at(-1)?.content ?? "", /workflow\/workflows/);
  });

  it("keeps keyword triggering enabled when the setting is absent or loading fails", async () => {
    const mod = await load();
    const stores = [
      { load: () => ({}), save: () => {} },
      {
        load: () => {
          throw new Error("read failed");
        },
        save: () => {},
      },
    ];

    for (const settingsStore of stores) {
      const pi = {
        on: () => {},
        registerCommand: () => {},
        getActiveTools: () => [],
        setActiveTools: () => {},
      } as unknown as ExtensionAPI;

      const state = mod.installWorkflowKeywordArming(pi, undefined, { settingsStore });

      assert.equal(state.keywordTriggerEnabled, true);
      assert.equal(state.keywordTriggerWord, "workflow");
    }
  });

  it("loads the persisted keyword trigger preference on install", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    let setActiveToolsCalls = 0;
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      registerCommand: () => {},
      sendMessage: () => {},
      getActiveTools: () => ["bash", "read"],
      setActiveTools: () => {
        setActiveToolsCalls++;
      },
    } as unknown as ExtensionAPI;

    const state = mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions(false));
    assert.equal(state.keywordTriggerEnabled, false, "persisted off should apply to new sessions");

    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should be registered");
    const result = inputHandler({
      source: "interactive",
      text: "Please discuss workflows as a normal topic.",
    });

    assert.deepEqual(result, { action: "continue" });
    assert.equal(setActiveToolsCalls, 0);
  });

  it("loads the persisted keyword trigger word on install", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    let setActiveToolsCalls = 0;
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      registerCommand: () => {},
      sendMessage: () => {},
      getActiveTools: () => ["bash", "read"],
      setActiveTools: () => {
        setActiveToolsCalls++;
      },
    } as unknown as ExtensionAPI;

    const state = mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions(true, "pi-workflow"));
    assert.equal(state.keywordTriggerWord, "pi-workflow");

    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should be registered");
    assert.deepEqual(inputHandler({ source: "interactive", text: "Please discuss workflows normally." }), {
      action: "continue",
    });
    assert.equal(setActiveToolsCalls, 0);

    const result = inputHandler({ source: "interactive", text: "Please run pi-workflow now." });
    assert.equal((result as { action?: string }).action, "transform");
    assert.equal(setActiveToolsCalls, 1);
  });

  it("keeps session trigger state when saving the preference fails", async () => {
    const mod = await load();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sent: Array<{ content?: string }> = [];
    const pi = {
      on: () => {},
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: (message: { content?: string }) => {
        sent.push(message);
      },
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI;

    const state = mod.installWorkflowKeywordArming(pi, undefined, {
      settingsStore: {
        load: () => ({ keywordTriggerEnabled: true }),
        save: () => {
          throw new Error("write failed");
        },
      },
    });
    const command = commands.get("workflows-trigger");
    assert.ok(command, "should register /workflows-trigger");

    await command.handler("off", {});

    assert.equal(state.keywordTriggerEnabled, false);
    assert.equal(state.active, false);
    assert.match(sent.at(-1)?.content ?? "", /could not be saved/i);

    await command.handler("on", {});

    assert.equal(state.keywordTriggerEnabled, true);
    assert.match(sent.at(-1)?.content ?? "", /could not be saved/i);
  });

  it("saves active tools and adds WORKFLOW_TOOL_NAME on triggered input", async () => {
    const mod = await load();
    let savedTools: string[] = [];
    const pi = {
      on: (_event: string, _handler: unknown) => {},
      getActiveTools: () => ["bash", "read"],
      setActiveTools: (tools: string[]) => {
        savedTools = tools;
      },
    } as unknown as ExtensionAPI;

    mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions());

    // Simulate the "input" event — find the registered handler
    // We need to actually invoke the handler the install sets up.
    // Re-implement the scenario more directly:

    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    const pi2 = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      getActiveTools: () => ["bash", "read"],
      setActiveTools: (tools: string[]) => {
        savedTools = tools;
      },
    } as unknown as ExtensionAPI;

    savedTools = [];
    mod.installWorkflowKeywordArming(pi2, undefined, testSettingsOptions());

    const inputHandler = captured.find((c) => c.event === "input")?.handler as
      | ((event: { source?: string; text?: string }) => { action: string; text?: string })
      | undefined;
    assert.notEqual(inputHandler, undefined, "input handler should be registered");

    // Invoke with non-trigger text — should NOT save tools
    const resultNonTrigger = inputHandler?.({ source: "interactive", text: "hello world" });
    assert.deepEqual(resultNonTrigger, { action: "continue" }, "non-trigger input should return continue");
    assert.deepEqual(savedTools, [], "tools should not change for non-trigger input");

    // Invoke with trigger text — should save and add WORKFLOW_TOOL_NAME
    const resultTrigger = inputHandler?.({ source: "interactive", text: "run a workflow test" });
    assert.ok(typeof resultTrigger === "object" && resultTrigger !== null, "should return a result object");
    assert.equal(resultTrigger.action, "transform", "should return transform action");
    assert.ok(
      typeof resultTrigger.text === "string" && resultTrigger.text.length > 0,
      "should return transformed text",
    );
    assert.ok(resultTrigger.text?.includes("run a workflow test"), "transformed text should include original prompt");
    assert.ok(savedTools.includes("workflow"), `saved tools (${savedTools.join(", ")}) should include "workflow"`);
  });

  it("does not transform keyword-triggered input when /workflows-trigger is off", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    let setActiveToolsCalls = 0;
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: () => {},
      getActiveTools: () => ["bash", "read"],
      setActiveTools: () => {
        setActiveToolsCalls++;
      },
    } as unknown as ExtensionAPI;

    mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions());
    await commands.get("workflows-trigger")?.handler("off", {});

    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should be registered");
    const result = inputHandler({
      source: "interactive",
      text: "Please discuss workflows as a normal topic.",
    });

    assert.deepEqual(result, { action: "continue" });
    assert.equal(setActiveToolsCalls, 0);
  });

  it("does not transform one-shot backspace-suppressed keyword input", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    let setActiveToolsCalls = 0;
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      registerCommand: () => {},
      sendMessage: () => {},
      getActiveTools: () => ["bash", "read"],
      setActiveTools: () => {
        setActiveToolsCalls++;
      },
    } as unknown as ExtensionAPI;

    const state = mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions());
    state.suppressedKeywordText = "Please discuss workflows as a normal topic.";

    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should be registered");
    const result = inputHandler({
      source: "interactive",
      text: "Please discuss workflows as a normal topic.",
    });

    assert.deepEqual(result, { action: "continue" });
    assert.equal(setActiveToolsCalls, 0);
    assert.equal(state.suppressedKeywordText, undefined, "suppression should be consumed after one submit");
  });

  it("transforms the same keyword input later when it was not just suppressed", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      registerCommand: () => {},
      sendMessage: () => {},
      getActiveTools: () => ["bash", "read"],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI;

    mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions());

    const text = "Please discuss workflows as a normal topic.";
    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should be registered");
    const result = inputHandler({ source: "interactive", text });

    assert.deepEqual(result, {
      action: "transform",
      text: mod.buildArmedWorkflowPrompt(text),
    });
  });

  it("still transforms effort-armed input when the keyword trigger is off", async () => {
    const mod = await load();
    const { createEffortState, effortDirective } = await import("../src/effort-command.js");
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const effort = createEffortState();
    effort.level = "high";
    let tools: string[] = [];
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: () => {},
      getActiveTools: () => ["bash", "read"],
      setActiveTools: (next: string[]) => {
        tools = next;
      },
    } as unknown as ExtensionAPI;

    mod.installWorkflowKeywordArming(pi, effort, testSettingsOptions());
    await commands.get("workflows-trigger")?.handler("off", {});

    const text = "Please discuss workflows as a normal topic.";
    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should be registered");
    const result = inputHandler({ source: "interactive", text });

    // The effort path arms on ANY substantive message, so its directive also
    // carries the conversational-escape (skip the workflow on trivial turns) and
    // states the truthful "effort" opt-in reason (not "the word you typed").
    const effortExtra = [effortDirective("high"), mod.EFFORT_CONVERSATIONAL_ESCAPE].filter(Boolean).join(" ");
    assert.deepEqual(result, {
      action: "transform",
      text: mod.buildArmedWorkflowPrompt(text, { reason: "effort", extraDirective: effortExtra }),
    });
    const transformed = (result as { text: string }).text;
    assert.match(
      transformed,
      /skip the workflow and just respond directly/,
      "effort path allows skipping the workflow",
    );
    assert.match(transformed, /standing effort mode armed this turn/i, "effort path states the truthful reason");
    assert.ok(!/\bMUST\b/.test(transformed), "effort path must not force with MUST");
    assert.ok(tools.includes(mod.WORKFLOW_TOOL_NAME), "effort mode should still add the workflow tool");
  });

  it("restores original tools on turn_end after a triggered turn", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];

    let currentTools: string[] = ["bash", "read", "edit", "write"];
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      getActiveTools: () => [...currentTools],
      setActiveTools: (tools: string[]) => {
        currentTools = [...tools];
      },
    } as unknown as ExtensionAPI;

    mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions());

    const inputHandler = captured.find((c) => c.event === "input")?.handler;
    const turnEndHandler = captured.find((c) => c.event === "turn_end")?.handler;
    assert.notEqual(inputHandler, undefined, "input handler should be registered");
    assert.notEqual(turnEndHandler, undefined, "turn_end handler should be registered");

    const initialTools = ["bash", "read", "edit", "write"];

    // First trigger: save tools and add "workflow"
    inputHandler?.({ source: "interactive", text: "trigger workflow test" });
    assert.ok(currentTools.includes("workflow"), "workflow tool should be added");
    assert.ok(currentTools.length > initialTools.length, "tool set should be expanded");

    // turn_end: restore to saved tools
    turnEndHandler?.();
    assert.deepEqual(currentTools, initialTools, "tools should be restored after turn_end");
  });

  it("does not add WORKFLOW_TOOL_NAME if already present", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    let currentTools: string[] = ["bash", "read", "workflow"];

    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      getActiveTools: () => [...currentTools],
      setActiveTools: (tools: string[]) => {
        currentTools = [...tools];
      },
    } as unknown as ExtensionAPI;

    mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions());

    const inputHandler = captured.find((c) => c.event === "input")?.handler;
    assert.notEqual(inputHandler, undefined);

    inputHandler?.({ source: "interactive", text: "run workflow" });
    // "workflow" was already present, so tool count should not increase beyond duplicates
    assert.equal(currentTools.filter((t) => t === "workflow").length, 1, "workflow should appear exactly once");
  });

  it("input handler ignores non-interactive sources", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      getActiveTools: () => ["bash"],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI;

    mod.installWorkflowKeywordArming(pi, undefined, testSettingsOptions());

    const inputHandler = captured.find((c) => c.event === "input")?.handler as
      | ((event: { source?: string; text?: string }) => { action: string })
      | undefined;
    assert.notEqual(inputHandler, undefined);

    // Non-interactive source with trigger text should still transform
    const result = inputHandler?.({ source: "paste", text: "run a workflow scenario" });
    assert.deepEqual(result, { action: "continue" }, "non-interactive source should return continue");
  });
});

describe("registerWorkflowProgressCommands", () => {
  function setup() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sent: Array<{ content?: string }> = [];
    let settings: Record<string, unknown> = {};
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: (message: { content?: string }) => {
        sent.push(message);
      },
    } as unknown as ExtensionAPI;
    const settingsStore = {
      load: () => ({ ...settings }),
      save: (next: Record<string, unknown>) => {
        settings = { ...settings, ...next };
      },
    };
    return { commands, sent, settingsStore, getSettings: () => settings, pi };
  }

  it("registers a single merged /workflows-progress command (no separate -max command)", async () => {
    const mod = await load();
    const { commands, settingsStore, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    assert.ok(commands.get("workflows-progress"), "registers /workflows-progress");
    assert.equal(commands.get("workflows-progress-max"), undefined, "no separate /workflows-progress-max command");
    assert.equal(commands.size, 1, "only one command is registered");
  });

  it("persists a valid mode and reports both mode and max on status", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("detailed", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed" });
    assert.match(sent.at(-1)?.content ?? "", /detailed/i);

    await cmd.handler("compact", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "compact" });
    assert.match(sent.at(-1)?.content ?? "", /compact/i);

    await cmd.handler("status", {});
    assert.match(sent.at(-1)?.content ?? "", /panel is compact/i);
    assert.match(sent.at(-1)?.content ?? "", /up to \d+ agents per phase/i);

    await cmd.handler("", {});
    assert.match(sent.at(-1)?.content ?? "", /panel is compact/i);
    assert.match(sent.at(-1)?.content ?? "", /Usage: \/workflows-progress compact \| detailed \| status \| max <N>/);
  });

  it("ignores an invalid/unrecognized subverb without persisting, reporting current status", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    await commands.get("workflows-progress")?.handler("verbose", {});
    assert.deepEqual(getSettings(), {}, "invalid mode is not saved");
    assert.match(sent.at(-1)?.content ?? "", /Usage:/);
  });

  it("max <N> clamps and persists the per-phase agent cap, rejecting non-numbers", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("max 12", {});
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 12 });
    assert.match(sent.at(-1)?.content ?? "", /up to 12 agents per phase/);

    await cmd.handler("max 5000", {});
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "clamps to 1000");

    await cmd.handler("max abc", {});
    assert.match(sent.at(-1)?.content ?? "", /Invalid value/);
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "invalid value does not overwrite");

    await cmd.handler("max 0", {});
    assert.match(sent.at(-1)?.content ?? "", /Invalid value/);
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "invalid value does not overwrite");
  });

  it("max with no number reports the current max and usage", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("max", {});
    assert.match(sent.at(-1)?.content ?? "", /shows up to \d+ agents per phase/);
    assert.match(sent.at(-1)?.content ?? "", /Usage: \/workflows-progress max <1-1000>/);
  });

  it("is case-insensitive for subverbs", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("DETAILED", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed" });

    await cmd.handler("MAX 7", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed", progressPanelMaxAgents: 7 });
    assert.match(sent.at(-1)?.content ?? "", /up to 7 agents per phase/);
  });
});
