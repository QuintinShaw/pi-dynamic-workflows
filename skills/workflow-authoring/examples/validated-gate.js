export const meta = {
  name: "validated_gate",
  description: "Use validator feedback to steer bounded structured attempts through gate()",
  phases: [{ title: "Validate" }],
};

// ADAPT: replace the task, structured fields, and task-owned acceptance policy.
const task = args && typeof args.task === "string" ? args.task : "Produce an acceptable answer.";
const maxAttempts =
  args && Number.isInteger(args.maxAttempts) ? Math.max(1, Math.min(args.maxAttempts, 5)) : 3;
const resultSchema = {
  type: "object",
  properties: {
    acceptable: { type: "boolean" },
    answer: { type: "string" },
    feedback: { type: "string" },
  },
  required: ["acceptable", "answer", "feedback"],
};
const ledger = [];

phase("Validate");
const outcome = await gate(
  async (feedback, attempt) => {
    // gate() supplies undefined feedback initially and a zero-based attempt index.
    const value = await agent(
      `${task}${feedback ? ` Address this validator feedback: ${feedback}` : ""}`,
      {
        label: `gate-attempt:${attempt + 1}`,
        schema: resultSchema,
      },
    );
    ledger.push({
      attempt: attempt + 1,
      feedbackReceived: feedback ?? null,
      accepted: false,
      validatorFeedback: null,
      value,
    });
    return value;
  },
  (value) => {
    // The validator must return an object. A bare boolean is never an accepting verdict.
    const ok = value !== null && value.acceptable === true && value.answer.trim().length > 0;
    const feedback =
      value === null
        ? "The previous attempt returned no usable result."
        : value.feedback.trim() || "The answer did not satisfy the acceptance policy.";
    const entry = ledger[ledger.length - 1];
    entry.accepted = ok;
    entry.validatorFeedback = ok ? null : feedback;
    return ok ? { ok: true } : { ok: false, feedback };
  },
  { attempts: maxAttempts },
);

// INVARIANT: return gate exhaustion explicitly together with every attempt and feedback handoff.
return {
  ok: outcome.ok,
  value: outcome.value,
  attempts: outcome.attempts,
  ledger,
};
