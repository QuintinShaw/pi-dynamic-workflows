import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import { runWorkflow } from "../src/workflow.js";
import {
  CAPABILITY_TABLE_PUBLICATION_PATHS,
  checkWorkflowCapabilityPublications,
  renderSupportedCapabilityTable,
  renderWorkflowCapabilityDetails,
  renderWorkflowCapabilityReference,
} from "../src/workflow-authoring-reference.js";
import { WORKFLOW_CAPABILITY_CONTRACT } from "../src/workflow-capability-contract.js";
import { parseNpmPackFilePaths } from "../src/workflow-release-gate.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

const ROOT = join(import.meta.dirname, "..");
const SKILL_ROOT = "skills/workflow-authoring";
const REQUIRED_RESOURCES = [
  `${SKILL_ROOT}/SKILL.md`,
  `${SKILL_ROOT}/references/capabilities.md`,
  `${SKILL_ROOT}/references/capability-details.md`,
  `${SKILL_ROOT}/references/runtime.md`,
  `${SKILL_ROOT}/references/helpers.md`,
  `${SKILL_ROOT}/references/common-helpers.md`,
  `${SKILL_ROOT}/references/quality-helpers.md`,
  `${SKILL_ROOT}/references/retry-helper.md`,
  `${SKILL_ROOT}/references/specialized-helpers.md`,
  `${SKILL_ROOT}/references/lifecycle.md`,
  `${SKILL_ROOT}/references/versions.md`,
  `${SKILL_ROOT}/references/pattern-selection.md`,
  `${SKILL_ROOT}/references/focused-recipes.md`,
  `${SKILL_ROOT}/references/registry-ownership.md`,
  `${SKILL_ROOT}/references/review.md`,
  `${SKILL_ROOT}/references/debugging.md`,
  `${SKILL_ROOT}/examples/classify-and-act.js`,
  `${SKILL_ROOT}/examples/fan-out-and-synthesize.js`,
  `${SKILL_ROOT}/examples/adversarial-verification.js`,
  `${SKILL_ROOT}/examples/generate-and-filter.js`,
  `${SKILL_ROOT}/examples/tournament.js`,
  `${SKILL_ROOT}/examples/loop-until-done.js`,
  `${SKILL_ROOT}/examples/phased-budgets.js`,
  `${SKILL_ROOT}/examples/saved-nested-workflows.js`,
  `${SKILL_ROOT}/examples/bounded-semantic-retry.js`,
  `${SKILL_ROOT}/examples/validated-gate.js`,
  `${SKILL_ROOT}/examples/structured-output.js`,
] as const;

function requiredSchemaFields(schema?: Record<string, unknown>): unknown[] {
  return Array.isArray(schema?.required) ? Array.from(schema.required) : [];
}

function publishableFiles(): Set<string> {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" });
  return new Set(parseNpmPackFilePaths(output));
}

test("publishable Pi package discovers the workflow-authoring skill and all linked resources", () => {
  assert.deepEqual(packageJson.pi.skills, [SKILL_ROOT]);
  const files = publishableFiles();
  for (const resource of REQUIRED_RESOURCES) assert.ok(files.has(resource), `publishable package omitted ${resource}`);

  const skill = readFileSync(join(ROOT, SKILL_ROOT, "SKILL.md"), "utf8");
  const description = /^description:\s*(.+)$/m.exec(skill)?.[1] ?? "";
  for (const trigger of ["writing", "editing", "reviewing", "debugging"]) {
    assert.match(description, new RegExp(`\\b${trigger}\\b`, "i"));
  }
  assert.match(description, /not (?:for )?(?:merely )?running an existing workflow/i);
  assert.match(skill, new RegExp(`^  version: ["']?${packageJson.version.replaceAll(".", "\\.")}["']?$`, "m"));
  assert.ok(skill.split("\n").length <= 80, "SKILL.md should remain a short progressive-disclosure router");

  for (const sourcePath of REQUIRED_RESOURCES.filter((path) => path.endsWith(".md"))) {
    const source = readFileSync(join(ROOT, sourcePath), "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#([^)]+))?\)/g)) {
      const target = normalize(join(dirname(sourcePath), match[1]));
      assert.equal(
        relative(".", target).startsWith(".."),
        false,
        `${sourcePath} links outside the package: ${match[1]}`,
      );
      assert.ok(files.has(target), `${sourcePath} has a broken packaged link to ${target}`);
      if (match[2]) {
        const targetSource = readFileSync(join(ROOT, target), "utf8");
        const headingAnchors = targetSource
          .split("\n")
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) =>
            line
              .replace(/^#{1,6} /, "")
              .toLowerCase()
              .replace(/[^a-z0-9 -]/g, "")
              .trim()
              .replace(/ +/g, "-"),
          );
        assert.ok(
          targetSource.includes(`<a id="${match[2]}"></a>`) || headingAnchors.includes(match[2]),
          `${sourcePath} links to missing anchor ${target}#${match[2]}`,
        );
      }
    }
  }
});

