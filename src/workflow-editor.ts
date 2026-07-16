/**
 * "Workflows mode" input affordance, à la a smart input box:
 *
 *  - While the editor text contains the word `workflow`/`workflows`, those letters
 *    render as a flowing rainbow, signalling that submitting will engage a workflow.
 *  - Pressing Backspace immediately after such a word toggles the highlight OFF
 *    (the word stays, but turns plain white) — a non-destructive "don't run a
 *    workflow after all". Re-typing a fresh trigger word turns it back on.
 *  - When the highlight is ON at submit time, the user's message is transformed to
 *    instruct Pi to actually run the workflow tool.
 *
 * Implementation: we replace the core editor with a thin subclass of the exported
 * `CustomEditor` (which itself extends pi-tui's `Editor`), overriding only
 * `render()` (to colorize) and `handleInput()` (for the Backspace toggle). All
 * other editor behavior — history, autocomplete, paste, undo, multiline — is
 * inherited untouched.
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_KEYWORD_TRIGGER_WORD, normalizeKeywordTriggerWord } from "./config.js";
import { type EffortState, effortDirective, isSubstantive } from "./effort-command.js";
import {
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
  type WorkflowSettingsStore,
} from "./workflow-settings.js";

// A keyword trigger is a configured literal term. The default `workflow`
// trigger keeps legacy substring behavior and plural support (`workflows`) while
// custom trigger words match only that exact term. Slash commands like
// `/workflows` or `/pi-workflow` are left alone (not colored, not armed).
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function triggerSource(triggerWord: string): string {
  const escaped = escapeRegExp(triggerWord);
  if (triggerWord.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD) return `(?<!\\/)${escaped}s?`;
  return `(?<![/A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`;
}

function triggerRegex(triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD, flags = "i", atEnd = false): RegExp {
  const word = normalizeKeywordTriggerWord(triggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
  return new RegExp(`${triggerSource(word)}${atEnd ? "$" : ""}`, flags);
}

/** 256-color ring cycling through the spectrum — shifted by a tick to "flow". */
export const RAINBOW = [
  196, 160, 202, 166, 208, 172, 214, 178, 220, 184, 226, 190, 118, 82, 46, 47, 48, 49, 50, 51, 45, 39, 33, 27, 21, 57,
  93, 129, 165, 201, 198, 197,
];

export function hasTrigger(text: string, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD): boolean {
  return triggerRegex(triggerWord).test(text);
}

export function endsWithTrigger(textBeforeCursor: string, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD): boolean {
  return triggerRegex(triggerWord, "i", true).test(textBeforeCursor);
}

/** Shared, mutable view of whether "workflows mode" is currently armed. */
export interface WorkflowModeState {
  active: boolean;
  keywordTriggerEnabled: boolean;
  keywordTriggerWord?: string;
  suppressedKeywordText?: string;
}

export interface InstallWorkflowEditorOptions {
  settingsStore?: WorkflowSettingsStore;
}

interface AnsiToken {
  esc?: string;
  ch?: string;
}

/**
 * Split a rendered line into ANSI-escape tokens (passed through verbatim) and
 * single visible-character tokens. Handles CSI sequences (`\x1b[…m`, e.g. the
 * cursor's inverse-video) and APC/OSC string sequences (e.g. the zero-width
 * `CURSOR_MARKER` = `\x1b_pi:c\x07`) so colorization never corrupts them.
 */
export function tokenizeAnsi(line: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      let j = i + 1;
      const next = line[j];
      if (next === "[") {
        // CSI: ends at a final byte in 0x40–0x7e.
        j++;
        while (j < line.length && !(line[j] >= "@" && line[j] <= "~")) j++;
        j++;
      } else if (next === "]" || next === "_" || next === "P" || next === "^") {
        // String sequence: ends at BEL (\x07) or ST (\x1b\\).
        j++;
        while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
        if (line[j] === "\x07") j++;
        else if (line[j] === "\x1b") j += 2;
      } else {
        j++; // lone ESC + one byte
      }
      tokens.push({ esc: line.slice(i, j) });
      i = j;
    } else {
      tokens.push({ ch: line[i] });
      i++;
    }
  }
  return tokens;
}

/**
 * Colorize every `workflow`/`workflows` occurrence in a rendered line with a
 * flowing rainbow, leaving all ANSI escapes (cursor, markers) intact. Returns the
 * line unchanged when it contains no trigger.
 */
