import assert from "node:assert/strict";
import test from "node:test";
import {
  CapabilityClassification,
  CapabilityOrigin,
  CapabilitySupport,
  ComprehensionSuite,
  ComprehensionTaskKind,
  DiagnosticSeverity,
  DiscoveryPlacement,
  WorkflowAuthoringProtection,
  WorkflowReleaseDiagnosticCode,
} from "../src/enums.js";

test("workflow enums preserve their evidence and release wire values", () => {
  assert.deepEqual(Object.values(CapabilityClassification), [
    "runtime-global",
    "workflow-tool-input",
    "script-contract",
    "compatibility-behavior",
    "internal-substrate",
    "dynamic-reference",
  ]);
  assert.deepEqual(Object.values(CapabilitySupport), ["supported", "compatibility", "internal"]);
  assert.deepEqual(Object.values(DiscoveryPlacement), ["compact-guidance", "workflow-authoring-skill", "none"]);
  assert.deepEqual(Object.values(CapabilityOrigin), ["project", "tool-adapter", "vm-realm", "live-configuration"]);
  assert.deepEqual(Object.values(DiagnosticSeverity), ["error", "warning", "information"]);
  assert.deepEqual(Object.values(ComprehensionSuite), ["quick", "full", "coverage"]);
  assert.deepEqual(Object.values(ComprehensionTaskKind), ["write", "edit", "review", "debug"]);
  assert.deepEqual(Object.values(WorkflowAuthoringProtection), ["behaviorally-covered", "guidance-frozen"]);
  assert.equal(WorkflowReleaseDiagnosticCode.MISSING_AUTHORING_COVERAGE, "MISSING_AUTHORING_COVERAGE");
  assert.equal(WorkflowReleaseDiagnosticCode.PROTECTED_GUIDANCE_DRIFT, "PROTECTED_GUIDANCE_DRIFT");
  assert.equal(WorkflowReleaseDiagnosticCode.UNKNOWN_COMPREHENSION_SCENARIO, "UNKNOWN_COMPREHENSION_SCENARIO");
});
