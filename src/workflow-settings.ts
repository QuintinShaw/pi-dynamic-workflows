/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MAX_AGENT_RETRIES, MAX_CONCURRENCY, normalizeKeywordTriggerWord, WORKFLOW_SETTINGS_FILE } from "./config.js";
import { workflowHomeDir, workflowProjectPaths } from "./workflow-paths.js";

export interface WorkflowSettings {
  keywordTriggerEnabled?: boolean;
  /** Literal keyword that arms workflows mode from interactive input. */
  keywordTriggerWord?: string;
  /**
   * Initial in-memory orchestration effort for a fresh Pi session. Omitted
   * (the default) is "off"; slash commands never write this preference.
   */
  defaultEffort?: "off" | "high" | "ultra";
  defaultAgentTimeoutMs?: number | null;
  /**
   * Default hard token budget applied to runs that don't pass their own
   * `tokenBudget` (#68). null explicitly means "no budget" (useful in a
   * project override to cancel a global budget); omitted also means no budget.
   */
  defaultTokenBudget?: number | null;
  /** Default max concurrent agents per run. Clamped to the runtime maximum. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Bottom task-panel display mode: "compact" (default, one line per run) | "detailed". */
  progressPanelMode?: "compact" | "detailed";
  /** Max agents shown per phase in detailed progress mode (default 8). */
  progressPanelMaxAgents?: number;
  /**
   * Persist each workflow subagent transcript as a real pi session file under
   * the standard sessions directory (~/.pi/agent/sessions/<encoded-cwd>/),
   * keyed by the project cwd. Default false: subagent sessions stay in-memory
   * and only the compacted history embedded in the run JSON survives.
   */
  persistAgentSessions?: boolean;
  /**
   * Route UNTAGGED agent() calls (no `model`, no `tier`) to the orchestrating
   * session's main model instead of the implicit medium tier (when
   * configured) or the settings default. Default false (legacy routing).
   * Explicit `model`/`tier` tags are unaffected. Applies when the session has
   * a main model; with none set, legacy routing applies. The inherited model
   * is the main model in effect when the RUN starts; a mid-run /model switch
   * applies to subsequent runs. An unavailable inherited model degrades to
   * the settings default with a run-visible warning instead of throwing.
   */
  inheritMainModel?: boolean;
  /**
   * Character cap on a delivered background-run result's JSON-dump fallback
   * before truncation (default 400). String results and `verdict`/`report`/
   * `summary`/`synthesis` fields are never truncated.
   */
  deliveredResultMaxChars?: number;
  /**
   * Extra tool names to deny in workflow subagent sessions, on top of the
   * always-on `workflow`/`workflow_control` defaults (#107). Use it to block
   * other recursive-orchestration tools you have installed (e.g. a pi-subagents
   * tool) so a subagent can't fan out through them.
   */
  excludeSubagentTools?: string[];
  /**
   * Trusted provider/auth middleware extension names allowed in child sessions.
   * Omitted or [] loads no host extensions. Recursive workflow/subagent
   * extensions are always excluded.
   */
  providerMiddlewareExtensions?: string[];
}

export interface WorkflowSettingsStore {
  load(): WorkflowSettings;
  save(settings: WorkflowSettings): void;
}

export interface WorkflowSettingsOptions {
  /** Explicit settings path, primarily for tests and migrations. */
  settingsPath?: string;
  /** Project cwd whose project-level settings should override global settings. */
  cwd?: string;
  /** Explicit project settings path, primarily for tests. */
  projectSettingsPath?: string;
  /** Explicit project-local (in-repo) settings path, primarily for tests. */
  projectLocalSettingsPath?: string;
  /** Save destination when using saveWorkflowSettings with cwd. Default: global. */
  scope?: "global" | "project";
}

/** Path to the user-level workflow settings JSON file (~/.pi/workflows/settings.json). */
export function getWorkflowSettingsPath(): string {
  return join(workflowHomeDir(), "settings.json");
}

/** Path to this project's optional workflow settings override. */
export function getWorkflowProjectSettingsPath(cwd: string): string {
  return workflowProjectPaths(cwd).settingsPath;
}

/**
 * Path to the project-local (in-repo) workflow settings file
 * (`<cwd>/.pi/workflows/settings.json`). Lets a repository or its tooling ship
 * workflow defaults with the project, the same way project-local
 * `.pi/workflows/saved/` ships saved workflows.
 */
export function getProjectLocalWorkflowSettingsPath(cwd: string): string {
  return resolve(cwd, WORKFLOW_SETTINGS_FILE);
}

/**
 * Load settings from disk. Missing, corrupt, or invalid files resolve to {}.
 * Precedence when a cwd is provided (later wins): global user settings, then
 * the project-local in-repo file (`<cwd>/.pi/workflows/settings.json`), then
 * the per-project override under `~/.pi/workflows/projects/<key>/` — so a
 * repo can ship defaults while a user's own project override still wins.
 */