export function colorizeWorkflow(
  line: string,
  tick: number,
  palette: number[] = RAINBOW,
  triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD,
): string {
  const tokens = tokenizeAnsi(line);
  const visible = tokens
    .filter((t) => t.ch !== undefined)
    .map((t) => t.ch)
    .join("");
  if (!hasTrigger(visible, triggerWord)) return line;

  const ranges: Array<[number, number]> = [];
  const globalTrigger = triggerRegex(triggerWord, "gi");
  for (let m = globalTrigger.exec(visible); m; m = globalTrigger.exec(visible)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  const inRange = (idx: number) => ranges.some(([s, e]) => idx >= s && idx < e);

  let out = "";
  let vi = 0;
  for (const t of tokens) {
    if (t.esc !== undefined) {
      out += t.esc;
      continue;
    }
    if (inRange(vi)) {
      const color = palette[(vi + tick) % palette.length];
      // Reset only the foreground (39) afterwards so a surrounding inverse-video
      // (the cursor) is preserved.
      out += `\x1b[38;5;${color}m${t.ch}\x1b[39m`;
    } else {
      out += t.ch ?? "";
    }
    vi++;
  }
  return out;
}

/** Backspace arrives as DEL (0x7f) or BS (0x08) depending on the terminal. */
function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

/** Emitted at most once per process so a noisy host doesn't spam the log. */
let warnedUnexpectedArity = false;

/**
 * Pi's CustomEditor still forwards `(tui, theme, keybindings)` to the legacy
 * pi-tui Editor constructor. OMP's CustomEditor has no constructor and extends
 * the newer `Editor(theme)`. Select the argument layout from the base Editor's
 * required parameter count so one extension can run in either host.
 *
 * `baseEditorCtor` defaults to the real `Editor` class (via
 * `Object.getPrototypeOf(CustomEditor)`) and is only overridable so unit tests
 * can exercise both branches without depending on which host's `CustomEditor`
 * happens to be installed (see `tests/workflow-editor.test.ts`).
 */
export function customEditorConstructorArgs(
  tui: TUI,
  theme: EditorTheme,
  keybindings: ConstructorParameters<typeof CustomEditor>[2],
  baseEditorCtor: { readonly length: number } = Object.getPrototypeOf(CustomEditor) as { readonly length: number },
): ConstructorParameters<typeof CustomEditor> {
  if (baseEditorCtor.length === 1) {
    // The installed Pi types describe the legacy signature; OMP provides the
    // runtime-only `(theme, keybindings)` signature.
    return [theme, keybindings] as unknown as ConstructorParameters<typeof CustomEditor>;
  }
  // INTENTIONAL: any arity other than exactly 1 is treated as the legacy
  // 3-arg `(tui, theme, keybindings)` layout — this includes the expected
  // legacy case (2: pi-tui's `Editor(tui, theme, options)`), but also any
  // *unexpected* arity (0, 3, ...) from a host we haven't seen yet. That's a
  // deliberate choice: legacy is the layout we've actually verified against
  // real Pi releases, so it's the safer default. If a third host signature
  // ever shows up, this heuristic needs a new branch — the warning below is
  // meant to surface that instead of silently misconstructing the editor
  // (see https://github.com/QuintinShaw/pi-dynamic-workflows/issues/72).
  if (baseEditorCtor.length !== 2 && !warnedUnexpectedArity) {
    warnedUnexpectedArity = true;
    console.warn(
      `[pi-dynamic-workflows] WorkflowEditor: base editor constructor takes ${baseEditorCtor.length} required ` +
        "argument(s), which is neither the known OMP layout (1) nor the known legacy Pi layout (2). Falling back " +
        "to the legacy (tui, theme, keybindings) call — the editor may fail to render on this host. Please report " +
        "this at https://github.com/QuintinShaw/pi-dynamic-workflows/issues/72.",
    );
  }
  return [tui, theme, keybindings];
}

/**
 * Editor that paints the trigger words and owns the on/off toggle. Reads/writes
 * `state.active` so the extension's `input` handler can decide whether to force a
 * workflow at submit time.
 */
export class WorkflowEditor extends CustomEditor {
  private tick = 0;
  private timer?: ReturnType<typeof setInterval>;
  /** Toggled off by Backspace-after-word; re-armed when a fresh trigger appears. */
  private disabled = false;
  private wasTriggered = false;

  constructor(
    private readonly hostTui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private readonly modeState: WorkflowModeState,
  ) {
    super(...customEditorConstructorArgs(hostTui, theme, keybindings));
  }

  /** Highlighted/armed: a trigger is present and the user hasn't toggled it off. */
  isActive(): boolean {
    return (
      this.modeState.keywordTriggerEnabled &&
      !this.disabled &&
      hasTrigger(this.getText(), this.modeState.keywordTriggerWord)
    );
  }

  override handleInput(data: string): void {
    // First Backspace right after a trigger word disarms (non-destructive).
    if (isBackspace(data) && this.isActive() && this.cursorAfterTrigger()) {
      this.disabled = true;
      this.modeState.suppressedKeywordText = this.getText().trim();
      this.syncState();
      this.hostTui.requestRender();
      return;
    }
    const before = this.getText();
    super.handleInput(data);
    const after = this.getText();
    if (after !== before) {
      const now = hasTrigger(after, this.modeState.keywordTriggerWord);
      const normalizedAfter = after.trim();
      const suppressionCleared =
        this.modeState.suppressedKeywordText !== undefined &&
        normalizedAfter !== "" &&
        normalizedAfter !== this.modeState.suppressedKeywordText;
      if (suppressionCleared) {
        this.modeState.suppressedKeywordText = undefined;
      }
      // A freshly typed trigger re-arms a previously disabled box.
      if (now && (!this.wasTriggered || suppressionCleared)) this.disabled = false;
      this.wasTriggered = now;
    }
    this.syncState();
  }

  override render(width: number): string[] {
    // Defensive layer for issue #72: on some hosts a base-editor/pi-tui
    // version mismatch can leave the base `Editor`'s internal render state
    // uninitialized, making `super.render()` throw on every single render —
    // including the very first one, before the user has typed anything —
    // which crashes the whole app at launch with no way to recover (short of
    // disabling the extension). We can't fix a broken host from here, but we
    // CAN make sure this extension degrades to a plain, unstyled editor
    // instead of hard-crashing Pi/OMP.
    let lines: string[];
    let usingFallback = false;
    try {
      lines = super.render(width);
    } catch (err) {
      usingFallback = true;
      if (!WorkflowEditor.warnedRenderFallback) {
        WorkflowEditor.warnedRenderFallback = true;
        console.warn(
          "[pi-dynamic-workflows] WorkflowEditor: base editor render() threw; degrading to a minimal, unstyled " +
            "rendering so the app doesn't crash. Workflows-mode highlighting will be unavailable this session. " +
            `Original error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)} ` +
            "Please report this at https://github.com/QuintinShaw/pi-dynamic-workflows/issues/72.",
        );
      }
      lines = this.safeFallbackLines(width);
    }

    // Keep the shared state current even for non-keystroke changes (history
    // recall, programmatic setText) so the submit hook reads the right value.
    // Guarded: this bookkeeping must never itself throw — including against
    // the fallback lines above — or a broken host would still crash the app.
    try {
      this.syncState();
      this.reconcileAnimation();
    } catch {
      // Best-effort; rendering must proceed even if bookkeeping fails.
    }

    let active = false;
    try {
      active = this.isActive();
    } catch {
      active = false;
    }
    if (usingFallback || !active || lines.length === 0) return lines;

    try {
      // First and last lines are the editor's horizontal borders; only the text
      // lines in between are colorized.
      return lines.map((ln, i) =>
        i === 0 || i === lines.length - 1
          ? ln
          : colorizeWorkflow(ln, this.tick, RAINBOW, this.modeState.keywordTriggerWord),
      );
    } catch {
      // Colorizing is cosmetic; never let it turn a working render into a crash.
      return lines;
    }
  }

  /** Emitted at most once per process so a broken host doesn't spam the log every render. */
  private static warnedRenderFallback = false;

  /**
   * Minimal, defensive rendering used only when the base editor's render()
   * throws (see issue #72). Deliberately avoids calling any other overridden
   * or state-dependent method that might share the same broken internal
   * state; falls back to an empty array if even plain text access fails.
   * Not pretty (no borders, no wrapping beyond a hard slice) — the goal is
   * "the app still launches", not "the editor still looks nice".
   */
  private safeFallbackLines(width: number): string[] {
    try {
      const text = this.getText();
      const raw = text.length > 0 ? text.split("\n") : [""];
      const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
      return raw.map((line) => (line.length > safeWidth ? line.slice(0, safeWidth) : line));
    } catch {
      return [];
    }
  }

  /** Absolute text before the cursor, used to detect "right after the word". */
  private cursorAfterTrigger(): boolean {
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const before = lines.slice(0, line).join("\n") + (line > 0 ? "\n" : "") + (lines[line] ?? "").slice(0, col);
    return endsWithTrigger(before, this.modeState.keywordTriggerWord);
  }

  private syncState(): void {
    this.modeState.active = this.isActive();
  }

  private reconcileAnimation(): void {
    const shouldRun = this.isActive() && this.focused;
    if (shouldRun && !this.timer) {
      this.timer = setInterval(() => {
        this.tick = (this.tick + 1) % (RAINBOW.length * 6);
        this.hostTui.requestRender();
      }, 90);
      // Don't keep the process alive for the animation.
      (this.timer as { unref?: () => void }).unref?.();
    } else if (!shouldRun && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * The directive appended to a submitted message when workflows mode is armed.
 * `extraDirective` (e.g. an effort-tier nudge) is appended when present.
 */
export function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string {
  const lines = [
    text,
    "",
    "---",
    "[workflows mode is ON for this message]",
    "You MUST handle this request by calling the tool named exactly `workflow` (Pi's",
    "deterministic JavaScript workflow-orchestration tool from pi-dynamic-workflows).",
    "Write a workflow script that fans the task out across subagents via",
    "agent()/parallel()/pipeline().",
    "",
    "The ONLY acceptable action is a `workflow` tool call. Do NOT instead:",
    "- answer directly or in prose,",
    "- call the `subagent` tool yourself,",
    "- use any skill or command (e.g. pi-subagents, /code-review, deep-research),",
    '- or interpret the word "workflow/workflows" loosely as some other parallel/audit approach.',
    "Even for a small task, wrap it in a minimal `workflow` call with at least one agent().",
  ];
  if (extraDirective) lines.push("", extraDirective);
  return lines.join("\n");
}

/**
 * Install the workflows-mode editor and the submit-time forcing hook.
 * Call once with the UI context (e.g. in `session_start`).
 */
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
 * Register the bottom progress-panel preference commands:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress-max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export function registerWorkflowProgressCommands(
  pi: ExtensionAPI,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-progress", {
    description: "Bottom progress panel: compact | detailed | status",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      if (arg === "compact" || arg === "detailed") {
        const saved = persistProgressSettings(settingsStore, { progressPanelMode: arg });
        await say(
          saved
            ? `Workflow progress panel set to ${arg} — takes effect on the next render of a live run (no restart needed).`
            : `Workflow progress panel set to ${arg} for this session, but the preference could not be saved.`,
        );
        return;
      }
      await say(
        `Workflow progress panel is ${loadProgressMode(settingsStore)}. Usage: /workflows-progress compact | detailed | status`,
      );
    },
  });

  pi.registerCommand?.("workflows-progress-max", {
    description: "Max agents shown per phase in detailed progress mode (1-1000)",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      if (!arg) {
        await say(
          `Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress-max <1-1000>`,
        );
        return;
      }
      const n = Number.parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 1) {
        await say(`Invalid value "${arg}". Usage: /workflows-progress-max <1-1000> (a whole number ≥ 1).`);
        return;
      }
      const clamped = Math.min(1000, n);
      const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
      await say(
        saved
          ? `Detailed progress now shows up to ${clamped} agents per phase.`
          : `Set to ${clamped} for this session, but the preference could not be saved.`,
      );
    },
  });
}

export function installWorkflowEditor(
  pi: ExtensionAPI,
  ui: ExtensionUIContext,
  effort?: EffortState,
  options: InstallWorkflowEditorOptions = {},
): WorkflowModeState {
  const settingsStore = options.settingsStore ?? DEFAULT_SETTINGS_STORE;
  const initialSettings = loadInitialWorkflowSettings(settingsStore);
  const state: WorkflowModeState = {
    active: false,
    keywordTriggerEnabled: initialSettings.keywordTriggerEnabled ?? true,
    keywordTriggerWord: initialSettings.keywordTriggerWord ?? DEFAULT_KEYWORD_TRIGGER_WORD,
  };

  if (!ui.getEditorComponent?.()) {
    ui.setEditorComponent((tui, theme, keybindings) => new WorkflowEditor(tui, theme, keybindings, state));
  }
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
      // Tool restriction is best-effort; the directive still forces the workflow.
    }
    const extra = byEffort && effort ? effortDirective(effort.level) : undefined;
    return { action: "transform", text: buildForcedWorkflowPrompt(event.text, extra) } as const;
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
