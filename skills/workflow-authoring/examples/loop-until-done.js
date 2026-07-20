export const meta = {
  name: "loop_until_done",
  description: "Discover unknown-cardinality findings until repeated successful rounds are dry",
  phases: [{ title: "Discover" }],
};

// ADAPT: choose the target, stable identity field, schema, dry-round rule, and maximum bound.
const target = args && typeof args.target === "string" ? args.target : "new findings";
const maxRounds = args && Number.isInteger(args.maxRounds) ? Math.max(1, Math.min(args.maxRounds, 20)) : 6;
const consecutiveDry = 2;
const roundSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, detail: { type: "string" } },
        required: ["id", "detail"],
      },
    },
  },
  required: ["findings"],
};
const failedRounds = [];
const knownIds = new Set();
const findings = [];
let dryRounds = 0;
let roundsRun = 0;

phase("Discover");
while (roundsRun < maxRounds && dryRounds < consecutiveDry) {
  const roundNumber = roundsRun + 1;
  const response = await agent(
    `Find ${target}. Return only findings not represented by these stable IDs: ${JSON.stringify([...knownIds])}`,
    { label: `discover:${roundNumber}`, schema: roundSchema },
  );
  roundsRun++;
  if (response === null) {
    // INVARIANT: missing coverage is not evidence that a round was dry or part of a dry streak.
    failedRounds.push(roundNumber);
    dryRounds = 0;
    continue;
  }

  const fresh = [];
  for (const finding of response.findings) {
    if (!knownIds.has(finding.id)) {
      knownIds.add(finding.id);
      fresh.push(finding);
    }
  }
  if (fresh.length === 0) dryRounds++;
  else {
    dryRounds = 0;
    findings.push(...fresh);
  }
}

// INVARIANT: stable IDs, consecutive successful dry rounds, and maxRounds bound exploration.
const termination = dryRounds >= consecutiveDry ? "dry" : "max-rounds";
return {
  findings,
  failedRounds,
  roundsRun,
  termination,
  complete: failedRounds.length === 0 && termination === "dry",
};
