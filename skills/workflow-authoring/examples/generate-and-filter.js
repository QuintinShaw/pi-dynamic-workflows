export const meta = {
  name: "generate_and_filter",
  description: "Generate divergent candidates, deterministically deduplicate, then apply a rubric",
  phases: [{ title: "Generate" }, { title: "Filter" }],
};

// ADAPT: choose the topic, rubric, candidate schema, and a task-appropriate batch bound.
const topic = args && typeof args.topic === "string" ? args.topic : "candidate ideas";
const rubric = args && typeof args.rubric === "string" ? args.rubric : "Distinct and fit for purpose";
const batchCount = args && Number.isInteger(args.batches) ? Math.max(1, Math.min(args.batches, 8)) : 3;
const maxCandidates =
  args && Number.isInteger(args.maxCandidates) ? Math.max(1, Math.min(args.maxCandidates, 64)) : 24;
const generationSchema = {
  type: "object",
  properties: { candidates: { type: "array", items: { type: "string" } } },
  required: ["candidates"],
};
const filterSchema = {
  type: "object",
  properties: { keep: { type: "boolean" }, reason: { type: "string" } },
  required: ["keep", "reason"],
};

phase("Generate");
const batches = await parallel(
  Array.from({ length: batchCount }, (_, index) => () =>
    agent(`Generate divergent candidates for ${topic}. Seek a distinct angle for batch ${index + 1}.`, {
      label: `generate:${index + 1}`,
      schema: generationSchema,
    }),
  ),
);
const failedBatches = batches.flatMap((batch, index) => (batch === null ? [index + 1] : []));

// INVARIANT: JavaScript performs stable, normalized first-wins deduplication before filter calls.
const seen = new Set();
const deduplicated = [];
for (const batch of batches) {
  for (const candidate of batch?.candidates ?? []) {
    const key = candidate.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      deduplicated.push(candidate);
    }
  }
}
const candidates = deduplicated.slice(0, maxCandidates);
const omitted = deduplicated.slice(maxCandidates);

phase("Filter");
const verdicts = await parallel(
  candidates.map((candidate, index) => () =>
    agent(`Apply this rubric: ${rubric}\nCandidate: ${candidate}`, {
      label: `filter:${index + 1}`,
      schema: filterSchema,
    }),
  ),
);
const failedFilters = candidates.flatMap((candidate, index) => (verdicts[index] === null ? [candidate] : []));

return {
  candidates,
  omitted,
  survivors: candidates.filter((_, index) => verdicts[index]?.keep),
  rejected: candidates.filter((_, index) => verdicts[index] !== null && !verdicts[index].keep),
  failed: { batches: failedBatches, filters: failedFilters },
  complete: failedBatches.length === 0 && failedFilters.length === 0,
};
