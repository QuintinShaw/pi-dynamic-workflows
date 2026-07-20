import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import { evaluateWorkflowDeliveryChoice, WORKFLOW_DELIVERY_CHOICE_SCENARIOS } from "../src/workflow-delivery-choice.js";

const ROOT = resolve(import.meta.dirname, "..");
const delayed = WORKFLOW_DELIVERY_CHOICE_SCENARIOS.find(({ id }) => id === "background-delivery");
const inline = WORKFLOW_DELIVERY_CHOICE_SCENARIOS.find(({ id }) => id === "inline-result");

test("delivery-choice scenarios cover background delivery and same-turn inline use", () => {
  assert.ok(delayed);
  assert.ok(inline);
  assert.equal(WORKFLOW_DELIVERY_CHOICE_SCENARIOS.length, 2);
  assert.equal(delayed.expectedBackground, true);
  assert.match(delayed.prompt, /deliver.*later|later.*deliver/i);
  assert.equal(inline.expectedBackground, false);
  assert.match(inline.prompt, /same turn/i);
  assert.match(inline.prompt, /waiting/i);
});

test("delivery-choice scoring accepts the default for later delivery", () => {
  assert.ok(delayed);
  assert.equal(evaluateWorkflowDeliveryChoice(delayed, { script: "return {}" }).passed, true);
  assert.equal(evaluateWorkflowDeliveryChoice(delayed, { script: "return {}", background: true }).passed, true);
  assert.equal(evaluateWorkflowDeliveryChoice(delayed, { script: "return {}", background: false }).passed, false);
});

test("delivery-choice scoring requires background false for same-turn use", () => {
  assert.ok(inline);
  assert.equal(evaluateWorkflowDeliveryChoice(inline, { script: "return {}", background: false }).passed, true);
  assert.equal(evaluateWorkflowDeliveryChoice(inline, { script: "return {}" }).passed, false);
  assert.equal(evaluateWorkflowDeliveryChoice(inline, { script: "return {}", background: true }).passed, false);
});

test("delivery-choice scoring rejects malformed workflow calls", () => {
  assert.ok(delayed);
  assert.equal(evaluateWorkflowDeliveryChoice(delayed, null).passed, false);
  assert.equal(evaluateWorkflowDeliveryChoice(delayed, { background: true }).passed, false);
  assert.equal(evaluateWorkflowDeliveryChoice(delayed, { script: "", background: true }).passed, false);
  assert.equal(evaluateWorkflowDeliveryChoice(delayed, { script: "return {}", background: "true" }).passed, false);
});

test("delivery-choice CLI is package-wired and exposes help without provider calls", () => {
  assert.equal(packageJson.scripts["delivery-choice"], "tsx scripts/run-workflow-delivery-choice.ts");
  assert.equal(packageJson.scripts["check:scripts"], "tsc -p tsconfig.scripts.json");
  assert.match(packageJson.scripts.check, /check:scripts/);
  assert.doesNotMatch(packageJson.scripts.test, /delivery-choice/i);
  assert.doesNotMatch(packageJson.scripts["release:check"], /delivery-choice/i);
  assert.doesNotMatch(packageJson.scripts.prepublishOnly, /delivery-choice/i);

  const help = execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-workflow-delivery-choice.ts", "--help"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  assert.match(help, /--model <provider\/model>/i);
  assert.match(help, /--output <path>/i);
});
