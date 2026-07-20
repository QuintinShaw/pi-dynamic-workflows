/**
 * "Workflows mode" keyword trigger: while the submitted message contains the
 * bounded word `workflow`/`workflows` (or a configured custom trigger word),
 * the message is transformed at submit time to instruct Pi to actually run the
 * workflow tool. Detection is purely textual (`event.text` on the `input`
 * hook) — it does not depend on, or own, the host's editor component.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_KEYWORD_TRIGGER_WORD, normalizeKeywordTriggerWord } from "./config.js";
import { type EffortState, effortDirective, isSubstantive } from "./effort-command.js";
import {
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
  type WorkflowSettingsStore,
} from "./workflow-settings.js";

// A keyword trigger is a configured literal term. All trigger words use token
// boundaries so slash commands, paths, and identifier-like text stay untouched.
// The default `workflow` trigger additionally supports the plural `workflows`.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function triggerSource(triggerWord: string): string {
  const escaped = escapeRegExp(triggerWord);
  const plural = triggerWord.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD ? "s?" : "";
  return `(?<![/\\p{ID_Continue}$-])(?<!\\\\)${escaped}${plural}(?![/\\p{ID_Continue}$-])(?!\\\\)`;
}

function triggerRegex(triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD, flags = "iu", atEnd = false): RegExp {
  const word = normalizeKeywordTriggerWord(triggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
  return new RegExp(`${triggerSource(word)}${atEnd ? "$" : ""}`, flags);
}

export function hasTrigger(text: string, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD): boolean {
  return triggerRegex(triggerWord).test(text);
}

export function endsWithTrigger(textBeforeCursor: string, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD): boolean {
  return triggerRegex(triggerWord, "iu", true).test(textBeforeCursor);
}

/** Shared, mutable view of whether "workflows mode" is currently armed. */
export interface WorkflowModeState {
  active: boolean;
  keywordTriggerEnabled: boolean;
  keywordTriggerWord?: string;
  suppressedKeywordText?: string;
}

export interface InstallWorkflowKeywordArmingOptions {
  settingsStore?: WorkflowSettingsStore;
}

/**
 * Why a turn was armed. This is stated truthfully in the banner so the model
 * isn't told "the trigger word you typed" on a path where no word was typed:
 *  - "keyword": the user typed the configured workflow trigger word.
 *  - "effort": standing `/effort` armed this turn (no workflow word was typed).
 */
export type ArmReason = "keyword" | "effort";

/**
 * Appended to the effort-path directive: standing `/effort` arms on every
 * substantive message, so the model must be told it can decline the workflow on
 * a conversational or trivial turn (mirrors "solo only on conversational turns").
 */
export const EFFORT_CONVERSATIONAL_ESCAPE =
  "This turn was armed by standing effort mode, not by an explicit workflow request: if it is conversational or trivial, skip the workflow and just respond directly.";

/** The one-line, truthful "why armed" clause for each heuristic arming path. */
function armReasonClause(reason: ArmReason): string {
  return reason === "keyword"
    ? "you typed the workflow trigger word, which counts as an explicit opt-in to multi-agent orchestration"
    : "standing effort mode armed this turn (you did not explicitly ask for a workflow)";
}

/**
 * The #89 reassurance shared by every arming banner: a background run ENDING the
 * turn is expected, not a stall — the result auto-delivers back — so the model
 * shouldn't feel it must stay and block, nor avoid the tool to stay interactive.
 * Names when `background:false` is the right call (user waiting inline).
 */
const BACKGROUND_DELIVERY_REASSURANCE =
  "If you do call `workflow`, it runs in the background by default: this turn will end and the result is delivered back into the conversation automatically when it finishes — that's expected, not a stall, so you do not need to stay and block. Only pass background:false if the user is waiting for the result inline in this same turn.";

