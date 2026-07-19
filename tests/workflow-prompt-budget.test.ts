import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// Exact post-change measurements: ratchet only after reviewing a new accepted form.
// The prompt baseline intentionally uses an empty agentType registry so user configuration cannot alter it.
//
// ALWAYS-ON prompt (promptSnippet line + the single gate line): the authorize-
// keyword-trigger change took this DOWN from ~6_500 bytes (the ~20 "For workflow, …"
// how-to lines used to render every turn) to a single opt-in gate line. This PR then
// added concise task-shape positives to the gate line (#P4: balance the strong
// "do not call it" negative so the model still recognizes a good fit off-keyword),
// nudging the rendered always-on surface up to ~766 bytes — still an order of
// magnitude below the old always-on cost, and still self-priming-safe (no how-to here).
const RENDERED_PROMPT_BUDGET_BYTES = 800;
// TOOL DEFINITION (name + description + parameters): this GREW on purpose. The how-to
// mechanics moved OUT of the always-on prompt and the per-armed-turn message and INTO
// the tool's static `description` (see createWorkflowTool / workflowHowToGuidelines),
// where the model sees them whenever it looks at the tool — on every arming path and on
// off-keyword natural-language opt-ins — as a cacheable part of the tool definition
// rather than per-turn priming. So the definition went from ~2_529 to ~8_770 bytes.
// This is a MOVE, not new weight: it removed ~6.1KB re-injected on EACH armed turn
// (the armed message dropped from ~6_765 to ~905 bytes). Trimming the how-to text
// itself to shrink this definition is a SEPARATE concern (#65 / contract-concision
// work), not this PR's job — this PR does not claim a token saving on the definition.
// Ratcheted 8_800 → 8_900 for #68: the budget/timeout guideline now names the
// settings.json defaults (defaultTokenBudget, defaultAgentTimeoutMs) instead of
// claiming "the defaults are unbounded", which became false once those settings
// exist. Reviewed wording; ~90 bytes.
const TOOL_DEFINITION_BUDGET_BYTES = 8_900;

test("rendered workflow prompt contribution stays within its accepted size", async () => {
  await withRenderedWorkflow(async ({ systemPrompt, promptLines }) => {
    const expectedLines = new Set(promptLines);
    const renderedLines = systemPrompt.split("\n").filter((line) => expectedLines.has(line));
    assert.deepEqual(renderedLines, promptLines, "Pi should render each workflow prompt line exactly once");

    const renderedContribution = renderedLines.join("\n");
    const actualBytes = Buffer.byteLength(renderedContribution, "utf8");
    assert.ok(
      actualBytes <= RENDERED_PROMPT_BUDGET_BYTES,
      `Rendered workflow prompt is ${actualBytes} bytes; budget is ${RENDERED_PROMPT_BUDGET_BYTES}.\n${renderedContribution}`,
    );
  });
});

test("provider-visible workflow tool definition stays within its accepted size", async () => {
  await withRenderedWorkflow(async ({ wrappedWorkflow }) => {
    const definitionJson = JSON.stringify({
      name: wrappedWorkflow.name,
      description: wrappedWorkflow.description,
      parameters: wrappedWorkflow.parameters,
    });
    const actualBytes = Buffer.byteLength(definitionJson, "utf8");
    const parameterBytes = Buffer.byteLength(JSON.stringify(wrappedWorkflow.parameters), "utf8");

    assert.ok(
      actualBytes <= TOOL_DEFINITION_BUDGET_BYTES,
      `Workflow tool definition is ${actualBytes} bytes; budget is ${TOOL_DEFINITION_BUDGET_BYTES} (parameters: ${parameterBytes} bytes).\n${definitionJson}`,
    );
  });
});

test("the how-to mechanics live in the tool DESCRIPTION, not the always-on prompt", async () => {
  await withRenderedWorkflow(async ({ systemPrompt, wrappedWorkflow }) => {
    // The description is where the manual now lives (the model sees it whenever it
    // looks at the tool, on any arming path).
    assert.match(wrappedWorkflow.description, /How to write the script:/);
    assert.match(wrappedWorkflow.description, /export const meta = \{/);
    assert.match(wrappedWorkflow.description, /parallel\(\) takes functions, not promises/);

    // ...and NOT re-rendered into the always-on system prompt every turn.
    assert.doesNotMatch(systemPrompt, /parallel\(\) takes functions, not promises/);
  });
});

async function withRenderedWorkflow(
  inspect: (surface: {
    systemPrompt: string;
    promptLines: string[];
    wrappedWorkflow: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workflow-prompt-budget-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await withFakeHomeAsync(root, async () => {
      const workflow = createWorkflowTool({ cwd: root });
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        tools: ["workflow"],
        customTools: [workflow],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager: SettingsManager.inMemory(),
      });

      try {
        const wrappedWorkflow = session.agent.state.tools.find((tool) => tool.name === "workflow");
        assert.ok(wrappedWorkflow, "Pi should expose the wrapped workflow tool");

        await inspect({
          systemPrompt: session.agent.state.systemPrompt,
          promptLines: [
            `- workflow: ${workflow.promptSnippet}`,
            ...workflow.promptGuidelines.map((guideline) => `- ${guideline}`),
          ],
          wrappedWorkflow,
        });
      } finally {
        session.dispose();
      }
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
