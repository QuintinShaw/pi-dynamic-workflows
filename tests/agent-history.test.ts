import assert from "node:assert/strict";
import test from "node:test";
import { compactAgentHistory } from "../src/agent-history.js";

test("compactAgentHistory captures user, assistant, tool call, and tool result entries", () => {
  const history = compactAgentHistory([
    { role: "user", content: "inspect repo", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", name: "read", arguments: { file: "README.md" } },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "README content" }],
      isError: false,
      timestamp: 3,
    },
  ]);

  assert.deepEqual(
    history.map((entry) => [entry.role, entry.kind, entry.toolName, entry.text]),
    [
      ["user", "text", undefined, "inspect repo"],
      ["assistant", "text", undefined, "I will inspect it."],
      ["assistant", "toolCall", "read", '{"file":"README.md"}'],
      ["tool", "toolResult", "read", "README content"],
    ],
  );
});

test("compactAgentHistory records assistant and tool errors", () => {
  const history = compactAgentHistory([
    {
      role: "assistant",
      content: [],
      errorMessage: "model failed",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "exit 1" }],
      isError: true,
      timestamp: 2,
    },
  ]);

  assert.equal(history[0].kind, "error");
  assert.equal(history[0].text, "model failed");
  assert.equal(history[1].kind, "error");
  assert.equal(history[1].toolName, "bash");
  assert.equal(history[1].isError, true);
});

test("compactAgentHistory truncates text and keeps the latest entries", () => {
  const history = compactAgentHistory(
    [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "middle" }] },
      { role: "assistant", content: [{ type: "text", text: "Z".repeat(100) }] },
    ],
    { maxEntries: 2, maxTextChars: 30, maxTotalChars: 60 },
  );

  assert.equal(history.length, 2);
  assert.equal(history[0].text, "middle");
  assert.match(history[1].text, /truncated/);
  assert.ok(history[1].text.length <= 30);
});