/**
 * The directive appended to a submitted message when workflows mode is ARMED by a
 * HEURISTIC path — the keyword trigger or standing `/effort`. (The explicit
 * `/workflows run` command uses {@link buildForcedWorkflowPrompt} instead.)
 *
 * This authorizes — it does not force. Arming is a confirmed opt-in signal that
 * lifts the always-on "do not call the tool" gate for THIS message; the model
 * still decides whether the message is actually a request to do work (→ call the
 * `workflow` tool) or just talk about workflows (→ answer directly). The old
 * "You MUST / the ONLY acceptable action / Do NOT answer directly" forcing text
 * caused two bugs: it over-triggered on messages that merely mention workflows
 * (#88), and — by commanding the model to emit nothing but one `workflow` call
 * and not talk — it produced a bare background run that ends the turn and leaves
 * the user at an idle prompt (#89).
 *
 * The banner therefore (1) LEADS with the decision boundary (question/trivial →
 * answer directly; a real decomposable request → call `workflow`) rather than
 * leading with "call the tool"; (2) states the truthful opt-in `reason` for THIS
 * path (no "the word you typed" on the effort path, where none was); and (3)
 * carries the #89 background/deliver-back reassurance so an ending turn reads as
 * expected. The how-to mechanics are NOT here — they live in the tool's static
 * `description` (see createWorkflowTool), visible whenever the model looks at the
 * tool, so they aren't re-injected per armed turn (#65).
 *
 * `extraDirective` (e.g. an effort-tier nudge + EFFORT_CONVERSATIONAL_ESCAPE) is
 * appended when present.
 */
export function buildArmedWorkflowPrompt(
  text: string,
  opts: { reason?: ArmReason; extraDirective?: string } = {},
): string {
  const reason = opts.reason ?? "keyword";
  const lines = [
    text,
    "",
    "---",
    "[workflows mode armed. Decide first: if this message is a question, a trivial task, or",
    "just talk (about workflows, this repo, or the tool itself), answer it directly and stay",
    "conversational — arming authorizes the tool, it does not force it. If it is a real,",
    "decomposable request to do work, handle it by calling the `workflow` tool: write a script",
    "that fans the task out across subagents via agent()/parallel()/pipeline().",
    `Why this turn is armed: ${armReasonClause(reason)}.`,
    BACKGROUND_DELIVERY_REASSURANCE + "]",
  ];
  if (opts.extraDirective) lines.push("", opts.extraDirective);
  return lines.join("\n");
}

/**
 * The directive for the explicit `/workflows run <prompt>` command. Unlike the
 * heuristic {@link buildArmedWorkflowPrompt}, `/workflows run` is a maximal-intent
 * command — the user typed a command whose whole purpose is to execute a workflow
 * now — so it does NOT get the "if it's a question, just answer" escape. It still
 * avoids the old MUST/ONLY forcing language (which caused #88/#89) and still
 * carries the #89 background/deliver-back reassurance so an ending turn reads as
 * expected. `extraDirective` (e.g. a standing effort-tier nudge) is appended.
 */
export function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string {
  const lines = [
    text,
    "",
    "---",
    "[/workflows run — you ran an explicit command to execute a workflow for this request.",
    "Call the `workflow` tool now: write a script that fans this task out across subagents",
    "via agent()/parallel()/pipeline(). (This is a direct command, not a heuristic guess, so",
    "do not answer in prose instead of running the workflow.)",
    BACKGROUND_DELIVERY_REASSURANCE + "]",
  ];
  if (extraDirective) lines.push("", extraDirective);
  return lines.join("\n");
}

/** The exact name of the workflow tool that workflows mode forces. */
export const WORKFLOW_TOOL_NAME = "workflow";

