import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { checkWorkflowRelease, parseNpmPackFilePaths } from "../src/workflow-release-gate.js";

const root = resolve(import.meta.dirname, "..");
const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
});
const publishableFiles = parseNpmPackFilePaths(output);
const diagnostics = checkWorkflowRelease({ root, publishableFiles });

for (const item of diagnostics) {
  const stream = item.severity === "error" ? console.error : console.warn;
  stream(`[${item.severity}] ${item.code} (${item.subject}): ${item.message}`);
}

const errors = diagnostics.filter(({ severity }) => severity === "error");
if (errors.length > 0) {
  console.error(`Workflow release gate failed with ${errors.length} error(s).`);
  process.exitCode = 1;
} else {
  console.log(`Workflow release gate passed with ${diagnostics.length} warning(s).`);
}
