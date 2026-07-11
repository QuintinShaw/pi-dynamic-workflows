/**
 * Named workflow subagent definitions ("agentType" registry).
 *
 * A workflow script can route an agent() call to a reusable, named definition:
 *
 *   agent("audit this dir", { agentType: "security-auditor" })
 *
 * Definitions live as Markdown files under `.pi/agents/*.md` (project, cwd-relative)
 * and `~/.pi/agent/agents/*.md` (user — `getAgentDir() + "agents"`, honoring the
 * `PI_CODING_AGENT_DIR` override), matching pi-coding-agent's own built-in agent
 * discovery convention. The legacy `~/.pi/agents/*.md` location is still scanned as
 * a deprecated fallback (with a one-time warning) so users who followed this repo's
 * earlier docs are not silently broken; the new location wins on a name collision.
 * Frontmatter binds the subagent's tools, model, and a body prompt; project
 * definitions win over both user-level locations on a name collision. This mirrors
 * Claude Code's `.claude/agents` registry: agentType is a real binding of
 * tools+model+system-prompt, not a prose hint.
 *
 * Bound today: `tools` (allowlist), `disallowedTools` (denylist), `model`,
 * and the markdown body (`prompt`). Parsed-but-ignored for now (documented): `mcp`, `skills`, `background`.
 * Wired: `isolation` ("worktree") → createWorktree() in workflow.ts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AGENTS_DIR } from "./config.js";

export interface AgentDefinition {
  /** Stable identity used as the `agentType` value. */
  name: string;
  /** One-line summary (for discoverability in the tool guideline). */
  description?: string;
  /** Allowlist of coding-tool names the subagent may use. Undefined = all. */
  tools?: string[];
  /** Denylist of coding-tool names, applied after the allowlist. */
  disallowedTools?: string[];
  /** Model spec (`provider/modelId` or bare id) for this subagent. */
  model?: string;
  /** Isolation mode. When "worktree", agents using this type run in a git worktree. */
  isolation?: "worktree";
  /** Markdown body, prepended to the subagent's task as role guidance. */
  prompt: string;
  /** Where the definition was loaded from (project wins over user). */
  source: "project" | "user";
}

export type AgentRegistry = Map<string, AgentDefinition>;

function toStringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  // YAML list form: ["read", "grep"]
  if (Array.isArray(value)) {
    const arr = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
    return arr.length ? arr : undefined;
  }
  // Comma-separated string form: "read, grep, find" — the form pi-coding-agent's
  // parseFrontmatter returns and the form the official subagent example uses.
  if (typeof value === "string" && value.trim().length > 0) {
    const arr = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

/**
 * Parse one agent-definition markdown file. Returns null only when there is no
 * usable content (no name derivable and an empty body).
 */
export function parseAgentDefinition(
  content: string,
  source: "project" | "user",
  fileName: string,
): AgentDefinition | null {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(content);
  } catch {
    // Malformed frontmatter: treat the whole file as a body, name from filename.
    parsed = { frontmatter: {}, body: content };
  }
  const fm = parsed.frontmatter;
  const fmName = typeof fm.name === "string" ? fm.name.trim() : "";
  const name = fmName || basename(fileName).replace(/\.md$/i, "").trim();
  const prompt = parsed.body.trim();
  if (!name && !prompt) return null;

  return {
    name,
    description: typeof fm.description === "string" ? fm.description.trim() || undefined : undefined,
    tools: toStringArray(fm.tools),
    disallowedTools: toStringArray(fm.disallowedTools),
    model: typeof fm.model === "string" ? fm.model.trim() || undefined : undefined,
    isolation:
      typeof fm.isolation === "string" && fm.isolation.toLowerCase().trim() === "worktree" ? "worktree" : undefined,
    prompt,
    source,
  };
}

function readDefsFromDir(dir: string, source: "project" | "user"): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  const defs: AgentDefinition[] = [];
  for (const file of files.sort()) {
    try {
      const def = parseAgentDefinition(readFileSync(join(dir, file), "utf-8"), source, file);
      if (def) defs.push(def);
    } catch {
      // Skip unreadable/invalid files; never let one bad file break the registry.
    }
  }
  return defs;
}

