import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("README documents additive AI Code Flow compatibility APIs and limitations", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  for (const expected of [
    "{ scriptPath",
    "agentTypePolicy",
    "argsPatch",
    "effort",
    "plain JSON Schema",
    "one level",
    "JSON-serializable",
    "workflow cwd",
    "keywordTriggerWord",
  ]) {
    assert.match(readme, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), expected);
  }
});
