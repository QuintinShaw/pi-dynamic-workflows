import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createWorkflowTool } from "./workflow-tool.js";

/** Package-relative generated context-measurement artifact. */
export const WORKFLOW_CONTEXT_MEASUREMENT_PATH = "docs/workflow-context-surfaces.json";
const ROOT = join(import.meta.dirname, "..");
const SKILL_ROOT = "skills/workflow-authoring";
const SKILL_PATH = `${SKILL_ROOT}/SKILL.md`;

/** Canonical task profiles used for stable byte-based on-demand context measurements. */
export const WORKFLOW_AUTHORING_PROFILES = [
  {
    name: "write",
    files: [
      SKILL_PATH,
      `${SKILL_ROOT}/references/runtime.md`,
      `${SKILL_ROOT}/references/pattern-selection.md`,
      `${SKILL_ROOT}/references/focused-recipes.md`,
      `${SKILL_ROOT}/examples/fan-out-and-synthesize.js`,
      `${SKILL_ROOT}/examples/structured-output.js`,
    ],
  },
  {
    name: "edit",
    files: [
      SKILL_PATH,
      `${SKILL_ROOT}/references/runtime.md`,
      `${SKILL_ROOT}/references/lifecycle.md`,
      `${SKILL_ROOT}/references/focused-recipes.md`,
      `${SKILL_ROOT}/examples/phased-budgets.js`,
      `${SKILL_ROOT}/examples/saved-nested-workflows.js`,
    ],
  },
  {
    name: "review",
    files: [
      SKILL_PATH,
      `${SKILL_ROOT}/references/runtime.md`,
      `${SKILL_ROOT}/references/review.md`,
      `${SKILL_ROOT}/references/quality-helpers.md`,
      `${SKILL_ROOT}/examples/adversarial-verification.js`,
    ],
  },
  {
    name: "debug",
    files: [
      SKILL_PATH,
      `${SKILL_ROOT}/references/runtime.md`,
      `${SKILL_ROOT}/references/debugging.md`,
      `${SKILL_ROOT}/references/specialized-helpers.md`,
      `${SKILL_ROOT}/examples/validated-gate.js`,
    ],
  },
  {
    name: "loop",
    files: [
      SKILL_PATH,
      `${SKILL_ROOT}/references/runtime.md`,
      `${SKILL_ROOT}/references/pattern-selection.md`,
      `${SKILL_ROOT}/references/lifecycle.md`,
      `${SKILL_ROOT}/references/focused-recipes.md`,
      `${SKILL_ROOT}/examples/loop-until-done.js`,
      `${SKILL_ROOT}/examples/structured-output.js`,
    ],
  },
  {
    name: "retry",
    files: [
      SKILL_PATH,
      `${SKILL_ROOT}/references/runtime.md`,
      `${SKILL_ROOT}/references/retry-helper.md`,
      `${SKILL_ROOT}/references/focused-recipes.md`,
      `${SKILL_ROOT}/examples/bounded-semantic-retry.js`,
      `${SKILL_ROOT}/examples/structured-output.js`,
    ],
  },
] as const;

interface ByteSurface {
  serialization: string;
  bytes: number;
}

