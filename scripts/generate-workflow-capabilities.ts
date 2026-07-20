import { resolve } from "node:path";
import {
  checkWorkflowCapabilityPublications,
  writeWorkflowCapabilityPublications,
} from "../src/workflow-authoring-reference.js";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");

if (check) {
  const stale = checkWorkflowCapabilityPublications(root);
  if (stale.length > 0) {
    console.error(`Stale generated workflow capability publications:\n${stale.map((path) => `- ${path}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("Generated workflow capability publications are fresh.");
  }
} else {
  writeWorkflowCapabilityPublications(root);
  console.log("Generated workflow capability publications.");
}