export function registerWorkflowTriggerCommand(
  pi: ExtensionAPI,
  state: WorkflowModeState,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-trigger", {
    description: "Keyword workflow trigger: on | off | set <word> | reset | status",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const raw = args.trim();
      const [command = "status", ...rest] = raw.split(/\s+/);
      const arg = command.toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-trigger", content, display: true });
      if (arg === "on") {
        state.keywordTriggerEnabled = true;
        state.suppressedKeywordText = undefined;
        const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerEnabled: true });
        await say(
          saved
            ? `Workflows keyword trigger on — mentioning ${triggerDisplayName(state.keywordTriggerWord)} in an interactive message will auto-arm workflows mode. Saved for new sessions.`
            : "Workflows keyword trigger on for this session, but the preference could not be saved.",
        );
        return;
      }
      if (arg === "off") {
        state.keywordTriggerEnabled = false;
        state.active = false;
        state.suppressedKeywordText = undefined;
        const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerEnabled: false });
        await say(
          saved
            ? `Workflows keyword trigger off — messages can mention ${triggerDisplayName(state.keywordTriggerWord)} without forcing the workflow tool. Saved for new sessions. Use /workflows-trigger on to restore.`
            : "Workflows keyword trigger off for this session, but the preference could not be saved. Use /workflows-trigger on to restore.",
        );
        return;
      }
      if (arg === "set") {
        const requested = rest.join(" ");
        const keywordTriggerWord = normalizeKeywordTriggerWord(requested);
        if (!keywordTriggerWord) {
          await say(
            'Invalid trigger word. Use a non-empty term with no spaces and no leading "/", e.g. /workflows-trigger set pi-workflow',
          );
          return;
        }
        state.keywordTriggerWord = keywordTriggerWord;
        state.suppressedKeywordText = undefined;
        const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerWord });
        await say(
          saved
            ? `Workflows keyword trigger word set to "${keywordTriggerWord}". Saved for new sessions.`
            : `Workflows keyword trigger word set to "${keywordTriggerWord}" for this session, but the preference could not be saved.`,
        );
        return;
      }
      if (arg === "reset") {
        state.keywordTriggerWord = DEFAULT_KEYWORD_TRIGGER_WORD;
        state.suppressedKeywordText = undefined;
        const saved = persistWorkflowTriggerSettings(settingsStore, {
          keywordTriggerWord: DEFAULT_KEYWORD_TRIGGER_WORD,
        });
        await say(
          saved
            ? 'Workflows keyword trigger word reset to "workflow" (also matches "workflows"). Saved for new sessions.'
            : 'Workflows keyword trigger word reset to "workflow" for this session, but the preference could not be saved.',
        );
        return;
      }
      const keywordTriggerWord = resolvedTriggerWord(state.keywordTriggerWord);
      await say(
        `Workflows keyword trigger is ${state.keywordTriggerEnabled ? "on" : "off"}; trigger word is "${keywordTriggerWord}". Changes are saved for new sessions. Usage: /workflows-trigger on | off | set <word> | reset | status`,
      );
    },
  });
}

/**
 * Register the bottom progress-panel preference command:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export function registerWorkflowProgressCommands(
  pi: ExtensionAPI,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-progress", {
    description: "Bottom progress panel: compact | detailed | status | max <N>",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const trimmed = args.trim();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      const spaceIdx = trimmed.indexOf(" ");
      const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (verb === "compact" || verb === "detailed") {
        const saved = persistProgressSettings(settingsStore, { progressPanelMode: verb });
        await say(
          saved
            ? `Workflow progress panel set to ${verb} — takes effect on the next render of a live run (no restart needed).`
            : `Workflow progress panel set to ${verb} for this session, but the preference could not be saved.`,
        );
        return;
      }

      if (verb === "max") {
        if (!rest) {
          await say(
            `Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress max <1-1000>`,
          );
          return;
        }
        const n = Number.parseInt(rest, 10);
        if (!Number.isFinite(n) || n < 1) {
          await say(`Invalid value "${rest}". Usage: /workflows-progress max <1-1000> (a whole number ≥ 1).`);
          return;
        }
        const clamped = Math.min(1000, n);
        const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
        await say(
          saved
            ? `Detailed progress now shows up to ${clamped} agents per phase.`
            : `Set to ${clamped} for this session, but the preference could not be saved.`,
        );
        return;
      }

      await say(
        `Workflow progress panel is ${loadProgressMode(settingsStore)}, showing up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress compact | detailed | status | max <N>`,
      );
    },
  });
}

/**
 * Install the keyword-trigger arming hook (submit-time detection + prompt
 * rewrite) and the related trigger/progress commands. Call once (e.g. in
 * `session_start`).
 */
