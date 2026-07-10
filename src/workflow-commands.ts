/**
 * `/workflows` slash command: list, inspect, and control background workflow runs.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  fmtFull,
  fmtTokenSegment,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  tokenFigures,
  type WorkflowSnapshot,
} from "./display.js";
import { type EffortState, effortDirective } from "./effort-command.js";
import type { PersistedRunState } from "./run-persistence.js";
import { registerSavedWorkflow } from "./saved-commands.js";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME } from "./workflow-editor.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import { openWorkflowNavigator } from "./workflow-ui.js";

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

const USAGE =
  "Usage: /workflows [list] | run <prompt> | status <id> | watch <id> | stop <id> | pause <id> | resume <id> | rm <id> | save <name> [runId]";

const RUN_USAGE = "Usage: /workflows run <prompt> — force a dynamic workflow from the prompt";

function summarizeRun(run: PersistedRunState): string {
  const icon = STATUS_ICON[run.status] ?? "?";
  const done = run.agents.filter((a) => a.status === "done").length;
  const total = run.agents.length;
  const segment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  const tokens = segment ? ` · ${segment}` : "";
  return `${icon} ${run.runId}  ${run.workflowName} [${run.status}] ${done}/${total} agents${tokens}`;
}

function oneLineProgress(snapshot: WorkflowSnapshot): string {
  const total = snapshot.agents.length;
  const done = snapshot.agents.filter((a) => a.status === "done").length;
  const running = snapshot.agents.filter((a) => a.status === "running").length;
  const errs = snapshot.agents.filter((a) => a.status === "error").length;
  const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
  return `◆ ${snapshot.name}: ${done}/${total} done${running ? `, ${running} running` : ""}${
    errs ? `, ${errs} err` : ""
  }${phase}`;
}

/**
 * Subscribe to a running run's events and stream live progress to the status bar,
 * printing the final snapshot when it finishes. Non-blocking: returns true if the
 * run was active and is now being watched, false otherwise. Listeners clean up on
 * completion so nothing leaks.
 */
function watchRun(manager: WorkflowManager, pi: ExtensionAPI, ctx: ExtensionCommandContext, id: string): boolean {
  const active = manager.getRun(id);
  if (active?.status !== "running") return false;

  const key = `wf:${id}`;
  const update = () => {
    const run = manager.getRun(id);
    if (run) ctx.ui.setStatus(key, oneLineProgress(run.snapshot));
  };
  const onEvent = (e: { runId?: string }) => {
    if (!e || e.runId === id) update();
  };
  let settled = false;
  const progressEvents = ["agentStart", "agentEnd", "phase", "log"];
  const finalEvents = ["complete", "error", "stopped", "paused"];
  const finish = (e: { runId?: string }) => {
    if (e && e.runId !== id) return;
    if (settled) return;
    settled = true;
    for (const ev of progressEvents) manager.off(ev, onEvent);
    for (const ev of finalEvents) manager.off(ev, finish);
    ctx.ui.setStatus(key, undefined);
    const run = manager.getRun(id);
    if (run) {
      void pi.sendMessage({
        customType: "workflows",
        content: renderWorkflowText(recomputeWorkflowSnapshot(run.snapshot), true),
        display: true,
      });
    }
  };
  for (const ev of progressEvents) manager.on(ev, onEvent);
  for (const ev of finalEvents) manager.on(ev, finish);
  update();
  return true;
}

