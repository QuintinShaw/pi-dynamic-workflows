export const meta = {
  name: "adversarial_verification",
  description: "Produce claims and challenge them in separate skeptical contexts",
  phases: [{ title: "Produce" }, { title: "Verify" }],
};

// ADAPT: validate and bound topics; define the evidence standard and schemas.
const topics =
  args && Array.isArray(args.topics) ? args.topics : [{ id: "sample", topic: "Verify one sample claim" }];
const rubric = args && typeof args.rubric === "string" ? args.rubric : "Evidence is direct and sufficient";
const productionSchema = {
  type: "object",
  properties: {
    claim: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
  },
  required: ["claim", "evidence"],
};
const verdictSchema = {
  type: "object",
  properties: { upheld: { type: "boolean" }, reason: { type: "string" } },
  required: ["upheld", "reason"],
};

phase("Produce");
const productions = await parallel(
  topics.map((topic, index) => () =>
    agent(`Develop a claim and cite its evidence.\n\n${JSON.stringify(topic)}`, {
      label: `produce:${index}:${String(topic.id)}`,
      schema: productionSchema,
    }),
  ),
);
const producerFailures = topics.flatMap((topic, index) =>
  productions[index] === null ? [String(topic.id)] : [],
);
const reviewable = topics.flatMap((topic, index) =>
  productions[index] === null ? [] : [{ topic, production: productions[index] }],
);

phase("Verify");
// INVARIANT: each skeptic is a fresh agent call, never the producer reviewing itself.
const verdicts = await parallel(
  reviewable.map(({ topic, production }, index) => () =>
    agent(
      `Act as a skeptic. Try to refute this production under the rubric.\nRubric: ${rubric}\nProduction: ${JSON.stringify(production)}`,
      { label: `skeptic:${index}:${String(topic.id)}`, schema: verdictSchema },
    ),
  ),
);
const skepticFailures = reviewable.flatMap(({ topic }, index) =>
  verdicts[index] === null ? [String(topic.id)] : [],
);

return {
  reviewed: reviewable.flatMap(({ topic, production }, index) =>
    verdicts[index] === null
      ? []
      : [{ id: String(topic.id), production, verdict: verdicts[index] }],
  ),
  failed: { producers: producerFailures, skeptics: skepticFailures },
  complete: producerFailures.length === 0 && skepticFailures.length === 0,
};
