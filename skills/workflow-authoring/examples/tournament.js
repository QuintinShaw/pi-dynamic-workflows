export const meta = {
  name: "pairwise_tournament",
  description: "Create bounded contenders and choose among them through pairwise judgments",
  phases: [{ title: "Compete" }, { title: "Judge" }],
};

// ADAPT: choose the task, pairwise rubric, schemas, and a suitable contender bound.
const task = args && typeof args.task === "string" ? args.task : "Propose a candidate";
const rubric = args && typeof args.rubric === "string" ? args.rubric : "Prefer the better task fit";
const contenderCount = args && Number.isInteger(args.contenders)
  ? Math.max(2, Math.min(args.contenders, 8))
  : 4;
const contenderSchema = {
  type: "object",
  properties: { candidate: { type: "string" }, rationale: { type: "string" } },
  required: ["candidate", "rationale"],
};
const judgeSchema = {
  type: "object",
  properties: { winnerIndex: { type: "integer", enum: [0, 1] }, reason: { type: "string" } },
  required: ["winnerIndex", "reason"],
};

phase("Compete");
const attempts = await parallel(
  Array.from({ length: contenderCount }, (_, index) => () =>
    agent(`${task}\nAttempt a distinct approach as contender ${index + 1}.`, {
      label: `contender:${index + 1}`,
      schema: contenderSchema,
    }),
  ),
);
const failedContenders = attempts.flatMap((attempt, index) => (attempt === null ? [index + 1] : []));
let round = attempts.flatMap((attempt, index) =>
  attempt === null ? [] : [{ id: `contender-${index + 1}`, attempt }],
);
const failedMatches = [];
const bracket = [];

phase("Judge");
// INVARIANT: JavaScript owns the bounded bracket; agents only judge one pair at a time.
let roundNumber = 1;
while (round.length > 1) {
  const matches = [];
  for (let index = 0; index < round.length; index += 2) {
    const match = { left: round[index], right: round[index + 1] ?? null, match: index / 2 + 1 };
    matches.push(match);
    bracket.push({
      round: roundNumber,
      match: match.match,
      leftId: match.left.id,
      rightId: match.right?.id ?? null,
    });
  }
  const judgments = await parallel(
    matches.map(({ left, right, match }) => () =>
      right === null
        ? Promise.resolve({ winnerIndex: 0, reason: "bye" })
        : agent(
            `Choose index 0 or 1 under this rubric: ${rubric}\nCandidate 0: ${JSON.stringify(left.attempt)}\nCandidate 1: ${JSON.stringify(right.attempt)}`,
            { label: `judge:${roundNumber}:${match}`, schema: judgeSchema },
          ),
    ),
  );
  round = matches.flatMap(({ left, right, match }, index) => {
    const judgment = judgments[index];
    if (judgment === null) {
      failedMatches.push(`round-${roundNumber}-match-${match}`);
      return [];
    }
    return [judgment.winnerIndex === 1 && right !== null ? right : left];
  });
  roundNumber++;
}

return {
  winner: failedMatches.length === 0 ? (round[0] ?? null) : null,
  bracket,
  failed: { contenders: failedContenders, matches: failedMatches },
  complete: failedContenders.length === 0 && failedMatches.length === 0 && round.length === 1,
};