test("always-read skill guidance preserves identity and payload across downstream agent calls", () => {
  const skill = readFileSync(join(ROOT, SKILL_ROOT, "SKILL.md"), "utf8");

  assert.match(
    skill,
    /when one agent consumes another's selected result, include both its stable ID and actual data in the downstream prompt/i,
  );
});

test("one generated supported-capability table is fresh across skill, README, and website docs", () => {
  assert.deepEqual(CAPABILITY_TABLE_PUBLICATION_PATHS, [
    "skills/workflow-authoring/references/capabilities.md",
    "README.md",
    "docs/workflow-authoring.md",
  ]);
  assert.deepEqual(checkWorkflowCapabilityPublications(ROOT), []);

  const generatedTable = renderSupportedCapabilityTable();
  for (const path of CAPABILITY_TABLE_PUBLICATION_PATHS) {
    const publication = readFileSync(join(ROOT, path), "utf8");
    assert.equal(publication.split(generatedTable).length - 1, 1, `${path} must reuse the exact generated table once`);
  }
  assert.match(generatedTable, /agent\(prompt, options\?\)/);
  assert.match(generatedTable, /label.*string.*optional.*derived from phase and call count/i);
  assert.match(generatedTable, /background\?: boolean = true/);
  assert.match(
    readFileSync(join(ROOT, "README.md"), "utf8"),
    /\[workflow authoring guide\]\(docs\/workflow-authoring\.md\)/,
  );
  assert.match(readFileSync(join(ROOT, "docs/workflow-authoring.md"), "utf8"), /^## Supported capabilities$/m);
  assert.doesNotMatch(generatedTable, /console|VM realm|compatibility-behavior|internal-substrate/);
  assert.doesNotMatch(generatedTable, /openai|gpt-|agentType catalogue|model route entries/i);

  const installedReference = renderWorkflowCapabilityDetails();
  for (const expectedMetadata of [
    "Dynamic reference owner: `model-tier-config`",
    "Item shape: `{ name: string; description?: string }`",
    "Future lookup connection: `loadModelTierConfig`",
    "Dynamic reference owner: `agent-registry`",
    "Future lookup connection: `loadAgentRegistry`",
  ]) {
    assert.match(installedReference, new RegExp(expectedMetadata.replace(/[{}?]/g, "\\$&")));
  }
  assert.doesNotMatch(installedReference, /Dynamic reference.*items:/i);

  const stale = checkWorkflowCapabilityPublications(ROOT, {
    "README.md": readFileSync(join(ROOT, "README.md"), "utf8").replace("| agent |", "| stale-agent |"),
    "docs/workflow-authoring.md": "missing generated anchors",
  });
  assert.deepEqual(stale, ["README.md", "docs/workflow-authoring.md"]);
});

test("generated capability index and exhaustive details are fresh and absent from permanent context surfaces", () => {
  const index = readFileSync(join(ROOT, SKILL_ROOT, "references/capabilities.md"), "utf8");
  const details = readFileSync(join(ROOT, SKILL_ROOT, "references/capability-details.md"), "utf8");
  assert.equal(index, renderWorkflowCapabilityReference());
  assert.equal(details, renderWorkflowCapabilityDetails());
  assert.equal(index.split(renderSupportedCapabilityTable()).length - 1, 1);
  assert.match(index, /exhaustive generated facts.*capability-details\.md/i);
  assert.doesNotMatch(index, /<a id="agent"><\/a>/);
  assert.match(details, /<a id="agent"><\/a>/);
  assert.doesNotMatch(details, /BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES/);
  assert.ok(Buffer.byteLength(index, "utf8") < Buffer.byteLength(details, "utf8"));
  for (const fact of WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts()) {
    assert.equal(fact.reference?.split("#")[0], `${SKILL_ROOT}/references/capability-details.md`);
  }

  const tool = createWorkflowTool({ cwd: ROOT });
  const permanentPrompt = JSON.stringify({ snippet: tool.promptSnippet, guidelines: tool.promptGuidelines });
  const providerVisibleDefinition = JSON.stringify({ description: tool.description, parameters: tool.parameters });
  for (const surface of [permanentPrompt, providerVisibleDefinition]) {
    assert.doesNotMatch(surface, /generated from WORKFLOW_CAPABILITY_CONTRACT/i);
    assert.doesNotMatch(surface, /Workflow capability reference|Supported capability index/i);
    assert.doesNotMatch(surface, /skills\/workflow-authoring|references\/capabilities\.md/i);
  }
});

test("lifecycle guidance explains configured timeout and token-budget defaults", () => {
  const lifecycle = readFileSync(join(ROOT, SKILL_ROOT, "references/lifecycle.md"), "utf8");

  assert.match(lifecycle, /omitted `agentTimeoutMs`.*configured `defaultAgentTimeoutMs`.*otherwise.*unbounded/is);
  assert.match(lifecycle, /omitted `tokenBudget`.*configured `defaultTokenBudget`.*otherwise.*unlimited/is);
  assert.match(lifecycle, /soft pre-call gates.*concurrent work can overshoot/is);
});

test("generated facts cover the lifecycle constraints taught by the skill", () => {
  const facts = new Map(WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts().map((fact) => [fact.id, fact]));
  const exactFacts = [
    "workflow.runtime.agent",
    "workflow.runtime.workflow",
    "workflow.runtime.retry",
    "workflow.runtime.checkpoint",
    "workflow.runtime.budget",
    "workflow.script.return-value",
    "workflow.script.determinism",
  ]
    .flatMap((id) => {
      const fact = facts.get(id);
      return fact ? [fact.signature ?? "", ...fact.constraints] : [];
    })
    .join(" ");

  for (const requiredFact of [
    /recoverable failures return null/i,
    /selector priority/i,
    /longest unchanged prefix/i,
    /one nested level/i,
    /exhaustion returns (?:only )?the last result/i,
    /consumes one agent slot and no tokens/i,
    /in-flight work can overshoot/i,
    /JSON-serializable/i,
    /Date\.now\(\).*Math\.random\(\)/i,
  ]) {
    assert.match(exactFacts, requiredFact);
  }
});

test("generated gate facts expose exact callback, option, and result contracts", () => {
  const gate = WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts().find(
    (fact) => fact.id === "workflow.runtime.gate",
  );

  assert.ok(gate);
  assert.equal(
    gate.signature,
    "gate(thunk: (feedback: string | undefined, attempt: number) => unknown | Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } | Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>",
  );
  assert.deepEqual(gate.options?.options, [
    {
      name: "attempts",
      type: "number",
      optional: true,
      default: "3",
      constraints: ["authors must provide a finite integer; runtime clamps values below 1 to 1"],
      dynamicReference: null,
    },
  ]);
  assert.match(gate.constraints.join(" "), /feedback is undefined.*first thunk call/i);
  assert.match(gate.constraints.join(" "), /attempt is zero-based/i);
  assert.match(gate.constraints.join(" "), /accepted when.*truthy ok.*bare boolean.*not accepted/i);

  const helpers = readFileSync(join(ROOT, SKILL_ROOT, "references/specialized-helpers.md"), "utf8");
  assert.match(helpers, /thunk.*feedback.*attempt/i);
  assert.match(helpers, /zero-based/i);
  assert.match(helpers, /validator.*value.*ok.*feedback/i);
  assert.match(helpers, /bare boolean.*not accepted/i);

  const recipes = readFileSync(join(ROOT, SKILL_ROOT, "references/focused-recipes.md"), "utf8");
  assert.match(recipes, /\[Validated gate\]\(\.\.\/examples\/validated-gate\.js\)/);
});

test("generated helper facts expose exact callback, option, result, and failure contracts", () => {
  const facts = new Map(WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts().map((fact) => [fact.id, fact]));
  const verify = facts.get("workflow.runtime.verify");
  const judgePanel = facts.get("workflow.runtime.judgePanel");
  const loopUntilDry = facts.get("workflow.runtime.loopUntilDry");
  const completenessCheck = facts.get("workflow.runtime.completenessCheck");
  const retry = facts.get("workflow.runtime.retry");
  const pipeline = facts.get("workflow.runtime.pipeline");
  const agent = facts.get("workflow.runtime.agent");
  const background = facts.get("workflow.tool-input.background");
  const metadata = facts.get("workflow.script.metadata");

  assert.match(verify?.signature ?? "", /reviewers.*threshold.*lens.*realCount.*votes/i);
  assert.deepEqual(
    verify?.options?.options.map(({ name, default: value }) => [name, value]),
    [
      ["reviewers", "2"],
      ["threshold", "0.5"],
      ["lens", null],
    ],
  );
  assert.match(verify?.constraints.join(" ") ?? "", /successful votes.*denominator/i);

  assert.match(judgePanel?.signature ?? "", /judges.*rubric.*index.*attempt.*score.*judgments.*undefined/i);
  assert.deepEqual(
    judgePanel?.options?.options.map(({ name, default: value }) => [name, value]),
    [
      ["judges", "3"],
      ["rubric", '"overall quality and correctness"'],
    ],
  );
  assert.match(judgePanel?.constraints.join(" ") ?? "", /stable.*input index.*tie/i);

  assert.match(loopUntilDry?.signature ?? "", /round.*roundIndex.*key.*consecutiveEmpty.*maxRounds/i);
  assert.deepEqual(
    loopUntilDry?.options?.options.map(({ name, default: value }) => [name, value]),
    [
      ["round", null],
      ["key", "JSON.stringify"],
      ["consecutiveEmpty", "2"],
      ["maxRounds", "50"],
    ],
  );
  assert.match(loopUntilDry?.constraints.join(" ") ?? "", /capacity exhaustion.*partial array/i);
  assert.match(loopUntilDry?.constraints.join(" ") ?? "", /does not report whether termination/i);

  assert.match(completenessCheck?.signature ?? "", /complete: boolean.*missing\?: string\[\].*null/i);
  assert.match(completenessCheck?.constraints.join(" ") ?? "", /4,000.*serialized result/i);

  assert.match(retry?.signature ?? "", /attempt: number.*until.*boolean.*Promise<unknown>/i);
  assert.deepEqual(
    retry?.options?.options.map(({ name, default: value }) => [name, value]),
    [
      ["attempts", "3"],
      ["until", "accept first result when omitted"],
    ],
  );
  assert.match(retry?.constraints.join(" ") ?? "", /zero-based/i);
  assert.match(retry?.constraints.join(" ") ?? "", /synchronous.*Promise.*first result/i);

  assert.match(pipeline?.constraints.join(" ") ?? "", /null.*next stage/i);
  assert.match(agent?.constraints.join(" ") ?? "", /schema noncompliance.*nonrecoverable/i);
  assert.match(agent?.constraints.join(" ") ?? "", /selected.*unavailable.*session default/i);
  assert.match(agent?.constraints.join(" ") ?? "", /worktree isolation.*best-effort/i);
  assert.match(background?.constraints.join(" ") ?? "", /background workflows are headless/i);
  assert.match(background?.constraints.join(" ") ?? "", /checkpoint.*foreground confirmation/i);
  assert.match(metadata?.signature ?? "", /phases\?: Array<\{ title: string; detail\?: string; model\?: string \}>/);
  assert.match(metadata?.constraints.join(" ") ?? "", /only legal export/i);
  assert.match(metadata?.constraints.join(" ") ?? "", /literal.*string concatenation.*template interpolation/i);

  const qualityHelpers = readFileSync(join(ROOT, SKILL_ROOT, "references/quality-helpers.md"), "utf8");
  const retryHelper = readFileSync(join(ROOT, SKILL_ROOT, "references/retry-helper.md"), "utf8");
  const specializedHelpers = readFileSync(join(ROOT, SKILL_ROOT, "references/specialized-helpers.md"), "utf8");
  assert.match(qualityHelpers, /verify.*reviewers: number.*threshold: number.*lens: string/i);
  assert.match(qualityHelpers, /judgePanel.*judges: number.*rubric: string/i);
  assert.match(qualityHelpers, /successful votes.*denominator/i);
  assert.match(specializedHelpers, /agent-limit exhaustion.*partial/i);
  assert.match(retryHelper, /retry.*zero-based.*synchronous/i);
  assert.match(retryHelper, /await retry/i);
  assert.match(specializedHelpers, /await gate/i);
  assert.match(retryHelper, /await.*agent.*resolved value.*ledger/i);
  assert.match(specializedHelpers, /await.*agent.*resolved value.*ledger/i);
  const runtime = readFileSync(join(ROOT, SKILL_ROOT, "references/runtime.md"), "utf8");
  assert.match(runtime, /pipeline.*null.*next stage/i);
  assert.match(runtime, /schema noncompliance.*throw/i);
  assert.match(runtime, /phases.*\[\{.*title.*detail.*model/i);
  assert.match(runtime, /only legal export.*meta/i);
  assert.match(runtime, /export default.*other exports.*invalid/i);
  assert.match(runtime, /agent\(prompt.*label.*schema/i);
  const lifecycle = readFileSync(join(ROOT, SKILL_ROOT, "references/lifecycle.md"), "utf8");
  assert.match(lifecycle, /background workflows are headless/i);
  assert.match(lifecycle, /checkpoint.*foreground/i);
});

test("fan-out-and-synthesize example waits for the complete result set and preserves failures", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/fan-out-and-synthesize.js"), "utf8");
  const work = [
    { id: "alpha", task: "A" },
    { id: "beta", task: "B" },
    { id: "gamma", task: "C" },
  ];
  const finished = new Set<string>();
  const labels: string[] = [];
  let synthesisSawCompleteFanOut = false;

  const result = await runWorkflow<{
    ledger: Array<{ id: string; status: string; result: unknown }>;
    synthesis: unknown;
  }>(script, {
    args: { work },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(prompt: string, options: { label?: string; schema?: unknown }) {
        if (options.label === "synthesize-complete-set") {
          synthesisSawCompleteFanOut = finished.size === work.length;
          assert.match(prompt, /"id":"beta"/);
          assert.match(prompt, /"status":"failed"/);
          return { summary: "complete", coveredIds: ["alpha", "gamma"], failedIds: ["beta"] };
        }
        const id = options.label?.split(":").at(-1) ?? "unknown";
        finished.add(id);
        return id === "beta" ? "" : `result:${id}`;
      },
    },
  });

  assert.equal(synthesisSawCompleteFanOut, true);
  assert.deepEqual(labels, ["fanout:0:alpha", "fanout:1:beta", "fanout:2:gamma", "synthesize-complete-set"]);
  assert.equal(new Set(labels).size, labels.length, "all agent labels must be unique");
  assert.deepEqual(
    result.result.ledger.map(({ id, status, result: itemResult }) => ({ id, status, result: itemResult })),
    [
      { id: "alpha", status: "complete", result: "result:alpha" },
      { id: "beta", status: "failed", result: null },
      { id: "gamma", status: "complete", result: "result:gamma" },
    ],
  );
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("classify-and-act classifies the complete set before routed action", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/classify-and-act.js"), "utf8");
  const labels: string[] = [];
  const classified = new Set<string>();
  let actionsStartedAfterClassification = true;

  const result = await runWorkflow<{
    handled: Array<{ id: string; category: string }>;
    failed: { classification: string[]; action: string[] };
  }>(script, {
    args: { items: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(_prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label.startsWith("classify:")) {
          const id = label.split(":").at(-1) ?? "";
          classified.add(id);
          return id === "beta" ? null : { category: id === "alpha" ? "direct" : "iterative", reason: "fixture" };
        }
        actionsStartedAfterClassification &&= classified.size === 3;
        return label.endsWith(":gamma") ? null : { outcome: "handled" };
      },
    },
  });

  assert.equal(actionsStartedAfterClassification, true);
  assert.deepEqual(labels, ["classify:0:alpha", "classify:1:beta", "classify:2:gamma", "act:0:alpha", "act:1:gamma"]);
  assert.deepEqual([...result.result.failed.classification], ["beta"]);
  assert.deepEqual([...result.result.failed.action], ["gamma"]);
  assert.deepEqual(
    result.result.handled.map(({ id, category }) => ({ id, category })),
    [{ id: "alpha", category: "direct" }],
  );
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("adversarial verification uses separate producer and skeptic calls and retains failures", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/adversarial-verification.js"), "utf8");
  const labels: string[] = [];
  const finishedProducers = new Set<string>();
  let skepticsStartedAfterProduction = true;

  const result = await runWorkflow<{
    failed: { producers: string[]; skeptics: string[] };
  }>(script, {
    args: { topics: [{ id: "alpha" }, { id: "beta" }] },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label.startsWith("produce:")) {
          const id = label.split(":").at(-1) ?? "";
          finishedProducers.add(id);
          return id === "beta" ? null : { claim: "claim-alpha", evidence: ["source"] };
        }
        skepticsStartedAfterProduction &&= finishedProducers.size === 2;
        assert.match(prompt, /claim-alpha/);
        return null;
      },
    },
  });

  assert.equal(skepticsStartedAfterProduction, true);
  assert.deepEqual(labels, ["produce:0:alpha", "produce:1:beta", "skeptic:0:alpha"]);
  assert.equal(new Set(labels).size, labels.length);
  assert.deepEqual([...result.result.failed.producers], ["beta"]);
  assert.deepEqual([...result.result.failed.skeptics], ["alpha"]);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("generate-and-filter deterministically deduplicates before rubric filtering", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/generate-and-filter.js"), "utf8");
  const labels: string[] = [];
  const filteredCandidates: string[] = [];

  const result = await runWorkflow<{
    candidates: string[];
    survivors: string[];
    failed: { batches: number[]; filters: string[] };
  }>(script, {
    args: { batches: 3, maxCandidates: 3, topic: "names", rubric: "clear" },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label === "generate:1") return { candidates: ["Alpha", " Beta "] };
        if (label === "generate:2") return { candidates: [" alpha ", "Gamma"] };
        if (label === "generate:3") return null;
        const candidate = /Candidate: (.*)$/.exec(prompt)?.[1] ?? "";
        filteredCandidates.push(candidate);
        return candidate.trim() === "Beta" ? null : { keep: candidate === "Alpha", reason: "fixture" };
      },
    },
  });

  assert.deepEqual(filteredCandidates, ["Alpha", " Beta ", "Gamma"]);
  assert.deepEqual([...result.result.candidates], ["Alpha", " Beta ", "Gamma"]);
  assert.deepEqual([...result.result.survivors], ["Alpha"]);
  assert.deepEqual([...result.result.failed.batches], [3]);
  assert.deepEqual([...result.result.failed.filters], [" Beta "]);
  assert.equal(new Set(labels).size, labels.length);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("generate-and-filter bounds rubric calls after deterministic deduplication", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/generate-and-filter.js"), "utf8");
  const filterLabels: string[] = [];
  const result = await runWorkflow<{ candidates: string[]; omitted: string[] }>(script, {
    args: { batches: 1, maxCandidates: 2 },
    persistLogs: false,
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        if (label === "generate:1") return { candidates: ["Alpha", "alpha", "Beta", "Gamma"] };
        filterLabels.push(label ?? "");
        return { keep: true, reason: "fixture" };
      },
    },
  });

  assert.deepEqual([...result.result.candidates], ["Alpha", "Beta"]);
  assert.deepEqual([...result.result.omitted], ["Gamma"]);
  assert.deepEqual(filterLabels, ["filter:1", "filter:2"]);
});

