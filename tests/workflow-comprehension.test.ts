import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import {
  COMPREHENSION_SCENARIOS,
  type ModelGeneration,
  ModelGenerationError,
  runComprehensionScenario,
  selectComprehensionScenarios,
} from "../src/workflow-comprehension.js";

const VALID_WORKFLOW = `export const meta = { name: "quick", description: "fixture" }
const [alpha, beta] = await parallel([
  () => agent("alpha", { label: "alpha" }),
  () => agent("beta", { label: "beta" }),
])
return { alpha, beta }
`;

function generation(workflow = VALID_WORKFLOW): ModelGeneration {
  return {
    workflow,
    skillLoadingEvidence: {
      discovered: true,
      loaded: true,
      toolCalls: [{ tool: "read", path: "/installed/skills/workflow-authoring/SKILL.md" }],
    },
    tokenUsage: { input: 100, output: 50, total: 150, cost: 0.001, cacheRead: 0, cacheWrite: 0 },
  };
}

test("comprehension remains a manual, skipped-by-default command", () => {
  assert.equal(packageJson.scripts.comprehension, "tsx scripts/run-workflow-comprehension.ts");
  assert.doesNotMatch(packageJson.scripts.test, /comprehension/i);
  assert.doesNotMatch(packageJson.scripts["release:check"], /comprehension/i);
  assert.doesNotMatch(packageJson.scripts.prepublishOnly, /comprehension/i);
});

test("comprehension CLI exposes the coverage suite and exact targeted scenarios without provider calls", () => {
  const help = execFileSync(process.execPath, ["--import", "tsx", "scripts/run-workflow-comprehension.ts", "--help"], {
    encoding: "utf8",
  });

  assert.match(help, /--suite quick\|full\|coverage/);
  assert.match(help, /--scenario <id>/);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/run-workflow-comprehension.ts",
          "--model",
          "fixture/model",
          "--scenario",
          "not-a-real-scenario",
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    /Unknown scenario not-a-real-scenario/,
  );
});

test("quick, full, and coverage scenario sets expose the agreed authoring branches without naming the skill", () => {
  assert.deepEqual(
    selectComprehensionScenarios("quick").map(({ id }) => id),
    ["quick-write"],
  );
  assert.deepEqual(
    selectComprehensionScenarios("full").map(({ id }) => id),
    ["full-write", "full-edit", "full-review", "full-debug", "full-loop", "full-retry"],
  );
  assert.deepEqual(
    selectComprehensionScenarios("coverage").map(({ id }) => id),
    ["coverage-fan-out-synthesize", "coverage-generate-filter", "coverage-judge-panel"],
  );

  const fullText = COMPREHENSION_SCENARIOS.map(({ prompt }) => prompt).join("\n");
  assert.doesNotMatch(fullText, /workflow-authoring/i);
  for (const expected of [
    "workflow(",
    "control helper",
    "phase budget",
    "structured output",
    "successful dry rounds",
    "retry(",
  ]) {
    assert.match(fullText, new RegExp(expected.replace("(", "\\("), "i"));
  }
});

test("a generated workflow is parsed and executed through the real runtime with deterministic fake agents", async () => {
  const scenario = selectComprehensionScenarios("quick")[0];
  assert.ok(scenario);
  const evidence = await runComprehensionScenario({
    scenario,
    provider: "fixture",
    model: "fixture/model",
    extensionVersion: "2.13.1",
    contractVersions: { format: "1.0.0", content: "2.13.1" },
    skillVersion: "2.13.1",
    generate: async () => generation(),
  });

  assert.equal(evidence.passed, true);
  assert.deepEqual(
    evidence.runtime.calls.map(({ label }) => label),
    ["alpha", "beta"],
  );
  assert.equal(evidence.runtime.topology.maxConcurrent, 2);
  assert.deepEqual(evidence.runtime.result, { alpha: "result:alpha", beta: "result:beta" });
  assert.equal(evidence.failure, null);
  assert.equal(evidence.generatedWorkflow, VALID_WORKFLOW);
  assert.equal(evidence.skillLoadingEvidence.loaded, true);
  assert.equal(evidence.tokenUsage.total, 150);
});

test("quick evidence requires alpha and beta work to reach the returned result", async () => {
  const scenario = selectComprehensionScenarios("quick")[0];
  assert.ok(scenario);
  const compliant = `export const meta = { name: "quick_variant", description: "arbitrary labels preserve task results" }
const [left, right] = await parallel([
  () => agent("summarize alpha", { label: "summary:left" }),
  () => agent("summarize beta", { label: "summary:right" }),
])
return { alpha: left, beta: right }`;
  const unrelated = `export const meta = { name: "quick_mutant", description: "unrelated parallel work" }
await parallel([
  () => agent("unrelated one", { label: "unrelated:1" }),
  () => agent("unrelated two", { label: "unrelated:2" }),
])
return { unrelated: true }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  assert.equal((await run(compliant)).passed, true);
  assert.equal((await run(unrelated)).passed, false);
});

test("quick evidence rejects duplicate task labels", async () => {
  const scenario = selectComprehensionScenarios("quick")[0];
  assert.ok(scenario);
  const duplicateLabels = `export const meta = { name: "quick_duplicate_labels", description: "duplicate labels" }
const [alpha, beta] = await parallel([
  () => agent("summarize alpha", { label: "summary" }),
  () => agent("summarize beta", { label: "summary" }),
])
return { alpha, beta }`;

  const evidence = await runComprehensionScenario({
    scenario,
    provider: "fixture",
    model: "fixture/model",
    extensionVersion: "2.13.1",
    contractVersions: { format: "1.0.0", content: "2.13.1" },
    skillVersion: "2.13.1",
    generate: async () => generation(duplicateLabels),
  });

  assert.equal(evidence.passed, false);
});

test("full-write evidence requires structured task calls and completed/missing provenance", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-write");
  assert.ok(scenario);
  const schema = `{ type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }`;
  const compliant = `export const meta = { name: "write_variant", description: "preserves coverage" }
const [alpha, beta] = await parallel([
  () => agent("work unit alpha", { label: "work:left", schema: ${schema} }),
  () => agent("work unit beta", { label: "work:right", schema: ${schema} }),
])
return { completed: alpha ? [alpha] : [], missingWork: beta ? [] : [{ id: "beta", reason: "agent failed" }] }`;
  const flattened = `export const meta = { name: "write_flattened", description: "flattens structured fields without losing provenance" }
const schema = { type: "object", properties: { summary: { type: "string" }, confidence: { type: "number" } }, required: ["summary", "confidence"] }
const [alpha, beta] = await parallel([
  () => agent("work unit alpha", { label: "work:left", schema }),
  () => agent("work unit beta", { label: "work:right", schema }),
])
return {
  completed: alpha ? [{ id: "alpha", ...alpha }] : [],
  missingWork: beta ? [] : [{ id: "beta", reason: "agent failed" }],
}`;
  const identityAware = `export const meta = { name: "write_identity", description: "validates structured task identity" }
const units = ["alpha", "beta"]
const schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["complete"] },
    summary: { type: "string" },
  },
  required: ["id", "status", "summary"],
}
const results = await parallel(units.map((id, index) => () => agent("work unit " + id + "; echo id " + id, { label: "work:" + index, schema })))
const completed = []
const missingWork = []
for (let index = 0; index < units.length; index++) {
  const id = units[index]
  const result = results[index]
  if (result && result.id === id && result.status === "complete") completed.push({ id, output: result })
  else missingWork.push({ id, reason: result ? "invalid identity or status" : "agent failed" })
}
return { completed, missingWork }`;
  const sharedContext = `export const meta = { name: "write_shared_context", description: "mentions every unit in shared context" }