export function loadWorkflowSettings(settingsPathOrOptions?: string | WorkflowSettingsOptions): WorkflowSettings {
  const options = normalizeOptions(settingsPathOrOptions);
  const globalSettings = readSettings(options.settingsPath ?? getWorkflowSettingsPath());
  const projectLocalPath =
    options.projectLocalSettingsPath ?? (options.cwd ? getProjectLocalWorkflowSettingsPath(options.cwd) : undefined);
  const projectPath =
    options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
  return {
    ...globalSettings,
    ...(projectLocalPath ? readSettings(projectLocalPath) : {}),
    ...(projectPath ? readSettings(projectPath) : {}),
  };
}

/** Merge known settings into the user-level settings file. */
export function saveWorkflowSettings(
  settings: WorkflowSettings,
  settingsPathOrOptions?: string | WorkflowSettingsOptions,
): void {
  const options = normalizeOptions(settingsPathOrOptions);
  const projectPath =
    options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
  const path =
    options.scope === "project" && projectPath ? projectPath : (options.settingsPath ?? getWorkflowSettingsPath());
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = readObject(path);
  writeFileSync(path, `${JSON.stringify({ ...existing, ...normalizeSettings(settings) }, null, 2)}\n`, "utf-8");
}

/** Save a global preference and update an existing project override if one is present. */
export function saveWorkflowSettingsForCwd(settings: WorkflowSettings, cwd: string): void {
  saveWorkflowSettings(settings);
  const projectPath = getWorkflowProjectSettingsPath(cwd);
  if (existsSync(projectPath)) {
    saveWorkflowSettings(settings, { projectSettingsPath: projectPath, scope: "project" });
  }
}

function normalizeOptions(settingsPathOrOptions?: string | WorkflowSettingsOptions): WorkflowSettingsOptions {
  return typeof settingsPathOrOptions === "string"
    ? { settingsPath: settingsPathOrOptions }
    : (settingsPathOrOptions ?? {});
}

function readSettings(path: string): WorkflowSettings {
  if (!existsSync(path)) return {};
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

function normalizeSettings(value: unknown): WorkflowSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const settings: WorkflowSettings = {};
  if (typeof raw.keywordTriggerEnabled === "boolean") {
    settings.keywordTriggerEnabled = raw.keywordTriggerEnabled;
  }
  const keywordTriggerWord = normalizeKeywordTriggerWord(raw.keywordTriggerWord);
  if (keywordTriggerWord !== undefined) settings.keywordTriggerWord = keywordTriggerWord;
  if (raw.defaultEffort === "off" || raw.defaultEffort === "high" || raw.defaultEffort === "ultra") {
    settings.defaultEffort = raw.defaultEffort;
  }
  if (raw.defaultAgentTimeoutMs === null) {
    settings.defaultAgentTimeoutMs = null;
  } else if (
    typeof raw.defaultAgentTimeoutMs === "number" &&
    Number.isFinite(raw.defaultAgentTimeoutMs) &&
    raw.defaultAgentTimeoutMs > 0
  ) {
    settings.defaultAgentTimeoutMs = raw.defaultAgentTimeoutMs;
  }
  if (raw.defaultTokenBudget === null) {
    settings.defaultTokenBudget = null;
  } else {
    const defaultTokenBudget = normalizeInteger(raw.defaultTokenBudget, 1, Number.MAX_SAFE_INTEGER);
    if (defaultTokenBudget !== undefined) settings.defaultTokenBudget = defaultTokenBudget;
  }
  const defaultConcurrency = normalizeInteger(raw.defaultConcurrency, 1, MAX_CONCURRENCY);
  if (defaultConcurrency !== undefined) settings.defaultConcurrency = defaultConcurrency;
  const defaultAgentRetries = normalizeInteger(raw.defaultAgentRetries, 0, MAX_AGENT_RETRIES);
  if (defaultAgentRetries !== undefined) settings.defaultAgentRetries = defaultAgentRetries;
  if (raw.progressPanelMode === "compact" || raw.progressPanelMode === "detailed") {
    settings.progressPanelMode = raw.progressPanelMode;
  }
  if (
    typeof raw.progressPanelMaxAgents === "number" &&
    Number.isFinite(raw.progressPanelMaxAgents) &&
    raw.progressPanelMaxAgents >= 1
  ) {
    settings.progressPanelMaxAgents = Math.min(1000, Math.floor(raw.progressPanelMaxAgents));
  }
  if (typeof raw.persistAgentSessions === "boolean") {
    settings.persistAgentSessions = raw.persistAgentSessions;
  }
  if (typeof raw.inheritMainModel === "boolean") {
    settings.inheritMainModel = raw.inheritMainModel;
  }
  const deliveredResultMaxChars = normalizeInteger(raw.deliveredResultMaxChars, 1, 1_000_000);
  if (deliveredResultMaxChars !== undefined) settings.deliveredResultMaxChars = deliveredResultMaxChars;
  if (Array.isArray(raw.excludeSubagentTools)) {
    const names = raw.excludeSubagentTools.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (names.length) settings.excludeSubagentTools = names;
  }
  if (Array.isArray(raw.providerMiddlewareExtensions)) {
    settings.providerMiddlewareExtensions = raw.providerMiddlewareExtensions
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      .map((name) => name.trim());
  }
  return settings;
}

function normalizeInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return undefined;
  return Math.min(max, Math.floor(value));
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
