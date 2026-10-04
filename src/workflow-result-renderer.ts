import { getMarkdownTheme, keyHint, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Fold only the display; keep the delivered message and its full result pointer intact. */
export const renderWorkflowResult: MessageRenderer = (message, { expanded, outputPad }, theme) => {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  const box = new Box(outputPad ?? 1, 1, (line) => theme.bg("customMessageBg", line));
  const label = theme.fg("customMessageLabel", "[workflow-result]");

  if (expanded) {
    box.addChild(new Text(label, 0, 0));
    box.addChild(
      new Markdown(text, 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }),
    );
  } else {
    const summary = text.trimStart().split("\n", 1)[0]?.trim() || "Workflow result";
    box.addChild({
      render: (width) => [truncateToWidth(`${label} ${theme.fg("customMessageText", summary)}`, width)],
      invalidate() {},
    });
    box.addChild(new Text(keyHint("app.tools.expand", "to expand"), 0, 0));
  }
  return box;
};
