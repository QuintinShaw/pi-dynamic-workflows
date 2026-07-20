import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
import packageJson from "../package.json" with { type: "json" };
import {
  checkWorkflowContextMeasurement,
  measureWorkflowContextSurfaces,
  renderWorkflowContextMeasurement,
  WORKFLOW_CONTEXT_MEASUREMENT_PATH,
} from "../src/workflow-context-measurement.js";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const ROOT = join(import.meta.dirname, "..");

test("workflow context measurement reports Pi-rendered prompt and provider tool definition separately", async () => {
  const artifact = measureWorkflowContextSurfaces(ROOT);
  assert.deepEqual(JSON.parse(renderWorkflowContextMeasurement()), artifact);

  assert.equal(artifact.formatVersion, 2);
  assert.equal(artifact.encoding, "utf8");
  assert.deepEqual(artifact.sources, ["src/workflow-tool.ts", "skills/workflow-authoring"]);
  assert.equal(artifact.surfaces.permanentWorkflowPrompt.serialization, "UTF-8 bytes of LF-joined Pi prompt lines");
  assert.equal(
    artifact.surfaces.providerVisibleWorkflowToolDefinition.serialization,
    "UTF-8 bytes of JSON.stringify({ name, description, parameters })",
  );
  assert.match(artifact.surfaces.workflowAuthoringSkillDiscovery.serialization, /package-relative location/i);
  assert.ok(artifact.surfaces.workflowAuthoringSkillDiscovery.bytes > 0);
  assert.equal(artifact.surfaces.workflowAuthoringSkillCorpus.files, 27);
  assert.ok(artifact.surfaces.workflowAuthoringSkillCorpus.bytes > 0);
  assert.equal(artifact.surfaces.representativeAuthoringProfiles.profiles.length, 6);
  assert.deepEqual(
    artifact.surfaces.representativeAuthoringProfiles.profiles.map(({ name }) => name),
    ["write", "edit", "review", "debug", "loop", "retry"],
  );
  for (const profile of artifact.surfaces.representativeAuthoringProfiles.profiles) {
    const expected = profile.files.reduce((sum, path) => sum + Buffer.byteLength(readFileSync(join(ROOT, path))), 0);
    assert.equal(profile.bytes, expected, `${profile.name} profile must sum its declared files`);
  }
  const profileBytes = artifact.surfaces.representativeAuthoringProfiles.profiles
    .map(({ bytes }) => bytes)
    .sort((a, b) => a - b);
  assert.equal(artifact.surfaces.representativeAuthoringProfiles.medianBytes, (profileBytes[2] + profileBytes[3]) / 2);

  await withRenderedWorkflow(async ({ systemPrompt, promptLines, wrappedWorkflow }) => {
    const expectedLines = new Set(promptLines);
    const renderedLines = systemPrompt.split("\n").filter((line) => expectedLines.has(line));
    assert.deepEqual(renderedLines, promptLines, "Pi should render each workflow prompt line exactly once");

    const providerDefinition = JSON.stringify({
      name: wrappedWorkflow.name,
      description: wrappedWorkflow.description,
      parameters: wrappedWorkflow.parameters,
    });
    assert.equal(artifact.surfaces.permanentWorkflowPrompt.bytes, Buffer.byteLength(renderedLines.join("\n"), "utf8"));
    assert.equal(
      artifact.surfaces.providerVisibleWorkflowToolDefinition.bytes,
      Buffer.byteLength(providerDefinition, "utf8"),
    );
  });
});

test("workflow context measurement generation is deterministic and committed artifact is fresh", () => {
  const first = renderWorkflowContextMeasurement();
  const second = renderWorkflowContextMeasurement();

  assert.equal(first, second);
  assert.equal(readFileSync(join(ROOT, WORKFLOW_CONTEXT_MEASUREMENT_PATH), "utf8"), first);
  assert.equal(checkWorkflowContextMeasurement(ROOT), true);
  assert.equal(checkWorkflowContextMeasurement(ROOT, `${first}stale`), false);
  assert.equal(packageJson.scripts["context:check"], "tsx scripts/generate-workflow-context-measurement.ts --check");
  assert.match(packageJson.scripts.test, /release:check/);
  assert.match(packageJson.scripts["release:check"], /context:check/);
});

test("context freshness command prints both current byte counts", () => {
  const output = execFileSync("npm", ["run", "context:check"], { cwd: ROOT, encoding: "utf8" });

  assert.match(output, /Permanent workflow prompt: \d+ bytes/);
  assert.match(output, /Provider-visible workflow tool definition: \d+ bytes/);
  assert.match(output, /Workflow-authoring skill discovery: \d+ bytes/);
  assert.match(output, /Workflow-authoring skill corpus: \d+ bytes across \d+ files/);
  assert.match(output, /Representative authoring profile median: \d+(?:\.5)? bytes/);
  assert.match(output, /measurement is fresh/i);
});

async function withRenderedWorkflow(
  inspect: (surface: {
    systemPrompt: string;
    promptLines: string[];
    wrappedWorkflow: { name: string; description: string; parameters: unknown };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workflow-context-measurement-"));
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
            ...(workflow.promptGuidelines ?? []).map((guideline) => `- ${guideline}`),
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