export function installWorkflowKeywordArming(
  pi: ExtensionAPI,
  effort?: EffortState,
  options: InstallWorkflowKeywordArmingOptions = {},
): WorkflowModeState {
  const settingsStore = options.settingsStore ?? DEFAULT_SETTINGS_STORE;
  const initialSettings = loadInitialWorkflowSettings(settingsStore);
  const state: WorkflowModeState = {
    active: false,
    keywordTriggerEnabled: initialSettings.keywordTriggerEnabled ?? true,
    keywordTriggerWord: initialSettings.keywordTriggerWord ?? DEFAULT_KEYWORD_TRIGGER_WORD,
  };

  registerWorkflowTriggerCommand(pi, state, settingsStore);
  registerWorkflowProgressCommands(pi, settingsStore);

  // Active tools saved while a turn is restricted to `workflow`; restored on turn_end.
  let savedTools: string[] | undefined;

  // When armed at submit time, rewrite the user's message to force a workflow AND
  // ensure the `workflow` tool is in the active tool set, so the model can call it.
  // We keep all existing tools (bash, read, edit, write, web_search, etc.) because
  // the model often needs them BEFORE writing the workflow script (e.g. exploring
  // the codebase, reading files, searching for context). This only ADDS the
  // workflow tool to the active set; no tools are removed (the original set is
  // saved in `savedTools` and restored elsewhere).
  //
  // NOTE: we check event.text directly (hasTrigger) rather than state.active from
  // the editor, because the editor's state is reset synchronously by submitValue()
  // BEFORE the input event fires (the actual prompt processing is async).
  pi.on("input", (event: { source?: string; text?: string }) => {
    if (event.source !== "interactive" || !event.text) return { action: "continue" } as const;
    // Arm either when the user typed the "workflow(s)" trigger, or when standing
    // effort mode is on and the message is a substantive request.
    const normalizedText = event.text.trim();
    const suppressed = state.suppressedKeywordText === normalizedText;
    if (suppressed) state.suppressedKeywordText = undefined;
    const triggered = state.keywordTriggerEnabled && !suppressed && hasTrigger(event.text, state.keywordTriggerWord);
    const byEffort = !triggered && !!effort && effort.level !== "off" && isSubstantive(event.text);
    if (!triggered && !byEffort) return { action: "continue" } as const;
    try {
      if (savedTools === undefined) {
        savedTools = pi.getActiveTools?.() ?? [];
        const current = [...savedTools];
        if (!current.includes(WORKFLOW_TOOL_NAME)) {
          current.push(WORKFLOW_TOOL_NAME);
        }
        pi.setActiveTools?.(current);
      }
    } catch {
      // Tool restriction is best-effort; the armed directive still authorizes the workflow.
    }
    // Effort path: the trigger word was NOT typed — this arms on ANY substantive
    // message while standing effort is on. So the directive must (a) state the
    // truthful "effort" reason (not "the word you typed"), and (b) let the model
    // skip the workflow entirely on conversational/trivial turns, not just on
    // questions about workflows.
    const extra =
      byEffort && effort
        ? [effortDirective(effort.level), EFFORT_CONVERSATIONAL_ESCAPE].filter(Boolean).join(" ")
        : undefined;
    const reason: ArmReason = byEffort ? "effort" : "keyword";
    return {
      action: "transform",
      text: buildArmedWorkflowPrompt(event.text, { reason, extraDirective: extra }),
    } as const;
  });

  // Restore the user's full tool set once the forced turn completes.
  pi.on("turn_end", () => {
    if (savedTools === undefined) return;
    const restore = savedTools;
    savedTools = undefined;
    try {
      pi.setActiveTools?.(restore);
    } catch {
      // ignore — nothing we can do if the host rejects the restore
    }
  });

  return state;
}

const DEFAULT_SETTINGS_STORE: WorkflowSettingsStore = {
  load: loadWorkflowSettings,
  save: saveWorkflowSettings,
};

function loadInitialWorkflowSettings(settingsStore: WorkflowSettingsStore): WorkflowSettings {
  try {
    const settings = settingsStore.load();
    return {
      keywordTriggerEnabled: settings.keywordTriggerEnabled,
      keywordTriggerWord: normalizeKeywordTriggerWord(settings.keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD,
    };
  } catch {
    return { keywordTriggerEnabled: true, keywordTriggerWord: DEFAULT_KEYWORD_TRIGGER_WORD };
  }
}

function persistWorkflowTriggerSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function resolvedTriggerWord(keywordTriggerWord: string | undefined): string {
  return normalizeKeywordTriggerWord(keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
}

function triggerDisplayName(keywordTriggerWord: string | undefined): string {
  const word = resolvedTriggerWord(keywordTriggerWord);
  return word.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD ? "workflow/workflows" : `"${word}"`;
}

function persistProgressSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function loadProgressMode(settingsStore: WorkflowSettingsStore): "compact" | "detailed" {
  try {
    return settingsStore.load().progressPanelMode ?? "compact";
  } catch {
    return "compact";
  }
}

function loadProgressMaxAgents(settingsStore: WorkflowSettingsStore): number {
  try {
    return settingsStore.load().progressPanelMaxAgents ?? 8;
  } catch {
    return 8;
  }
}
