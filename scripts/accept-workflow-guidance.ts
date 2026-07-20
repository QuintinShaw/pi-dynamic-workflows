import { resolve } from "node:path";
import { acceptWorkflowGuidance } from "../src/accept-workflow-guidance.js";

const root = resolve(import.meta.dirname, "..");

try {
  const accepted = acceptWorkflowGuidance(root, process.argv.slice(2));
  for (const { path, previousSha256, sha256, changed } of accepted) {
    console.log(changed ? `Accepted ${path}: ${previousSha256} -> ${sha256}` : `Already accepted ${path}: ${sha256}`);
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
