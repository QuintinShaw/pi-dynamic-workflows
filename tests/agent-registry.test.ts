import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  applyToolPolicy,
  listAgentTypes,
  loadAgentRegistry,
  parseAgentDefinition,
  resolveAgentType,
} from "../src/agent-registry.js";
import { runWorkflow } from "../src/workflow.js";

// ── parseAgentDefinition ───────────────────────────────────────────────────

describe("parseAgentDefinition", () => {
  it("parses frontmatter (name/description/model/tools/disallowedTools) + body", () => {
    const md = [
      "---",
      "name: security-auditor",
      "description: Reviews code for vulnerabilities",
      "model: openai/gpt-4.1",
      "tools: [read, grep]",
      "disallowedTools:",
      "  - write",
      "  - bash",
      "---",
      "You are a security auditor. Be thorough.",
    ].join("\n");
    const def = parseAgentDefinition(md, "project", "security-auditor.md");
    assert.ok(def);
    assert.equal(def.name, "security-auditor");
    assert.equal(def.description, "Reviews code for vulnerabilities");
    assert.equal(def.model, "openai/gpt-4.1");
    assert.deepEqual(def.tools, ["read", "grep"]);
    assert.deepEqual(def.disallowedTools, ["write", "bash"]);
    assert.equal(def.prompt, "You are a security auditor. Be thorough.");
    assert.equal(def.source, "project");
  });

  it("derives name from filename when frontmatter has none", () => {
    const def = parseAgentDefinition("Just a body, no frontmatter.", "user", "reviewer.md");
    assert.ok(def);
    assert.equal(def.name, "reviewer");
    assert.equal(def.prompt, "Just a body, no frontmatter.");
    assert.equal(def.tools, undefined);
  });

  it("returns null when there is no name and no body", () => {
    assert.equal(parseAgentDefinition("", "project", ""), null);
  });

  it("ignores non-string array entries in tools", () => {
    const md = "---\nname: x\ntools: [read, 3, '', write]\n---\nbody";
    const def = parseAgentDefinition(md, "project", "x.md");
    assert.deepEqual(def?.tools, ["read", "write"]);
  });

  it("parses isolation: worktree from frontmatter", () => {
    const content = "---\nname: isolated-agent\nisolation: worktree\n---\nBody.";
    const def = parseAgentDefinition(content, "project", "isolated-agent.md");
    assert.ok(def);
    assert.equal(def.isolation, "worktree");
  });

  it("ignores unknown isolation values", () => {
    const content = "---\nname: agent\nisolation: unknown-value\n---\nBody.";
    const def = parseAgentDefinition(content, "project", "agent.md");
    assert.ok(def);
    assert.equal(def.isolation, undefined);
  });
});

// ── loadAgentRegistry (dir injection) ──────────────────────────────────────

