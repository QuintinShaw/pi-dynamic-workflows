import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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

    const reg = loadAgentRegistry(root, { projectDir, userDir });
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
    });
    assert.equal(reg.size, 0);
  });

  it("skips non-.md files and survives an unreadable file", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-"));
    const projectDir = join(root, "p");
    writeDef(projectDir, "ok.md", "---\nname: ok\n---\nbody");
    writeDef(projectDir, "notes.txt", "ignored");
    const reg = loadAgentRegistry(root, { projectDir, userDir: join(root, "none") });
    assert.deepEqual([...reg.keys()], ["ok"]);
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
