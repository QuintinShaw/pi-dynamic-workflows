export const meta = {
  name: "fan_out_and_synthesize",
  description: "Run bounded independent work, retain a complete coverage ledger, then synthesize",
  phases: [{ title: "Fan out" }, { title: "Synthesize" }],
};

// ADAPT: validate and bound args.work for the task before invoking this workflow.
const work = args && Array.isArray(args.work) ? args.work : [];

phase("Fan out");
const fanOutResults = await parallel(
  work.map((unit, index) => () =>
    agent(
      `Complete this independent work unit. Return only evidence relevant to it.\n\n${JSON.stringify(unit)}`,
      // INVARIANT: index plus a stable task-owned id keeps labels unique.
      { label: `fanout:${index}:${String(unit.id)}` },
    ),
  ),
);

// INVARIANT: preserve every intended identity before filtering or synthesis.
const ledger = work.map((unit, index) => ({
  id: String(unit.id),
  status: fanOutResults[index] === null ? "failed" : "complete",
  result: fanOutResults[index],
}));

phase("Synthesize");
const synthesis = await agent(
  `Synthesize the complete fan-out ledger below. Distinguish covered work from failed/missing coverage; do not invent results.\n\n${JSON.stringify(ledger)}`,
  {
    label: "synthesize-complete-set",
    // ADAPT: keep the schema small and aligned with downstream field access.
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        coveredIds: { type: "array", items: { type: "string" } },
        failedIds: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "coveredIds", "failedIds"],
    },
  },
);

// INVARIANT: return plain serializable data, including missing-coverage identities.
return { ledger, synthesis };
