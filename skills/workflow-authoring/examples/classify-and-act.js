export const meta = {
  name: "classify_and_act",
  description: "Classify bounded work before routing each item to an appropriate actor",
  phases: [{ title: "Classify" }, { title: "Act" }],
};

// ADAPT: validate and bound items, categories, prompts, and schemas for the task.
const items =
  args && Array.isArray(args.items) ? args.items : [{ id: "sample", task: "Classify one sample item" }];
const categories = ["direct", "parallel", "iterative"];
const instructionsByCategory = {
  direct: "Handle directly in one focused pass.",
  parallel: "Divide independent parts, account for each part, then combine them.",
  iterative: "Work in bounded rounds and stop when the task-specific condition is met.",
};
const classificationSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: categories },
    reason: { type: "string" },
  },
  required: ["category", "reason"],
};
const actionSchema = {
  type: "object",
  properties: { outcome: { type: "string" } },
  required: ["outcome"],
};

phase("Classify");
const classifications = await parallel(
  items.map((item, index) => () =>
    agent(`Classify this item as ${categories.join(", ")}.\n\n${JSON.stringify(item)}`, {
      label: `classify:${index}:${String(item.id)}`,
      schema: classificationSchema,
    }),
  ),
);
const failedClassification = items.flatMap((item, index) =>
  classifications[index] === null ? [String(item.id)] : [],
);
const routed = items.flatMap((item, index) =>
  classifications[index] === null ? [] : [{ item, classification: classifications[index] }],
);

// INVARIANT: no routed action starts until the complete classification set exists.
phase("Act");
const actions = await parallel(
  routed.map(({ item, classification }, index) => () =>
    agent(
      `${instructionsByCategory[classification.category]}\n\n${JSON.stringify(item)}`,
      { label: `act:${index}:${String(item.id)}`, schema: actionSchema },
    ),
  ),
);
const failedAction = routed.flatMap(({ item }, index) => (actions[index] === null ? [String(item.id)] : []));

// INVARIANT: retain identities for failures in either stage.
return {
  handled: routed.flatMap(({ item, classification }, index) =>
    actions[index] === null
      ? []
      : [{ id: String(item.id), category: classification.category, result: actions[index] }],
  ),
  failed: { classification: failedClassification, action: failedAction },
  complete: failedClassification.length === 0 && failedAction.length === 0,
};