function renderPersistedStatus(run: PersistedRunState): string {
  const lines = [`${STATUS_ICON[run.status] ?? "?"} ${run.workflowName} (${run.runId}) — ${run.status}`];
  if (run.currentPhase) lines.push(`  phase: ${run.currentPhase}`);
  for (const agent of run.agents) {
    const icon =
      agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : agent.status === "running" ? "◆" : "·";
    lines.push(`  ${icon} ${agent.label}`);
  }
  const tokenSegment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  if (tokenSegment) lines.push(`  tokens: ${tokenSegment}`);
  if (run.durationMs) lines.push(`  duration: ${(run.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

export interface WorkflowCommandOptions {
  /** Saved-workflow storage, enabling `/workflows save`. */
  storage?: WorkflowStorage;
  /** Working directory for saved workflows registered via `save`. */
  cwd?: string;
  /** Standing effort mode; when high/ultra, `/workflows run` carries its directive too. */
  effort?: EffortState;
}

/** Register the `/workflows` command against the shared manager. Idempotent. */
export function registerWorkflowCommands(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: WorkflowCommandOptions = {},
): void {
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "workflows");
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }

  pi.registerCommand("workflows", {
    description:
      "Manage workflow runs — no args (opens navigator) | run <prompt> | status/stop/pause/resume <id> | rm <id> | save <name> [runId]",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      const id = parts[1];
      const print = (text: string) => pi.sendMessage({ customType: "workflows", content: text, display: true });

      switch (sub) {
        case "run": {
          const prompt = args
            .trim()
            .slice(parts[0]?.length ?? 0)
            .trim();
          if (!prompt) {
            ctx.ui.notify(RUN_USAGE, "warning");
            return;
          }

          // Best-effort: ensure the workflow tool is active (session_start usually has).
          // Add-only so this does not interfere with the keyword hook's save/restore state.
          try {
            const active = pi.getActiveTools?.() ?? [];
            if (!active.includes(WORKFLOW_TOOL_NAME)) pi.setActiveTools?.([...active, WORKFLOW_TOOL_NAME]);
          } catch {
            // ignore — the forced directive is the real forcing primitive
          }

          const effort = opts.effort;
          const extra = effort && effort.level !== "off" ? effortDirective(effort.level) : undefined;
          const forced = buildForcedWorkflowPrompt(prompt, extra);
          ctx.ui.notify(`Forcing workflow: ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`, "info");
          try {
            await pi.sendMessage(
              { customType: "workflow-run", content: forced, display: true },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch {
            ctx.ui.notify("Could not start the workflow turn.", "error");
          }
          return;
        }
        case "ui":
        case "list": {
          // Interactive navigator when a UI is available; plain text otherwise
          // (print/RPC mode) or when the user explicitly asks for `list`.
          if (sub !== "list" && ctx.hasUI) {
            await openWorkflowNavigator(pi, manager, ctx.ui, { storage: opts.storage, cwd: opts.cwd });
            return;
          }
          if (parts.length === 0 && ctx.hasUI) {
            await openWorkflowNavigator(pi, manager, ctx.ui, { storage: opts.storage, cwd: opts.cwd });
            return;
          }
          const runs = manager.listRuns();
          if (!runs.length) {
            await print("No workflow runs yet. Start one with a background workflow (background: true).");
            return;
          }
          await print(["Workflow runs:", ...runs.map(summarizeRun), "", USAGE].join("\n"));
          return;
        }
        case "watch":
        case "status": {
          if (!id) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          // A running run streams live progress to the status bar and prints the
          // final snapshot when it finishes — no need to re-run the command.
          if (watchRun(manager, pi, ctx, id)) {
            ctx.ui.notify(`Watching ${id} — live progress in the status bar; result prints when it finishes.`, "info");
            return;
          }
          const live = manager.getSnapshot(id);
          if (live) {
            await print(renderWorkflowText(recomputeWorkflowSnapshot(live), false));
            return;
          }
          const run = manager.listRuns().find((r) => r.runId === id);
          if (!run) {
            ctx.ui.notify(`No workflow run "${id}"`, "error");
            return;
          }
          await print(renderPersistedStatus(run));
          return;
        }
        case "stop": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(
            manager.stop(id) ? `Stopped ${id}` : `Cannot stop ${id} (not running)`,
            manager.getRun(id) ? "info" : "warning",
          );
          return;
        }
        case "pause": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.pause(id) ? `Paused ${id}` : `Cannot pause ${id} (not running)`, "info");
          return;
        }
        case "resume": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          const ok = await manager.resume(id);
          ctx.ui.notify(ok ? `Resumed ${id}` : `Resume not available for ${id} yet`, ok ? "info" : "warning");
          return;
        }
        case "rm": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.deleteRun(id) ? `Removed ${id}` : `No run ${id}`, "info");
          return;
        }
        case "save": {
          const name = id;
          if (!name) return ctx.ui.notify("Usage: /workflows save <name> [runId]", "warning");
          if (!opts.storage) return ctx.ui.notify("Saving is not available (no storage configured)", "error");
          const storage = opts.storage;
          const runs = manager.listRuns();
          const runIdArg = parts[2];
          // Pick the named run, else the most recent run that still has its script.
          const run = runIdArg ? runs.find((r) => r.runId === runIdArg) : runs.find((r) => r.script);
          if (!run?.script) {
            ctx.ui.notify(runIdArg ? `No run ${runIdArg} with a script` : "No saved run to save", "error");
            return;
          }
          let saved: ReturnType<WorkflowStorage["save"]>;
          try {
            saved = storage.save({
              name,
              description: run.workflowName,
              script: run.script,
              location: "project",
            });
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
          }
          registerSavedWorkflow(pi, opts.cwd ?? process.cwd(), saved, undefined, () =>
            storage.list().some((w) => w.name === saved.name),
          );
          ctx.ui.notify(`Saved /${name} (from ${run.runId})`, "info");
          return;
        }
        default:
          ctx.ui.notify(`Unknown subcommand "${sub}". ${USAGE}`, "warning");
      }
    },
  });
}
