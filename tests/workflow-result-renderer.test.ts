import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type CustomMessage,
  CustomMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderWorkflowResult } from "../src/workflow-result-renderer.js";

initTheme("dark", false);

test("the published extension registers a workflow-result renderer", async () => {
  const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { loadExtensions, createExtensionRuntime } = await import(new URL("core/extensions/loader.js", sdkEntry).href);
  const { createEventBus } = await import(new URL("core/event-bus.js", sdkEntry).href);
  const entry = fileURLToPath(new URL("../extensions/workflow.ts", import.meta.url));
  const loaded = await loadExtensions([entry], process.cwd(), createEventBus(), createExtensionRuntime());
  assert.deepEqual(loaded.errors, []);
  assert.equal(typeof loaded.extensions[0]?.messageRenderers.get("workflow-result"), "function");
});

function resultMessage(content: CustomMessage["content"]): CustomMessage {
  return {
    role: "custom",
    customType: "workflow-result",
    content,
    display: true,
    details: { deliveryId: "delivery-one" },
    timestamp: 0,
  };
}

test("workflow results fold, expand, and refold through Pi's custom message component", () => {
  const content = [
    "Background workflow completed (1 agent).",
    "",
    "# Full report",
    "SECRET_BODY",
    "Full result: /result.json",
  ].join("\n");
  const message = resultMessage(content);
  const before = structuredClone(message);
  const component = new CustomMessageComponent(message, renderWorkflowResult, getMarkdownTheme(), 0);

  const collapsed = component.render(80).join("\n");
  assert.match(collapsed, /workflow-result/);
  assert.match(collapsed, /Background workflow completed/);
  assert.doesNotMatch(collapsed, /SECRET_BODY|result\.json/);
  assert.ok(component.render(80).length <= 5, "collapsed result must not grow with report length");

  component.setExpanded(true);
  const expanded = component.render(80).join("\n");
  assert.match(expanded, /Full report/);
  assert.match(expanded, /SECRET_BODY/);
  assert.match(expanded, /Full result: \/result\.json/);

  component.setExpanded(false);
  component.invalidate();
  assert.doesNotMatch(component.render(80).join("\n"), /SECRET_BODY/);
  assert.deepEqual(message, before, "rendering must not rewrite content or delivery metadata");
});

test("long wide-character summaries stay bounded across resize and output padding changes", () => {
  const component = new CustomMessageComponent(
    resultMessage(`${"界".repeat(2000)}\nHIDDEN_BODY`),
    renderWorkflowResult,
    getMarkdownTheme(),
    0,
  );
  for (const pad of [0, 1, 3]) {
    component.setOutputPad(pad);
    for (const width of [12, 24, 80]) {
      const lines = component.render(width);
      assert.ok(lines.length <= 8, `collapsed output must stay bounded at width ${width}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /HIDDEN_BODY/);
    }
  }
});

test("text-block results and blank content render without altering message data", () => {
  const message = resultMessage([
    { type: "text", text: "Completed\r\n" },
    { type: "image", data: "", mimeType: "image/png" },
    { type: "text", text: "BLOCK_BODY" },
  ]);
  const component = new CustomMessageComponent(message, renderWorkflowResult, getMarkdownTheme(), 1);
  assert.match(component.render(60).join("\n"), /Completed/);
  assert.doesNotMatch(component.render(60).join("\n"), /BLOCK_BODY/);
  component.setExpanded(true);
  assert.match(component.render(60).join("\n"), /BLOCK_BODY/);

  const empty = new CustomMessageComponent(resultMessage(" \r\n"), renderWorkflowResult, getMarkdownTheme(), 1);
  assert.match(empty.render(60).join("\n"), /Workflow result/);
});
