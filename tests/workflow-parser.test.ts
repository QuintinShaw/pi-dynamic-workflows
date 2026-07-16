import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowScript } from "../src/workflow.js";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  model: 'provider/default-model',
  phases: [{ title: 'Scan', detail: 'Collect inputs', model: 'default' }]
}

phase('Scan')
return { ok: true }
`;

test("parseWorkflowScript accepts literal workflow metadata", () => {
  const parsed = parseWorkflowScript(validScript);
  assert.equal(parsed.meta.name, "demo_workflow");
  assert.equal(parsed.meta.description, "A useful workflow");
  assert.deepEqual(parsed.meta.phases, [{ title: "Scan", detail: "Collect inputs", model: "default" }]);
  assert.match(parsed.body, /phase\('Scan'\)/);
  assert.doesNotMatch(parsed.body, /export const meta/);
});

test("parseWorkflowScript accepts static template literals", () => {
  const parsed = parseWorkflowScript("export const meta = { name: `demo`, description: `static` }\nreturn true");
  assert.equal(parsed.meta.name, "demo");
  assert.equal(parsed.meta.description, "static");
});

test("parseWorkflowScript requires meta export first", () => {
  assert.throws(
    () => parseWorkflowScript("const x = 1\nexport const meta = { name: 'demo', description: 'desc' }"),
    /must be the first statement/,
  );
});

test("parseWorkflowScript requires name and description", () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'demo' }"), /meta.description/);
  assert.throws(() => parseWorkflowScript("export const meta = { description: 'desc' }"), /meta.name/);
});

test("parseWorkflowScript rejects non-literal metadata", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: makeName(), description: 'desc' }"),
    /non-literal node type.*CallExpression/,
  );
  assert.throws(
    () => parseWorkflowScript("const name = 'demo'; export const meta = { name, description: 'desc' }"),
    /must be the first statement/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: name, description: 'desc' }"),
    /non-literal node type.*Identifier/,
  );
});

test("parseWorkflowScript rejects object hazards", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { ...base, name: 'demo', description: 'desc' }"),
    /spread not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { ['name']: 'demo', description: 'desc' }"),
    /computed keys not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { __proto__: {}, name: 'demo', description: 'desc' }"),
    /reserved key name/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { get name() { return 'demo' }, description: 'desc' }"),
    /methods\/accessors not allowed/,
  );
});

test("parseWorkflowScript rejects array hazards", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [,,] }"),
    /sparse arrays not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [...items] }"),
    /spread not allowed/,
  );
});

test("parseWorkflowScript rejects template interpolation", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: `demo_$" + "{id}`, description: 'desc' }"),
    /template interpolation not allowed/,
  );
});

// ─── Negative / error-path tests ───────────────────────────────────────────────

test("parseWorkflowScript rejects empty string", () => {
  assert.throws(() => parseWorkflowScript(""), /must be the first statement/);
});

test("parseWorkflowScript rejects whitespace-only string", () => {
  assert.throws(() => parseWorkflowScript("   "), /must be the first statement/);
});

test("parseWorkflowScript rejects script without meta export", () => {
  assert.throws(() => parseWorkflowScript("return 42"), /must be the first statement/);
});

test("parseWorkflowScript rejects meta without const keyword", () => {
  assert.throws(
    () => parseWorkflowScript("export var meta = { name: 'demo', description: 'desc' }"),
    /must be `export const meta/,
  );
});

test("parseWorkflowScript rejects meta with wrong variable name", () => {
  assert.throws(
    () => parseWorkflowScript("export const x = { name: 'demo', description: 'desc' }"),
    /must declare `meta`/,
  );
});

test("parseWorkflowScript rejects multiple declarations", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }, x = 1"),
    /must declare only/,
  );
});

test("parseWorkflowScript rejects meta without init value", () => {
  assert.throws(() => parseWorkflowScript("export const meta"), /SyntaxError|must have a literal value/);
});

test("parseWorkflowScript rejects empty name string", () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: '', description: 'desc' }"), /non-empty string/);
});

test("parseWorkflowScript rejects empty description string", () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'demo', description: '' }"), /non-empty string/);
});

test("parseWorkflowScript rejects phases that is not an array", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: 'scalar' }"),
    /must be an array/,
  );
});

test("parseWorkflowScript rejects phases without title", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [{ detail: 'x' }] }"),
    /must have a title string/,
  );
});

test("parseWorkflowScript rejects meta.model with wrong type", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', model: 123 }"),
    /must be a string/,
  );
});

test("parseWorkflowScript still parses a removed/unknown meta field (e.g. whenToUse)", () => {
  // whenToUse is no longer an official field; a script that still sets it must keep
  // parsing (it's just ignored), not throw.
  const parsed = parseWorkflowScript(
    "export const meta = { name: 'demo', description: 'desc', whenToUse: 'legacy' }\nreturn 1",
  );
  assert.equal(parsed.meta.name, "demo");
});

test("parseWorkflowScript ignores nondeterministic API names in comments and strings", () => {
  const parsed = parseWorkflowScript(
    "export const meta = { name: 'demo', description: 'desc' }\n" +
      "// Date.now() Math.random() new Date()\n" +
      "return `Date.now() Math.random() new Date()`",
  );
  assert.match(parsed.body, /Date\.now\(\)/);
});

test("parseWorkflowScript rejects nondeterministic APIs", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn Date.now()"),
    /must be deterministic/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn Math.random()"),
    /must be deterministic/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn new Date()"),
    /must be deterministic/,
  );
});