test("tournament keeps a bounded bracket in JavaScript and agents judge only pairs", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/tournament.js"), "utf8");
  const labels: string[] = [];
  const judgePrompts: string[] = [];

  const result = await runWorkflow<{
    winner: { id: string } | null;
    bracket: Array<{ round: number; match: number; leftId: string; rightId: string | null }>;
    failed: { contenders: number[]; matches: string[] };
  }>(script, {
    args: { contenders: 4, task: "pick", rubric: "best" },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label.startsWith("contender:")) return { candidate: label, rationale: "fixture" };
        judgePrompts.push(prompt);
        return { winnerIndex: 0, reason: "fixture" };
      },
    },
  });

  assert.equal(judgePrompts.length, 3, "four contenders require exactly three pairwise judgments");
  assert.ok(judgePrompts.every((prompt) => /Candidate 0:/.test(prompt) && /Candidate 1:/.test(prompt)));
  assert.deepEqual(
    Array.from(result.result.bracket, ({ leftId, rightId }) => [leftId, rightId]),
    [
      ["contender-1", "contender-2"],
      ["contender-3", "contender-4"],
      ["contender-1", "contender-3"],
    ],
  );
  assert.equal(result.result.winner?.id, "contender-1");
  assert.equal(new Set(labels).size, labels.length);
  assert.doesNotThrow(() => JSON.stringify(result.result));

  const failedResult = await runWorkflow<{
    failed: { contenders: number[]; matches: string[] };
  }>(script, {
    args: { contenders: 3 },
    persistLogs: false,
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        if (label === "contender:2") return null;
        if (label?.startsWith("contender:")) return { candidate: label, rationale: "fixture" };
        return null;
      },
    },
  });
  assert.deepEqual([...failedResult.result.failed.contenders], [2]);
  assert.deepEqual([...failedResult.result.failed.matches], ["round-1-match-1"]);
});