const schema = { type: "object", properties: { id: { type: "string", enum: ["alpha", "beta"] }, value: { type: "string" } }, required: ["id", "value"] }
const context = { work: [{ id: "alpha" }, { id: "beta" }] }
const [alpha, beta] = await parallel([
  () => agent("work unit alpha; shared context: " + JSON.stringify(context), { label: "author-alpha", schema }),
  () => agent("work unit beta; shared context: " + JSON.stringify(context), { label: "author-beta", schema }),
])
return {
  completed: alpha ? [{ id: "alpha", value: alpha.value }] : [],
  missingWork: beta ? [] : [{ id: "beta", reason: "agent failed" }],
}`;
  const omitsRedundantControlField = `export const meta = { name: "write_control_projection", description: "preserves useful payload and infers completion from collection placement" }
const schema = { type: "object", properties: { unitId: { type: "string" }, completed: { type: "boolean" }, summary: { type: "string" } }, required: ["unitId", "completed", "summary"] }
const [alpha, beta] = await parallel([
  () => agent("work unit alpha", { label: "work-alpha", schema }),
  () => agent("work unit beta", { label: "work-beta", schema }),
])
return {
  completed: alpha ? [{ id: "alpha", unitId: alpha.unitId, summary: alpha.summary }] : [],
  missingWork: beta ? [] : [{ id: "beta", reason: "agent failed" }],
}`;
  const renamedPayload = `export const meta = { name: "write_renamed_payload", description: "preserves runtime payload under a domain field" }
const schema = { type: "object", properties: { output: { type: "string" } }, required: ["output"] }
const [alpha, beta] = await parallel([
  () => agent("work unit alpha", { label: "work-alpha", schema }),
  () => agent("work unit beta", { label: "work-beta", schema }),
])
return {
  completed: alpha ? [{ id: "alpha", data: alpha.output }] : [],
  missingWork: beta ? [] : [{ id: "beta", reason: "agent failed" }],
}`;
  const shallowMutant = `export const meta = { name: "write_mutant", description: "mentions beta without preserving coverage" }
const schema = ${schema}
await parallel([
  () => agent("unrelated structured call", { label: "alpha", schema }),
  () => agent("beta", { label: "beta" }),
])
return { note: "beta" }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  assert.equal((await run(compliant)).passed, true);
  assert.equal((await run(flattened)).passed, true);
  assert.equal((await run(identityAware)).passed, true);
  const sharedContextEvidence = await run(sharedContext);
  assert.equal(sharedContextEvidence.passed, true, JSON.stringify(sharedContextEvidence, null, 2));
  const controlProjectionEvidence = await run(omitsRedundantControlField);
  assert.equal(controlProjectionEvidence.passed, true, JSON.stringify(controlProjectionEvidence, null, 2));
  const renamedPayloadEvidence = await run(renamedPayload);
  assert.equal(renamedPayloadEvidence.passed, true, JSON.stringify(renamedPayloadEvidence, null, 2));
  assert.equal((await run(shallowMutant)).passed, false);
});

test("full scenarios execute writing, editing, reviewing, and debugging behavior", async () => {
  const workflows = new Map([
    [
      "full-write",
      `export const meta = { name: "write", description: "fixture" }
const units = ["alpha", "beta"]
const values = await parallel(units.map(id => () => agent(id, { label: id, schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } })))
return { completed: values.filter(Boolean), missing: units.filter((_id, index) => values[index] === null) }`,
    ],
    [
      "full-edit",
      `export const meta = { name: "edit", description: "fixture", phases: [{ title: "Prepare" }] }
phase("Prepare", { budget: 100 })
await agent("prepare", { label: "prepare" })
const alpha = await workflow("child-workflow", { id: "alpha" })
const beta = await workflow("child-workflow", { id: "beta" })
return { alpha, beta }`,
    ],
    [
      "full-review",
      `export const meta = { name: "review", description: "fixture" }
const claim = await agent("claim", { label: "claim" })
const verdict = await verify(claim, { reviewers: 3, threshold: 0.6, lens: ["source", "logic"] })
return { claim, verdict }`,
    ],
    [
      "full-debug",
      `export const meta = { name: "debug", description: "fixture" }
const result = await retry(
  attempt => agent("attempt " + attempt, { label: "attempt:" + attempt, schema: { type: "object", properties: { acceptable: { type: "boolean" }, answer: { type: "string" } }, required: ["acceptable", "answer"] } }),
  { attempts: 3, until: value => value.acceptable },
)
return { result }`,
    ],
    [
      "full-loop",
      `export const meta = { name: "loop", description: "truthful bounded discovery" }
const schema = { type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { id: { type: "string" }, evidence: { type: "string" } }, required: ["id", "evidence"] } } }, required: ["findings"] }
const findings = []
const failures = []
let dry = 0
let round = 0
while (round < 5 && dry < 2) {
  const label = "discovery-round:" + (round + 1)
  const result = await agent("discover round " + (round + 1), { label, schema })
  if (result === null) {
    failures.push({ id: label })
    dry = 0
  } else if (result.findings.length === 0) dry++
  else {
    dry = 0
    for (const finding of result.findings) if (!findings.some(existing => existing.id === finding.id)) findings.push(finding)
  }
  round++
}
return { findings, failedRounds: failures, termination: dry >= 2 ? "successful-dry" : "maximum", complete: failures.length === 0 && dry >= 2 }`,
    ],
    [
      "full-retry",
      `export const meta = { name: "retry_exact", description: "retry with explicit outcome" }
const schema = { type: "object", properties: { acceptable: { type: "boolean" }, answer: { type: "string" } }, required: ["acceptable", "answer"] }
const ledger = []
const accepted = await retry(
  async attempt => {
    const result = await agent("attempt " + attempt, { label: "retry-attempt:" + (attempt + 1), schema })
    ledger.push({ attempt, result })
    return result
  },
  { attempts: 3, until: value => value !== null && value.acceptable === true },
)
return { accepted, attempts: ledger, exhausted: accepted === null || accepted.acceptable !== true }`,
    ],
  ]);

  for (const scenario of selectComprehensionScenarios("full")) {
    const workflow = workflows.get(scenario.id);
    assert.ok(workflow);
    const evidence = await runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });
    assert.equal(evidence.passed, true, `${scenario.id}: ${evidence.failure?.message}`);
    if (scenario.id === "full-write") {
      assert.equal(evidence.runtime.failures[0]?.errorCode, "AGENT_EXECUTION_ERROR");
      assert.match(evidence.runtime.failures[0]?.message ?? "", /deterministic beta failure/i);
    }
  }
});

