export const meta = {
  name: "phased_budgets",
  description: "Bound noisy work with named phase budgets and report shared token spending truthfully",
  phases: [{ title: "Explore" }, { title: "Deliver" }],
};

// ADAPT: validate the work, choose phase budgets, prompts, schemas, and invocation-level tokenBudget.
const work = args && Array.isArray(args.work) ? args.work.slice(0, 8) : [{ id: "sample" }];
const phaseBudget =
  args && Number.isFinite(args.phaseBudget) ? Math.max(1, Math.min(args.phaseBudget, 100000)) : 2000;
const resultSchema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};
const phases = [];

phase("Explore", { budget: phaseBudget });
const exploreStart = budget.spent();
const explored = [];
const exploreMissing = [];
const exploreAttempted = work.map((item) => String(item.id));
for (let index = 0; index < work.length; index++) {
  const item = work[index];
  const id = String(item.id);
  try {
    const result = await agent(`Explore this bounded work item: ${JSON.stringify(item)}`, {
      label: `explore:${index}:${id}`,
      schema: resultSchema,
    });
    if (result === null) exploreMissing.push(id);
    else explored.push({ id, index, result });
  } catch (error) {
    if (!error || error.code !== "TOKEN_BUDGET_EXHAUSTED") throw error;
    // INVARIANT: the soft gate blocks this and later calls; retain every intended identity as missing coverage.
    exploreMissing.push(...work.slice(index).map((remaining) => String(remaining.id)));
    break;
  }
}
phases.push({
  title: "Explore",
  startSpent: exploreStart,
  endSpent: budget.spent(),
  attempted: exploreAttempted,
  missing: exploreMissing,
});

phase("Deliver");
const deliverStart = budget.spent();
const delivered = [];
const deliverMissing = [];
for (const item of explored) {
  const result = await agent(`Turn this exploration into a deliverable: ${JSON.stringify(item.result)}`, {
    label: `deliver:${item.index}:${item.id}`,
    schema: resultSchema,
  });
  if (result === null) deliverMissing.push(item.id);
  else delivered.push({ id: item.id, result });
}
phases.push({
  title: "Deliver",
  startSpent: deliverStart,
  endSpent: budget.spent(),
  attempted: explored.map((item) => item.id),
  missing: deliverMissing,
});

// INVARIANT: phase and total budgets are soft pre-call gates; completed in-flight work may overshoot a limit.
return {
  phases,
  delivered,
  totalSpent: budget.spent(),
  remaining: budget.remaining(),
  complete: exploreMissing.length === 0 && deliverMissing.length === 0,
};