describe("loadAgentRegistry", () => {
  function writeDef(dir: string, file: string, content: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), content, "utf-8");
  }

  it("loads project + user defs; project wins on a name collision", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-"));
    const projectDir = join(root, "project");
    const userDir = join(root, "user");
    writeDef(projectDir, "reviewer.md", "---\nname: reviewer\nmodel: project/model\n---\nproject body");
    writeDef(userDir, "reviewer.md", "---\nname: reviewer\nmodel: user/model\n---\nuser body");
    writeDef(userDir, "researcher.md", "---\nname: researcher\n---\nuser-only researcher");

    const reg = loadAgentRegistry(root, { projectDir, userDir, legacyUserDir: join(root, "legacy-none") });
    assert.equal(reg.size, 2);
    assert.equal(reg.get("reviewer")?.model, "project/model", "project def wins");
    assert.equal(reg.get("reviewer")?.source, "project");
    assert.equal(reg.get("researcher")?.source, "user");
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty registry when no dirs exist", () => {
    const reg = loadAgentRegistry("/nonexistent", {
      projectDir: "/nonexistent/a",
      userDir: "/nonexistent/b",
      legacyUserDir: "/nonexistent/c",
    });
    assert.equal(reg.size, 0);
  });

  it("skips non-.md files and survives an unreadable file", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-"));
    const projectDir = join(root, "p");
    writeDef(projectDir, "ok.md", "---\nname: ok\n---\nbody");
    writeDef(projectDir, "notes.txt", "ignored");
    const reg = loadAgentRegistry(root, {
      projectDir,
      userDir: join(root, "none"),
      legacyUserDir: join(root, "legacy-none"),
    });
    assert.deepEqual([...reg.keys()], ["ok"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("comma-separated tools/disallowedTools string form parses like the YAML list form", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-"));
    const projectDir = join(root, "p");
    writeDef(
      projectDir,
      "scout.md",
      ["---", "name: scout", "tools: read, grep, find", "disallowedTools: write, bash", "---", "Scout body."].join(
        "\n",
      ),
    );
    const reg = loadAgentRegistry(root, {
      projectDir,
      userDir: join(root, "none"),
      legacyUserDir: join(root, "legacy-none"),
    });
    assert.deepEqual(reg.get("scout")?.tools, ["read", "grep", "find"]);
    assert.deepEqual(reg.get("scout")?.disallowedTools, ["write", "bash"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("default userDir resolution uses getAgentDir() (~/.pi/agent/agents) with no injected opts", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "pi-home-"));
    const originalHome = process.env.HOME;
    const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpHome;
    try {
      const expectedUserDir = join(getAgentDir(), "agents");
      assert.equal(expectedUserDir, join(tmpHome, ".pi", "agent", "agents"), "sanity: HOME override took effect");
      writeDef(expectedUserDir, "scout.md", "---\nname: scout\n---\nUser-level scout.");

      const cwd = mkdtempSync(join(tmpdir(), "pi-cwd-"));
      const reg = loadAgentRegistry(cwd);
      assert.equal(reg.get("scout")?.source, "user");
      assert.equal(reg.get("scout")?.prompt, "User-level scout.");
      rmSync(cwd, { recursive: true, force: true });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── loadAgentRegistry dual-scan: new location + deprecated legacy fallback ──

describe("loadAgentRegistry legacy ~/.pi/agents fallback", () => {
  function writeDef(dir: string, file: string, content: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), content, "utf-8");
  }

  function withCapturedWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const result = fn();
      return { result, warnings };
    } finally {
      console.warn = originalWarn;
    }
  }

  it("resolves a definition that exists only in the legacy location and warns once", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-legacy-"));
    const legacyUserDir = join(root, "legacy-user");
    writeDef(legacyUserDir, "scout.md", "---\nname: scout\ntools: read, grep\n---\nLegacy scout.");
    writeDef(legacyUserDir, "other.md", "---\nname: other\n---\nAnother legacy agent.");

    const { result: reg, warnings } = withCapturedWarnings(() =>
      loadAgentRegistry(root, {
        projectDir: join(root, "project-none"),
        userDir: join(root, "user-none"),
        legacyUserDir,
      }),
    );

    assert.equal(reg.get("scout")?.source, "user");
    assert.equal(reg.get("scout")?.prompt, "Legacy scout.");
    assert.deepEqual(reg.get("scout")?.tools, ["read", "grep"]);
    assert.ok(reg.get("other"), "second legacy-only def also resolves");
    assert.equal(warnings.length, 1, "exactly one deprecation warning, not one per legacy file");
    assert.match(warnings[0], /deprecated/i);
    assert.match(warnings[0], new RegExp(legacyUserDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    rmSync(root, { recursive: true, force: true });
  });

  it("a new-location definition shadows a same-named legacy definition and suppresses its warning", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-legacy-"));
    const userDir = join(root, "user");
    const legacyUserDir = join(root, "legacy-user");
    writeDef(userDir, "scout.md", "---\nname: scout\nmodel: new/model\n---\nNew scout.");
    writeDef(legacyUserDir, "scout.md", "---\nname: scout\nmodel: old/model\n---\nOld scout.");

    const { result: reg, warnings } = withCapturedWarnings(() =>
      loadAgentRegistry(root, {
        projectDir: join(root, "project-none"),
        userDir,
        legacyUserDir,
      }),
    );

    assert.equal(reg.size, 1);
    assert.equal(reg.get("scout")?.model, "new/model", "new location wins over legacy");
    assert.equal(reg.get("scout")?.prompt, "New scout.");
    assert.equal(warnings.length, 0, "no deprecation warning when the legacy file is fully shadowed");
    rmSync(root, { recursive: true, force: true });
  });

  it("mixes new and legacy-only names: new wins on collision, legacy fills the rest, one warning", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-legacy-"));
    const userDir = join(root, "user");
    const legacyUserDir = join(root, "legacy-user");
    writeDef(userDir, "scout.md", "---\nname: scout\nmodel: new/model\n---\nNew scout.");
    writeDef(legacyUserDir, "scout.md", "---\nname: scout\nmodel: old/model\n---\nOld scout.");
    writeDef(legacyUserDir, "researcher.md", "---\nname: researcher\n---\nLegacy-only researcher.");

    const { result: reg, warnings } = withCapturedWarnings(() =>
      loadAgentRegistry(root, {
        projectDir: join(root, "project-none"),
        userDir,
        legacyUserDir,
      }),
    );

    assert.equal(reg.size, 2);
    assert.equal(reg.get("scout")?.model, "new/model");
    assert.equal(reg.get("researcher")?.source, "user");
    assert.equal(warnings.length, 1, "warns once for the researcher-only legacy resolution");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("resolveAgentType / listAgentTypes", () => {
  const reg: AgentRegistry = new Map([
    ["a", { name: "a", description: "A agent", prompt: "be a", source: "project" } as AgentDefinition],
  ]);
  it("resolves a known name and returns undefined otherwise", () => {
    assert.equal(resolveAgentType("a", reg)?.name, "a");
    assert.equal(resolveAgentType("missing", reg), undefined);
    assert.equal(resolveAgentType(undefined, reg), undefined);
  });
  it("lists names + descriptions", () => {
    assert.deepEqual(listAgentTypes(reg), [{ name: "a", description: "A agent" }]);
  });
});

// ── applyToolPolicy ────────────────────────────────────────────────────────

describe("applyToolPolicy", () => {
  const tools = [{ name: "read" }, { name: "write" }, { name: "bash" }, { name: "edit" }];
  it("returns all tools when no policy", () => {
    assert.deepEqual(
      applyToolPolicy(tools).map((t) => t.name),
      ["read", "write", "bash", "edit"],
    );
  });
  it("keeps only the allowlist", () => {
    assert.deepEqual(
      applyToolPolicy(tools, ["read", "grep"]).map((t) => t.name),
      ["read"],
    );
  });
  it("removes the denylist", () => {
    assert.deepEqual(
      applyToolPolicy(tools, undefined, ["write", "bash"]).map((t) => t.name),
      ["read", "edit"],
    );
  });
  it("applies allowlist then denylist", () => {
    assert.deepEqual(
      applyToolPolicy(tools, ["read", "write"], ["write"]).map((t) => t.name),
      ["read"],
    );
  });
});

describe("agentDefinitionKey", () => {
  it("is null for undefined and stable for the same def", () => {
    assert.equal(agentDefinitionKey(undefined), null);
    const def: AgentDefinition = { name: "x", prompt: "p", tools: ["read"], source: "project" };
    assert.equal(
      agentDefinitionKey(def),
      agentDefinitionKey({ ...def, source: "user" }),
      "source is not part of identity",
    );
  });
  it("changes when tools/model/prompt change", () => {
    const base: AgentDefinition = { name: "x", prompt: "p", model: "m", tools: ["read"], source: "project" };
    assert.notEqual(agentDefinitionKey(base), agentDefinitionKey({ ...base, prompt: "p2" }));
    assert.notEqual(agentDefinitionKey(base), agentDefinitionKey({ ...base, model: "m2" }));
    assert.notEqual(agentDefinitionKey(base), agentDefinitionKey({ ...base, tools: ["read", "write"] }));
  });

  it("changes when isolation changes", () => {
    const base: AgentDefinition = { name: "x", prompt: "p", source: "project" };
    assert.notEqual(agentDefinitionKey(base), agentDefinitionKey({ ...base, isolation: "worktree" }));
  });
});

// ── runtime integration: agentType binds tools/model/prompt via runWorkflow ──

function capturingAgent() {
  const seen: Array<{
    model?: string;
    tier?: string;
    toolNames?: string[];
    disallowedToolNames?: string[];
    instructions?: string;
    cwd?: string;
    cwdExists?: boolean;
  }> = [];
  const runner = {
    async run(_prompt: string, options: Record<string, unknown>) {
      seen.push({
        model: options.model as string | undefined,
        tier: options.tier as string | undefined,
        toolNames: options.toolNames as string[] | undefined,
        disallowedToolNames: options.disallowedToolNames as string[] | undefined,
        instructions: options.instructions as string | undefined,
        cwd: options.cwd as string | undefined,
        cwdExists: typeof options.cwd === "string" ? existsSync(options.cwd) : undefined,
      });
      return "ok";
    },
  };
  return { seen, runner };
}

const registry: AgentRegistry = new Map([
  [
    "security-auditor",
    {
      name: "security-auditor",
      description: "sec",
      model: "vendor/auditor-model",
      tools: ["read", "grep"],
      disallowedTools: ["write", "bash"],
      prompt: "You are a security auditor.",
      source: "project",
    } as AgentDefinition,
  ],
]);

describe("agentType binding through runWorkflow", () => {
  it("binds tools, model, and the body prompt for a known agentType", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
const r = await agent('audit', { label: 'a', agentType: 'security-auditor' })
return r`;
    await runWorkflow(script, { agent: runner, persistLogs: false, agentRegistry: registry });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, "vendor/auditor-model", "agentType model is applied");
    assert.deepEqual(seen[0].toolNames, ["read", "grep"], "allowlist forwarded");
    assert.deepEqual(seen[0].disallowedToolNames, ["write", "bash"], "denylist forwarded");
    assert.ok(seen[0].instructions?.includes("You are a security auditor."), "body prompt injected");
  });

  it("explicit opts.model beats the agentType model", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
await agent('audit', { label: 'a', agentType: 'security-auditor', model: 'explicit/model' })
return {}`;
    await runWorkflow(script, { agent: runner, persistLogs: false, agentRegistry: registry });
    assert.equal(seen[0].model, "explicit/model");
  });

  it("agentType model beats a tier (model passed, tier still forwarded)", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
await agent('audit', { label: 'a', agentType: 'security-auditor', tier: 'small' })
return {}`;
    await runWorkflow(script, { agent: runner, persistLogs: false, agentRegistry: registry });
    assert.equal(seen[0].model, "vendor/auditor-model", "definition model wins over tier");
  });

  it("agentType isolation: worktree runs the agent in an isolated cwd", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-agent-isolation-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      const isolatedRegistry: AgentRegistry = new Map([
        [
          "isolated-auditor",
          {
            name: "isolated-auditor",
            prompt: "Run isolated.",
            isolation: "worktree",
            source: "project",
          } as AgentDefinition,
        ],
      ]);
      const { seen, runner } = capturingAgent();
      const script = `export const meta = { name: 'isolated', description: 'agentType isolation' }
await agent('audit', { label: 'a', agentType: 'isolated-auditor' })
return {}`;

      await runWorkflow(script, {
        cwd: repo,
        runId: "iso-test",
        agent: runner,
        persistLogs: false,
        agentRegistry: isolatedRegistry,
      });

      assert.equal(seen.length, 1);
      assert.ok(seen[0].cwd, "isolated agent should receive a cwd");
      assert.notEqual(seen[0].cwd, repo, "agent cwd should not be the base repo");
      assert.equal(seen[0].cwdExists, true, "worktree cwd should exist while the agent runs");
      assert.ok(seen[0].instructions?.includes("Requested isolation: worktree"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("unknown agentType logs a fallback and binds no tools/model", async () => {
    const { seen, runner } = capturingAgent();
    const logs: string[] = [];
    const script = `export const meta = { name: 'at', description: 'agentType' }
await agent('do it', { label: 'a', agentType: 'nope' })
return {}`;
    await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      agentRegistry: registry,
      onLog: (m) => logs.push(m),
    });
    assert.equal(seen[0].model, undefined, "no model bound");
    assert.equal(seen[0].toolNames, undefined, "no tool allowlist bound");
    assert.ok(seen[0].instructions?.includes("nope"), "falls back to the prose hint");
    assert.ok(
      logs.some((l) => /unknown agentType/i.test(l)),
      "warns about the unknown agentType",
    );
  });

  it("editing a definition invalidates the resume cache for that call", async () => {
    // First run journals the call under the original definition's hash.
    const journal: import("../src/workflow.js").JournalEntry[] = [];
    const first = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
const r = await agent('audit', { label: 'a', agentType: 'security-auditor' })
return r`;
    await runWorkflow(script, {
      agent: first.runner,
      persistLogs: false,
      agentRegistry: registry,
      onAgentJournal: (e) => journal.push(e),
    });
    assert.equal(first.seen.length, 1);

    // Resume with an EDITED definition (different model) → cache must miss → re-run.
    const securityAuditor = registry.get("security-auditor");
    assert.ok(securityAuditor, "security-auditor definition should be loaded");
    const editedRegistry: AgentRegistry = new Map([
      ["security-auditor", { ...securityAuditor, model: "vendor/changed-model" }],
    ]);
    const second = capturingAgent();
    await runWorkflow(script, {
      agent: second.runner,
      persistLogs: false,
      agentRegistry: editedRegistry,
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.equal(second.seen.length, 1, "edited definition busts the cache and re-runs live");
    assert.equal(second.seen[0].model, "vendor/changed-model");
  });

  it("resume cache HITS when the definition is unchanged", async () => {
    const journal: import("../src/workflow.js").JournalEntry[] = [];
    const first = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
const r = await agent('audit', { label: 'a', agentType: 'security-auditor' })
return r`;
    await runWorkflow(script, {
      agent: first.runner,
      persistLogs: false,
      agentRegistry: registry,
      onAgentJournal: (e) => journal.push(e),
    });
    const second = capturingAgent();
    await runWorkflow(script, {
      agent: second.runner,
      persistLogs: false,
      agentRegistry: registry,
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.equal(second.seen.length, 0, "unchanged definition → cache hit → no live run");
  });
});
