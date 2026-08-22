/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that runs its script, passing parsed arguments through as `args`.
 */

import { createCodingTools, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { claimCommand, commandOwner, isCommandRegistered } from "./command-registry.js";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";

function savedCommandOwnedByExtension(pi: ExtensionAPI, name: string): boolean {
  const owner = commandOwner(pi, name);
  return owner === "builtin" || owner === "saved";
}

/**
 * Pi cannot unregister a slash command. Distinguish commands this extension
 * owns from built-ins/other extensions before a save or rename reaches disk.
 */
export function savedWorkflowCommandAvailability(
  pi: ExtensionAPI,
  name: string,
): { ok: true } | { ok: false; message: string } {
  if (!isCommandRegistered(pi, name) || savedCommandOwnedByExtension(pi, name)) return { ok: true };
  return { ok: false, message: `/${name} is already provided by Pi or another extension.` };
}

function reportText(result: WorkflowRunResult): string {
  const r = result.result as { report?: unknown } | undefined;
  if (r && typeof r.report === "string" && r.report.trim()) return r.report;
  return JSON.stringify(result.result, null, 2);
}

export function parseCommandArgs(raw: string, parameters?: SavedWorkflow["parameters"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
    else positional.push(token);
  }
  out._ = positional.join(" ");
  out._raw = raw.trim();
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

/** Register one saved workflow as a dynamically loaded slash command. */
export function registerSavedWorkflow(
  pi: ExtensionAPI,
  cwd: string | (() => string),
  wf: Pick<SavedWorkflow, "name" | "description" | "script" | "parameters">,
  manager?: WorkflowManager | (() => WorkflowManager | undefined),
  exists?: () => boolean,
  loadWorkflow?: () => Pick<SavedWorkflow, "name" | "description" | "script" | "parameters"> | null | undefined,
): { ok: true } | { ok: false; message: string } {
  const availability = savedWorkflowCommandAvailability(pi, wf.name);
  if (!availability.ok) return availability;
  if (isCommandRegistered(pi, wf.name)) return { ok: true };
  const getCwd = typeof cwd === "function" ? cwd : () => cwd;
  const getManager = typeof manager === "function" ? manager : () => manager;
  try {
    pi.registerCommand(wf.name, {
      description: wf.description || `Saved workflow: ${wf.name}`,
      async handler(args: string, ctx: ExtensionCommandContext) {
        // The loader is deliberately evaluated at invocation. After rename/delete
        // the old unavoidable Pi registration cannot execute a frozen script.
        const liveWorkflow = loadWorkflow ? loadWorkflow() : exists && !exists() ? null : wf;
        if (!liveWorkflow) {
          ctx.ui.notify(
            `/${wf.name} is not available in this project — reload the session to drop the stale command.`,
            "warning",
          );
          return;
        }
        try {
          const liveManager = getManager();
          if (liveManager) {
            const { runId } = liveManager.startInBackground(
              liveWorkflow.script,
              parseCommandArgs(args, liveWorkflow.parameters),
            );
            ctx.ui.notify(
              `/${liveWorkflow.name} running in the background (${runId}) — watch the task panel or /workflows; the result is posted here when it finishes.`,
              "info",
            );
            return;
          }
          const liveCwd = getCwd();
          ctx.ui.notify(`Starting /${liveWorkflow.name}…`, "info");
          const result = await runWorkflow(liveWorkflow.script, {
            cwd: liveCwd,
            args: parseCommandArgs(args, liveWorkflow.parameters),
            tools: createCodingTools(liveCwd),
            onPhase: (title) => ctx.ui.setStatus(`wf:${liveWorkflow.name}`, `${liveWorkflow.name}: ${title}`),
          });
          ctx.ui.setStatus(`wf:${liveWorkflow.name}`, undefined);
          await pi.sendMessage({
            customType: `workflow:${liveWorkflow.name}`,
            content: reportText(result),
            display: true,
          });
        } catch (error) {
          ctx.ui.setStatus(`wf:${liveWorkflow.name}`, undefined);
          ctx.ui.notify(`/${liveWorkflow.name} failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
    claimCommand(pi, wf.name, "saved");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function registerAllSavedWorkflows(
  pi: ExtensionAPI,
  cwd: string | (() => string),
  storage: WorkflowStorage | (() => WorkflowStorage),
  manager?: WorkflowManager | (() => WorkflowManager | undefined),
): void {
  const getStorage = typeof storage === "function" ? storage : () => storage;
  const getCwd = typeof cwd === "function" ? cwd : () => cwd;
  for (const workflow of getStorage().list()) {
    const name = workflow.name;
    registerSavedWorkflow(
      pi,
      getCwd,
      workflow,
      manager,
      () => getStorage().load(name) != null,
      () => getStorage().load(name),
    );
  }
}
