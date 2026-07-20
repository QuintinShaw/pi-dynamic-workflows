/**
 * Shared registry of the 5 curated built-in workflow patterns
 * (`deep-research`, `adversarial-review`, `code-review`, `multi-perspective`,
 * `codebase-audit`).
 *
 * This is the single place that turns a pattern's name + caller-supplied args
 * into a runnable script (and, where a pattern needs it, an exec context such
 * as web tools). Both entry points a model or user can reach a built-in
 * through — the `/deep-research`-style slash commands (builtin-commands.ts)
 * and the `workflow` tool's `name` input (workflow-tool.ts) — resolve through
 * this one registry, so the two paths can never drift apart and the
 * per-pattern generator scripts are written exactly once.
 */

import { createCodingTools, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
import { generateCodeReviewWorkflow } from "./code-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "./deep-research.js";
import { createWebTools } from "./web-tools.js";
import type { WorkflowStorage } from "./workflow-saved.js";

/** Default perspective set used when a caller gives fewer than two. */
export const DEFAULT_MULTI_PERSPECTIVES: readonly string[] = [
  "technical",
  "product",
  "security",
  "user experience",
  "maintainability",
];

/** A resolved, ready-to-run script plus the exec context it needs (if any). */
export interface BuiltinWorkflowInvocation {
  script: string;
  tools?: ToolDefinition[];
  toolset?: string;
}

export interface BuiltinWorkflowDescriptor {
  /** Also the slash-command name (without the leading `/`). */
  name: string;
  description: string;
  /** Build the script (and exec context) for one invocation; throws on invalid `args`. */
  resolve(cwd: string, args: unknown): BuiltinWorkflowInvocation;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function requireNonEmptyString(value: unknown, argName: string, patternName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Built-in workflow "${patternName}" requires args.${argName} to be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, argName: string, patternName: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim())) {
    throw new Error(
      `Built-in workflow "${patternName}" requires args.${argName} to be a non-empty array of non-empty strings.`,
    );
  }
  return value;
}

/** The 5 curated built-in workflow patterns, keyed by their stable name. */
export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflowDescriptor[] = [
  {
    name: "deep-research",
    description: "Research a question across the web with cross-checked sources. args: { question: string }.",
    resolve(cwd, args) {
      requireNonEmptyString(asRecord(args).question, "question", "deep-research");
      return {
        script: generateDeepResearchWorkflow(),
        // Research agents need real web access on top of the coding tools; the
        // "web-research" tag is what a resumed run re-resolves (see
        // WorkflowManagerOptions.toolsets).
        tools: [...createCodingTools(cwd), ...createWebTools()],
        toolset: "web-research",
      };
    },
  },
  {
    name: "adversarial-review",
    description:
      "Investigate a task, then cross-check each finding with skeptical reviewers. args: { task: string, reviewers?: number, threshold?: number }.",
    resolve(_cwd, args) {
      requireNonEmptyString(asRecord(args).task, "task", "adversarial-review");
      return { script: generateAdversarialReviewWorkflow() };
    },
  },
  {
    name: "code-review",
    description:
      "Multi-angle parallel code review: 7 specialized finders (correctness, reuse, simplification, efficiency, altitude) + verify pass → ranked findings. args: { diff: string, diffSource?: string }.",
    resolve(_cwd, args) {
      // Truncation past MAX_DIFF_CHARS already happens inside the generated
      // script at runtime (see code-review.ts); a caller invoking by name is
      // responsible for supplying `diff` (e.g. by running `git diff` itself),
      // unlike the /code-review slash command, which fetches it automatically.
      requireNonEmptyString(asRecord(args).diff, "diff", "code-review");
      return { script: generateCodeReviewWorkflow() };
    },
  },
  {
    name: "multi-perspective",
    description:
      "Analyze a topic from several independent perspectives in parallel, then synthesize. args: { topic: string, perspectives?: string[] }.",
    resolve(_cwd, args) {
      const record = asRecord(args);
      const topic = requireNonEmptyString(record.topic, "topic", "multi-perspective");
      const perspectives =
        Array.isArray(record.perspectives) && record.perspectives.length >= 2
          ? requireStringArray(record.perspectives, "perspectives", "multi-perspective")
          : [...DEFAULT_MULTI_PERSPECTIVES];
      return { script: generateMultiPerspectiveWorkflow(topic, perspectives) };
    },
  },
  {
    name: "codebase-audit",
    description:
      "Run parallel checks against a codebase scope, then cross-validate and report. args: { scope: string, checks: string[] }.",
    resolve(_cwd, args) {
      const record = asRecord(args);
      const scope = requireNonEmptyString(record.scope, "scope", "codebase-audit");
      const checks = requireStringArray(record.checks, "checks", "codebase-audit");
      return { script: generateCodebaseAuditWorkflow(scope, checks) };
    },
  },
];

/** Stable list of built-in workflow pattern names, in registry order. */
export const BUILTIN_WORKFLOW_NAMES: readonly string[] = BUILTIN_WORKFLOWS.map((w) => w.name);

export function findBuiltinWorkflow(name: string): BuiltinWorkflowDescriptor | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.name === name);
}

/**
 * Resolve a name to a runnable invocation, checking project/user saved
 * workflows first and falling back to the built-in patterns — the same
 * precedence `workflow-saved.ts` already uses internally (project > user), one
 * level up: saved workflows (of either scope) beat a built-in of the same name.
 */
export function resolveWorkflowInvocation(
  name: string,
  args: unknown,
  ctx: { storage: WorkflowStorage; cwd: string },
): BuiltinWorkflowInvocation | undefined {
  const saved = ctx.storage.load(name);
  if (saved) return { script: saved.script };
  const builtin = findBuiltinWorkflow(name);
  if (builtin) return builtin.resolve(ctx.cwd, args);
  return undefined;
}
