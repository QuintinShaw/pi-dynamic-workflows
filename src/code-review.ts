/**
 * 7-angle parallel code review workflow.
 */
export function generateCodeReviewWorkflow(): string {
  return `export const meta = {
  name: 'code_review',
  description: '7-angle parallel code review with adversarial verification',
  phases: [
    { title: 'Gather' },
    { title: 'Angles' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

const target = (args && args.target) || '.'

phase('Gather')
const gathered = await agent(
  'Gather the code diff to review. Target: ' + target + '\\n\\n' +
  'Run: git diff @{upstream}...HEAD (or git diff HEAD~1 if no upstream). ' +
  'If the diff is empty, also try git diff HEAD for uncommitted changes. ' +
  'Read the enclosing functions for each changed hunk. ' +
  'Return the diff text and the list of changed file paths.',
  { label: 'gather', schema: { type: 'object', properties: { diff: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['diff', 'files'] } }
)

if (!gathered || !gathered.diff || !gathered.diff.trim()) {
  return { findings: [], report: 'No diff found — nothing to review.' }
}

phase('Angles')
const candidates = await parallel([
  () => agent(
    'CODE REVIEW ANGLE A — Line-by-line scan.\\n\\nDiff:\\n' + gathered.diff +
    '\\n\\nRead every hunk line by line. Also read the enclosing function for each hunk — bugs in unchanged lines of a touched function are in scope. ' +
    'For every line ask: what input, state, timing, or platform makes this line wrong? ' +
    'Find: inverted/wrong conditions, off-by-one, null/undefined deref, missing await, falsy-zero checks, wrong-variable copy-paste, swallowed error. ' +
    'Return up to 6 findings.',
    { label: 'angle-A', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } }, required: ['file', 'line', 'summary', 'failure_scenario'] } } }, required: ['findings'] } }
  ),
  () => agent(
    'CODE REVIEW ANGLE B — Removed-behavior audit.\\n\\nDiff:\\n' + gathered.diff +
    '\\n\\nFor every line the diff DELETES or replaces, name the invariant or behavior it enforced, ' +
    'then search the new code for where that invariant is re-established. ' +
    'If you cannot find it, that is a finding: a removed guard, dropped error path, narrowed validation, deleted test. ' +
    'Return up to 6 findings.',
    { label: 'angle-B', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } }, required: ['file', 'line', 'summary', 'failure_scenario'] } } }, required: ['findings'] } }
  ),
  () => agent(
    'CODE REVIEW ANGLE C — Cross-file tracer.\\n\\nDiff:\\n' + gathered.diff + '\\nChanged files: ' + JSON.stringify(gathered.files) +
    '\\n\\nFor each function the diff changes, use grep to find its callers. ' +
    'Check whether the change breaks any call site: new precondition, changed return shape, new exception, timing dependency. ' +
    'Also check callees: does a parallel change make a call unsafe? Return up to 6 findings.',
    { label: 'angle-C', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } }, required: ['file', 'line', 'summary', 'failure_scenario'] } } }, required: ['findings'] } }
  ),
  () => agent(
    'CODE REVIEW ANGLE D — Language pitfalls.\\n\\nDiff:\\n' + gathered.diff +
    '\\n\\nCheck for language-specific pitfalls: nil-map write, range-variable capture, defer-in-loop, ' +
    'goroutine leak, context misuse, sync primitive copy (Go); missing await, undefined access, ' +
    'prototype pollution, event listener leak (JS/TS); mutable default arguments, reference aliasing (Python). ' +
    'Return up to 6 findings.',
    { label: 'angle-D', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } }, required: ['file', 'line', 'summary', 'failure_scenario'] } } }, required: ['findings'] } }
  ),
  () => agent(
    'CODE REVIEW ANGLE E — Reuse check.\\n\\nDiff:\\n' + gathered.diff + '\\nChanged files: ' + JSON.stringify(gathered.files) +
    '\\n\\nGrep shared/utility modules and files adjacent to the changes for existing helpers this new code duplicates. ' +
    'Name the existing helper that should be called instead. Return up to 6 findings.',
    { label: 'angle-E', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } }, required: ['file', 'line', 'summary', 'failure_scenario'] } } }, required: ['findings'] } }
  ),
  () => agent(
    'CODE REVIEW ANGLE F — Simplification.\\n\\nDiff:\\n' + gathered.diff +
    '\\n\\nFlag unnecessary complexity the diff adds: redundant or derivable state, copy-paste with slight variation, ' +
    'deep nesting, dead code left behind. Name the simpler form that does the same job. Return up to 6 findings.',
    { label: 'angle-F', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } }, required: ['file', 'line', 'summary', 'failure_scenario'] } } }, required: ['findings'] } }
  ),
  () => agent(
    'CODE REVIEW ANGLE G — Altitude.\\n\\nDiff:\\n' + gathered.diff +
    '\\n\\nCheck that each change is implemented at the right depth. Special cases layered on shared infrastructure ' +
    'are a sign the fix is not deep enough. Prefer generalizing the underlying mechanism over adding special cases. ' +
    'Return up to 6 findings.',
    { label: 'angle-G', tier: 'big', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } }, required: ['file', 'line', 'summary', 'failure_scenario'] } } }, required: ['findings'] } }
  ),
])

const allFindings = candidates
  .filter(Boolean)
  .flatMap((c) => (c && c.findings) || [])
  .slice(0, 42)

if (allFindings.length === 0) {
  return { findings: [], report: 'No issues found across all review angles.' }
}

phase('Verify')
const verdicts = await parallel(allFindings.map((f, i) => () =>
  agent(
    'Verify this code review finding. ' +
    'Return CONFIRMED (can name inputs → wrong output), PLAUSIBLE (mechanism real, trigger uncertain), or REFUTED (factually wrong or already guarded). ' +
    'PLAUSIBLE by default for races, nil on rare paths, off-by-one on non-excluded boundaries. ' +
    'REFUTED only when constructible from code: factually wrong, provably impossible, or already handled.\\n\\n' +
    'FINDING: ' + JSON.stringify(f),
    { label: 'verify-' + (i + 1), schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] }, reason: { type: 'string' } }, required: ['verdict', 'reason'] } }
  )
))

const survivors = allFindings
  .filter((_, i) => {
    const v = verdicts[i]
    return v && v.verdict !== 'REFUTED'
  })
  .slice(0, 10)

phase('Report')
const report = await agent(
  'Write a code review report. Include ONLY the findings that survived verification (below), ranked most-severe first. ' +
  'Cap at 10 findings. For each finding: **[SEVERITY]** \x60file:line\x60 — summary\\n> Failure scenario: concrete inputs → wrong output or crash\\n\\n' +
  'Severity levels: CRITICAL / HIGH / MEDIUM / LOW / CLEANUP. ' +
  'Correctness bugs outrank cleanup. Note how many candidates were generated vs. survived.\\n\\n' +
  'SURVIVORS:\\n' + JSON.stringify(survivors),
  { label: 'report', tier: 'big' }
)

return { findings: survivors, report }`;
}
