export const meta = {
  name: "structured_output",
  description: "Validate agent output with a plain JSON Schema before JavaScript consumes fields",
  phases: [{ title: "Extract" }],
};

// ADAPT: validate and bound work, then keep the schema as small as downstream JavaScript needs.
const work = args && Array.isArray(args.work) ? args.work.slice(0, 8) : [{ id: "sample" }];
const outputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["summary", "confidence"],
};
const outputs = [];
const missing = [];

phase("Extract");
for (let index = 0; index < work.length; index++) {
  const item = work[index];
  const id = String(item.id);
  const result = await agent(`Summarize this item: ${JSON.stringify(item)}`, {
    label: `structured:${index}:${id}`,
    schema: outputSchema,
  });
  if (result === null) {
    missing.push(id);
    outputs.push({ id, status: "missing", summary: null });
    continue;
  }
  // INVARIANT: field access happens only after schema validation guarantees this shape.
  outputs.push({ id, status: "complete", summary: result.summary.toUpperCase(), confidence: result.confidence });
}

return { outputs, missing, complete: missing.length === 0 };