test("fan-out-and-synthesize evidence preserves complete contributor coverage through synthesis", async () => {
  const scenario = selectComprehensionScenarios("coverage").find(({ id }) => id === "coverage-fan-out-synthesize");
  assert.ok(scenario);
  const compliant = `export const meta = { name: "fan_out_synthesize", description: "complete contributor coverage" }
const briefs = ["climate", "transport"]
const researchSchema = { type: "object", properties: { id: { type: "string" }, finding: { type: "string" } }, required: ["id", "finding"] }
const results = await parallel(briefs.map(id => () => agent("Research brief " + id, { label: "research:" + id, schema: researchSchema })))
const contributorCoverage = briefs.map((id, index) => ({ id, result: results[index], missing: results[index] === null }))
const synthesis = await agent("Synthesize all intended briefs: " + JSON.stringify(contributorCoverage), {
  label: "synthesis:all-briefs",
  schema: { type: "object", properties: { summary: { type: "string" }, coveredIds: { type: "array" }, missingIds: { type: "array" } }, required: ["summary", "coveredIds", "missingIds"] },
})
return { contributorCoverage, synthesis }`;
  const contributorPromptsMentionSynthesis = `export const meta = { name: "fan_out_synthesis_word", description: "ordinary contributor wording mentions synthesis" }
const briefs = ["climate", "transport"]
const researchSchema = { type: "object", properties: { id: { type: "string" }, finding: { type: "string" } }, required: ["id", "finding"] }
const results = await parallel(briefs.map(id => () => agent("Research " + id + " for the final synthesis", { label: "research:" + id, schema: researchSchema })))
const contributorCoverage = briefs.map((id, index) => ({ id, result: results[index], missing: results[index] === null }))
const synthesis = await agent("Combine complete contributor coverage: " + JSON.stringify(contributorCoverage), {
  label: "final:all-briefs",
  schema: { type: "object", properties: { summary: { type: "string" }, coveredIds: { type: "array" }, missingIds: { type: "array" } }, required: ["summary", "coveredIds", "missingIds"] },
})
return { contributorCoverage, synthesis }`;
  const statusLedgerWithPrettyInput = `export const meta = { name: "fan_out_status_ledger", description: "separate status ledger and synthesis payload" }
const briefs = ["climate", "transport"]
const schema = { type: "object", properties: { id: { type: "string" }, finding: { type: "string" } }, required: ["id", "finding"] }
const results = await parallel(briefs.map(id => () => agent("Research brief " + id, { label: "research:" + id, schema })))
const coverageLedger = briefs.map((id, index) => ({ id, status: results[index] === null ? "missing" : "complete" }))
const synthesisInput = { intendedBriefIds: briefs, climate: results[0], transport: results[1], coverageLedger }
const synthesis = await agent("Synthesize complete coverage:\\n" + JSON.stringify(synthesisInput, null, 2), { label: "synthesis:all", schema })
return { coverageLedger, synthesis }`;
  const misattributesMissingCoverage = `export const meta = { name: "fan_out_wrong_missing", description: "misattributes missing coverage" }
const briefs = ["climate", "transport"]
const schema = { type: "object", properties: { id: { type: "string" }, finding: { type: "string" } }, required: ["id", "finding"] }
const results = await parallel(briefs.map(id => () => agent("Research brief " + id, { label: "research:" + id, schema })))
const coverageLedger = [{ id: "climate", status: "complete" }, { id: "transport", status: "complete", missingClimate: true }]
const synthesisInput = { intendedBriefIds: briefs, climate: results[0], transport: null, coverageLedger }
const synthesis = await agent("Synthesize complete coverage: " + JSON.stringify(synthesisInput), { label: "synthesis:all", schema })
return { coverageLedger, synthesis }`;
  const disassociatesClimatePayload = `export const meta = { name: "fan_out_wrong_payload", description: "scatters climate fields into fabricated data" }
const briefs = ["climate", "transport"]
const schema = { type: "object", properties: { id: { type: "string" }, finding: { type: "string" } }, required: ["id", "finding"] }
const results = await parallel(briefs.map(id => () => agent("Research brief " + id, { label: "research:" + id, schema })))
const coverageLedger = [{ id: "climate", status: "complete" }, { id: "transport", status: "missing" }]
const fabricated = { id: "transport", finding: "fabricated", notes: [results[0].id, results[0].finding] }
const synthesis = await agent("Synthesize with transport missing: " + JSON.stringify(fabricated), { label: "synthesis:all", schema })
return { coverageLedger, synthesis }`;
  const omitsMissingContributor = `export const meta = { name: "fan_out_omission", description: "drops failed contributors" }
const briefs = ["climate", "transport"]
const schema = { type: "object", properties: { id: { type: "string" }, finding: { type: "string" } }, required: ["id", "finding"] }
const results = await parallel(briefs.map(id => () => agent("Research brief " + id, { label: "research:" + id, schema })))
const available = results.filter(Boolean)
const synthesis = await agent("Synthesize available results: " + JSON.stringify(available), { label: "synthesis:available", schema })
return { available, synthesis }`;
  const skipsSynthesis = `export const meta = { name: "fan_out_only", description: "never synthesizes" }
const briefs = ["climate", "transport"]
const schema = { type: "object", properties: { id: { type: "string" }, finding: { type: "string" } }, required: ["id", "finding"] }
const results = await parallel(briefs.map(id => () => agent("Research brief " + id, { label: "research:" + id, schema })))
return { contributorCoverage: briefs.map((id, index) => ({ id, result: results[index] })) }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  const compliantEvidence = await run(compliant);
  assert.equal(compliantEvidence.passed, true, JSON.stringify(compliantEvidence, null, 2));
  const synthesisWordingEvidence = await run(contributorPromptsMentionSynthesis);
  assert.equal(synthesisWordingEvidence.passed, true, JSON.stringify(synthesisWordingEvidence, null, 2));
  const statusLedgerEvidence = await run(statusLedgerWithPrettyInput);
  assert.equal(statusLedgerEvidence.passed, true, JSON.stringify(statusLedgerEvidence, null, 2));
  assert.equal((await run(misattributesMissingCoverage)).passed, false);
  assert.equal((await run(disassociatesClimatePayload)).passed, false);
  assert.equal((await run(omitsMissingContributor)).passed, false);
  assert.equal((await run(skipsSynthesis)).passed, false);
});

test("generate-and-filter evidence enforces generation, deduplication, bounding, and filter provenance", async () => {
  const scenario = selectComprehensionScenarios("coverage").find(({ id }) => id === "coverage-generate-filter");
  assert.ok(scenario);
  const compliant = `export const meta = { name: "generate_filter", description: "deduplicate and bound before filtering" }
const generatorSchema = { type: "object", properties: { candidates: { type: "array" } }, required: ["candidates"] }
const generated = await parallel([0, 1].map(index => () => agent("Generate candidate batch " + index, { label: "generator:" + index, schema: generatorSchema })))
const retained = []
const seen = new Set()
for (const batch of generated) {
  for (const candidate of batch.candidates) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    if (retained.length < 3) retained.push(candidate)
  }
}
const filterSchema = { type: "object", properties: { id: { type: "string" }, accepted: { type: "boolean" }, reason: { type: "string" } }, required: ["id", "accepted", "reason"] }
const decisions = await parallel(retained.map(candidate => () => agent("Filter candidate: " + JSON.stringify(candidate), { label: "filter:" + candidate.id, schema: filterSchema })))
return {
  generatorOutputs: generated,
  retainedIds: retained.map(candidate => candidate.id),
  accepted: decisions.filter(decision => decision?.accepted),
  filterFailures: retained.filter((_candidate, index) => decisions[index] === null).map(candidate => ({ id: candidate.id })),
}`;
  const arraySchemaWithNaturalFilterPrompt = `export const meta = { name: "generate_filter_array", description: "accept array generators and natural filter prompts" }
const generatorSchema = {
  type: "array",
  items: { type: "object", properties: { id: { type: "string" }, proposal: { type: "string" } }, required: ["id", "proposal"] },
}
const generated = await parallel([
  () => agent("Return candidate objects", { label: "gen-left", schema: generatorSchema }),
  () => agent("Return candidate objects", { label: "gen-right", schema: generatorSchema }),
])
const retained = []
const seen = new Set()
for (const batch of generated) {
  for (const candidate of batch ?? []) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    if (retained.length < 3) retained.push(candidate)
  }
}
const filterSchema = { type: "object", properties: { accept: { type: "boolean" }, reason: { type: "string" } }, required: ["accept", "reason"] }
const decisions = await parallel(retained.map(candidate => () => agent(
  "Evaluate candidate " + candidate.id + ". Proposal: " + candidate.proposal,
  { label: "filter:" + candidate.id, schema: filterSchema },
)))
return {
  generatorOutputs: generated,
  retainedIds: retained.map(candidate => candidate.id),
  accepted: decisions.map((decision, index) => ({ decision, candidate: retained[index] })).filter(({ decision }) => decision?.accept).map(({ decision, candidate }) => ({
    candidateId: candidate.id,
    accept: decision.accept,
    reason: decision.reason,
  })),
  filterFailures: retained.filter((_candidate, index) => decisions[index] === null).map(candidate => ({ id: candidate.id })),
}`;
  const schemaShapedResults = `export const meta = { name: "generate_filter_schema_shapes", description: "honor nested generator and filter schemas" }
