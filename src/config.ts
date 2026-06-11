/**
 * Configuration constants for pi-dynamic-workflows.
 */

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/** Default timeout for a single agent in milliseconds (5 minutes). */
export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;

/** Default token budget if none specified. */
export const DEFAULT_TOKEN_BUDGET = null;

/** Directory for persisting workflow run state. */
export const WORKFLOW_RUNS_DIR = ".pi/workflows/runs";

/** Directory for saved workflow commands. */
export const WORKFLOW_SAVED_DIR = ".pi/workflows/saved";

/** User-level saved workflows directory. */
export const USER_WORKFLOW_SAVED_DIR = "~/.pi/workflows/saved";

/** User-level model tiers config file, relative to the home directory. */
export const MODEL_TIERS_FILE = ".pi/workflows/model-tiers.json";

/** User-level workflow extension settings file, relative to the home directory. */
export const WORKFLOW_SETTINGS_FILE = ".pi/workflows/settings.json";

/**
 * Named workflow subagent definitions directory. Resolved both project-relative
 * (cwd/.pi/agents) and home-relative (~/.pi/agents); project entries win on name
 * collision. Each `*.md` file is an agent definition (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".pi/agents";
