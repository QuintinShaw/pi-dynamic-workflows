/**
 * Tests for tools availability when workflows mode is triggered.
 *
 * The bug: when a user message contains "workflow" (trigger keyword),
 * installWorkflowKeywordArming's input handler calls:
 *   pi.setActiveTools?.([WORKFLOW_TOOL_NAME]);
 * which restricts ALL tools to ONLY the workflow tool.
 * The model then cannot use read, bash, edit, write, web_search, etc.
 * and gets "Tool X not found" errors.
 *
 * The fix: preserve default Pi tools alongside the workflow tool.
 * These tests verify that default tools remain available after the
 * workflows-mode trigger fires.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, mock } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  takeWorkflowRuntime,
} from "../src/extension-reload.js";
import { _registerBoundSessionSendForTests, _resetDeliveryRegistriesForTests } from "../src/task-panel.js";
import { buildArmedWorkflowPrompt, WORKFLOW_TOOL_NAME, type WorkflowModeState } from "../src/workflow-editor.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// ---------------------------------------------------------------------------
// Default Pi tools that every Pi install provides (plugin-independent)
// ---------------------------------------------------------------------------
const DEFAULT_PI_TOOLS = [
  "bash",
  "read",
  "edit",
  "write",
  "ask_user_question",
  "todo",
  "web_search",
  "web_fetch",
  "advisor",
  "subagent",
  "workflow",
  "workflow_control",
];

// Additional tools from context-mode plugin (common but not guaranteed)
// We do NOT include these in DEFAULT_PI_TOOLS for compatibility.
// Tools like ctx_execute, ctx_execute_file, ctx_index, ctx_search, etc.
// are from a plugin and may not be present.

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockPi {
  on: ReturnType<typeof mock.fn>;
  getActiveTools: ReturnType<typeof mock.fn>;
  setActiveTools: ReturnType<typeof mock.fn>;
  handlers: Record<string, Array<(...args: any[]) => any>>;
}

function createMockPi(initialTools: string[] = [...DEFAULT_PI_TOOLS]): MockPi {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    on: mock.fn((event: string, handler: (...args: any[]) => any) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    getActiveTools: mock.fn(() => [...initialTools]),
    setActiveTools: mock.fn(),
    handlers,
  };
}

function testSettingsOptions(keywordTriggerEnabled = true, keywordTriggerWord?: string) {
  return {
    settingsStore: {
      load: () => ({ keywordTriggerEnabled, ...(keywordTriggerWord ? { keywordTriggerWord } : {}) }),
      save: () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// Test: installWorkflowKeywordArming keeps default tools available
// ---------------------------------------------------------------------------

describe("installWorkflowKeywordArming - tool availability", () => {
  it("should include default Pi tools when input handler fires with 'workflow'", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    const mockPi = createMockPi([...DEFAULT_PI_TOOLS]);

    installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

    // Simulate user submitting a message with "workflow" keyword
    const inputHandlers = mockPi.handlers.input;
    assert.ok(inputHandlers, "input handler should be registered");
    assert.equal(inputHandlers.length, 1);

    const result = inputHandlers[0]({
      source: "interactive",
      text: "przetestuj to workflow zadanie",
    });

    // Verify transform result
    assert.deepEqual(result, {
      action: "transform",
      text: buildArmedWorkflowPrompt("przetestuj to workflow zadanie"),
    });

    // Verify getActiveTools was called
    assert.equal(mockPi.getActiveTools.mock.callCount(), 1);

    // Verify setActiveTools was called
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);

    const calledWith = mockPi.setActiveTools.mock.calls[0].arguments[0];
    assert.ok(Array.isArray(calledWith), "setActiveTools should be called with an array");

    // The critical assertion: the workflow tool must be present
    assert.ok(calledWith.includes(WORKFLOW_TOOL_NAME), `"${WORKFLOW_TOOL_NAME}" must be in active tools`);

    // The critical assertion: default Pi tools must still be available
    for (const tool of DEFAULT_PI_TOOLS) {
      assert.ok(
        calledWith.includes(tool),
        `"${tool}" should still be available when workflows mode is triggered (got: [${calledWith.join(", ")}])`,
      );
    }

    // Verify tools are not restricted to just workflow
    assert.ok(
      calledWith.length > 1,
      `More than one tool should be active, not just workflow (got: [${calledWith.join(", ")}])`,
    );
  });

  it("should restore original tools on turn_end", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    // Add a bonus tool to simulate a plugin adding a tool
    const originalTools = ["bash", "read", "edit", "write", "custom-plugin-tool", "workflow", "workflow_control"];
    const mockPi = createMockPi(originalTools);

    installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

    // Trigger input with "workflows"
    const inputHandlers = mockPi.handlers.input;
    inputHandlers[0]({
      source: "interactive",
      text: "run workflows",
    });

    // Verify tools were set (with default tools preserved)
    const toolsWhenActive = mockPi.setActiveTools.mock.calls[0].arguments[0];
    for (const t of originalTools) {
      assert.ok(toolsWhenActive.includes(t), `"${t}" should be in active tools`);
    }

    // Simulate turn_end
    const turnEndHandlers = mockPi.handlers.turn_end;
    assert.ok(turnEndHandlers, "turn_end handler should be registered");
    assert.equal(turnEndHandlers.length, 1);

    turnEndHandlers[0]();

    // Verify original tools were restored exactly
    const restoredTools = mockPi.setActiveTools.mock.calls[1].arguments[0];
    assert.deepEqual(restoredTools, originalTools, "original tools should be restored exactly");
  });

  it("should fire for a configured trigger word but not the default word", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    const mockPi = createMockPi();
    installWorkflowKeywordArming(
      mockPi as unknown as ExtensionAPI,
      undefined,
      testSettingsOptions(true, "pi-workflow"),
    );

    const inputHandlers = mockPi.handlers.input;
    assert.deepEqual(inputHandlers[0]({ source: "interactive", text: "run workflow" }), { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);

    const result = inputHandlers[0]({ source: "interactive", text: "run pi-workflow" });
    assert.equal(result.action, "transform");
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);
  });

  it('should not fire for "/workflows" (slash command, not trigger)', async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    const mockPi = createMockPi();

    installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

    // Simulate user submitting a slash command
    const inputHandlers = mockPi.handlers.input;
    const result = inputHandlers[0]({
      source: "interactive",
      text: "/workflows list",
    });

    // Should not transform (slash commands are not triggers)
    assert.deepEqual(result, { action: "continue" });

    // Should NOT have called setActiveTools
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should not fire for non-interactive sources", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    const mockPi = createMockPi();

    installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

    const inputHandlers = mockPi.handlers.input;
    const result = inputHandlers[0]({
      source: "api", // non-interactive
      text: "run a workflow",
    });

    assert.deepEqual(result, { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should not fire for empty text", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    const mockPi = createMockPi();

    installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

    const inputHandlers = mockPi.handlers.input;
    const result = inputHandlers[0]({
      source: "interactive",
      text: "",
    });

    assert.deepEqual(result, { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should handle getActiveTools returning undefined gracefully", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    // Pi may not have getActiveTools in some hosts
    const mockPi = createMockPi();
    mockPi.getActiveTools = mock.fn(() => undefined as unknown as string[]);

    installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

    const inputHandlers = mockPi.handlers.input;
    assert.doesNotThrow(() => {
      inputHandlers[0]({
        source: "interactive",
        text: "test workflow",
      });
    });
  });

  it("should handle setActiveTools throwing gracefully (best-effort)", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    const mockPi = createMockPi();
    mockPi.setActiveTools = mock.fn(() => {
      throw new Error("host rejected tool restriction");
    });

    installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

    const inputHandlers = mockPi.handlers.input;
    // Should not throw — the catch block handles it
    const result = inputHandlers[0]({
      source: "interactive",
      text: "test workflow",
    });

    // Should still return the transform action even if setActiveTools failed
    assert.equal(result.action, "transform");
  });

  it("should handle multiple trigger events and restore correctly", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    const originalTools = ["bash", "read", "edit", "write"];
    const mockPi = createMockPi(originalTools);

    installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

    // First trigger
    const inputHandlers = mockPi.handlers.input;
    inputHandlers[0]({
      source: "interactive",
      text: "test workflow 1",
    });

    // Second trigger (before turn_end)
    inputHandlers[0]({
      source: "interactive",
      text: "test workflow 2",
    });

    // setActiveTools should only have been called once (savedTools is already set)
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);

    // turn_end restores
    const turnEndHandlers = mockPi.handlers.turn_end;
    turnEndHandlers[0]();

    // Subsequent turn_end should NOT restore again (savedTools is now undefined)
    mockPi.setActiveTools.mock.resetCalls();
    turnEndHandlers[0]();
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0, "second turn_end should not call setActiveTools");
  });

  it("should work with different keyword variations: 'workflow', 'workflows', 'WORKFLOW'", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    for (const keyword of ["workflow", "workflows", "WORKFLOW", "WorkFlows"]) {
      const mockPi = createMockPi();
      installWorkflowKeywordArming(mockPi as unknown as ExtensionAPI, undefined, testSettingsOptions());

      mockPi.setActiveTools.mock.resetCalls();

      const inputHandlers = mockPi.handlers.input;
      inputHandlers[0]({
        source: "interactive",
        text: `run ${keyword} test`,
      });

      const tools = mockPi.setActiveTools.mock.calls[0]?.arguments[0];
      assert.ok(tools?.includes("bash"), `bash should be available for keyword "${keyword}"`);
      assert.ok(tools?.includes("read"), `read should be available for keyword "${keyword}"`);
      assert.ok(tools?.includes(WORKFLOW_TOOL_NAME), `workflow should be in active tools for keyword "${keyword}"`);
    }
  });

  it("should return correct WorkflowModeState", async () => {
    const { installWorkflowKeywordArming } = await import("../src/workflow-editor.js");

    const mockPi = createMockPi();

    const state: WorkflowModeState = installWorkflowKeywordArming(
      mockPi as unknown as ExtensionAPI,
      undefined,
      testSettingsOptions(),
    );

    assert.equal(typeof state.active, "boolean");
    assert.equal(state.active, false);
  });
});

describe("workflow extension - control tool availability", () => {
  it("registers both control tools and hands the live runtime across reload", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime(process.cwd());
        const registeredTools: string[] = [];
        const activeTools = ["bash", "read"];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        const pi = {
          registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        const { default: installExtension } = await import("../extensions/workflow.js");

        installExtension(pi);

        assert.deepEqual(registeredTools.slice(0, 2), ["workflow", "workflow_control"]);
        assert.equal(handlers.session_start.length, 1);
        handlers.session_start[0](
          {},
          {
            cwd: process.cwd(),
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "session-1" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );

        assert.ok(activeTools.includes("workflow"));
        assert.ok(activeTools.includes("workflow_control"));

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const staged = takeWorkflowRuntime(process.cwd());
        assert.ok(staged, "session_shutdown(reload) stages the live manager for the next extension generation");
        staged.effort.level = "high";
        handoffWorkflowRuntime(staged);

        const secondHandlers: Record<string, Array<(...args: any[]) => any>> = {};
        const secondPi = {
          registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!secondHandlers[event]) secondHandlers[event] = [];
            secondHandlers[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        installExtension(secondPi);
        assert.equal(takeWorkflowRuntime(process.cwd()), undefined, "the fresh factory consumes the staged runtime");

        secondHandlers.session_start?.[0]?.(
          { reason: "reload" },
          {
            cwd: process.cwd(),
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "session-2" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );

        secondHandlers.session_shutdown?.[0]?.({ reason: "reload" });
        const restaged = takeWorkflowRuntime(process.cwd());
        assert.equal(restaged?.manager, staged.manager, "a compatible generation keeps the exact live manager");
        assert.equal(restaged?.effort.level, "high", "session effort survives with the compatible runtime");
        discardWorkflowRuntime(process.cwd());
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("hands the live runtime across in-process session replacement when the destination is safe", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-replace-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-dw-session-files-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const sameSessionFile = join(sessionDir, "same.jsonl");
        writeFileSync(
          sameSessionFile,
          `${JSON.stringify({
            type: "session",
            id: "same",
            cwd: process.cwd(),
            timestamp: new Date().toISOString(),
          })}\n`,
        );

        // resume requires a readable same-cwd header; fork may lack a file;
        // new/reload are same-project by definition.
        const cases: Array<{
          reason: "new" | "resume" | "fork";
          event: { reason: string; targetSessionFile?: string };
        }> = [
          { reason: "new", event: { reason: "new" } },
          { reason: "fork", event: { reason: "fork" } },
          { reason: "resume", event: { reason: "resume", targetSessionFile: sameSessionFile } },
        ];

        for (const { reason, event } of cases) {
          discardWorkflowRuntime(process.cwd());

          const activeTools = ["bash", "read"];
          const handlers: Record<string, Array<(...args: any[]) => any>> = {};
          const pi = {
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (eventName: string, handler: (...args: any[]) => any) => {
              if (!handlers[eventName]) handlers[eventName] = [];
              handlers[eventName].push(handler);
            },
            getActiveTools: () => [...activeTools],
            setActiveTools: (tools: string[]) => {
              activeTools.splice(0, activeTools.length, ...tools);
            },
            sendMessage: () => {},
          } as unknown as ExtensionAPI;
          const { default: installExtension } = await import("../extensions/workflow.js");
          installExtension(pi);

          handlers.session_shutdown?.[0]?.(event);
          const staged = takeWorkflowRuntime(process.cwd());
          assert.ok(
            staged,
            `session_shutdown(${reason}) must stage the live manager so background result delivery survives`,
          );
          handoffWorkflowRuntime(staged);

          const secondDelivered: string[] = [];
          const secondHandlers: Record<string, Array<(...args: any[]) => any>> = {};
          const secondPi = {
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (eventName: string, handler: (...args: any[]) => any) => {
              if (!secondHandlers[eventName]) secondHandlers[eventName] = [];
              secondHandlers[eventName].push(handler);
            },
            getActiveTools: () => [...activeTools],
            setActiveTools: (tools: string[]) => {
              activeTools.splice(0, activeTools.length, ...tools);
            },
            sendMessage: (msg: { content?: string }) => {
              if (msg.content) secondDelivered.push(msg.content);
            },
          } as unknown as ExtensionAPI;
          installExtension(secondPi);
          assert.equal(takeWorkflowRuntime(process.cwd()), undefined, "second generation claims the staged runtime");

          // Production session_start does not pass stableSend — steal map only.
          _resetDeliveryRegistriesForTests();
          _registerBoundSessionSendForTests(`session-${reason}`, (msg) => {
            if (typeof msg.content === "string") secondDelivered.push(msg.content);
            return Promise.resolve();
          });
          secondHandlers.session_start?.[0]?.(
            { reason },
            {
              cwd: process.cwd(),
              model: undefined,
              modelRegistry: {},
              sessionManager: {
                getSessionId: () => `session-${reason}`,
              },
              ui: { setWidget: () => {}, notify: () => {} },
            },
          );

          const fakeRun = {
            runId: "bg-1",
            background: true,
            sessionId: `session-${reason}`,
            snapshot: { name: "t", agentCount: 0 },
            result: { agentCount: 0, result: { verdict: `ok-${reason}` } },
          };
          const origGet = staged.manager.getRun.bind(staged.manager);
          (staged.manager as { getRun: (id: string) => unknown }).getRun = (id: string) =>
            id === "bg-1" ? fakeRun : origGet(id);
          staged.manager.emit("complete", { runId: "bg-1" });
          assert.ok(
            secondDelivered.some((c) => c.includes(`ok-${reason}`)),
            `completion after ${reason} handoff must deliver via the stolen host send`,
          );
          discardWorkflowRuntime(process.cwd());
        }
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("resume fails closed without a readable same-cwd session header; fork may hand off without a file", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-resume-closed-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-dw-session-resume-closed-"));
    const otherProject = mkdtempSync(join(tmpdir(), "pi-dw-other-resume-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const { default: installExtension } = await import("../extensions/workflow.js");
        const makePi = (handlers: Record<string, Array<(...args: any[]) => any>>) =>
          ({
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (event: string, handler: (...args: any[]) => any) => {
              if (!handlers[event]) handlers[event] = [];
              handlers[event].push(handler);
            },
            getActiveTools: () => ["bash"],
            setActiveTools: () => {},
            sendMessage: () => {},
          }) as unknown as ExtensionAPI;

        const installWithLiveRun = (runId: string) => {
          discardWorkflowRuntime();
          const seedHandlers: Record<string, Array<(...args: any[]) => any>> = {};
          installExtension(makePi(seedHandlers));
          seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
          const staged = takeWorkflowRuntime();
          assert.ok(staged, "seed reload must expose the manager for live-run injection");

          const paused: string[] = [];
          staged.manager.listLiveRuns = (() => [{ runId, status: "running" }]) as typeof staged.manager.listLiveRuns;
          staged.manager.pause = ((id: string) => {
            paused.push(id);
            return true;
          }) as typeof staged.manager.pause;
          handoffWorkflowRuntime(staged);

          const handlers: Record<string, Array<(...args: any[]) => any>> = {};
          installExtension(makePi(handlers));
          return { handlers, paused };
        };

        // resume + no targetSessionFile → discard
        {
          const { handlers, paused } = installWithLiveRun("resume-no-target");
          handlers.session_shutdown?.[0]?.({ reason: "resume" });
          assert.deepEqual(paused, ["resume-no-target"], "fail-closed resume must pause the live run");
          assert.equal(
            takeWorkflowRuntime(process.cwd()),
            undefined,
            "resume without targetSessionFile must fail closed (no handoff)",
          );
        }

        // resume + missing/unreadable header → discard
        {
          const { handlers, paused } = installWithLiveRun("resume-missing-header");
          handlers.session_shutdown?.[0]?.({
            reason: "resume",
            targetSessionFile: join(sessionDir, "does-not-exist.jsonl"),
          });
          assert.deepEqual(paused, ["resume-missing-header"], "unreadable resume target must pause the live run");
          assert.equal(
            takeWorkflowRuntime(process.cwd()),
            undefined,
            "resume with missing session header must fail closed",
          );
        }

        // resume + different cwd header → discard
        {
          discardWorkflowRuntime(process.cwd());
          const foreign = join(sessionDir, "foreign.jsonl");
          writeFileSync(
            foreign,
            `${JSON.stringify({
              type: "session",
              id: "foreign",
              cwd: otherProject,
              timestamp: new Date().toISOString(),
            })}\n`,
          );
          const { handlers, paused } = installWithLiveRun("resume-foreign-cwd");
          handlers.session_shutdown?.[0]?.({ reason: "resume", targetSessionFile: foreign });
          assert.deepEqual(paused, ["resume-foreign-cwd"], "cross-project resume must pause the source live run");
          assert.equal(
            takeWorkflowRuntime(process.cwd()),
            undefined,
            "resume into a different project must discard, not hand off",
          );
        }

        // resume + same cwd header → handoff
        {
          discardWorkflowRuntime(process.cwd());
          const same = join(sessionDir, "same-cwd.jsonl");
          writeFileSync(
            same,
            `${JSON.stringify({
              type: "session",
              id: "same",
              cwd: process.cwd(),
              timestamp: new Date().toISOString(),
            })}\n`,
          );
          const { handlers, paused } = installWithLiveRun("resume-same-cwd");
          handlers.session_shutdown?.[0]?.({ reason: "resume", targetSessionFile: same });
          assert.deepEqual(paused, [], "same-project resume must keep the live run running");
          const staged = takeWorkflowRuntime(process.cwd());
          assert.ok(staged, "resume with readable same-cwd header must hand off");
          discardWorkflowRuntime(process.cwd());
        }

        // fork without a session file still hands off (new fork file may not exist yet)
        {
          const { handlers, paused } = installWithLiveRun("fork-no-target");
          handlers.session_shutdown?.[0]?.({ reason: "fork" });
          assert.deepEqual(paused, [], "fork without a target file stays in-project and must keep the live run");
          const staged = takeWorkflowRuntime(process.cwd());
          assert.ok(staged, "fork without targetSessionFile must still hand off");
          discardWorkflowRuntime(process.cwd());
        }

        // fork + positively foreign cwd → pause + discard
        {
          const foreign = join(sessionDir, "foreign-fork.jsonl");
          writeFileSync(
            foreign,
            `${JSON.stringify({
              type: "session",
              id: "foreign-fork",
              cwd: otherProject,
              timestamp: new Date().toISOString(),
            })}\n`,
          );
          const { handlers, paused } = installWithLiveRun("fork-foreign-cwd");
          handlers.session_shutdown?.[0]?.({ reason: "fork", targetSessionFile: foreign });
          assert.deepEqual(paused, ["fork-foreign-cwd"], "foreign fork target must pause the source live run");
          assert.equal(takeWorkflowRuntime(), undefined, "foreign fork target must not stage a handoff");
        }
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it("defers saved-command registration until session_start so cross-cwd descriptions come from the target project", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-saved-defer-"));
    const otherProject = mkdtempSync(join(tmpdir(), "pi-dw-other-saved-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const { createWorkflowStorage } = await import("../src/workflow-saved.js");
        createWorkflowStorage(process.cwd()).save({
          name: "same",
          description: "SECRET_FROM_A",
          script: "export SOURCE_A",
          location: "project",
        });
        createWorkflowStorage(otherProject).save({
          name: "same",
          description: "from-B",
          script: "export TARGET_B",
          location: "project",
        });

        discardWorkflowRuntime(process.cwd());
        discardWorkflowRuntime(otherProject);

        const commands: Array<{
          name: string;
          description?: string;
          handler: (args: string, ctx: unknown) => unknown;
        }> = [];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        const pi = {
          registerTool: () => {},
          registerCommand: (
            name: string,
            spec: { description?: string; handler: (args: string, ctx: unknown) => unknown },
          ) => {
            commands.push({ name, description: spec.description, handler: spec.handler });
          },
          getCommands: () => commands.map((c) => ({ name: c.name, description: c.description })),
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => ["bash"],
          setActiveTools: () => {},
          sendMessage: () => {},
        } as unknown as ExtensionAPI;

        const { default: installExtension } = await import("../extensions/workflow.js");
        installExtension(pi);

        assert.equal(
          commands.some((c) => c.name === "same"),
          false,
          "factory must not register project saved commands before session_start",
        );

        handlers.session_start?.[0]?.(
          { reason: "resume" },
          {
            cwd: otherProject,
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "session-b" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );

        const savedCmd = commands.find((c) => c.name === "same");
        assert.ok(savedCmd, "session_start must register the target project's saved command");
        assert.equal(
          savedCmd.description,
          "from-B",
          "command description must come from the session project, not the factory cwd",
        );

        // Capture the live manager and assert the handler executes B's script.
        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const runtime = claimWorkflowRuntime(process.cwd()).compatible;
        assert.ok(runtime, "shutdown after rebuild must be claimable via process.cwd()");
        const started: string[] = [];
        runtime.manager.startInBackground = ((script: string) => {
          started.push(script);
          return { runId: "bg-same", promise: new Promise(() => {}) };
        }) as typeof runtime.manager.startInBackground;

        const notified: Array<{ message: string; type?: string }> = [];
        await savedCmd.handler("", {
          ui: {
            notify: (message: string, type?: string) => notified.push({ message, type }),
            setStatus: () => {},
          },
        });
        assert.deepEqual(started, ["export TARGET_B"]);
        assert.ok(notified.some((n) => n.type === "info"));
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it("wires model_select to manager.setMainModel", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-model-select-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime(process.cwd());
        const { WorkflowManager } = await import("../src/workflow-manager.js");
        const seen: Array<string | undefined> = [];
        const original = WorkflowManager.prototype.setMainModel;
        WorkflowManager.prototype.setMainModel = function setMainModelSpy(spec: string | undefined) {
          seen.push(spec);
          return original.call(this, spec);
        };
        try {
          const activeTools = ["bash", "read"];
          const handlers: Record<string, Array<(...args: any[]) => any>> = {};
          const pi = {
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (event: string, handler: (...args: any[]) => any) => {
              if (!handlers[event]) handlers[event] = [];
              handlers[event].push(handler);
            },
            getActiveTools: () => [...activeTools],
            setActiveTools: (tools: string[]) => {
              activeTools.splice(0, activeTools.length, ...tools);
            },
            sendMessage: () => {},
          } as unknown as ExtensionAPI;
          const { default: installExtension } = await import("../extensions/workflow.js");
          installExtension(pi);

          assert.equal(handlers.model_select?.length, 1, "must listen for model_select");

          handlers.session_start[0](
            {},
            {
              cwd: process.cwd(),
              model: { provider: "start-prov", id: "model-a" },
              modelRegistry: {},
              sessionManager: { getSessionId: () => "session-model" },
              ui: { setWidget: () => {}, notify: () => {} },
            },
          );
          assert.ok(seen.includes("start-prov/model-a"), "session_start should seed mainModel from ctx.model");

          handlers.model_select[0]({
            type: "model_select",
            model: { provider: "live-prov", id: "model-b" },
            previousModel: { provider: "start-prov", id: "model-a" },
            source: "set",
          });
          assert.ok(
            seen.includes("live-prov/model-b"),
            "model_select must call setMainModel with the newly selected spec",
          );

          discardWorkflowRuntime(process.cwd());
        } finally {
          WorkflowManager.prototype.setMainModel = original;
        }
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("queues completions that land before session_start and flushes them after", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-prebind-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime(process.cwd());
        const activeTools = ["bash", "read"];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        const delivered: string[] = [];
        const pi = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: (msg: { content?: string }) => {
            if (!(pi as { _bound?: boolean })._bound) {
              throw new Error("Extension runtime not initialized");
            }
            if (msg.content) delivered.push(msg.content);
          },
          _bound: false,
        } as unknown as ExtensionAPI & { _bound: boolean };
        const { default: installExtension } = await import("../extensions/workflow.js");
        installExtension(pi);

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const staged = takeWorkflowRuntime(process.cwd());
        assert.ok(staged);
        handoffWorkflowRuntime(staged);

        const handlers2: Record<string, Array<(...args: any[]) => any>> = {};
        const pi2 = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers2[event]) handlers2[event] = [];
            handlers2[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: (msg: { content?: string }) => {
            if (!(pi2 as { _bound?: boolean })._bound) {
              throw new Error("Extension runtime not initialized");
            }
            if (msg.content) delivered.push(msg.content);
          },
          _bound: false,
        } as unknown as ExtensionAPI & { _bound: boolean };
        installExtension(pi2);

        const fakeRun = {
          runId: "bg-prebind",
          background: true,
          snapshot: { name: "t", agentCount: 0 },
          result: { agentCount: 0, result: { verdict: "prebind-ok" } },
        };
        const mgr = staged.manager;
        const origGet = mgr.getRun.bind(mgr);
        (mgr as { getRun: (id: string) => unknown }).getRun = (id: string) =>
          id === "bg-prebind" ? fakeRun : origGet(id);
        // Ensure flush can see the in-memory pending marker (not only disk).
        const origListLive = mgr.listLiveRuns?.bind(mgr);
        (mgr as { listLiveRuns: () => unknown[] }).listLiveRuns = () => {
          const live = origListLive ? origListLive() : [];
          return live.some((r: { runId?: string }) => r?.runId === "bg-prebind") ? live : [...live, fakeRun];
        };
        mgr.emit("complete", { runId: "bg-prebind" });
        assert.equal(delivered.length, 0, "must not deliver while runtime unbound");

        pi2._bound = true;
        _resetDeliveryRegistriesForTests();
        _registerBoundSessionSendForTests("s-prebind", (msg) => {
          if (typeof msg.content === "string") delivered.push(msg.content);
          return Promise.resolve();
        });
        handlers2.session_start?.[0]?.(
          { reason: "reload" },
          {
            cwd: process.cwd(),
            model: undefined,
            modelRegistry: {},
            sessionManager: {
              getSessionId: () => "s-prebind",
            },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );
        assert.ok(
          delivered.some((c) => c.includes("prebind-ok")),
          "session_start must flush the pre-bind queue",
        );
        discardWorkflowRuntime(process.cwd());
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("rebuilds the manager when session_start ctx.cwd differs from factory cwd", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-crosscwd-"));
    const otherProject = mkdtempSync(join(tmpdir(), "pi-dw-other-project-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime(process.cwd());
        const activeTools = ["bash", "read"];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        const pi = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        const { default: installExtension } = await import("../extensions/workflow.js");
        installExtension(pi);

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const factoryRuntime = takeWorkflowRuntime(process.cwd());
        assert.ok(factoryRuntime);
        const factoryManager = factoryRuntime.manager;
        assert.equal(resolve(factoryManager.getCwd()), resolve(process.cwd()));
        handoffWorkflowRuntime(factoryRuntime);

        const handlers2: Record<string, Array<(...args: any[]) => any>> = {};
        const pi2 = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers2[event]) handlers2[event] = [];
            handlers2[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        installExtension(pi2);

        handlers2.session_start?.[0]?.(
          { reason: "resume" },
          {
            cwd: otherProject,
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "foreign-session" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );

        handlers2.session_shutdown?.[0]?.({ reason: "reload" });
        // Process-wide slot: claimable via process.cwd() even though the manager
        // owns otherProject. Next factory (which only knows process.cwd()) must
        // receive the same manager.
        const rebuilt = claimWorkflowRuntime(process.cwd()).compatible;
        assert.ok(rebuilt, "rebuilt runtime must be claimable via process.cwd() (factory path)");
        assert.equal(resolve(rebuilt.manager.getCwd()), resolve(otherProject));
        assert.notEqual(rebuilt.manager, factoryManager, "must not keep the source-project manager");
        // Round-trip: a third factory install must adopt the claimed manager.
        handoffWorkflowRuntime(rebuilt);
        const handlers3: Record<string, Array<(...args: any[]) => any>> = {};
        const pi3 = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers3[event]) handlers3[event] = [];
            handlers3[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        installExtension(pi3);
        handlers3.session_start?.[0]?.(
          { reason: "reload" },
          {
            cwd: otherProject,
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "foreign-session-2" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );
        handlers3.session_shutdown?.[0]?.({ reason: "reload" });
        const again = claimWorkflowRuntime(process.cwd()).compatible;
        assert.ok(again);
        assert.equal(again.manager, rebuilt.manager, "round-trip reload must keep the same live manager");
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it("pauses in-flight runs and discards on quit/unknown shutdown (nothing will claim)", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-quit-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime(process.cwd());
        const activeTools = ["bash", "read"];
        const makePi = (handlers: Record<string, Array<(...args: any[]) => any>>) =>
          ({
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (event: string, handler: (...args: any[]) => any) => {
              if (!handlers[event]) handlers[event] = [];
              handlers[event].push(handler);
            },
            getActiveTools: () => [...activeTools],
            setActiveTools: (tools: string[]) => {
              activeTools.splice(0, activeTools.length, ...tools);
            },
            sendMessage: () => {},
          }) as unknown as ExtensionAPI;
        const { default: installExtension } = await import("../extensions/workflow.js");

        const installWithLiveRun = (runId: string) => {
          discardWorkflowRuntime();
          const seedHandlers: Record<string, Array<(...args: any[]) => any>> = {};
          installExtension(makePi(seedHandlers));
          seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
          const staged = takeWorkflowRuntime();
          assert.ok(staged, "seed reload must expose the manager for live-run injection");

          const paused: string[] = [];
          staged.manager.listLiveRuns = (() => [{ runId, status: "running" }]) as typeof staged.manager.listLiveRuns;
          staged.manager.pause = ((id: string) => {
            paused.push(id);
            return true;
          }) as typeof staged.manager.pause;
          handoffWorkflowRuntime(staged);

          const handlers: Record<string, Array<(...args: any[]) => any>> = {};
          installExtension(makePi(handlers));
          return { handlers, paused };
        };

        {
          const { handlers, paused } = installWithLiveRun("shutdown-unknown");
          handlers.session_shutdown?.[0]?.();
          assert.deepEqual(paused, ["shutdown-unknown"], "missing shutdown reason must pause the live run");
          assert.equal(
            takeWorkflowRuntime(process.cwd()),
            undefined,
            "session_shutdown with no reason must not stage a handoff",
          );
        }
        {
          const { handlers, paused } = installWithLiveRun("shutdown-quit");
          handlers.session_shutdown?.[0]?.({ reason: "quit" });
          assert.deepEqual(paused, ["shutdown-quit"], "quit must pause the live run before process teardown");
          assert.equal(
            takeWorkflowRuntime(process.cwd()),
            undefined,
            "session_shutdown(quit) must not stage a handoff — process is exiting",
          );
        }
        {
          const { handlers, paused } = installWithLiveRun("shutdown-manual");
          handlers.session_shutdown?.[0]?.({ reason: "manual" });
          assert.deepEqual(paused, ["shutdown-manual"], "unknown shutdown reasons must pause the live run");
          assert.equal(
            takeWorkflowRuntime(process.cwd()),
            undefined,
            "unknown shutdown reasons must not stage a handoff",
          );
        }
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("sessionFileCwd (read-only header probe)", () => {
  it("reads cwd from the session header without creating sidecars", async () => {
    const { sessionFileCwd } = await import("../extensions/workflow.js");
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-session-probe-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(
        file,
        JSON.stringify({
          type: "session",
          id: "abc",
          cwd: "/tmp/target-project",
          timestamp: new Date().toISOString(),
        }) +
          "\n" +
          JSON.stringify({ type: "message", role: "user", content: "hi" }) +
          "\n",
      );
      const before = new Set(readdirSync(dir));
      assert.equal(sessionFileCwd(file), resolve("/tmp/target-project"));
      const after = new Set(readdirSync(dir));
      assert.deepEqual([...after].sort(), [...before].sort(), "probe must not create files or dirs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing, empty, or non-session files", async () => {
    const { sessionFileCwd } = await import("../extensions/workflow.js");
    assert.equal(sessionFileCwd(undefined), undefined);
    assert.equal(sessionFileCwd("/no/such/file.jsonl"), undefined);
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-session-probe-bad-"));
    try {
      const empty = join(dir, "empty.jsonl");
      writeFileSync(empty, "");
      assert.equal(sessionFileCwd(empty), undefined);
      const other = join(dir, "other.jsonl");
      writeFileSync(other, `${JSON.stringify({ type: "message", role: "user" })}\n`);
      assert.equal(sessionFileCwd(other), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
