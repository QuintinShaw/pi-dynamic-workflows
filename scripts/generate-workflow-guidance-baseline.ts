import { resolve } from "node:path";
import {
  renderWorkflowGuidanceBaseline,
  WORKFLOW_GUIDANCE_BASELINE_PATH,
  writeWorkflowGuidanceBaseline,
} from "../src/workflow-release-gate.js";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");

if (check) {
  const { readFileSync } = await import("node:fs");
  if (readFileSync(resolve(root, WORKFLOW_GUIDANCE_BASELINE_PATH), "utf8") !== renderWorkflowGuidanceBaseline(root)) {
    console.warn(`Non-contractual workflow prose drift: ${WORKFLOW_GUIDANCE_BASELINE_PATH}`);
  } else {
    console.log("Workflow guidance prose baseline is unchanged.");
  }
} else {
  writeWorkflowGuidanceBaseline(root);
  console.log(`Generated ${WORKFLOW_GUIDANCE_BASELINE_PATH}.`);
}
