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
// The upstream authorization gate is the only always-on guideline. Authoring
// mechanics stay in the compact static tool definition and discoverable skill.
const RENDERED_PROMPT_BUDGET_BYTES = 800;
// #105 corrected omitted timeout/budget semantics to name configured defaults,
// increasing the compact definition from 3,802 to 3,918 bytes.
// Made the 5 built-in workflow patterns (deep-research, adversarial-review,
// code-review, multi-perspective, codebase-audit) reachable from the tool
// itself, not only slash commands: added an optional `name` input (with a
// deliberately terse description that defers argument-shape details to a new
// workflow-patterns skill) and a one-clause addition to `script`'s
// description noting it's optional when `name` is given, increasing this
// compact definition from 3,918 to 4,267 bytes (+349).
//
// That is not the full always-on cost of this change, stated honestly: the
// new workflow-patterns skill itself also contributes an always-on
// discovery entry (its `name` + `description`, shown to the model regardless
// of whether the skill is ever loaded) of ~593 bytes — see
// docs/workflow-context-surfaces.json's `registeredSkillsDiscovery`, which is
// generic over every skill package.json's `pi.skills` registers (not
// hardcoded to workflow-authoring), so this and any future skill's always-on
// cost stays tracked. Total always-on growth from this change is
// approximately 349 (this tool definition) + 593 (skill discovery) ≈ 942
// bytes — well short of loading the skill's full body, which only happens
// on demand.
const TOOL_DEFINITION_BUDGET_BYTES = 4_267;

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