/**
 * Load the agent registry once for a run. Scans the project dir, then the
 * user dir, then — as a deprecated fallback — the legacy user dir; the FIRST
 * definition for a name wins (project > user > legacy user, then filename
 * order), so a name collision is resolved deterministically and silently.
 *
 * When a definition is only found at the legacy location (not shadowed by
 * the new user dir), a single deprecation warning is logged for this call
 * telling the user to move their files — not one warning per legacy file.
 *
 * `opts` overrides the scanned directories (used by tests).
 */
export function loadAgentRegistry(
  cwd: string,
  opts?: { projectDir?: string; userDir?: string; legacyUserDir?: string },
): AgentRegistry {
  const projectDir = opts?.projectDir ?? join(cwd, AGENTS_DIR);
  // User-level definitions live under the agent dir (e.g. ~/.pi/agent/agents/),
  // matching the convention used by pi-coding-agent's built-in agent discovery
  // and the official subagent extension example. Reading getAgentDir() also
  // honors the PI_CODING_AGENT_DIR env override.
  const userDir = opts?.userDir ?? join(getAgentDir(), "agents");
  // Deprecated: this repo's docs used to point users at ~/.pi/agents/ before
  // pi-coding-agent's convention (~/.pi/agent/agents/) was known. Keep scanning
  // it as a fallback so those files don't silently stop resolving.
  const legacyUserDir = opts?.legacyUserDir ?? join(homedir(), AGENTS_DIR);

  const registry: AgentRegistry = new Map();
  for (const def of readDefsFromDir(projectDir, "project")) {
    if (def.name && !registry.has(def.name)) registry.set(def.name, def);
  }
  if (userDir !== projectDir) {
    for (const def of readDefsFromDir(userDir, "user")) {
      if (def.name && !registry.has(def.name)) registry.set(def.name, def);
    }
  }
  if (legacyUserDir !== projectDir && legacyUserDir !== userDir) {
    let warnedLegacy = false;
    for (const def of readDefsFromDir(legacyUserDir, "user")) {
      if (def.name && !registry.has(def.name)) {
        registry.set(def.name, def);
        if (!warnedLegacy) {
          console.warn(
            `[agent-registry] Loaded agent definition(s) from the deprecated location "${legacyUserDir}". ` +
              `Move them to "${userDir}" — the old location may stop being read in a future release.`,
          );
          warnedLegacy = true;
        }
      }
    }
  }
  return registry;
}

/** Resolve an agentType name to its definition, or undefined if not registered. */
export function resolveAgentType(name: string | undefined, registry: AgentRegistry): AgentDefinition | undefined {
  if (!name) return undefined;
  return registry.get(name);
}

/**
 * Apply a definition's tool policy to a tool list: keep only allowlisted names
 * (when an allowlist is given), then drop any denylisted names. Generic over any
 * object with a `name` so it is unit-testable without real ToolDefinitions.
 */
export function applyToolPolicy<T extends { name: string }>(tools: T[], allow?: string[], deny?: string[]): T[] {
  let out = tools;
  if (allow?.length) {
    const allowSet = new Set(allow);
    out = out.filter((t) => allowSet.has(t.name));
  }
  if (deny?.length) {
    const denySet = new Set(deny);
    out = out.filter((t) => !denySet.has(t.name));
  }
  return out;
}

/**
 * A stable identity string for a resolved definition, folded into the resume
 * call-hash so editing an agent `.md` invalidates that call's cached result.
 */
export function agentDefinitionKey(def: AgentDefinition | undefined): string | null {
  if (!def) return null;
  return JSON.stringify({
    tools: def.tools ?? null,
    disallowedTools: def.disallowedTools ?? null,
    model: def.model ?? null,
    isolation: def.isolation ?? null,
    prompt: def.prompt,
  });
}

/** List registered agent types for discoverability in the tool guideline. */
export function listAgentTypes(registry: AgentRegistry): Array<{ name: string; description?: string }> {
  return [...registry.values()].map((d) => ({ name: d.name, description: d.description }));
}