test("tournament advances an odd contender by bye without an agent judgment", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/tournament.js"), "utf8");
  const judgeLabels: string[] = [];
  const result = await runWorkflow<{ bracket: Array<{ rightId: string | null }>; winner: { id: string } }>(script, {
    args: { contenders: 3 },
    persistLogs: false,
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        if (label?.startsWith("contender:")) return { candidate: label, rationale: "fixture" };
        judgeLabels.push(label ?? "");
        return { winnerIndex: 0, reason: "fixture" };
      },
    },
  });

  assert.deepEqual(judgeLabels, ["judge:1:1", "judge:2:1"]);
  assert.equal(
    result.result.bracket.some(({ rightId }) => rightId === null),
    true,
  );
  assert.equal(result.result.winner.id, "contender-1");
});

test("loop-until-done uses stable identities, dry-round termination, and a maximum bound", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/loop-until-done.js"), "utf8");
  const dryLabels: string[] = [];
  const rounds = [
    {
      findings: [
        { id: "alpha", detail: "first" },
        { id: "alpha", detail: "same-round duplicate" },
      ],
    },
    { findings: [{ id: "alpha", detail: "duplicate" }] },
    { findings: [{ id: "beta", detail: "second" }] },
    { findings: [] },
    { findings: [] },
  ];
  const dryResult = await runWorkflow<{ findings: Array<{ id: string }>; failedRounds: number[] }>(script, {
    args: { maxRounds: 10 },
    persistLogs: false,
    onAgentStart: ({ label }) => dryLabels.push(label),
    agent: { run: async () => rounds.shift() ?? { findings: [{ id: "unexpected", detail: "too late" }] } },
  });

  assert.deepEqual(dryLabels, ["discover:1", "discover:2", "discover:3", "discover:4", "discover:5"]);
  assert.deepEqual(
    Array.from(dryResult.result.findings, ({ id }) => id),
    ["alpha", "beta"],
  );

  const boundedLabels: string[] = [];
  const boundedResult = await runWorkflow<{ complete: boolean; termination: string }>(script, {
    args: { maxRounds: 3 },
    persistLogs: false,
    onAgentStart: ({ label }) => boundedLabels.push(label),
    agent: {
      run: async (_prompt: string, { label }: { label?: string }) => ({
        findings: [{ id: label, detail: "new" }],
      }),
    },
  });
  assert.deepEqual(boundedLabels, ["discover:1", "discover:2", "discover:3"]);
  assert.equal(boundedResult.result.complete, false);
  assert.equal(boundedResult.result.termination, "max-rounds");

  const failedResult = await runWorkflow<{ complete: boolean; failedRounds: number[]; termination: string }>(script, {
    args: { maxRounds: 5 },
    persistLogs: false,
    agent: { run: async () => null },
  });
  assert.deepEqual([...failedResult.result.failedRounds], [1, 2, 3, 4, 5]);
  assert.equal(failedResult.result.complete, false);
  assert.equal(failedResult.result.termination, "max-rounds");
  assert.equal(new Set(dryLabels).size, dryLabels.length);
  assert.doesNotThrow(() => JSON.stringify(dryResult.result));
});

