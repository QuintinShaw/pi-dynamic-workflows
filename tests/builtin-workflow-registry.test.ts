/**
 * Tests for the shared builtin-workflow registry (src/builtin-workflows.ts) —
 * the single resolution path the `/deep-research`-style slash commands
 * (builtin-commands.ts) and the `workflow` tool's `name` input
 * (workflow-tool.ts) both consult, so a pattern's generator script is written
 * exactly once and both entry points can never drift apart.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "../src/adversarial-review.js";
import {
  BUILTIN_WORKFLOW_NAMES,
  BUILTIN_WORKFLOWS,
  DEFAULT_MULTI_PERSPECTIVES,
  findBuiltinWorkflow,
  resolveWorkflowInvocation,
} from "../src/builtin-workflows.js";
import { generateCodeReviewWorkflow } from "../src/code-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "../src/deep-research.js";
import { parseWorkflowScript } from "../src/workflow.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";

/** Look up a built-in descriptor, failing the test clearly if the name is unknown. */
function requireBuiltin(name: string) {
  const found = findBuiltinWorkflow(name);
  assert.ok(found, `${name} should be a known built-in workflow`);
  return found;
}

function withTempCwd(fn: (cwd: string) => void) {
  return () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-registry-"));
    try {
      fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

// ─── Registry shape ─────────────────────────────────────────────────────────────

test("BUILTIN_WORKFLOW_NAMES lists exactly the 5 curated patterns", () => {
  assert.deepEqual([...BUILTIN_WORKFLOW_NAMES].sort(), [
    "adversarial-review",
    "code-review",
    "codebase-audit",
    "deep-research",
    "multi-perspective",
  ]);
});

test("findBuiltinWorkflow resolves each of the 5 names and rejects unknown names", () => {
  for (const name of BUILTIN_WORKFLOW_NAMES) {
    assert.ok(findBuiltinWorkflow(name), `${name} should be found`);
  }
  assert.equal(findBuiltinWorkflow("not-a-real-pattern"), undefined);
});

// ─── Per-pattern resolve() ──────────────────────────────────────────────────────

test(
  "deep-research resolve() produces the real generator script and the web-research exec context",
  withTempCwd((cwd) => {
    const invocation = requireBuiltin("deep-research").resolve(cwd, { question: "what is pi?" });
    assert.equal(invocation.script, generateDeepResearchWorkflow());
    assert.equal(invocation.toolset, "web-research");
    const tools = invocation.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, "should carry an explicit tool set");
    const toolNames = (tools ?? []).map((t) => t.name);
    assert.ok(
      toolNames.some((n) => /search|fetch|web/i.test(n)),
      `expected web tools among: ${toolNames.join(", ")}`,
    );
  }),
);

test("deep-research resolve() rejects a missing/blank question", () => {
  const resolve = requireBuiltin("deep-research").resolve;
  assert.throws(() => resolve("/tmp", {}), /question/);
  assert.throws(() => resolve("/tmp", { question: "   " }), /question/);
});

test("adversarial-review resolve() produces the real generator script with no special exec context", () => {
  const invocation = requireBuiltin("adversarial-review").resolve("/tmp", { task: "investigate this" });
  assert.equal(invocation.script, generateAdversarialReviewWorkflow());
  assert.equal(invocation.tools, undefined);
  assert.equal(invocation.toolset, undefined);
});

test("adversarial-review resolve() rejects a missing task", () => {
  assert.throws(() => requireBuiltin("adversarial-review").resolve("/tmp", {}), /task/);
});

test("code-review resolve() produces the real generator script and requires a diff", () => {
  const invocation = requireBuiltin("code-review").resolve("/tmp", { diff: "some diff", diffSource: "git diff" });
  assert.equal(invocation.script, generateCodeReviewWorkflow());
  assert.throws(() => requireBuiltin("code-review").resolve("/tmp", {}), /diff/);
  assert.throws(() => requireBuiltin("code-review").resolve("/tmp", { diff: "" }), /diff/);
});

test("multi-perspective resolve() bakes the given topic/perspectives into the same generator output", () => {
  const invocation = requireBuiltin("multi-perspective").resolve("/tmp", {
    topic: "climate policy",
    perspectives: ["economic", "environmental"],
  });
  assert.equal(invocation.script, generateMultiPerspectiveWorkflow("climate policy", ["economic", "environmental"]));
});

test("multi-perspective resolve() falls back to the default perspective set below 2 items", () => {
  const noPerspectives = requireBuiltin("multi-perspective").resolve("/tmp", { topic: "topic" });
  const onePerspective = requireBuiltin("multi-perspective").resolve("/tmp", {
    topic: "topic",
    perspectives: ["only-one"],
  });
  const expected = generateMultiPerspectiveWorkflow("topic", [...DEFAULT_MULTI_PERSPECTIVES]);
  assert.equal(noPerspectives.script, expected);
  assert.equal(onePerspective.script, expected);
});

test("multi-perspective resolve() rejects a missing topic", () => {
  assert.throws(() => requireBuiltin("multi-perspective").resolve("/tmp", { perspectives: ["a", "b"] }), /topic/);
});

test("codebase-audit resolve() bakes the given scope/checks into the same generator output", () => {
  const invocation = requireBuiltin("codebase-audit").resolve("/tmp", {
    scope: "src/",
    checks: ["security", "performance"],
  });
  assert.equal(invocation.script, generateCodebaseAuditWorkflow("src/", ["security", "performance"]));
});

test("codebase-audit resolve() rejects a missing scope or empty checks", () => {
  const resolve = requireBuiltin("codebase-audit").resolve;
  assert.throws(() => resolve("/tmp", { checks: ["a"] }), /scope/);
  assert.throws(() => resolve("/tmp", { scope: "src/", checks: [] }), /checks/);
  assert.throws(() => resolve("/tmp", { scope: "src/" }), /checks/);
});

// ─── resolveWorkflowInvocation: precedence and fallback ────────────────────────

test(
  "resolveWorkflowInvocation falls back to the built-in pattern when nothing is saved",
  withTempCwd((cwd) => {
    const storage = createWorkflowStorage(cwd);
    const resolved = resolveWorkflowInvocation("deep-research", { question: "q" }, { storage, cwd });
    assert.ok(resolved);
    assert.equal(resolved.script, generateDeepResearchWorkflow());
    assert.equal(resolved.toolset, "web-research");
  }),
);

test(
  "resolveWorkflowInvocation prefers a project/user saved workflow over a built-in of the same name",
  withTempCwd((cwd) => {
    const storage = createWorkflowStorage(cwd);
    const customScript = "export const meta = { name: 'custom_deep_research', description: 'override' }\nreturn 1";
    storage.save({ name: "deep-research", description: "custom override", script: customScript });

    const resolved = resolveWorkflowInvocation("deep-research", { question: "q" }, { storage, cwd });
    assert.ok(resolved);
    assert.equal(resolved.script, customScript);
    // The saved workflow wins outright — it does not carry the built-in's
    // web-research exec context, since it is a wholly different script.
    assert.equal(resolved.toolset, undefined);
    assert.equal(parseWorkflowScript(resolved.script).meta.name, "custom_deep_research");
  }),
);

test(
  "resolveWorkflowInvocation returns undefined for a name that is neither saved nor built-in",
  withTempCwd((cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.equal(resolveWorkflowInvocation("not-a-real-workflow", {}, { storage, cwd }), undefined);
  }),
);

// ─── Every registered script actually parses ───────────────────────────────────

test("every built-in pattern's resolve() output is a parseable workflow script", () => {
  const validArgsByName: Record<string, unknown> = {
    "deep-research": { question: "q" },
    "adversarial-review": { task: "t" },
    "code-review": { diff: "d" },
    "multi-perspective": { topic: "t" },
    "codebase-audit": { scope: "s", checks: ["c"] },
  };
  for (const descriptor of BUILTIN_WORKFLOWS) {
    const { script } = descriptor.resolve("/tmp", validArgsByName[descriptor.name]);
    const { meta } = parseWorkflowScript(script);
    assert.ok(meta.name, `${descriptor.name} script should declare export const meta.name`);
  }
});
