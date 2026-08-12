/**
 * Bundled workflow commands: `/deep-research`, `/adversarial-review`,
 * `/multi-perspective`, `/code-review`, and `/codebase-audit`.
 *
 * Each command starts its generated workflow through the WorkflowManager's
 * background path — the command returns immediately, progress is visible in
 * the task panel and `/workflows` (pause/stop work like any managed run), and
 * the report is delivered back into the conversation on completion by
 * installResultDelivery. Running inline in the handler instead would block the
 * whole session until the workflow finished (#104).
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BuiltinWorkflowInvocation } from "./builtin-workflows.js";
import { findBuiltinWorkflow } from "./builtin-workflows.js";
import { MAX_DIFF_CHARS } from "./code-review.js";
import { parseCommandArgs } from "./saved-commands.js";
import type { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";

const COMMAND_ERROR_MAX_CHARS = 32_000;
const AUTO_SCOPE_METADATA_MAX_CHARS = 2_000_000;
const AUTO_SCOPE_MAX_PATHS = 4_096;
const AUTO_SCOPE_MAX_ARG_BYTES = 256 * 1024;

const AUTO_SCOPE_ROOT_RULES: ReadonlyArray<readonly [prefix: string, reason: string]> = [
  [".playwright-mcp", "browser capture"],
  ["graphify-out", "graph index output"],
  ["supabase/.temp", "tool state"],
  [".code-review-graph", "code index output"],
  [".gitnexus", "code index output"],
  [".codegraph", "code index output"],
];

const AUTO_SCOPE_DIRECTORY_RULES = new Map<string, string>([
  ["node_modules", "dependency output"],
  ["coverage", "coverage output"],
  [".nyc_output", "coverage output"],
  ["__pycache__", "cache output"],
  [".pytest_cache", "cache output"],
  [".mypy_cache", "cache output"],
  [".ruff_cache", "cache output"],
  [".turbo", "cache output"],
  [".cache", "cache output"],
  ["playwright-report", "browser report"],
  ["test-results", "test output"],
]);

export interface CapturedCommandPrefix {
  stdout: string;
  totalChars: number;
}

export interface DiffNumstatEntry {
  path: string;
  addedLines: number | null;
  deletedLines: number | null;
  binary: boolean;
}

export interface ExcludedDiffEntry extends DiffNumstatEntry {
  reason: string;
}

export interface CodeReviewAutoScope {
  included: DiffNumstatEntry[];
  excluded: ExcludedDiffEntry[];
}

/**
 * Stream command output while retaining only the prefix the review can use.
 * This keeps memory bounded by MAX_DIFF_CHARS without imposing a child-process
 * maxBuffer that rejects large diffs before the review's own truncation policy
 * can run. stdout is decoded incrementally so split UTF-8 sequences are counted
 * the same way as JavaScript String.length.
 */
export function captureCommandPrefix(
  command: string,
  args: string[],
  options: { cwd: string; maxChars: number },
): Promise<CapturedCommandPrefix> {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1) {
    return Promise.reject(new Error("captureCommandPrefix: maxChars must be a positive safe integer"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let totalChars = 0;
    let stderr = "";
    let stderrTruncated = false;

    child.stdout.on("data", (chunk: string) => {
      totalChars += chunk.length;
      const remaining = options.maxChars - stdout.length;
      if (remaining > 0) stdout += chunk.slice(0, remaining);
    });
    child.stderr.on("data", (chunk: string) => {
      const remaining = COMMAND_ERROR_MAX_CHARS - stderr.length;
      if (remaining > 0) stderr += chunk.slice(0, remaining);
      if (chunk.length > remaining) stderrTruncated = true;
    });

    child.once("error", reject);
    child.stdout.once("error", reject);
    child.stderr.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, totalChars });
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const detail = stderr.trim();
      const truncationNote = stderrTruncated ? " [stderr truncated]" : "";
      reject(new Error(`${command} failed with ${reason}${detail ? `: ${detail}${truncationNote}` : ""}`));
    });
  });
}