const candidateSchema = { type: "object", properties: { id: { type: "string" }, proposal: { type: "string" } }, required: ["id", "proposal"] }
const generatorSchema = {
  type: "object",
  properties: { candidates: { type: "object", properties: { primary: candidateSchema, shared: candidateSchema }, required: ["primary", "shared"] } },
  required: ["candidates"],
}
const generated = await parallel([
  () => agent("Generate candidate objects left", { label: "generator:left", schema: generatorSchema }),
  () => agent("Generate candidate objects right", { label: "generator:right", schema: generatorSchema }),
])
const retained = []
const seen = new Set()
for (const output of generated) {
  for (const candidate of [output.candidates.primary, output.candidates.shared]) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    if (retained.length < 3) retained.push(candidate)
  }
}
const filterSchema = {
  type: "object",
  properties: {
    candidate: candidateSchema,
    decision: { type: "object", properties: { accept: { type: "boolean" }, rationale: { type: "string" } }, required: ["accept", "rationale"] },
  },
  required: ["candidate", "decision"],
}
const decisions = await parallel(retained.map(candidate => () => agent(
  "Filter candidate " + candidate.id + ": " + candidate.proposal,
  { label: "filter:generator:" + candidate.id, schema: filterSchema },
)))
return {
  generatorOutputs: generated.map((output, index) => ({ source: index, candidates: output.candidates })),
  retainedIds: retained.map(candidate => candidate.id),
  filterResults: decisions.map((decision, index) => ({ id: retained[index].id, decision })),
  accepted: decisions.map((result, index) => ({ result, candidate: retained[index] })).filter(({ result }) => result?.decision.accept).map(({ candidate }) => ({ id: candidate.id, proposal: candidate.proposal })),
  filterFailures: retained.filter((_candidate, index) => decisions[index] === null).map(candidate => ({ id: candidate.id })),
}`;
  const prefixItemGenerators = `export const meta = { name: "generate_filter_prefix_items", description: "honor tuple generator schemas" }
const candidate = (id) => ({ type: "object", properties: { id: { const: id }, proposal: { type: "string" } }, required: ["id", "proposal"] })
const schemas = [
  { type: "array", prefixItems: [candidate("signal-a"), candidate("shared")], items: false },
  { type: "array", prefixItems: [candidate("shared"), candidate("signal-b")], items: false },
]
const generatorOutputs = await parallel([
  () => agent("Produce the first candidate batch", { label: "source:prefix-left", schema: schemas[0] }),
  () => agent("Produce the second candidate batch", { label: "source:prefix-right", schema: schemas[1] }),
])
const retained = []
const seen = new Set()
for (const batch of generatorOutputs) {
  for (const item of batch) {
    if (!seen.has(item.id) && retained.length < 3) {
      seen.add(item.id)
      retained.push(item)
    }
  }
}
const filterSchema = { type: "object", properties: { candidateId: { type: "string" }, accepted: { type: "boolean" }, rationale: { type: "string" } }, required: ["candidateId", "accepted", "rationale"] }
const filterResults = await parallel(retained.map((item, index) => () => agent(
  "Context mentions signal-a shared signal-b. Candidate: " + JSON.stringify(item),
  { label: "filter:prefix:" + index, schema: filterSchema },
)))
return {
  generatorOutputs,
  retainedCandidateIdentities: retained.map(({ id, proposal }) => ({ id, proposal })),
  filterResults,
  acceptedFilterResults: filterResults.filter((result) => result?.accepted),
  filterFailures: retained.flatMap((item, index) => filterResults[index] === null ? [{ candidateId: item.id }] : []),
}`;
  const constCandidateBatches = `export const meta = { name: "generate_filter_const_batches", description: "honor constant candidate batches" }
const left = [{ id: "signal-a", proposal: "proposal:signal-a" }, { id: "shared", proposal: "proposal:shared:first" }]
const right = [{ id: "shared", proposal: "proposal:shared:duplicate" }, { id: "signal-b", proposal: "proposal:signal-b" }]
const generatorSchema = (candidates) => ({ type: "object", properties: { candidates: { const: candidates } }, required: ["candidates"] })
const generatorOutputs = await parallel([
  () => agent("Produce left candidates", { label: "source:left", schema: generatorSchema(left) }),
  () => agent("Produce right candidates", { label: "source:right", schema: generatorSchema(right) }),
])
const retained = []
const seen = new Set()
for (const batch of generatorOutputs) for (const candidate of batch.candidates) {
  if (!seen.has(candidate.id) && retained.length < 3) { seen.add(candidate.id); retained.push(candidate) }
}
const filterSchema = { type: "object", properties: { candidateId: { type: "string" }, accepted: { type: "boolean" }, reason: { type: "string" } }, required: ["candidateId", "accepted", "reason"] }
const decisions = await parallel(retained.map(candidate => () => agent("Filter candidate: " + JSON.stringify(candidate), { label: "filter:" + candidate.id, schema: filterSchema })))
return {
  generatorOutputs,
  retainedIds: retained.map(candidate => candidate.id),
  accepted: decisions.filter(decision => decision?.accepted),
  filterFailures: retained.filter((_candidate, index) => decisions[index] === null).map(candidate => ({ id: candidate.id })),
}`;
  const enumCandidateItems = `export const meta = { name: "generate_filter_enum_items", description: "honor enumerated candidate items" }