/** Versioned byte measurements for always-on, discovery, corpus, and representative authoring surfaces. */
export interface WorkflowContextMeasurement {
  formatVersion: 2;
  encoding: "utf8";
  sources: ["src/workflow-tool.ts", "skills/workflow-authoring"];
  surfaces: {
    permanentWorkflowPrompt: ByteSurface;
    providerVisibleWorkflowToolDefinition: ByteSurface;
    workflowAuthoringSkillDiscovery: ByteSurface;
    ordinaryWorkflowOwnedAlwaysOn: ByteSurface;
    workflowAuthoringSkillCorpus: ByteSurface & { files: number };
    representativeAuthoringProfiles: {
      serialization: "sum of UTF-8 bytes for each profile's declared package-relative files";
      medianBytes: number;
      profiles: Array<{ name: string; files: string[]; bytes: number }>;
    };
  };
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fileBytes(root: string, path: string): number {
  return bytes(readFileSync(join(root, path), "utf8"));
}

function skillFiles(root: string): string[] {
  const absoluteRoot = join(root, SKILL_ROOT);
  const pending = [absoluteRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

function skillDiscoveryEntry(root: string): string {
  const skill = readFileSync(join(root, SKILL_PATH), "utf8");
  const name = /^name:\s*(.+)$/m.exec(skill)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(skill)?.[1]?.trim();
  if (!name || !description) throw new Error(`${SKILL_PATH} must declare name and description`);
  return [
    "<skill>",
    `  <name>${name}</name>`,
    `  <description>${description}</description>`,
    `  <location>${SKILL_PATH}</location>`,
    "</skill>",
  ].join("\n");
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[Math.floor(middle)] ?? 0);
}

/** Measures permanent, discovery, corpus, and canonical on-demand workflow context surfaces. */
export function measureWorkflowContextSurfaces(root: string = ROOT): WorkflowContextMeasurement {
  const tool = createWorkflowTool();
  const permanentWorkflowPrompt = [
    `- workflow: ${tool.promptSnippet}`,
    ...(tool.promptGuidelines ?? []).map((guideline) => `- ${guideline}`),
  ].join("\n");
  const providerVisibleWorkflowToolDefinition = JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
  const discoveryEntry = skillDiscoveryEntry(root);
  const corpusFiles = skillFiles(root);
  const corpusBytes = corpusFiles.reduce((sum, path) => sum + fileBytes(root, path), 0);
  const profiles = WORKFLOW_AUTHORING_PROFILES.map((profile) => ({
    name: profile.name,
    files: [...profile.files],
    bytes: profile.files.reduce((sum, path) => sum + fileBytes(root, path), 0),
  }));
  const promptBytes = bytes(permanentWorkflowPrompt);
  const toolBytes = bytes(providerVisibleWorkflowToolDefinition);
  const discoveryBytes = bytes(discoveryEntry);

  return {
    formatVersion: 2,
    encoding: "utf8",
    sources: ["src/workflow-tool.ts", "skills/workflow-authoring"],
    surfaces: {
      permanentWorkflowPrompt: {
        serialization: "UTF-8 bytes of LF-joined Pi prompt lines",
        bytes: promptBytes,
      },
      providerVisibleWorkflowToolDefinition: {
        serialization: "UTF-8 bytes of JSON.stringify({ name, description, parameters })",
        bytes: toolBytes,
      },
      workflowAuthoringSkillDiscovery: {
        serialization: "UTF-8 bytes of normalized Pi skill XML with package-relative location",
        bytes: discoveryBytes,
      },
      ordinaryWorkflowOwnedAlwaysOn: {
        serialization:
          "sum of permanent prompt, provider-visible tool definition, and normalized skill discovery bytes",
        bytes: promptBytes + toolBytes + discoveryBytes,
      },
      workflowAuthoringSkillCorpus: {
        serialization: "sum of UTF-8 bytes for every file under skills/workflow-authoring",
        files: corpusFiles.length,
        bytes: corpusBytes,
      },
      representativeAuthoringProfiles: {
        serialization: "sum of UTF-8 bytes for each profile's declared package-relative files",
        medianBytes: median(profiles.map(({ bytes: profileBytes }) => profileBytes)),
        profiles,
      },
    },
  };
}

/** Render the current measurement as deterministic formatted JSON. */
export function renderWorkflowContextMeasurement(): string {
  return `${JSON.stringify(measureWorkflowContextSurfaces(), null, 2)}\n`;
}

/** Write the generated measurement under root and return the measured values. */
export function writeWorkflowContextMeasurement(root: string): WorkflowContextMeasurement {
  const measurement = measureWorkflowContextSurfaces(root);
  writeFileSync(join(root, WORKFLOW_CONTEXT_MEASUREMENT_PATH), `${JSON.stringify(measurement, null, 2)}\n`);
  return measurement;
}

/** Report whether committed or supplied measurement JSON matches current package bytes. */
export function checkWorkflowContextMeasurement(root: string, actual?: string): boolean {
  const committed = actual ?? readFileSync(join(root, WORKFLOW_CONTEXT_MEASUREMENT_PATH), "utf8");
  return committed === `${JSON.stringify(measureWorkflowContextSurfaces(root), null, 2)}\n`;
}