test("loop-until-done resets its consecutive dry streak after missing coverage", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/loop-until-done.js"), "utf8");
  const labels: string[] = [];
  const responses = [{ findings: [] }, null, { findings: [] }, { findings: [] }];
  const result = await runWorkflow<{ complete: boolean; failedRounds: number[]; termination: string }>(script, {
    args: { maxRounds: 5 },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      run: async () => {
        const response = responses.shift();
        return response === undefined ? { findings: [{ id: "late", detail: "too late" }] } : response;
      },
    },
  });

  assert.deepEqual(labels, ["discover:1", "discover:2", "discover:3", "discover:4"]);
  assert.deepEqual([...result.result.failedRounds], [2]);
  assert.equal(result.result.termination, "dry");
  assert.equal(result.result.complete, false);
});

test("phased-budget recipe reports soft-gate spending and bounds later calls", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/phased-budgets.js"), "utf8");
  const labels: string[] = [];
  const result = await runWorkflow<{
    phases: Array<{ title: string; startSpent: number; endSpent: number; attempted: string[]; missing: string[] }>;
    totalSpent: number;
  }>(script, {
    args: { phaseBudget: 10, work: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(_prompt: string, options: { label?: string; onUsage?: (usage: unknown) => void }) {
        options.onUsage?.({ input: 10, output: 0, total: 10, cost: 0, cacheRead: 0, cacheWrite: 0 });
        return options.label === "deliver:0:alpha" ? null : { summary: options.label ?? "" };
      },
    },
  });

  assert.deepEqual(labels, ["explore:0:alpha", "deliver:0:alpha"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.phases[0])), {
    title: "Explore",
    startSpent: 0,
    endSpent: 10,
    attempted: ["alpha", "beta", "gamma"],
    missing: ["beta", "gamma"],
  });
  assert.deepEqual(Array.from(result.result.phases[1]?.missing ?? []), ["alpha"]);
  assert.equal(result.result.totalSpent, 20);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("saved-workflow recipe runs context-supplied nested jobs sequentially at one level", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/saved-nested-workflows.js"), "utf8");
  const child = `export const meta = { name: 'installed_child', description: 'fixture' }
const result = await agent('child:' + args.id, { label: 'child:' + args.id })
return { id: args.id, result }`;
  const labels: string[] = [];
  let active = 0;
  let maxActive = 0;
  const result = await runWorkflow<{
    nested: Array<{ id: string; status: string; result: unknown }>;
    missing: string[];
  }>(script, {
    args: { savedWorkflowName: "installed-child", jobs: [{ id: "alpha" }, { id: "beta" }] },
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "installed-child" ? child : undefined),
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        if (label === "child:beta") return null;
        return label === "prepare-nested-jobs" ? { ready: true } : `result:${label}`;
      },
    },
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(labels, ["prepare-nested-jobs", "child:alpha", "child:beta"]);
  assert.deepEqual(Array.from(result.result.missing), ["beta"]);
  assert.deepEqual(
    Array.from(result.result.nested, ({ id, status }) => ({ id, status })),
    [
      { id: "alpha", status: "complete" },
      { id: "beta", status: "missing" },
    ],
  );
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("bounded-retry recipe separates transport retries and preserves every semantic attempt", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/bounded-semantic-retry.js"), "utf8");
  const labels: string[] = [];
  const result = await runWorkflow<{
    ok: boolean;
    exhausted: boolean;
    attempts: Array<{ attempt: number; status: string; result: unknown }>;
  }>(script, {
    args: { maxSemanticAttempts: 3, transportRetries: 1 },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        if (label === "semantic-attempt:1") return null;
        return { accepted: false, answer: `answer:${label}`, feedback: "try again" };
      },
    },
  });

  assert.deepEqual(labels, ["semantic-attempt:1", "semantic-attempt:2", "semantic-attempt:3"]);
  assert.deepEqual(
    Array.from(result.result.attempts, ({ attempt, status }) => ({ attempt, status })),
    [
      { attempt: 1, status: "missing" },
      { attempt: 2, status: "rejected" },
      { attempt: 3, status: "rejected" },
    ],
  );
  assert.equal(result.result.ok, false);
  assert.equal(result.result.exhausted, true);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("validated-gate recipe uses exact callbacks and returns feedback-ledger evidence", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/validated-gate.js"), "utf8");
  const labels: string[] = [];
  const prompts: string[] = [];
  const result = await runWorkflow<{
    ok: boolean;
    value: { acceptable: boolean; answer: string; feedback: string };
    attempts: number;
    ledger: Array<{
      attempt: number;
      feedbackReceived: string | null;
      accepted: boolean;
      validatorFeedback: string | null;
    }>;
  }>(script, {
    args: { task: "Explain the contract", maxAttempts: 3 },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(prompt: string, { label, schema }: { label?: string; schema?: Record<string, unknown> }) {
        prompts.push(prompt);
        assert.deepEqual(requiredSchemaFields(schema), ["acceptable", "answer", "feedback"]);
        if (label === "gate-attempt:1") {
          return { acceptable: false, answer: "too short", feedback: "add concrete detail" };
        }
        return { acceptable: true, answer: "A concrete and complete answer", feedback: "" };
      },
    },
  });

  assert.deepEqual(labels, ["gate-attempt:1", "gate-attempt:2"]);
  assert.match(prompts[1] ?? "", /add concrete detail/);
  assert.equal(result.result.ok, true);
  assert.equal(result.result.attempts, 2);
  assert.equal(result.result.value.answer, "A concrete and complete answer");
  assert.deepEqual(
    Array.from(result.result.ledger, ({ attempt, feedbackReceived, accepted, validatorFeedback }) => ({
      attempt,
      feedbackReceived,
      accepted,
      validatorFeedback,
    })),
    [
      {
        attempt: 1,
        feedbackReceived: null,
        accepted: false,
        validatorFeedback: "add concrete detail",
      },
      { attempt: 2, feedbackReceived: "add concrete detail", accepted: true, validatorFeedback: null },
    ],
  );
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("structured-output recipe requires schema validation before consuming fields", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/structured-output.js"), "utf8");
  const labels: string[] = [];
  const result = await runWorkflow<{
    outputs: Array<{ id: string; status: string; summary: string | null }>;
    missing: string[];
  }>(script, {
    args: { work: [{ id: "alpha" }, { id: "alpha" }, { id: "beta" }] },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(_prompt: string, { label, schema }: { label?: string; schema?: Record<string, unknown> }) {
        assert.deepEqual(requiredSchemaFields(schema), ["summary", "confidence"]);
        return label === "structured:2:beta" ? null : { summary: "validated", confidence: 0.8 };
      },
    },
  });

  assert.deepEqual(labels, ["structured:0:alpha", "structured:1:alpha", "structured:2:beta"]);
  assert.equal(new Set(labels).size, labels.length);
  assert.deepEqual(
    Array.from(result.result.outputs, ({ id, status, summary }) => ({ id, status, summary })),
    [
      { id: "alpha", status: "complete", summary: "VALIDATED" },
      { id: "alpha", status: "complete", summary: "VALIDATED" },
      { id: "beta", status: "missing", summary: null },
    ],
  );
  assert.deepEqual(Array.from(result.result.missing), ["beta"]);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});