const left = [{ id: "left-only", proposal: "proposal:left" }, { id: "shared", proposal: "proposal:shared" }]
const right = [{ id: "shared", proposal: "proposal:shared" }, { id: "right-only", proposal: "proposal:right" }]
const generatorSchema = (allowed) => ({ type: "object", properties: { candidates: { type: "array", items: { enum: allowed }, minItems: 2, maxItems: 2 } }, required: ["candidates"] })
const generatorOutputs = await parallel([
  () => agent("Produce left candidates", { label: "source:left", schema: generatorSchema(left) }),
  () => agent("Produce right candidates", { label: "source:right", schema: generatorSchema(right) }),
])
const retained = []
const seen = new Set()
for (const batch of generatorOutputs) for (const candidate of batch.candidates) {
  if (!seen.has(candidate.id) && retained.length < 3) { seen.add(candidate.id); retained.push(candidate) }
}
const filterSchema = { type: "object", properties: { candidateId: { type: "string" }, accepted: { type: "boolean" }, reason: { type: "string" } }, required: ["candidateId", "accepted", "reason"] }
const decisions = await parallel(retained.map(candidate => () => agent("Filter candidate: " + JSON.stringify(candidate), { label: "filter:" + candidate.id, schema: filterSchema })))
return {
  generatorOutputs,
  retainedIds: retained.map(candidate => candidate.id),
  accepted: decisions.filter(decision => decision?.accepted),
  filterFailures: retained.filter((_candidate, index) => decisions[index] === null).map(candidate => ({ id: candidate.id })),
}`;
  const singleCandidateResults = `export const meta = { name: "generate_filter_single_candidates", description: "deduplicate root candidate results" }
const generatorSchema = { type: "object", properties: { id: { type: "string", const: "shared" }, proposal: { type: "string", enum: ["proposal:fixed"] } }, required: ["id", "proposal"] }
const generated = await parallel([
  () => agent("Generate one candidate left", { label: "source:left", schema: generatorSchema }),
  () => agent("Generate one candidate right", { label: "source:right", schema: generatorSchema }),
])
const retained = []
const seen = new Set()
for (const candidate of generated) {
  if (seen.has(candidate.id)) continue
  seen.add(candidate.id)
  if (retained.length < 3) retained.push(candidate)
}
const filterSchema = { type: "object", properties: { accept: { type: "boolean" }, reason: { type: "string" } }, required: ["accept", "reason"] }
const decisions = await parallel(retained.map(candidate => () => agent("Filter " + candidate.id + ": " + candidate.proposal, { label: "filter:" + candidate.id, schema: filterSchema })))
return {
  generatorOutputs: generated,
  retainedIds: retained.map(candidate => candidate.id),
  accepted: retained.filter((_candidate, index) => decisions[index]?.accept).map((candidate, index) => ({ id: candidate.id, reason: decisions[index].reason })),
  filterFailures: retained.filter((_candidate, index) => decisions[index]?.accept === false).map(candidate => ({ id: candidate.id, status: "rejected" })),
}`;
  const filtersBeforeGeneratorsComplete = `export const meta = { name: "generate_filter_early", description: "starts filters before generation completes" }
const generatorSchema = { type: "object", properties: { candidates: { type: "array" } }, required: ["candidates"] }
const generatorPromises = [0, 1].map(index => agent("Generate candidate batch " + index, { label: "generator:" + index, schema: generatorSchema }))
const retained = [
  { id: "signal-a", proposal: "proposal:signal-a" },
  { id: "shared", proposal: "proposal:shared:first" },
  { id: "signal-b", proposal: "proposal:signal-b" },
]
const filterSchema = { type: "object", properties: { id: { type: "string" }, accepted: { type: "boolean" }, reason: { type: "string" } }, required: ["id", "accepted", "reason"] }
const decisions = await parallel(retained.map(candidate => () => agent("Filter candidate: " + JSON.stringify(candidate), { label: "filter:" + candidate.id, schema: filterSchema })))
const generated = await Promise.all(generatorPromises)
return {
  generatorOutputs: generated,
  retainedIds: retained.map(candidate => candidate.id),
  accepted: decisions.filter(decision => decision?.accepted),
  filterFailures: retained.filter((_candidate, index) => decisions[index] === null).map(candidate => ({ id: candidate.id })),
}`;
  const filtersRawDuplicates = `export const meta = { name: "generate_filter_raw", description: "filters before deduplication and bounding" }
const generatorSchema = { type: "object", properties: { candidates: { type: "array" } }, required: ["candidates"] }
const generated = await parallel([0, 1].map(index => () => agent("Generate candidate batch " + index, { label: "generator:" + index, schema: generatorSchema })))
const raw = generated.flatMap(batch => batch.candidates)
const filterSchema = { type: "object", properties: { id: { type: "string" }, accepted: { type: "boolean" } }, required: ["id", "accepted"] }
const decisions = await parallel(raw.map((candidate, index) => () => agent("Filter candidate: " + JSON.stringify(candidate), { label: "filter:" + candidate.id + ":" + index, schema: filterSchema })))
return { generatorOutputs: generated, retainedIds: raw.map(candidate => candidate.id), accepted: decisions.filter(Boolean), filterFailures: [] }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  const compliantEvidence = await run(compliant);
  assert.equal(compliantEvidence.passed, true, JSON.stringify(compliantEvidence, null, 2));
  const arraySchemaEvidence = await run(arraySchemaWithNaturalFilterPrompt);
  assert.equal(arraySchemaEvidence.passed, true, JSON.stringify(arraySchemaEvidence, null, 2));
  const schemaShapedEvidence = await run(schemaShapedResults);
  assert.equal(schemaShapedEvidence.passed, true, JSON.stringify(schemaShapedEvidence, null, 2));
  const prefixItemEvidence = await run(prefixItemGenerators);
  assert.equal(prefixItemEvidence.passed, true, JSON.stringify(prefixItemEvidence, null, 2));
  const constBatchEvidence = await run(constCandidateBatches);
  assert.equal(constBatchEvidence.passed, true, JSON.stringify(constBatchEvidence, null, 2));
  const enumItemEvidence = await run(enumCandidateItems);
  assert.equal(enumItemEvidence.passed, true, JSON.stringify(enumItemEvidence, null, 2));
  assert.deepEqual(
    enumItemEvidence.runtime.calls.slice(0, 2).map(({ result }) => result),
    [
      {
        candidates: [
          { id: "left-only", proposal: "proposal:left" },
          { id: "shared", proposal: "proposal:shared" },
        ],
      },
      {
        candidates: [
          { id: "shared", proposal: "proposal:shared" },
          { id: "right-only", proposal: "proposal:right" },
        ],
      },
    ],
  );
  const singleCandidateEvidence = await run(singleCandidateResults);
  assert.equal(singleCandidateEvidence.passed, true, JSON.stringify(singleCandidateEvidence, null, 2));
  assert.deepEqual(
    singleCandidateEvidence.runtime.calls.slice(0, 2).map(({ result }) => result),
    [
      { id: "shared", proposal: "proposal:fixed" },
      { id: "shared", proposal: "proposal:fixed" },
    ],
  );
  assert.equal((await run(filtersBeforeGeneratorsComplete)).passed, false);
  assert.equal((await run(filtersRawDuplicates)).passed, false);
});

