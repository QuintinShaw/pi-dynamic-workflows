/** Classifies a workflow capability by its runtime and documentation role. */
export enum CapabilityClassification {
  RUNTIME_GLOBAL = "runtime-global",
  WORKFLOW_TOOL_INPUT = "workflow-tool-input",
  SCRIPT_CONTRACT = "script-contract",
  COMPATIBILITY_BEHAVIOR = "compatibility-behavior",
  INTERNAL_SUBSTRATE = "internal-substrate",
  DYNAMIC_REFERENCE = "dynamic-reference",
}

/** Declares whether workflow authors should use a capability. */
export enum CapabilitySupport {
  SUPPORTED = "supported",
  COMPATIBILITY = "compatibility",
  INTERNAL = "internal",
}

/** Identifies the model-visible surface responsible for discovery. */
export enum DiscoveryPlacement {
  COMPACT_GUIDANCE = "compact-guidance",
  WORKFLOW_AUTHORING_SKILL = "workflow-authoring-skill",
  NONE = "none",
}

/** Names the subsystem that owns a capability's behavior. */
export enum CapabilityOrigin {
  PROJECT = "project",
  TOOL_ADAPTER = "tool-adapter",
  VM_REALM = "vm-realm",
  LIVE_CONFIGURATION = "live-configuration",
}

/** Severity carried by capability-alignment diagnostics. */
export enum DiagnosticSeverity {
  ERROR = "error",
  WARNING = "warning",
  INFORMATION = "information",
}

/** Optional model-comprehension scenario groups. */
export enum ComprehensionSuite {
  QUICK = "quick",
  FULL = "full",
  COVERAGE = "coverage",
}

/** Authoring operation exercised by a comprehension scenario. */
export enum ComprehensionTaskKind {
  WRITE = "write",
  EDIT = "edit",
  REVIEW = "review",
  DEBUG = "debug",
}

/** Whether authoring guidance may be optimized against behavioral evidence or must remain frozen. */
export enum WorkflowAuthoringProtection {
  BEHAVIORALLY_COVERED = "behaviorally-covered",
  GUIDANCE_FROZEN = "guidance-frozen",
}

/** Machine-readable release-gate failure and warning domains. */
export enum WorkflowReleaseDiagnosticCode {
  INCOMPATIBLE_VERSION = "INCOMPATIBLE_VERSION",
  MISSING_BEHAVIOR_EVIDENCE = "MISSING_BEHAVIOR_EVIDENCE",
  UNRESOLVED_BEHAVIOR_EVIDENCE = "UNRESOLVED_BEHAVIOR_EVIDENCE",
  BROKEN_CONTRACT_REFERENCE = "BROKEN_CONTRACT_REFERENCE",
  MISSING_PACKAGE_RESOURCE = "MISSING_PACKAGE_RESOURCE",
  BROKEN_PACKAGE_LINK = "BROKEN_PACKAGE_LINK",
  STALE_GENERATED_SURFACE = "STALE_GENERATED_SURFACE",
  TOOL_INPUT_MISMATCH = "TOOL_INPUT_MISMATCH",
  RUNTIME_CONSTRAINT_DISAGREEMENT = "RUNTIME_CONSTRAINT_DISAGREEMENT",
  NON_CONTRACTUAL_PROSE_DRIFT = "NON_CONTRACTUAL_PROSE_DRIFT",
  MISSING_AUTHORING_COVERAGE = "MISSING_AUTHORING_COVERAGE",
  UNPROTECTED_AUTHORING_GUIDANCE = "UNPROTECTED_AUTHORING_GUIDANCE",
  PROTECTED_GUIDANCE_DRIFT = "PROTECTED_GUIDANCE_DRIFT",
  UNKNOWN_COMPREHENSION_SCENARIO = "UNKNOWN_COMPREHENSION_SCENARIO",
}
