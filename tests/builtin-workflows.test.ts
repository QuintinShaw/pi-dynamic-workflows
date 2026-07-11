import assert from "node:assert/strict";
import test from "node:test";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "../src/adversarial-review.js";
import { generateCodeReviewWorkflow } from "../src/code-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "../src/deep-research.js";
import { createWebTools } from "../src/web-tools.js";
import { parseWorkflowScript } from "../src/workflow.js";

// ─── Deep Research ──────────────────────────────────────────────────────────────

test("generateDeepResearchWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateDeepResearchWorkflow());
  assert.equal(meta.name, "deep_research");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Queries", "Gather", "Verify", "Report"],
  );
  assert.match(body, /args && args\.question/);
  assert.match(body, /web_search/);
  assert.match(body, /web_fetch/);
});

test("generateDeepResearchWorkflow uses configurable angles and minSupport", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /args\.angles/);
  assert.match(body, /args\.minSupport/);
});

// ─── Adversarial Review ─────────────────────────────────────────────────────────

test("generateAdversarialReviewWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.equal(meta.name, "adversarial_review");
  assert.match(body, /args && args\.task/);
  assert.match(body, /threshold/);
  assert.match(body, /survives/);
});

test("generateAdversarialReviewWorkflow phases are Investigate, Refute, Consensus", () => {
  const { meta } = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Investigate", "Refute", "Consensus"],
  );
});

// ─── Codebase Audit ─────────────────────────────────────────────────────────────

test("generateCodebaseAuditWorkflow produces a valid, parseable script", () => {
  const { meta } = parseWorkflowScript(
    generateCodebaseAuditWorkflow("src/", ["check types", "find bugs", "review style"]),
  );
  assert.equal(meta.name, "codebase_audit");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Individual Checks", "Cross-Validation", "Report"],
  );
});

test("generateCodebaseAuditWorkflow creates an agent per check item", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["check-a", "check-b", "check-c"]);
  assert.match(body, /check-a/);
  assert.match(body, /check-b/);
  assert.match(body, /check-c/);
});

test("generateCodebaseAuditWorkflow uses parallel for checks", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["lint"]);
  assert.match(body, /parallel\(/);
});

test("generateCodebaseAuditWorkflow includes validator and report phases", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["test"]);
  assert.match(body, /validator/);
  assert.match(body, /report-writer/);
});

test("generateCodebaseAuditWorkflow escapes single quotes in scope", () => {
  const body = generateCodebaseAuditWorkflow("it's a test", ["check"]);
  // Should not contain unescaped quotes that would break the script
  assert.ok(!body.includes("it's") || body.includes("it\\'s"), "should not contain it's");
});

test("generateCodebaseAuditWorkflow truncates long scope names", () => {
  const long = "x".repeat(100);
  const body = generateCodebaseAuditWorkflow(long, ["check"]);
  // The scope in the script is .slice(0, 60), so the full 100-char string should not appear
  const fullString = "x".repeat(100);
  assert.ok(!body.includes(fullString), "should not contain the full 100-char string verbatim");
  // But the truncated 60-char version should appear
  assert.ok(body.includes("x".repeat(60)), "should contain the truncated 60-char version");
});

// ─── Multi-Perspective ──────────────────────────────────────────────────────────

test("generateMultiPerspectiveWorkflow produces a valid, parseable script", () => {
  const { meta } = parseWorkflowScript(
    generateMultiPerspectiveWorkflow("climate change", ["economic", "environmental", "social"]),
  );
  assert.equal(meta.name, "multi_perspective_analysis");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Perspective Analysis", "Synthesis"],
  );
});

test("generateMultiPerspectiveWorkflow creates one agent per perspective", () => {
  const perspectives = ["technical", "business", "user"];
  const body = generateMultiPerspectiveWorkflow("new API", perspectives);
  assert.match(body, /technical/);
  assert.match(body, /business/);
  assert.match(body, /user/);
});

test("generateMultiPerspectiveWorkflow uses parallel for perspective analysis", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1", "p2"]);
  assert.match(body, /parallel\(/);
});

test("generateMultiPerspectiveWorkflow includes synthesis phase", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1"]);
  assert.match(body, /synthesizer/);
});

test("generateMultiPerspectiveWorkflow returns analyses and synthesis", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1"]);
  assert.match(body, /analyses/);
  assert.match(body, /synthesis/);
});

// ─── Web Tools ──────────────────────────────────────────────────────────────────

test("createWebTools exposes web_search and web_fetch", () => {
  const tools = createWebTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["web_fetch", "web_search"]);
});

// ─── Code Review ────────────────────────────────────────────────────────────────

test("generateCodeReviewWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateCodeReviewWorkflow());
  assert.equal(meta.name, "code_review");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Find", "Verify", "Report"],
  );
  assert.match(body, /parallel/);
  assert.match(body, /candidateSchema/);
});

test("generateCodeReviewWorkflow truncates an oversized diff and surfaces it", () => {
  const { body } = parseWorkflowScript(generateCodeReviewWorkflow());
  assert.match(body, /MAX_DIFF_CHARS/);
  assert.match(body, /diffTruncated/);
});
