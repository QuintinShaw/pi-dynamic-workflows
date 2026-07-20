import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };
import {
  evaluateWorkflowDeliveryChoice,
  WORKFLOW_DELIVERY_CHOICE_SCENARIOS,
  type WorkflowDeliveryChoiceScenario,
} from "../src/workflow-delivery-choice.js";
import { createWorkflowTool, type WorkflowToolInput } from "../src/workflow-tool.js";

const ROOT = resolve(import.meta.dirname, "..");

interface CliOptions {
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
  if (resolvedModel.error || !resolvedModel.model) {
    throw new Error(resolvedModel.error ?? `Could not resolve ${cli.model}`);
  }
  if (!modelRegistry.hasConfiguredAuth(resolvedModel.model)) {
    throw new Error(
      `Selected model ${resolvedModel.model.provider}/${resolvedModel.model.id} is not currently available`,
    );
  }
  if (resolvedModel.warning) {
    process.stderr.write(`[model] ${resolvedModel.warning}\n`);
  }

  const model = resolvedModel.model;
  const modelSelection = {
    requested: cli.model,
    resolved: `${model.provider}/${model.id}`,
    thinkingLevel: resolvedModel.thinkingLevel ?? null,
  };
  const scenarios = [];
  for (const scenario of WORKFLOW_DELIVERY_CHOICE_SCENARIOS) {
    process.stdout.write(`[delivery-choice] ${scenario.id} with ${modelSelection.resolved}\n`);
    scenarios.push(
      await runScenario(scenario, {
        modelRuntime,
        model,
        thinkingLevel: resolvedModel.thinkingLevel,
      }),
    );
  }
  const output = {
    formatVersion: 1,
    extensionVersion: packageJson.version,
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
  process.stdout.write(`[delivery-choice] evidence written to ${cli.output}\n`);
  process.stdout.write(
    `[delivery-choice] ${output.summary.passed}/${output.summary.total} scenarios passed (non-blocking)\n`,
  );
}

async function runScenario(
  scenario: WorkflowDeliveryChoiceScenario,
  options: {
    modelRuntime: ModelRuntime;
    model: Model<Api>;
    thinkingLevel?: ModelThinkingLevel;
  },
) {
  const isolatedRoot = await mkdtemp(join(tmpdir(), "workflow-delivery-choice-"));
  const captured: { value?: WorkflowToolInput } = {};
  const workflow = createWorkflowTool({ cwd: isolatedRoot });
  const captureTool = defineTool({
    name: workflow.name,
    label: workflow.label,
    description: workflow.description,
    promptSnippet: workflow.promptSnippet,
    promptGuidelines: workflow.promptGuidelines,
    parameters: workflow.parameters,
    async execute(toolCallId, params) {
      void toolCallId;
      captured.value = params;
      return {
        content: [{ type: "text" as const, text: "Workflow invocation captured for delivery-choice evidence." }],
        details: { captured: true },
      };
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const { session } = await createAgentSession({
    cwd: isolatedRoot,
    agentDir: isolatedRoot,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    settingsManager,
    sessionManager: SessionManager.inMemory(isolatedRoot),
    tools: ["workflow"],
    customTools: [captureTool],
  });
  try {
    await session.prompt(`${scenario.prompt}\n\nCall the workflow tool exactly once. Do not answer in prose instead.`);
    const evaluation = evaluateWorkflowDeliveryChoice(scenario, captured.value);
    return {
      task: scenario,
      capturedArguments: captured.value ?? null,
      tokenUsage: sessionTokenUsage(session.getSessionStats()),
      ...evaluation,
    };
  } finally {
    session.dispose();
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

function sessionTokenUsage(
  stats: ReturnType<Awaited<ReturnType<typeof createAgentSession>>["session"]["getSessionStats"]>,
) {
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
  let model: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--model" && value) {
      model = value;
      index++;
    } else if (flag === "--output" && value) {
      output = resolve(value);
      index++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag ?? ""}`);
    }
  }
  if (!model) {
    throw new Error("--model <provider/model> is required; the harness never chooses a model implicitly");
  }
  const safeModel = model.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  return {
    model,
    output: output ?? join(ROOT, ".pi/model-comprehension", `delivery-choice-${safeModel}.json`),
  };
}

function printUsage(): void {
  process.stdout.write(`Usage: npm run delivery-choice -- --model <provider/model> [--output <path>]

Runs two optional delivery-choice scenarios against the real workflow tool definition.
The evidence records whether the model kept the default background run or selected background:false for same-turn use.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