/** Parse `git diff --numstat -z --no-renames` without losing unusual filenames. */
export function parseDiffNumstat(output: string): DiffNumstatEntry[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) throw new Error("git numstat output is not NUL-terminated");

  return output
    .slice(0, -1)
    .split("\0")
    .map((record, index) => {
      const firstTab = record.indexOf("\t");
      const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
      if (firstTab < 1 || secondTab < firstTab + 2) {
        throw new Error(`git numstat record ${index + 1} is malformed`);
      }

      const addedText = record.slice(0, firstTab);
      const deletedText = record.slice(firstTab + 1, secondTab);
      const path = record.slice(secondTab + 1);
      if (!path || path.includes("\uFFFD")) {
        throw new Error(`git numstat record ${index + 1} has an unsupported path`);
      }

      const binary = addedText === "-" && deletedText === "-";
      if (!binary && (!/^\d+$/.test(addedText) || !/^\d+$/.test(deletedText))) {
        throw new Error(`git numstat record ${index + 1} has invalid line counts`);
      }
      if (!binary && (addedText === "-" || deletedText === "-")) {
        throw new Error(`git numstat record ${index + 1} has inconsistent binary markers`);
      }

      const addedLines = binary ? null : Number.parseInt(addedText, 10);
      const deletedLines = binary ? null : Number.parseInt(deletedText, 10);
      if (
        (addedLines !== null && !Number.isSafeInteger(addedLines)) ||
        (deletedLines !== null && !Number.isSafeInteger(deletedLines))
      ) {
        throw new Error(`git numstat record ${index + 1} exceeds safe integer limits`);
      }

      return { path, addedLines, deletedLines, binary };
    });
}

/** Return a reason only for paths that are high-confidence generated artifacts. */
export function classifyCodeReviewArtifact(path: string): string | undefined {
  for (const [prefix, reason] of AUTO_SCOPE_ROOT_RULES) {
    if (path.startsWith(`${prefix}/`)) return reason;
  }

  const segments = path.split("/");
  for (const segment of segments.slice(0, -1)) {
    const reason = AUTO_SCOPE_DIRECTORY_RULES.get(segment);
    if (reason) return reason;
  }
  for (let index = 0; index < segments.length - 2; index += 1) {
    if (segments[index] === "cypress" && ["screenshots", "videos"].includes(segments[index + 1])) {
      return "browser capture";
    }
  }

  const basename = segments.at(-1)?.toLowerCase() ?? "";
  if (/\.(?:[cm]?js|css)\.map$/.test(basename)) return "source map";
  if (/\.(?:min|bundle)\.(?:[cm]?js|css)$/.test(basename)) return "compiled bundle";
  if (basename.endsWith(".tsbuildinfo")) return "compiler state";
  if (basename.includes(".generated.") || basename.includes(".gen.")) return "generated file";
  return undefined;
}

export async function discoverCodeReviewAutoScope(cwd: string): Promise<CodeReviewAutoScope> {
  const metadata = await captureCommandPrefix(
    "git",
    ["diff", "HEAD", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color"],
    { cwd, maxChars: AUTO_SCOPE_METADATA_MAX_CHARS },
  );
  if (metadata.totalChars > metadata.stdout.length) {
    throw new Error(`tracked-change metadata exceeds ${AUTO_SCOPE_METADATA_MAX_CHARS.toLocaleString()} characters`);
  }

  const included: DiffNumstatEntry[] = [];
  const excluded: ExcludedDiffEntry[] = [];
  for (const entry of parseDiffNumstat(metadata.stdout)) {
    const reason = classifyCodeReviewArtifact(entry.path);
    if (reason) excluded.push({ ...entry, reason });
    else included.push(entry);
  }
  return { included, excluded };
}

function buildAutoScopedDiffArgs(scope: CodeReviewAutoScope): string[] {
  if (scope.included.length > AUTO_SCOPE_MAX_PATHS) {
    throw new Error(
      `auto-scope selected ${scope.included.length.toLocaleString()} paths (limit ${AUTO_SCOPE_MAX_PATHS})`,
    );
  }
  const argBytes = scope.included.reduce((total, entry) => total + Buffer.byteLength(entry.path, "utf8") + 1, 0);
  if (argBytes > AUTO_SCOPE_MAX_ARG_BYTES) {
    throw new Error(
      `auto-scope path arguments use ${argBytes.toLocaleString()} bytes (limit ${AUTO_SCOPE_MAX_ARG_BYTES.toLocaleString()})`,
    );
  }
  return [
    "--literal-pathspecs",
    "diff",
    "HEAD",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--",
    ...scope.included.map((entry) => entry.path),
  ];
}

function sumChangedLines(entries: DiffNumstatEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.addedLines ?? 0) + (entry.deletedLines ?? 0), 0);
}