test("judge-panel evidence requires produced candidates, numeric judges, and the unchanged helper winner", async () => {
  const scenario = selectComprehensionScenarios("coverage").find(({ id }) => id === "coverage-judge-panel");
  assert.ok(scenario);
  const compliant = `export const meta = { name: "judge_panel", description: "rank actual produced candidates" }
const candidateSchema = { type: "object", properties: { id: { type: "string" }, answer: { type: "string" } }, required: ["id", "answer"] }
const attempts = await parallel([
  () => agent("Produce candidate draft-a", { label: "candidate:draft-a", schema: candidateSchema }),
  () => agent("Produce candidate draft-b", { label: "candidate:draft-b", schema: candidateSchema }),
])
const winner = await judgePanel(attempts, { judges: 3, rubric: "factual correctness and logical validity" })
return { attempts, winner }`;
  const wrappedAttempts = `export const meta = { name: "wrapped_judge_panel", description: "preserve attempt provenance" }
const candidateSchema = { type: "object", properties: { id: { type: "string" }, answer: { type: "string" } }, required: ["id", "answer"] }
const producedAttempts = await parallel([
  () => agent("Produce candidate draft-a", { label: "candidate:draft-a", schema: candidateSchema }),
  () => agent("Produce candidate draft-b", { label: "candidate:draft-b", schema: candidateSchema }),
])
const attempts = producedAttempts.map((attempt, index) => ({ workId: "attempt-" + index, attempt }))
const winner = await judgePanel(attempts, { judges: 3, rubric: "factual correctness and logical validity" })
return { producedAttempts: attempts, winningResult: winner }`;
  const enrichedAttempts = `export const meta = { name: "enriched_judge_panel", description: "losslessly enrich produced attempts" }
const candidateSchema = { type: "object", properties: { id: { type: "string" }, answer: { type: "string" } }, required: ["id", "answer"] }
const produced = await parallel([
  () => agent("Produce candidate draft-a", { label: "candidate:draft-a", schema: candidateSchema }),
  () => agent("Produce candidate draft-b", { label: "candidate:draft-b", schema: candidateSchema }),
])
const attempts = produced.map((attempt, index) => ({ ...attempt, index }))
const winner = await judgePanel(attempts, { judges: 3, rubric: "factual correctness and logical validity" })
return { attempts, winner }`;
  const nestedEnrichment = `export const meta = { name: "nested_enriched_judge_panel", description: "retain produced attempts beside enriched judge inputs" }
const candidateSchema = { type: "object", properties: { id: { type: "string" }, answer: { type: "string" } }, required: ["id", "answer"] }
const produced = await parallel([
  () => agent("Produce candidate draft-a", { label: "candidate:draft-a", schema: candidateSchema }),
  () => agent("Produce candidate draft-b", { label: "candidate:draft-b", schema: candidateSchema }),
])
const producedAttempts = produced.map((attempt, index) => ({ workId: "attempt-" + index, index, attempt }))
const judgeInputs = producedAttempts.map(entry => ({ ...entry, notes: [] }))
const winner = await judgePanel(judgeInputs, { judges: 3, rubric: "factual correctness and logical validity" })
return { producedAttempts, winner }`;
  const manualJudges = `export const meta = { name: "manual_judges", description: "bypasses judgePanel" }
const candidateSchema = { type: "object", properties: { id: { type: "string" }, answer: { type: "string" } }, required: ["id", "answer"] }
const attempts = await parallel([
  () => agent("Produce candidate draft-a", { label: "candidate:draft-a", schema: candidateSchema }),
  () => agent("Produce candidate draft-b", { label: "candidate:draft-b", schema: candidateSchema }),
])
const judgments = await parallel(attempts.flatMap((attempt, attemptIndex) => [0, 1, 2].map(judgeIndex => () => agent("Judge " + JSON.stringify(attempt), { label: "manual:" + attemptIndex + ":" + judgeIndex, schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"] } }))))
return { attempts, winner: { index: 1, attempt: attempts[1], score: 1, judgments } }`;
  const addsCandidateAfterPanel = `export const meta = { name: "extra_candidate", description: "adds a third produced candidate after judging" }
const schema = { type: "object", properties: { id: { type: "string" }, answer: { type: "string" } }, required: ["id", "answer"] }
const attempts = await parallel([
  () => agent("Produce candidate draft-a", { label: "candidate:draft-a", schema }),
  () => agent("Produce candidate draft-b", { label: "candidate:draft-b", schema }),
])
const winner = await judgePanel(attempts, { judges: 3, rubric: "factual correctness and logical validity" })
const extra = await agent("Produce candidate draft-c", { label: "candidate:draft-c", schema })
return { attempts: [...attempts, extra], winner }`;
  const discardsWinner = `export const meta = { name: "discarded_winner", description: "drops the helper result" }
const schema = { type: "object", properties: { id: { type: "string" }, answer: { type: "string" } }, required: ["id", "answer"] }
const attempts = await parallel([
  () => agent("Produce candidate draft-a", { label: "candidate:draft-a", schema }),
  () => agent("Produce candidate draft-b", { label: "candidate:draft-b", schema }),
])
await judgePanel(attempts, { judges: 3, rubric: "factual correctness and logical validity" })
return { attempts }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  const compliantEvidence = await run(compliant);
  assert.equal(compliantEvidence.passed, true, JSON.stringify(compliantEvidence, null, 2));
  const wrappedEvidence = await run(wrappedAttempts);
  assert.equal(wrappedEvidence.passed, true, JSON.stringify(wrappedEvidence, null, 2));
  const enrichedEvidence = await run(enrichedAttempts);
  assert.equal(enrichedEvidence.passed, true, JSON.stringify(enrichedEvidence, null, 2));
  const nestedEvidence = await run(nestedEnrichment);
  assert.equal(nestedEvidence.passed, true, JSON.stringify(nestedEvidence, null, 2));
  assert.equal((await run(manualJudges)).passed, false);
  assert.equal((await run(addsCandidateAfterPanel)).passed, false);
  assert.equal((await run(discardsWinner)).passed, false);
});

test("edit evidence identifies preparation by timeline and requires returned child results", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-edit");
  assert.ok(scenario);
  const compliant = `export const meta = { name: "edit_variant", description: "arbitrary preparation label", phases: [{ title: "Prepare" }] }
phase("Prepare", { budget: 100 })
const preparation = await agent("prepare child runs", { label: "child:preparation" })
const alpha = await workflow("child-workflow", { id: "alpha" })
const beta = await workflow("child-workflow", { id: "beta" })
return { preparation, childResults: { alpha, beta } }`;
  const discardsChildren = `export const meta = { name: "edit_mutant", description: "discards child results", phases: [{ title: "Prepare" }] }
phase("Prepare", { budget: 100 })
await agent("prepare child runs", { label: "prepare" })
await workflow("child-workflow", { id: "alpha" })
await workflow("child-workflow", { id: "beta" })
return { discarded: true }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  assert.equal((await run(compliant)).passed, true);
  assert.equal((await run(discardsChildren)).passed, false);
});

test("review evidence requires an executed quality helper and returned claim plus verdict", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-review");
  assert.ok(scenario);
  const commentOnly = `export const meta = { name: "review", description: "fixture" }
// verify(
const first = await agent("first", { label: "first" })
const second = await agent("second", { label: "second" })
return { unrelated: [first, second] }`;

  const evidence = await runComprehensionScenario({
    scenario,
    provider: "fixture",
    model: "fixture/model",
    extensionVersion: "2.13.1",
    contractVersions: { format: "1.0.0", content: "2.13.1" },
    skillVersion: "2.13.1",
    generate: async () => generation(commentOnly),
  });

  assert.equal(evidence.passed, false);
  assert.equal(evidence.runtime.assertions.find(({ name }) => name === "quality:executed")?.passed, false);
  assert.equal(evidence.runtime.assertions.find(({ name }) => name === "review:returned-outcome")?.passed, false);
});

