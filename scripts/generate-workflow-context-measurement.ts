import { resolve } from "node:path";
import {
  checkWorkflowContextMeasurement,
  measureWorkflowContextSurfaces,
  WORKFLOW_CONTEXT_MEASUREMENT_PATH,
  writeWorkflowContextMeasurement,
} from "../src/workflow-context-measurement.js";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const measurement = check ? measureWorkflowContextSurfaces() : writeWorkflowContextMeasurement(root);
const {
  permanentWorkflowPrompt,
  providerVisibleWorkflowToolDefinition,
  registeredSkillsDiscovery,
  workflowAuthoringSkillCorpus,
  representativeAuthoringProfiles,
} = measurement.surfaces;

console.log(`Permanent workflow prompt: ${permanentWorkflowPrompt.bytes} bytes`);
console.log(`Provider-visible workflow tool definition: ${providerVisibleWorkflowToolDefinition.bytes} bytes`);
console.log(
  `Registered skills discovery (all ${registeredSkillsDiscovery.skills.length}): ${registeredSkillsDiscovery.bytes} bytes`,
);
for (const skill of registeredSkillsDiscovery.skills) {
  console.log(`  - ${skill.root}: ${skill.bytes} bytes`);
}
console.log(
  `Workflow-authoring skill corpus: ${workflowAuthoringSkillCorpus.bytes} bytes across ${workflowAuthoringSkillCorpus.files} files`,
);
console.log(`Representative authoring profile median: ${representativeAuthoringProfiles.medianBytes} bytes`);

if (check && !checkWorkflowContextMeasurement(root)) {
  console.error(`Stale workflow context measurement: ${WORKFLOW_CONTEXT_MEASUREMENT_PATH}`);
  process.exitCode = 1;
} else if (check) {
  console.log("Workflow context measurement is fresh.");
} else {
  console.log(`Generated ${WORKFLOW_CONTEXT_MEASUREMENT_PATH}.`);
}
