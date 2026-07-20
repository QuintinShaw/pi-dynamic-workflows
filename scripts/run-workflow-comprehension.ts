import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import packageJson from "../package.json" with { type: "json" };
import { createStructuredOutputTool, type StructuredOutputCapture } from "../src/structured-output.js";
import { WORKFLOW_CAPABILITY_DEFINITION } from "../src/workflow-capability-contract.js";
import {
  COMPREHENSION_SCENARIOS,
  type ComprehensionScenario,
  ComprehensionSuite,
  type ComprehensionTokenUsage,
  type ModelGeneration,
  ModelGenerationError,
  runComprehensionScenario,
  selectComprehensionScenarios,
} from "../src/workflow-comprehension.js";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_PATH = join(ROOT, "skills/workflow-authoring/SKILL.md");
const OUTPUT_SCHEMA = Type.Object({
  workflow: Type.String({ description: "The complete plain-JavaScript workflow source" }),
});

interface CliOptions {
  suite: ComprehensionSuite;
  scenario: string | null;
  model: string;
  output: string;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  const cli = parseArgs(process.argv.slice(2));
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  await modelRuntime.getAvailable();
  const modelRegistry = new ModelRegistry(modelRuntime);
  const resolvedModel = resolveCliModel({ cliModel: cli.model, modelRuntime });
  if (resolvedModel.error || !resolvedModel.model)
    throw new Error(resolvedModel.error ?? `Could not resolve ${cli.model}`);
  if (!modelRegistry.hasConfiguredAuth(resolvedModel.model)) {
    throw new Error(
      `Selected model ${resolvedModel.model.provider}/${resolvedModel.model.id} is not currently available`,
    );
  }
  if (resolvedModel.warning) console.warn(`[model] ${resolvedModel.warning}`);

  const model = resolvedModel.model;
  const modelSelection = {
    requested: cli.model,
    resolved: `${model.provider}/${model.id}`,
    thinkingLevel: resolvedModel.thinkingLevel ?? null,
  };
  const skillVersion = readSkillVersion();
  const selectedScenarios = cli.scenario
    ? COMPREHENSION_SCENARIOS.filter(({ id }) => id === cli.scenario)
    : selectComprehensionScenarios(cli.suite);
  const scenarios = [];
  for (const scenario of selectedScenarios) {
    console.log(
      `[comprehension] ${scenario.id} with ${modelSelection.resolved}${modelSelection.thinkingLevel ? `:${modelSelection.thinkingLevel}` : ""}`,
    );
    scenarios.push(
      await runComprehensionScenario({
        scenario,
        provider: resolvedModel.model.provider,
        modelSelection,
        extensionVersion: packageJson.version,
        contractVersions: {
          format: WORKFLOW_CAPABILITY_DEFINITION.versions.format.version,
          content: WORKFLOW_CAPABILITY_DEFINITION.versions.content.version,
        },
        skillVersion,
        generate: (task) =>
          generateWorkflow(task, {
            modelRuntime,
            model,
            thinkingLevel: resolvedModel.thinkingLevel,
          }),
      }),
    );
  }

  const output = {
    formatVersion: 2,
    suite: selectedScenarios[0]?.suite ?? cli.suite,
    targetedScenario: cli.scenario,
    modelSelection,
    summary: {
      total: scenarios.length,
      passed: scenarios.filter(({ passed }) => passed).length,
      failed: scenarios.filter(({ passed }) => !passed).length,
    },
    scenarios,
  };
  await mkdir(dirname(cli.output), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`[comprehension] evidence written to ${cli.output}`);
  console.log(
    `[comprehension] ${output.summary.passed}/${output.summary.total} scenarios passed (evidence only; non-blocking)`,
  );
}

