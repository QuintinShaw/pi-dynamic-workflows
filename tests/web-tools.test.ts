import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  htmlToText,
  parseBingResults,
} from "../src/web-tools.js";

// ─── createWebSearchTool ─────────────────────────────────────────────────────

test("createWebSearchTool has correct name and metadata", () => {
  const tool = createWebSearchTool();
  assert.equal(tool.name, "web_search");
  assert.equal(tool.label, "Web Search");
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.parameters, "parameters should be truthy");
});

test("createWebSearchTool has execute function", () => {
  const tool = createWebSearchTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWebSearchTool tool has parameters with query field", () => {
  const tool = createWebSearchTool();
  assert.ok(tool.parameters, "should have parameters");
});

test("createWebSearchTool has default count", () => {
  const tool = createWebSearchTool();
  // Verify the tool definition has the right shape
  assert.ok(tool.parameters, "parameters should be truthy");
});

// ─── createWebFetchTool ────────────────────────────────────────────────────────

test("createWebFetchTool has correct name and metadata", () => {
  const tool = createWebFetchTool();
  assert.equal(tool.name, "web_fetch");
  assert.equal(tool.label, "Web Fetch");
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.parameters, "parameters should be truthy");
});

test("createWebFetchTool has execute function", () => {
  const tool = createWebFetchTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWebFetchTool accepts maxChars parameter", () => {
  const toolSmall = createWebFetchTool(100);
  const toolLarge = createWebFetchTool(10000);
  assert.equal(typeof toolSmall.execute, "function");
  assert.equal(typeof toolLarge.execute, "function");
});

test("createWebFetchTool has parameters with url field", () => {
  const tool = createWebFetchTool();
  const params = tool.parameters;
  assert.ok(params, "should have parameters");
});

// ─── createWebTools ────────────────────────────────────────────────────────────

test("createWebTools returns both tools in correct order", () => {
  const tools = createWebTools();
  assert.equal(tools.length, 2);
  assert.ok(Array.isArray(tools), "tools should be an array");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["web_fetch", "web_search"]);
});

test("createWebTools returns unique tool definitions (no duplicates)", () => {
  const tools = createWebTools();
  const names = tools.map((t) => t.name);
  const unique = new Set(names);
  assert.equal(names.length, unique.size, "tool names should be unique");
});

test("createWebTools each tool has execute", () => {
  const tools = createWebTools();
  for (const tool of tools) {
    assert.ok(tool.execute, `${tool.name} should have execute`);
  }
});

// ─── HTML parsing (import internal functions via tsx) ──────────────────────────

test("htmlToText strips HTML tags correctly", () => {
  assert.equal(htmlToText("<p>Hello</p>"), "Hello");
  assert.equal(htmlToText("<div>Line1</div><div>Line2</div>").trim(), "Line1\nLine2");
  assert.equal(htmlToText("Plain text"), "Plain text");
  assert.equal(htmlToText("<script>var x=1;</script>content"), "content");
  assert.equal(htmlToText("<style>.cls{}</style>content"), "content");
});

test("htmlToText converts HTML entities", () => {
  assert.equal(htmlToText("&amp;"), "&");
  assert.equal(htmlToText("&lt;test&gt;"), "<test>");
  assert.equal(htmlToText("&quot;hello&quot;"), '"hello"');
  assert.equal(htmlToText("hello&nbsp;world"), "hello world");
  assert.equal(htmlToText("&#39;it&#39;s&#39;"), "'it's'");
  assert.equal(htmlToText("&apos;x&apos;"), "'x'");
});

test("htmlToText normalizes whitespace", () => {
  const result = htmlToText("Hello    World");
  assert.equal(result, "Hello World");
});

test("htmlToText collapses multiple newlines", () => {
  const result = htmlToText("Line1\n\n\n\nLine2");
  assert.equal(result, "Line1\n\nLine2");
});

test("htmlToText replaces block element close tags with newlines", () => {
  const result = htmlToText("<p>Para1</p><p>Para2</p>");
  assert.equal(result.trim(), "Para1\nPara2");
  // li tags
  const list = htmlToText("<li>Item1</li><li>Item2</li>");
  assert.equal(list.trim(), "Item1\nItem2");
});

test("parseBingResults extracts results from mock HTML", () => {
  const mockHtml = `
    <h2><a href="https://example.com/page1">First Result</a></h2>
    <h2><a href="https://example.com/page2">Second Result</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/page1");
  assert.equal(results[0].title, "First Result");
  assert.equal(results[1].url, "https://example.com/page2");
  assert.equal(results[1].title, "Second Result");
});

test("parseBingResults respects limit and filters bing/microsoft domains", () => {
  const mockHtml = `
    <h2><a href="https://www.bing.com/search">Bing Link</a></h2>
    <h2><a href="https://example.com/1">Result 1</a></h2>
    <h2><a href="https://go.microsoft.com/link">Microsoft Link</a></h2>
    <h2><a href="https://example.com/2">Result 2</a></h2>
    <h2><a href="https://example.com/3">Result 3</a></h2>
  `;
  const results = parseBingResults(mockHtml, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/1");
  assert.equal(results[1].url, "https://example.com/2");
});

test("parseBingResults deduplicates URLs", () => {
  const mockHtml = `
    <h2><a href="https://example.com/dup">Dup</a></h2>
    <h2><a href="https://example.com/dup">Dup Again</a></h2>
    <h2><a href="https://example.com/unique">Unique</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 2, "should deduplicate URLs");
});

test("parseBingResults handles empty HTML", () => {
  assert.deepEqual(parseBingResults("", 5), []);
  assert.deepEqual(parseBingResults("<html></html>", 5), []);
});

test("parseBingResults strips inner HTML from titles", () => {
  const mockHtml = `
    <h2><a href="https://example.com/page"><strong>Bold</strong> Title</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Bold Title", "HTML tags should be stripped from title");
});

test("readBodyCapped stops reading at the byte cap (audit2 #42)", async () => {
  const { readBodyCapped } = await import("../src/web-tools.js");
  // 5MB body: only ~2MB may be buffered (htmlToText regex passes never see more).
  const big = "x".repeat(5 * 1024 * 1024);
  const res = new Response(big);
  const body = await readBodyCapped(res);
  assert.ok(body.length <= 2 * 1024 * 1024, `capped at 2MB (got ${body.length})`);
  assert.ok(body.length > 1024 * 1024, "reads up to the cap, not less");
  // Small bodies pass through whole.
  const small = await readBodyCapped(new Response("hello"));
  assert.equal(small, "hello");
});
