/** One model-facing timing decision for invoking the workflow tool. */
export interface WorkflowDeliveryChoiceScenario {
  id: string;
  prompt: string;
  expectedBackground: boolean;
}

/** Pure scoring result for one captured workflow tool invocation. */
export interface WorkflowDeliveryChoiceEvaluation {
  passed: boolean;
  resolvedBackground: boolean | null;
  assertions: Array<{ name: string; passed: boolean; details: string }>;
}

/** Focused #89 scenarios for default background delivery versus same-turn use. */
export const WORKFLOW_DELIVERY_CHOICE_SCENARIOS: readonly WorkflowDeliveryChoiceScenario[] = [
  {
    id: "background-delivery",
    prompt:
      "Run a workflow to audit the repository from several independent angles. I do not need the result in this turn; let it be delivered back later so I can keep working.",
    expectedBackground: true,
  },
  {
    id: "inline-result",
    prompt:
      "Run a workflow to compare the two proposed designs, then use its result in your answer in this same turn. I am waiting for the result before you respond.",
    expectedBackground: false,
  },
];

/** Score captured workflow arguments without executing the submitted workflow. */
export function evaluateWorkflowDeliveryChoice(
  scenario: WorkflowDeliveryChoiceScenario,
  value: unknown,
): WorkflowDeliveryChoiceEvaluation {
  const input = isRecord(value) ? value : null;
  const hasScript = typeof input?.script === "string" && input.script.trim().length > 0;
  const validBackground = input !== null && (input.background === undefined || typeof input.background === "boolean");
  const resolvedBackground = validBackground ? (typeof input.background === "boolean" ? input.background : true) : null;
  const timingMatches = resolvedBackground === scenario.expectedBackground;
  const assertions = [
    {
      name: "workflow:called-with-script",
      passed: hasScript,
      details: "the model must invoke the real workflow tool shape with a nonblank script",
    },
    {
      name: "background:valid-type",
      passed: validBackground,
      details: "background must be omitted for its true default or supplied as a boolean",
    },
    {
      name: "background:matches-user-timing",
      passed: timingMatches,
      details: scenario.expectedBackground
        ? "later delivery should use the default background run"
        : "same-turn use should pass background: false",
    },
  ];
  return {
    passed: assertions.every(({ passed }) => passed),
    resolvedBackground,
    assertions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