async function generateWorkflow(
  scenario: ComprehensionScenario,
  options: {
    modelRuntime: ModelRuntime;
    model: Model<Api>;
    thinkingLevel?: ModelThinkingLevel;
  },
): Promise<ModelGeneration> {
  const isolatedRoot = await mkdtemp(join(tmpdir(), "workflow-comprehension-"));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const skill: Skill = {
    name: "workflow-authoring",
    description:
      "Guidance for writing, editing, reviewing, and debugging JavaScript workflow code for pi-dynamic-workflows.",
    filePath: SKILL_PATH,
    baseDir: dirname(SKILL_PATH),
    sourceInfo: {
      path: SKILL_PATH,
      source: "pi-dynamic-workflows comprehension harness",
      scope: "temporary",
      origin: "package",
      baseDir: dirname(SKILL_PATH),
    },
    disableModelInvocation: false,
  };
  const loader = new DefaultResourceLoader({
    cwd: isolatedRoot,
    agentDir: isolatedRoot,
    settingsManager,
    skillsOverride: (current) => ({ skills: [skill], diagnostics: current.diagnostics }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    appendSystemPromptOverride: () => [
      "This is a clean comprehension session. Consult applicable installed skills before producing the requested code.",
    ],
  });
  await loader.reload();

  const capture: StructuredOutputCapture<{ workflow: string }> = { called: false, value: undefined };
  const submit = createStructuredOutputTool({ schema: OUTPUT_SCHEMA, capture, name: "submit_comprehension" });
  const customTools = [submit];
  const skillToolCalls: Array<{ tool: string; path?: string }> = [];
  const { session } = await createAgentSession({
    cwd: isolatedRoot,
    agentDir: isolatedRoot,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    modelRuntime: options.modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(isolatedRoot),
    tools: ["read", "submit_comprehension"],
    customTools,
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "tool_execution_start") return;
    const path = event.toolName === "read" && typeof event.args?.path === "string" ? event.args.path : undefined;
    if (path?.includes("workflow-authoring")) skillToolCalls.push({ tool: event.toolName, path });
  });

  try {
    try {
      await session.prompt(
        `${scenario.prompt}\n\nYour final action must call submit_comprehension exactly once with the complete workflow source. Do not return prose instead.`,
      );
      if (!capture.called || !capture.value) {
        throw new Error(session.agent.state.errorMessage ?? "Model did not submit a workflow");
      }
      return {
        workflow: capture.value.workflow,
        skillLoadingEvidence: skillEvidence(skillToolCalls),
        tokenUsage: sessionTokenUsage(session.getSessionStats()),
      };
    } catch (error) {
      throw new ModelGenerationError(
        error instanceof Error ? error.message : String(error),
        skillEvidence(skillToolCalls),
        sessionTokenUsage(session.getSessionStats()),
      );
    }
  } finally {
    unsubscribe();
    session.dispose();
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

function skillEvidence(toolCalls: Array<{ tool: string; path?: string }>) {
  return {
    discovered: toolCalls.length > 0,
    loaded: toolCalls.some(({ path }) => path?.endsWith("/SKILL.md")),
    toolCalls,
  };
}

function sessionTokenUsage(
  stats: ReturnType<Awaited<ReturnType<typeof createAgentSession>>["session"]["getSessionStats"]>,
): ComprehensionTokenUsage {
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    total: stats.tokens.total,
    cost: stats.cost,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
  };
}

function parseArgs(args: string[]): CliOptions {
  let suite = ComprehensionSuite.QUICK;
  let suiteWasSet = false;
  let scenario: string | null = null;
  let model: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--suite" && value) {
      if (value === ComprehensionSuite.QUICK) {
        suite = ComprehensionSuite.QUICK;
      } else if (value === ComprehensionSuite.FULL) {
        suite = ComprehensionSuite.FULL;
      } else if (value === ComprehensionSuite.COVERAGE) {
        suite = ComprehensionSuite.COVERAGE;
      } else {
        throw new Error(`Unknown suite ${value}; expected quick, full, or coverage`);
      }
      suiteWasSet = true;
      index++;
    } else if (flag === "--scenario" && value) {
      scenario = value;
      index++;
    } else if (flag === "--model" && value) {
      model = value;
      index++;
    } else if (flag === "--output" && value) {
      output = resolve(value);
      index++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag ?? ""}`);
    }
  }
  if (suiteWasSet && scenario) throw new Error("--suite and --scenario are mutually exclusive");
  if (scenario && !COMPREHENSION_SCENARIOS.some(({ id }) => id === scenario)) {
    throw new Error(`Unknown scenario ${scenario}`);
  }
  if (!model) throw new Error("--model <provider/model> is required; the harness never chooses a model implicitly");
  const safeModel = model.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  const selectionName = scenario ?? suite;
  return {
    suite,
    scenario,
    model,
    output: output ?? join(ROOT, ".pi/model-comprehension", `${selectionName}-${safeModel}.json`),
  };
}

function readSkillVersion(): string {
  const match = readFileSync(SKILL_PATH, "utf8").match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m);
  if (!match?.[1]) throw new Error(`Could not read skill version from ${SKILL_PATH}`);
  return match[1];
}

function printUsage(): void {
  console.log(`Usage: npm run comprehension -- --model <provider/model> [--suite quick|full|coverage | --scenario <id>] [--output path]

Runs optional model-comprehension scenarios and writes comparison-ready JSON evidence.
Scenario failures are recorded but do not set a failing exit status. Setup and argument errors do fail.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
