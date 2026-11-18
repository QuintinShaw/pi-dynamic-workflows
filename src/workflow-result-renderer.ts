import { getMarkdownTheme, keyHint, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { WORKFLOW_RESULT_TYPE } from "./task-panel.js";

const PREVIEW_LINES = 3;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** Display only: folding never changes the message or what the model receives. */
export const renderWorkflowResult: MessageRenderer = (message, { expanded, outputPad }, theme) => {
  const text = messageText(message.content);
  const box = new Box(outputPad ?? 1, 1, (line) => theme.bg("customMessageBg", line));
  const label = theme.fg("customMessageLabel", theme.bold(`[${WORKFLOW_RESULT_TYPE}]`));
  const color = (line: string) => theme.fg("customMessageText", line);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (expanded) {
    box.addChild(new Text(label, 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color }));
    return box;
  }
  if (lines.length <= 1) {
    box.addChild(new Text(`${label} ${color(lines[0] ?? "Workflow result")}`, 0, 0));
    return box;
  }
  const preview = lines.slice(0, PREVIEW_LINES);
  box.addChild({
    render: (width: number) =>
      preview.map((line, i) => truncateToWidth(i === 0 ? `${label} ${color(line)}` : color(line), width)),
    invalidate() {},
  });
  if (lines.length > preview.length) box.addChild(new Text(keyHint("app.tools.expand", "to expand"), 0, 0));
  return box;
};
