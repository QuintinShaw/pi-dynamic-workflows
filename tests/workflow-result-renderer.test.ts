import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { CustomMessageComponent, initTheme, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WORKFLOW_RESULT_TYPE } from "../src/task-panel.ts";
import { renderWorkflowResult } from "../src/workflow-result-renderer.ts";

initTheme("dark");

const report = [
  '✓ Background workflow "demo" finished (2 agents · 1.2K tok · 3.4s).',
  "",
  "Verdict: ship it.",
  "First finding.",
  "Second finding.",
  "",
  "↳ Full result: /runs/demo.json",
].join("\n");

function component(content: unknown): CustomMessageComponent {
  const message = { role: "custom", customType: WORKFLOW_RESULT_TYPE, content, display: true, timestamp: 0 } as never;
  return new CustomMessageComponent(message, renderWorkflowResult as MessageRenderer);
}

function view(content: unknown, expanded: boolean, width = 80): string[] {
  const c = component(content);
  c.setExpanded(expanded);
  return c.render(width);
}

const text = (lines: string[]) => lines.map(strip).join("\n");

test("folded: the completion line, the start of the summary and the expand key", () => {
  const out = text(view(report, false));
  assert.match(out, /\[workflow-result\] ✓ Background workflow "demo" finished/);
  assert.match(out, /Verdict: ship it\./);
  assert.match(out, /expand/);
  assert.doesNotMatch(out, /Second finding/);
  assert.doesNotMatch(out, /Full result/);
});

test("expanded: the full report and the pointer to the full result", () => {
  const out = text(view(report, true));
  assert.match(out, /Second finding\./);
  assert.match(out, /Full result: \/runs\/demo\.json/);
  assert.doesNotMatch(out, /to expand/);
});

test("folds again after it was expanded", () => {
  const c = component(report);
  c.setExpanded(true);
  c.setExpanded(false);
  assert.doesNotMatch(text(c.render(80)), /Second finding/);
});

test("a one-line failure shows in full, wrapped, with no expand key", () => {
  const failure = `✗ Background workflow run-1 failed: ${"the provider closed the connection ".repeat(4)}`;
  const out = view(failure, false, 40);
  assert.ok(out.length > 1, "a long one-line failure wraps");
  assert.match(text(out).replace(/\s+/g, " "), /closed the connection the provider/);
  assert.doesNotMatch(text(out), /expand/);
});

test("folded lines fit a narrow terminal", () => {
  for (const line of view(report, false, 24)) assert.ok(visibleWidth(line) <= 24, `line wider than 24: ${strip(line)}`);
});

test("reads text blocks and falls back to a label for empty content", () => {
  assert.match(
    text(
      view(
        [
          { type: "text", text: report },
          { type: "image", data: "", mimeType: "image/png" },
        ],
        false,
      ),
    ),
    /finished/,
  );
  assert.match(text(view("", false)), /\[workflow-result\] Workflow result/);
});
