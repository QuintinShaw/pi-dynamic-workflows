import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Terminal, TUI } from "@earendil-works/pi-tui";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock terminal that satisfies the Terminal interface without real I/O. */
function makeMockTerminal(): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
}

/** Create a TUI instance safe for test usage (no real terminal I/O). */
function createMockTui(): TUI {
  return new TUI(makeMockTerminal(), false);
}

/** Editor theme stub. */
function makeTheme(): import("@earendil-works/pi-tui").EditorTheme {
  const identity = (s: string) => s;
  return {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  };
}

// Pure-function tests — import from source (tsx compiles on the fly)
async function load() {
  return import("../src/workflow-editor.js");
}

function testSettingsOptions(keywordTriggerEnabled = true) {
  return {
    settingsStore: {
      load: () => ({ keywordTriggerEnabled }),
      save: () => {},
    },
  };
}

function memorySettingsOptions(keywordTriggerEnabled = true) {
  let settings = { keywordTriggerEnabled };
  const saved: Array<{ keywordTriggerEnabled?: boolean }> = [];
  return {
    options: {
      settingsStore: {
        load: () => ({ ...settings }),
        save: (next: { keywordTriggerEnabled?: boolean }) => {
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
});

describe("tokenizeAnsi", () => {
  it("returns one token per char for plain text", async () => {
    const { tokenizeAnsi } = await load();
    const result = tokenizeAnsi("hello");
    assert.equal(result.length, 5);
    assert.deepEqual(result, [{ ch: "h" }, { ch: "e" }, { ch: "l" }, { ch: "l" }, { ch: "o" }]);
  });

  it("preserves CSI sequences as single tokens", async () => {
    const { tokenizeAnsi } = await load();
    const result = tokenizeAnsi("a\x1b[31mb\x1b[0mc");
    assert.equal(result.length, 5);
    assert.equal(result[0].ch, "a");
    assert.equal(result[1].esc, "\x1b[31m");
    assert.equal(result[2].ch, "b");
    assert.equal(result[3].esc, "\x1b[0m");
    assert.equal(result[4].ch, "c");
  });

  it("preserves OSC/APC string sequences (cursor markers)", async () => {
    const { tokenizeAnsi } = await load();
    const result = tokenizeAnsi("a\x1b_pi:c\x07b");
    assert.equal(result.length, 3);
    assert.equal(result[0].ch, "a");
    assert.equal(result[1].esc, "\x1b_pi:c\x07");
    assert.equal(result[2].ch, "b");
  });

  it("handles lone ESC as escape token", async () => {
    const { tokenizeAnsi } = await load();
    const result = tokenizeAnsi("a\x1bXb");
    assert.equal(result.length, 3);
    assert.equal(result[1].esc, "\x1bX");
  });

  it("returns empty array for empty input", async () => {
    const { tokenizeAnsi } = await load();
    assert.deepEqual(tokenizeAnsi(""), []);
  });
});

describe("colorizeWorkflow", () => {
  it("returns line unchanged when no trigger present", async () => {
    const { colorizeWorkflow } = await load();
    assert.equal(colorizeWorkflow("hello world", 0), "hello world");
  });

  it("colorizes workflow with ANSI escapes", async () => {
    const { colorizeWorkflow } = await load();
    const result = colorizeWorkflow("run a workflow", 0);
    // Should contain ANSI escapes around "workflow"
    assert.ok(result.includes("\x1b[38;5;"), "should contain \x1b[38;5;");
    // Per-character ANSI wrapping (each letter individually colored)
    assert.ok(result.startsWith("run a "), "should start with run a ");
    assert.ok(result.includes("\x1b[38;5;"), "should contain \x1b[38;5;");
    assert.ok(result.includes("m"), "should contain m");
  });

  it("returns plain text for empty string", async () => {
    const { colorizeWorkflow } = await load();
    assert.equal(colorizeWorkflow("", 0), "");
  });

  it("preserves existing ANSI in the line", async () => {
    const { colorizeWorkflow } = await load();
    const result = colorizeWorkflow("\x1b[1mworkflow\x1b[0m", 0);
    // The bold marker should survive
    assert.ok(result.includes("\x1b[1m"), "should contain \x1b[1m");
    // work around the trigger letters — the rainbow wraps individual chars
  });

  it("colorizes multiple occurrences", async () => {
    const { colorizeWorkflow } = await load();
    // Use a fixed palette of 2 colors for predictability
    const palette = [196, 46];
    const result = colorizeWorkflow("workflow workflow", 0, palette);
    // Per-character ANSI wrapping — each of the 16 chars (2x "workflow" = 16 chars)
    // should have ANSI color codes around them
    // The ESC (U+001B) control char is intentional here — it matches real ANSI
    // color codes emitted by colorizeWorkflow.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal ANSI escape sequences
    const ansiCodes = result.match(/\x1b\[38;5;\d+m/g);
    assert.equal(ansiCodes.length, 16, "each char of both words should be colored");
  });

  it("handles tick shift producing different colors", async () => {
    const { colorizeWorkflow } = await load();
    const palette = [196, 46];
    const t0 = colorizeWorkflow("workflow", 0, palette);
    const t1 = colorizeWorkflow("workflow", 1, palette);
    // Different tick → different color codes (may differ per char)
    assert.notEqual(t0, t1, "different tick should produce different output");
  });
});

describe("buildForcedWorkflowPrompt", () => {
  it("includes the original text", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    const result = buildForcedWorkflowPrompt("hello world");
    assert.ok(result.startsWith("hello world"), "should start with hello world");
  });

  it("includes the directive", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    const result = buildForcedWorkflowPrompt("test");
    assert.ok(result.includes("tool named exactly `workflow`"), "should contain tool named exactly `workflow");
    assert.ok(result.includes("MUST"), "should contain MUST");
  });

  it("is a multi-line string", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    const result = buildForcedWorkflowPrompt("test");
    assert.ok(result.includes("\n"), "should contain \n");
    assert.ok(result.includes("---"), "should contain ---");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WorkflowEditor — class tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("RAINBOW", () => {
  it("is a non-empty array of color codes", async () => {
    const { RAINBOW } = await load();
    assert.ok(Array.isArray(RAINBOW), "should be an array");
    assert.ok(RAINBOW.length > 0, "should have at least one color");
    for (const c of RAINBOW) {
      assert.equal(typeof c, "number", "each entry should be a number");
      assert.ok(c >= 0 && c <= 255, `color ${c} should be in 0-255 range`);
    }
  });
});

describe("WorkflowEditor", () => {
  type KBManagerClass = {
    new (
      userBindings?: unknown,
      configPath?: string,
    ): {
      matches(data: string, keybinding: string): boolean;
    };
  };

  let mod: Awaited<ReturnType<typeof load>>;
  let KB: KBManagerClass;

  before(async () => {
    mod = await load();
    // KeybindingsManager is not on the package's main exports path, so resolve
    // the package entry portably (no hardcoded absolute path) and derive the
    // internal module location relative to it. import.meta.resolve honours the
    // package's "import" export condition (require.resolve would fail — the
    // package defines no "require" condition).
    const pkgEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distDir = dirname(fileURLToPath(pkgEntryUrl));
    const keybindingsPath = join(distDir, "core", "keybindings.js");
    const core = await import(pathToFileURL(keybindingsPath).href);
    KB = core.KeybindingsManager as unknown as KBManagerClass;
  });

  function createEditor(
    stateOverrides?: Partial<{ active: boolean; keywordTriggerEnabled: boolean; suppressedKeywordText?: string }>,
  ): {
    editor: InstanceType<Awaited<ReturnType<typeof load>>["WorkflowEditor"]>;
    state: { active: boolean; keywordTriggerEnabled: boolean; suppressedKeywordText?: string };
  } {
    const tui = createMockTui();
    const theme = makeTheme();
    const kb = new KB();
    const state: { active: boolean; keywordTriggerEnabled: boolean; suppressedKeywordText?: string } = {
      active: false,
      keywordTriggerEnabled: true,
      ...stateOverrides,
    };
    const editor = new mod.WorkflowEditor(tui, theme, kb, state);
    return { editor, state };
  }

  it("constructs without throwing", () => {
    const { editor, state } = createEditor();
    assert.ok(editor instanceof mod.WorkflowEditor);
    assert.equal(state.active, false);
    assert.equal(state.keywordTriggerEnabled, true);
  });

  it("render() returns an array of strings", () => {
    const { editor } = createEditor();
    const lines = editor.render(80);
    assert.ok(Array.isArray(lines), "render() should return an array");
    for (const ln of lines) {
      assert.equal(typeof ln, "string", "each line should be a string");
    }
  });

  it("isActive() returns true when trigger text is present", () => {
    const { editor } = createEditor();
    assert.equal(editor.isActive(), false, "should be inactive on empty editor");
    editor.setText("run a workflow test");
    assert.equal(editor.isActive(), true, "should be active after typing trigger");
  });

  it("isActive() returns false when the keyword trigger is disabled", () => {
    const { editor, state } = createEditor({ keywordTriggerEnabled: false });
    editor.setText("run a workflow test");
    assert.equal(editor.isActive(), false, "keyword trigger off should suppress workflow mode");

    state.keywordTriggerEnabled = true;
    assert.equal(editor.isActive(), true, "re-enabling the keyword trigger should re-arm matching text");
  });

  it("isActive() returns false after backspace disarms trigger", () => {
    const { editor } = createEditor();
    editor.setText("workflow");
    assert.equal(editor.isActive(), true, "active after typing trigger");

    // Backspace (DEL = \x7f) when cursor is right after "workflow" should disarm
    editor.handleInput("\x7f");
    assert.equal(editor.isActive(), false, "should be inactive after backspace disarm");
  });

  it("backspace disarm records the exact text to suppress on submit", () => {
    const { editor, state } = createEditor();
    editor.setText("please discuss workflows");
    assert.equal(editor.isActive(), true, "active after typing trigger");

    editor.handleInput("\x7f");
    assert.equal(editor.isActive(), false, "should be inactive after backspace disarm");
    assert.equal(state.suppressedKeywordText, "please discuss workflows");

    editor.handleInput("!");
    assert.equal(state.suppressedKeywordText, undefined, "editing after disarm should clear one-shot suppression");
    assert.equal(editor.isActive(), true, "a changed trigger text should re-arm");
  });

  it("re-arms changed trigger text after an interactively typed trigger was disarmed", () => {
    const { editor, state } = createEditor();
    editor.handleInput("please discuss workflows");
    assert.equal(editor.isActive(), true, "active after typing trigger");

    editor.handleInput("\x7f");
    assert.equal(editor.isActive(), false, "backspace should disarm the current text");
    assert.equal(state.suppressedKeywordText, "please discuss workflows");

    editor.handleInput(" workflow");
    assert.equal(state.suppressedKeywordText, undefined, "changed trigger text should clear one-shot suppression");
    assert.equal(editor.isActive(), true, "changed trigger text should visually re-arm");
  });

  it("submit after backspace disarm preserves suppression for the input hook", () => {
    const { editor, state } = createEditor();
    editor.setText("please discuss workflows");
    editor.handleInput("\x7f");

    let submittedText: string | undefined;
    editor.onSubmit = (text: string) => {
      submittedText = text;
    };
    editor.handleInput("\r");

    assert.equal(submittedText, "please discuss workflows");
    assert.equal(state.suppressedKeywordText, "please discuss workflows");
  });

  it("handleInput calls onSubmit when Enter is pressed", () => {
    const { editor } = createEditor();
    let submittedText: string | undefined;
    editor.onSubmit = (text: string) => {
      submittedText = text;
    };
    editor.setText("hello");
    editor.handleInput("\r");
    assert.equal(submittedText, "hello", "onSubmit should have been called with the editor text");
  });

  it("modeState.active follows editor isActive state", () => {
    const { editor, state } = createEditor();

    assert.equal(state.active, false, "initially inactive");

    // setText alone does NOT call syncState — render() does.
    editor.setText("test workflow");
    editor.render(80);
    assert.equal(state.active, true, "active after setText + render");

    editor.handleInput("\x7f"); // Backspace disarms via handleInput
    assert.equal(state.active, false, "state becomes inactive after disarm");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  installWorkflowEditor — integration tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("installWorkflowEditor", () => {
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

    const ui = {
      setEditorComponent: (_factory: unknown) => {},
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());

    const events = registered.map((r) => r.event);
    assert.ok(events.includes("input"), 'should register "input" hook');
    assert.ok(events.includes("turn_end"), 'should register "turn_end" hook');
  });

  it("sets the editor component via ui.setEditorComponent", async () => {
    const mod = await load();
    let setFactory: unknown;
    const pi = {
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI;

    const ui = {
      setEditorComponent: (factory: unknown) => {
        setFactory = factory;
      },
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());

    assert.notEqual(setFactory, undefined, "setEditorComponent should have been called");
    assert.equal(typeof setFactory, "function", "the argument should be a factory function");
  });

  it("does not replace an existing custom editor component", async () => {
    const mod = await load();
    const captured: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
    let setEditorCalls = 0;
    let setActiveToolsCalls = 0;
    const existingEditorFactory = () => ({ kind: "existing-editor" });
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        captured.push({ event, handler });
      },
      getActiveTools: () => ["bash", "read"],
      setActiveTools: () => {
        setActiveToolsCalls++;
      },
    } as unknown as ExtensionAPI;

    const ui = {
      getEditorComponent: () => existingEditorFactory,
      setEditorComponent: () => {
        setEditorCalls++;
      },
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());

    assert.equal(setEditorCalls, 0, "existing custom editor should not be overwritten");

    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should still be registered");
    const result = inputHandler({
      source: "interactive",
      text: "Please run this workflow.",
    });
    assert.equal((result as { action?: string }).action, "transform");
    assert.equal(setActiveToolsCalls, 1, "workflow trigger should still add the workflow tool");
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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    const state = mod.installWorkflowEditor(pi, ui, undefined, store.options);
    assert.equal(state.keywordTriggerEnabled, true, "keyword trigger should default on");

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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    const state = mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions(false));
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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    const state = mod.installWorkflowEditor(pi, ui, undefined, {
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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());

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

    const ui2 = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    savedTools = [];
    mod.installWorkflowEditor(pi2, ui2, undefined, testSettingsOptions());

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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());
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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    const state = mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());
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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());

    const text = "Please discuss workflows as a normal topic.";
    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should be registered");
    const result = inputHandler({ source: "interactive", text });

    assert.deepEqual(result, {
      action: "transform",
      text: mod.buildForcedWorkflowPrompt(text),
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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, effort, testSettingsOptions());
    await commands.get("workflows-trigger")?.handler("off", {});

    const text = "Please discuss workflows as a normal topic.";
    const inputHandler = captured.find((h) => h.event === "input")?.handler;
    assert.ok(inputHandler, "input handler should be registered");
    const result = inputHandler({ source: "interactive", text });

    assert.deepEqual(result, {
      action: "transform",
      text: mod.buildForcedWorkflowPrompt(text, effortDirective("high")),
    });
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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());

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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());

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

    const ui = {
      setEditorComponent: () => {},
    } as unknown as ExtensionUIContext;

    mod.installWorkflowEditor(pi, ui, undefined, testSettingsOptions());

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

  it("persists a valid mode and reports the current one on status", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("detailed", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed" });
    assert.match(sent.at(-1)?.content ?? "", /detailed/i);

    await cmd.handler("status", {});
    assert.match(sent.at(-1)?.content ?? "", /panel is detailed/i);
  });

  it("ignores an invalid mode without persisting", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    await commands.get("workflows-progress")?.handler("verbose", {});
    assert.deepEqual(getSettings(), {}, "invalid mode is not saved");
    assert.match(sent.at(-1)?.content ?? "", /Usage:/);
  });

  it("clamps and persists the per-phase agent cap, rejecting non-numbers", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress-max");
    assert.ok(cmd, "registers /workflows-progress-max");

    await cmd.handler("5000", {});
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "clamps to 1000");

    await cmd.handler("abc", {});
    assert.match(sent.at(-1)?.content ?? "", /Invalid value/);
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "invalid value does not overwrite");

    await cmd.handler("0", {});
    assert.match(sent.at(-1)?.content ?? "", /Invalid value/);
  });
});