test("review evidence traces the claim through the exact verify contract", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-review");
  assert.ok(scenario);
  const compliant = `export const meta = { name: "review_variant", description: "returns exact verification ledger" }
const claim = await agent("produce claim", { label: "claim" })
const helperVerdict = await verify(claim, { reviewers: 3, threshold: 0.6, lens: ["source", "logic"] })
return { claim, helperVerdict }`;
  const descriptiveLenses = `export const meta = { name: "review_descriptive_lenses", description: "uses descriptive source and logic lenses" }
const claim = await agent("produce claim", { label: "claim" })
const verdict = await verify(claim, {
  reviewers: 3,
  threshold: 0.6,
  lens: ["Adversarial source review", "Adversarial logic review"],
})
return { claim, verdict }`;
  const structuredClaimProjection = `export const meta = { name: "review_structured_claim", description: "verifies a lossless claim projection" }
const produced = await agent("produce claim", {
  label: "claim",
  schema: {
    type: "object",
    properties: { claim: { type: "string" } },
    required: ["claim"],
    additionalProperties: false,
  },
})
const claim = produced.claim
const verdict = await verify(claim, { reviewers: 3, threshold: 0.6, lens: ["source", "logic"] })
return { claim, verdict }`;
  const morphologicalLenses = `export const meta = { name: "review_logical_lenses", description: "uses source verification and logical validity lenses" }
const claim = await agent("produce claim", { label: "claim" })
const verdict = await verify(claim, {
  reviewers: 3,
  threshold: 0.6,
  lens: ["source verification", "logical validity"],
})
return { claim, verdict }`;
  const fabricated = `export const meta = { name: "review_mutant", description: "unrelated verification" }
const claim = await agent("produce claim", { label: "claim" })
await verify("unrelated constant", { reviewers: 3, threshold: 0.6, lens: ["source", "logic"] })
return { claim, verdict: "fabricated" }`;
  const ignoredOptions = `export const meta = { name: "review_ignored_options", description: "uses invented verify options" }
const claim = await agent("produce claim", { label: "claim" })
const helperVerdict = await verify({ claim }, { prompt: "source and logic", label: "verify-claim" })
return { claim, helperVerdict }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  assert.equal((await run(compliant)).passed, true);
  assert.equal((await run(descriptiveLenses)).passed, true);
  assert.equal((await run(structuredClaimProjection)).passed, true);
  assert.equal((await run(morphologicalLenses)).passed, true);
  assert.equal((await run(fabricated)).passed, false);
  assert.equal((await run(ignoredOptions)).passed, false);
});

test("debug evidence requires bounded helper attempts and a returned accepted outcome", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-debug");
  assert.ok(scenario);
  const commentOnly = `export const meta = { name: "debug", description: "fixture" }
// retry(
const first = await agent("first", { label: "first" })
const second = await agent("second", { label: "second" })
return { unrelated: [first, second] }`;

  const evidence = await runComprehensionScenario({
    scenario,
    provider: "fixture",
    model: "fixture/model",
    extensionVersion: "2.13.1",
    contractVersions: { format: "1.0.0", content: "2.13.1" },
    skillVersion: "2.13.1",
    generate: async () => generation(commentOnly),
  });

  assert.equal(evidence.passed, false);
  assert.equal(evidence.runtime.assertions.find(({ name }) => name === "control:retried")?.passed, false);
  assert.equal(evidence.runtime.assertions.find(({ name }) => name === "debug:returned-outcome")?.passed, false);
});

test("debug evidence uses controlled validity and returns the accepted agent result", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-debug");
  assert.ok(scenario);
  const compliant = `export const meta = { name: "debug_variant", description: "bounded semantic gate" }
const schema = { type: "object", properties: { acceptable: { type: "boolean" }, answer: { type: "string" } }, required: ["acceptable", "answer"] }
const outcome = await gate(
  (feedback, attempt) => agent("answer the task; feedback=" + (feedback ?? "none"), { label: "attempt:" + attempt, schema }),
  value => value.acceptable ? { ok: true } : { ok: false, feedback: "make the answer acceptable" },
  { attempts: 3 },
)
return { acceptedResult: outcome.value, attempts: outcome.attempts }`;
  const acceptedProjection = `export const meta = { name: "debug_projection", description: "returns required accepted fields" }
const schema = { type: "object", additionalProperties: false, properties: { acceptable: { type: "boolean" }, answer: { type: "string" } }, required: ["acceptable", "answer"] }
const outcome = await gate(
  (feedback, attempt) => agent("answer" + (feedback ? ": " + feedback : ""), { label: "attempt:" + attempt, schema }),
  value => value.acceptable ? { ok: true } : { ok: false, feedback: "make acceptable" },
  { attempts: 3 },
)
return { accepted: outcome.ok ? { acceptable: outcome.value.acceptable, answer: outcome.value.answer } : null }`;
  const fabricated = `export const meta = { name: "debug_mutant", description: "fabricates success" }
let checks = 0
await gate(
  (_feedback, attempt) => agent("attempt", { label: "attempt:" + attempt }),
  () => ({ ok: ++checks > 1 }),
  { attempts: 2 },
)
return { ok: true, result: "fabricated" }`;
  const documentedGate = `export const meta = { name: "debug_documented_gate", description: "uses documented feedback contract" }
const schema = { type: "object", properties: { acceptable: { type: "boolean" }, answer: { type: "string" }, feedback: { type: "string" } }, required: ["acceptable", "answer", "feedback"] }
const result = await gate(
  (feedback, attempt) => agent("answer" + (feedback ? ": " + feedback : ""), { label: "gate-attempt:" + (attempt + 1), schema }),
  value => {
    const ok = value.acceptable === true && value.answer.trim().length > 0
    const feedback = value.feedback.trim() || "try again"
    return ok ? { ok: true } : { ok: false, feedback }
  },
  { attempts: 3 },
)
return { result }`;
  const duplicateLabels = `export const meta = { name: "debug_duplicate_labels", description: "reuses one label" }
const schema = { type: "object", properties: { acceptable: { type: "boolean" }, answer: { type: "string" } }, required: ["acceptable", "answer"] }
const result = await retry(
  () => agent("answer the task", { label: "attempt", schema }),
  { attempts: 3, until: value => value.acceptable },
)
return { result }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  assert.equal((await run(compliant)).passed, true);
  assert.equal((await run(acceptedProjection)).passed, true);
  assert.equal((await run(fabricated)).passed, false);
  const documentedGateEvidence = await run(documentedGate);
  assert.equal(documentedGateEvidence.passed, true, JSON.stringify(documentedGateEvidence, null, 2));
  assert.equal((await run(duplicateLabels)).passed, false);
});