function formatAutoScopeNotice(scope: CodeReviewAutoScope): string {
  const reasons = new Map<string, number>();
  for (const entry of scope.excluded) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  const reasonSummary = [...reasons.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  const selectedLines = sumChangedLines(scope.included);
  const skippedLines = sumChangedLines(scope.excluded);
  const skippedBinaries = scope.excluded.filter((entry) => entry.binary).length;
  const binarySummary = skippedBinaries > 0 ? `; ${skippedBinaries.toLocaleString()} binary` : "";
  return (
    `Auto-scope: reviewing ${scope.included.length.toLocaleString()} tracked files ` +
    `(~${selectedLines.toLocaleString()} changed lines); skipped ${scope.excluded.length.toLocaleString()} ` +
    `high-confidence artifacts (~${skippedLines.toLocaleString()} changed lines${binarySummary}). ` +
    `Rules: ${reasonSummary}. Use /code-review <path> to include an artifact explicitly.`
  );
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function alreadyRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

/** Split a command argument string into tokens, respecting single/double quotes. */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/**
 * Start a built-in workflow through the manager's background path and tell the
 * user where to watch it. startInBackground can throw synchronously (script
 * parse, run lease) — surface that as a notify instead of an unhandled error.
 * Async failures are handled by the manager's generic delivery ("✗ Background
 * workflow … failed"), so no handler-side await is needed — that await is
 * exactly what used to hang the session (#104).
 */
function startBackground(
  manager: WorkflowManager,
  ctx: ExtensionCommandContext,
  name: string,
  script: string,
  args?: unknown,
  exec?: { tools?: ToolDefinition[]; toolset?: string },
): void {
  try {
    const { runId } = manager.startInBackground(script, args, exec ?? {});
    ctx.ui.notify(
      `/${name} running in the background (${runId}) — watch the task panel or /workflows; the report is posted here when it finishes.`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`${name} failed to start: ${error instanceof Error ? error.message : error}`, "error");
  }
}

/**
 * Look up a built-in descriptor by its fixed, hardcoded name. Every call site
 * below passes one of the 5 literal names in BUILTIN_WORKFLOWS, so this can
 * only throw if that registry and this file's command names fall out of sync
 * — a programming error, not a user-input problem (tests pin the names stay
 * in sync, see builtin-commands.test.ts).
 */
function requireBuiltin(name: string) {
  const found = findBuiltinWorkflow(name);
  if (!found) throw new Error(`internal error: no built-in workflow registered for "${name}"`);
  return found;
}

/**
 * Resolve a built-in's script/exec context for the given args, surfacing an
 * invalid-args error (e.g. a whitespace-only string that passes the handler's
 * cheap `!value` check but fails the registry's real validation) as the same
 * kind of warning notify the handlers already use for their own validation,
 * rather than an uncaught rejection.
 */
function resolveBuiltinOrNotify(
  name: string,
  cwd: string,
  args: unknown,
  ctx: ExtensionCommandContext,
): BuiltinWorkflowInvocation | undefined {
  try {
    return requireBuiltin(name).resolve(cwd, args);
  } catch (error) {
    ctx.ui.notify(`/${name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return undefined;
  }
}

export function registerBuiltinWorkflows(
  pi: ExtensionAPI,
  opts: {
    cwd?: string;
    manager?: WorkflowManager;
    storage?: WorkflowStorage;
    /** Live accessors — preferred when the extension may replace manager/cwd after session_start. */
    getManager?: () => WorkflowManager;
    getCwd?: () => string;
    getStorage?: () => WorkflowStorage;
  },
): void {
  const getManager = (): WorkflowManager => {
    const m = opts.getManager?.() ?? opts.manager;
    if (!m) throw new Error("registerBuiltinWorkflows: no WorkflowManager");
    return m;
  };
  const getCwd = () => opts.getCwd?.() ?? opts.cwd ?? process.cwd();
  const getStorage = () => opts.getStorage?.() ?? opts.storage ?? createWorkflowStorage(getCwd());

  /**
   * A project/user saved workflow always takes precedence over a built-in of
   * the same name — on every path, not just the `workflow` tool's `name`
   * input. Builtins are registered as commands before saved workflows
   * (registerAllSavedWorkflows skips a name that's already registered), so
   * without this dynamic check a same-named saved workflow would silently
   * never run from its slash command. Checking here, at invocation time
   * rather than registration time, makes "saved wins" hold regardless of
   * registration order. Mirrors registerSavedWorkflow's own handler exactly
   * (same parseCommandArgs call, same startBackground path, no builtin exec
   * context) so a shadowed command behaves identically to how it would if the
   * saved workflow itself had been registered under this name.
   */
  function runSavedShadowIfPresent(name: string, rawArgs: string, ctx: ExtensionCommandContext): boolean {
    const saved = getStorage().load(name);
    if (!saved) return false;
    startBackground(getManager(), ctx, name, saved.script, parseCommandArgs(rawArgs, saved.parameters));
    return true;
  }

  if (!alreadyRegistered(pi, "deep-research")) {
    pi.registerCommand("deep-research", {
      description: "Research a question across the web with cross-checked sources",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("deep-research", args, ctx)) return;
        const question = args.trim();
        if (!question) return ctx.ui.notify("Usage: /deep-research <question>", "warning");
        // Resolve through the shared builtin registry (builtin-workflows.ts) so
        // this command and the workflow tool's `name` input always run the exact
        // same generated script and exec context (tools/toolset) for this pattern.
        const resolved = resolveBuiltinOrNotify("deep-research", getCwd(), { question }, ctx);
        if (!resolved) return;
        startBackground(
          getManager(),
          ctx,
          "deep-research",
          resolved.script,
          { question },
          {
            tools: resolved.tools,
            toolset: resolved.toolset,
          },
        );
      },
    });
  }

  if (!alreadyRegistered(pi, "adversarial-review")) {
    pi.registerCommand("adversarial-review", {
      description: "Investigate a task, then cross-check each finding with skeptical reviewers",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("adversarial-review", args, ctx)) return;
        const task = args.trim();
        if (!task) return ctx.ui.notify("Usage: /adversarial-review <task or question>", "warning");
        const resolved = resolveBuiltinOrNotify("adversarial-review", getCwd(), { task }, ctx);
        if (!resolved) return;
        startBackground(getManager(), ctx, "adversarial-review", resolved.script, { task });
      },
    });
  }

  if (!alreadyRegistered(pi, "code-review")) {
    pi.registerCommand("code-review", {
      description:
        "Multi-angle parallel code review: 7 specialized finders (correctness, reuse, simplification, efficiency, altitude) + verify pass → ranked findings",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("code-review", args, ctx)) return;
        const input = args.trim();
        const cwd = getCwd();
        let diffSource = "git diff HEAD";
        let cmd: string;
        let cmdArgs: string[];
        let autoScope: CodeReviewAutoScope | undefined;

        if (!input) {
          try {
            const discovered = await discoverCodeReviewAutoScope(cwd);
            if (discovered.excluded.length > 0 && discovered.included.length === 0) {
              return ctx.ui.notify(
                `Auto-scope skipped all ${discovered.excluded.length.toLocaleString()} tracked changes as ` +
                  `high-confidence generated/cache artifacts. Use /code-review <path> to review one explicitly.`,
                "warning",
              );
            }
            if (discovered.excluded.length > 0) {
              cmd = "git";
              cmdArgs = buildAutoScopedDiffArgs(discovered);
              autoScope = discovered;
              diffSource =
                `git diff HEAD (auto-scope: ${discovered.included.length.toLocaleString()} included, ` +
                `${discovered.excluded.length.toLocaleString()} artifacts skipped)`;
            } else {
              cmd = "git";
              cmdArgs = ["diff", "HEAD"];
            }
          } catch (error) {
            ctx.ui.notify(
              `Auto-scope unavailable (${shortError(error)}); reviewing the full git diff HEAD without skipping files.`,
              "warning",
            );
            cmd = "git";
            cmdArgs = ["diff", "HEAD"];
          }
        } else if (/^\d+$/.test(input)) {
          diffSource = `gh pr diff ${input}`;
          cmd = "gh";
          cmdArgs = ["pr", "diff", input];
        } else if (input.includes("..")) {
          diffSource = `git diff ${input}`;
          cmd = "git";
          cmdArgs = ["diff", input];
        } else {
          diffSource = `git diff HEAD -- ${input}`;
          cmd = "git";
          cmdArgs = ["diff", "HEAD", "--", input];
        }

        let captured: CapturedCommandPrefix;
        try {
          captured = await captureCommandPrefix(cmd, cmdArgs, {
            cwd,
            maxChars: MAX_DIFF_CHARS,
          });
        } catch (error) {
          if (!autoScope) {
            return ctx.ui.notify(`Failed to get diff (${diffSource}): ${shortError(error)}`, "error");
          }
          ctx.ui.notify(
            `Auto-scoped diff failed (${shortError(error)}); retrying the full git diff HEAD without skipping files.`,
            "warning",
          );
          autoScope = undefined;
          diffSource = "git diff HEAD";
          try {
            captured = await captureCommandPrefix("git", ["diff", "HEAD"], {
              cwd,
              maxChars: MAX_DIFF_CHARS,
            });
          } catch (fallbackError) {
            return ctx.ui.notify(`Failed to get diff (${diffSource}): ${shortError(fallbackError)}`, "error");
          }
        }

        if (autoScope && !captured.stdout.trim()) {
          ctx.ui.notify(
            "Auto-scoped diff became empty while it was being collected; retrying the full git diff HEAD.",
            "warning",
          );
          autoScope = undefined;
          diffSource = "git diff HEAD";
          try {
            captured = await captureCommandPrefix("git", ["diff", "HEAD"], {
              cwd,
              maxChars: MAX_DIFF_CHARS,
            });
          } catch (fallbackError) {
            return ctx.ui.notify(`Failed to get diff (${diffSource}): ${shortError(fallbackError)}`, "error");
          }
        }

        const diff = captured.stdout;
        const originalLength = captured.totalChars;
        if (!diff.trim()) return ctx.ui.notify(`No diff output from: ${diffSource}`, "warning");
        if (autoScope) ctx.ui.notify(formatAutoScopeNotice(autoScope), "info");

        if (originalLength > MAX_DIFF_CHARS) {
          ctx.ui.notify(
            `Diff is ${originalLength.toLocaleString()} characters — truncated to the first ` +
              `${MAX_DIFF_CHARS.toLocaleString()} for the review. Findings past the cut are not covered.`,
            "warning",
          );
        }

        const resolved = resolveBuiltinOrNotify("code-review", getCwd(), { diff, diffSource }, ctx);
        if (!resolved) return;
        startBackground(getManager(), ctx, "code-review", resolved.script, { diff, diffSource });
      },
    });
  }

  if (!alreadyRegistered(pi, "multi-perspective")) {
    pi.registerCommand("multi-perspective", {
      description: "Analyze a topic from several independent perspectives in parallel, then synthesize",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("multi-perspective", args, ctx)) return;
        const [topic, ...rest] = tokenizeArgs(args);
        if (!topic) {
          return ctx.ui.notify('Usage: /multi-perspective "<topic>" [perspective1] [perspective2] …', "warning");
        }
        // resolve() falls back to a broadly-useful default set when fewer than
        // two perspectives are given (see builtin-workflows.ts).
        const resolved = resolveBuiltinOrNotify("multi-perspective", getCwd(), { topic, perspectives: rest }, ctx);
        if (!resolved) return;
        startBackground(getManager(), ctx, "multi-perspective", resolved.script);
      },
    });
  }

  if (!alreadyRegistered(pi, "codebase-audit")) {
    pi.registerCommand("codebase-audit", {
      description: "Run parallel checks against a codebase scope, then cross-validate and report",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("codebase-audit", args, ctx)) return;
        const [scope, ...checks] = tokenizeArgs(args);
        if (!scope || checks.length === 0) {
          return ctx.ui.notify('Usage: /codebase-audit <scope> "<check1>" ["<check2>" …]', "warning");
        }
        const resolved = resolveBuiltinOrNotify("codebase-audit", getCwd(), { scope, checks }, ctx);
        if (!resolved) return;
        startBackground(getManager(), ctx, "codebase-audit", resolved.script);
      },
    });
  }
}
