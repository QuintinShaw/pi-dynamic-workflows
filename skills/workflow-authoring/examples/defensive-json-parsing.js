export const meta = {
  name: "defensive_json_parsing",
  description: "Parse agent() text output as JSON defensively when schema isn't used, flagging unparseable results instead of reading undefined fields",
  phases: [{ title: "Extract" }],
};

// Asking a model to "return STRICT JSON" in the prompt does not change what
// agent() gives back: without `schema`, the result is always the assistant's
// raw text. Reading a field off unparsed text (or off a plain-text agent()
// call in general) fails silently — `result.verdict` is `undefined`, not an
// error, and a fleet of such calls can look fully "successful" while every
// aggregator downstream gets undefined values. Prefer the `schema` option
// (see structured-output.js) whenever the shape matters; use this pattern
// only when a schema genuinely isn't available (e.g. an agentType/model that
// cannot be schema-validated).
function parseOrFlag(text, requiredKeys) {
  if (typeof text !== "string") return { ok: false, raw: text };
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  let value;
  try {
    value = JSON.parse(candidate.trim());
  } catch {
    return { ok: false, raw: text };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, raw: text };
  for (const key of requiredKeys) {
    if (!(key in value)) return { ok: false, raw: text };
  }
  return { ok: true, value };
}

// ADAPT: validate and bound work, then keep required fields as small as downstream JavaScript needs.
const work = args && Array.isArray(args.work) ? args.work.slice(0, 8) : [{ id: "sample" }];
const requiredKeys = ["verdict", "reason"];
const outputs = [];
const missing = [];
const unparseable = [];

phase("Extract");
for (let index = 0; index < work.length; index++) {
  const item = work[index];
  const id = String(item.id);
  const result = await agent(
    `Review this item and return STRICT JSON only, no prose: {"verdict": "pass" | "fail", "reason": string}. Item: ${JSON.stringify(item)}`,
    { label: `defensive:${index}:${id}` },
  );
  if (result === null) {
    missing.push(id);
    outputs.push({ id, status: "missing", verdict: null });
    continue;
  }
  const parsed = parseOrFlag(result, requiredKeys);
  if (!parsed.ok) {
    unparseable.push(id);
    outputs.push({ id, status: "unparseable", verdict: null });
    continue;
  }
  // INVARIANT: field access happens only after parseOrFlag confirms the required keys exist.
  outputs.push({ id, status: "complete", verdict: parsed.value.verdict });
}

return { outputs, missing, unparseable, complete: missing.length === 0 && unparseable.length === 0 };