test("loop evidence distinguishes failed rounds from successful dryness", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-loop");
  assert.ok(scenario);
  const numericIdentity = `export const meta = { name: "loop_numeric_identity", description: "preserves a stable numeric round identity" }
const schema = { type: "object", properties: { findings: { type: "array" } }, required: ["findings"] }
const findings = []
const failedRounds = []
let dry = 0
for (let index = 0; index < 5 && dry < 2; index++) {
  const result = await agent("round " + index, { label: "round:" + index, schema })
  if (result === null) { failedRounds.push(index); dry = 0; continue }
  findings.push(...result.findings)
  dry = result.findings.length === 0 ? dry + 1 : 0
}
return { findings, failedRounds, termination: "successful dry rounds", complete: failedRounds.length === 0 }`;
  const hardCodesFinding = `export const meta = { name: "loop_fabricated", description: "discards agent findings" }
const schema = { type: "object", properties: { findings: { type: "array" } }, required: ["findings"] }
const failedRounds = []
let dry = 0
for (let index = 0; index < 5 && dry < 2; index++) {
  const result = await agent("round " + index, { label: "round:" + index, schema })
  if (result === null) { failedRounds.push(index); dry = 0; continue }
  dry = result.findings.length === 0 ? dry + 1 : 0
}
return { findings: [{ id: "alpha", evidence: "fabricated" }], failedRounds, termination: "successful dry rounds", complete: false }`;
  const countsFailureAsDry = `export const meta = { name: "loop_mutant", description: "counts missing coverage as dry" }
const schema = { type: "object", properties: { findings: { type: "array" } }, required: ["findings"] }
const findings = await loopUntilDry({
  round: async index => {
    const result = await agent("round " + index, { label: "round:" + index, schema })
    return result?.findings ?? []
  },
  consecutiveEmpty: 2,
  maxRounds: 5,
})
return { findings, failedRounds: [], termination: "dry", complete: true }`;

  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  assert.equal((await run(numericIdentity)).passed, true);
  assert.equal((await run(hardCodesFinding)).passed, false);
  const evidence = await run(countsFailureAsDry);
  assert.equal(evidence.passed, false);
  assert.equal(evidence.runtime.assertions.find(({ name }) => name === "loop:successful-dry-stopping")?.passed, false);
  assert.equal(evidence.runtime.assertions.find(({ name }) => name === "loop:truthful-termination")?.passed, false);
});

test("retry evidence rejects async predicates and missing attempt ledgers", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-retry");
  assert.ok(scenario);
  const asyncPredicate = `export const meta = { name: "retry_async_mutant", description: "uses unsupported async until" }
const schema = { type: "object", properties: { acceptable: { type: "boolean" }, answer: { type: "string" } }, required: ["acceptable", "answer"] }
const result = await retry(
  attempt => agent("attempt " + attempt, { label: "attempt:" + attempt, schema }),
  { attempts: 3, until: async value => value !== null && value.acceptable === true },
)
return { accepted: result, attempts: [result], exhausted: false }`;
  const flattenedLedger = `export const meta = { name: "retry_flattened_ledger", description: "preserves result fields in each ledger entry" }
const schema = { type: "object", properties: { acceptable: { type: "boolean" }, answer: { type: "string" } }, required: ["acceptable", "answer"] }
const ledger = []
const result = await retry(
  async attempt => {
    const value = await agent("attempt " + attempt, { label: "attempt:" + attempt, schema })
    ledger.push({ attempt, acceptable: value.acceptable, answer: value.answer })
    return value
  },
  { attempts: 3, until: value => value !== null && value.acceptable === true },
)
return { accepted: result, ledger, exhausted: false }`;
  const finalOnly = `export const meta = { name: "retry_final_mutant", description: "drops attempt history" }
const schema = { type: "object", properties: { acceptable: { type: "boolean" }, answer: { type: "string" } }, required: ["acceptable", "answer"] }
const result = await retry(
  attempt => agent("attempt " + attempt, { label: "attempt:" + attempt, schema }),
  { attempts: 3, until: value => value !== null && value.acceptable === true },
)
return { accepted: result, exhausted: false }`;
  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  assert.equal((await run(asyncPredicate)).passed, false);
  assert.equal((await run(flattenedLedger)).passed, true);
  assert.equal((await run(finalOnly)).passed, false);
});

test("edit evidence requires sequential child invocations after preparation", async () => {
  const scenario = selectComprehensionScenarios("full").find(({ id }) => id === "full-edit");
  assert.ok(scenario);
  const childrenOutOfOrder = `export const meta = { name: "edit", description: "fixture", phases: [{ title: "Prepare" }] }
phase("Prepare", { budget: 100 })
await agent("prepare", { label: "prepare" })
const beta = await workflow("child-workflow", { id: "beta" })
const alpha = await workflow("child-workflow", { id: "alpha" })
return { alpha, beta }`;

  const evidence = await runComprehensionScenario({
    scenario,
    provider: "fixture",
    model: "fixture/model",
    extensionVersion: "2.13.1",
    contractVersions: { format: "1.0.0", content: "2.13.1" },
    skillVersion: "2.13.1",
    generate: async () => generation(childrenOutOfOrder),
  });

  assert.equal(evidence.passed, false);
  assert.equal(evidence.runtime.assertions.find(({ name }) => name === "nesting:sequential")?.passed, false);
});

test("parse and runtime failures remain separately visible instead of throwing", async () => {
  const scenario = selectComprehensionScenarios("quick")[0];
  assert.ok(scenario);
  const run = (workflow: string) =>
    runComprehensionScenario({
      scenario,
      provider: "fixture",
      model: "fixture/model",
      extensionVersion: "2.13.1",
      contractVersions: { format: "1.0.0", content: "2.13.1" },
      skillVersion: "2.13.1",
      generate: async () => generation(workflow),
    });

  const malformed = await run("not a workflow");
  assert.equal(malformed.passed, false);
  assert.equal(malformed.failure?.stage, "parse");
  assert.match(malformed.failure?.message ?? "", /meta|export|parse|script|unexpected token/i);
  assert.deepEqual(malformed.runtime.calls, []);

  const throwsAtRuntime = await run(`export const meta = { name: "throws", description: "valid source" }
throw new Error("deterministic runtime failure")`);
  assert.equal(throwsAtRuntime.passed, false);
  assert.equal(throwsAtRuntime.failure?.stage, "runtime");
  assert.match(throwsAtRuntime.failure?.message ?? "", /deterministic runtime failure/i);
});

test("provider generation failures retain complete versioned evidence", async () => {
  const scenario = selectComprehensionScenarios("quick")[0];
  assert.ok(scenario);
  const evidence = await runComprehensionScenario({
    scenario,
    provider: "provider-x",
    modelSelection: {
      requested: "provider-x/model-y:high",
      resolved: "provider-x/model-y",
      thinkingLevel: "high",
    },
    extensionVersion: "2.13.1",
    contractVersions: { format: "1.0.0", content: "2.13.1" },
    skillVersion: "2.13.1",
    generate: async () => {
      throw new ModelGenerationError(
        "quota unavailable",
        {
          discovered: true,
          loaded: true,
          toolCalls: [{ tool: "read", path: "/installed/skills/workflow-authoring/SKILL.md" }],
        },
        { input: 80, output: 20, total: 100, cost: 0.002, cacheRead: 5, cacheWrite: 0 },
      );
    },
  });

  assert.equal(evidence.formatVersion, 2);
  assert.equal(evidence.provider, "provider-x");
  assert.deepEqual(evidence.modelSelection, {
    requested: "provider-x/model-y:high",
    resolved: "provider-x/model-y",
    thinkingLevel: "high",
  });
  assert.equal(evidence.extensionVersion, "2.13.1");
  assert.deepEqual(evidence.contractVersions, { format: "1.0.0", content: "2.13.1" });
  assert.equal(evidence.skillVersion, "2.13.1");
  assert.equal(evidence.task.id, "quick-write");
  assert.equal(evidence.generatedWorkflow, null);
  assert.equal(evidence.failure?.stage, "generation");
  assert.equal(evidence.failure?.message, "quota unavailable");
  assert.equal(evidence.skillLoadingEvidence.loaded, true);
  assert.equal(evidence.tokenUsage?.total, 100);
  assert.equal(evidence.passed, false);
});
