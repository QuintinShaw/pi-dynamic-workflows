/**
 * Real web tools for research workflows. These execute in the extension host
 * process (which has network access), not in a subagent sandbox, so they perform
 * genuine HTTP requests via Node's fetch.
 *
 * - web_search: best-effort Bing HTML scrape -> result {url, title}
 * - web_fetch:  fetch a URL and return readable text (HTML stripped, truncated)
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Read cap for fetched pages (audit2 #42): htmlToText runs ~10 regex passes
 * over whatever we buffer — an unbounded multi-MB body stalls the host event
 * loop on every agent's progress pipeline. 2MB is far above any documentation
 * page's readable content. */
const MAX_FETCH_BODY_BYTES = 2 * 1024 * 1024;

async function fetchText(url: string, timeoutMs = 15000): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: controller.signal, redirect: "follow" });
    return { status: res.status, body: await readBodyCapped(res) };
  } finally {
    clearTimeout(timer);
  }
}

/** Read the response body, stopping at MAX_FETCH_BODY_BYTES. */
export async function readBodyCapped(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total >= MAX_FETCH_BODY_BYTES) break;
    }
  } finally {
    if (total >= MAX_FETCH_BODY_BYTES) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const merged = new Uint8Array(Math.min(total, MAX_FETCH_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.subarray(0, merged.length - offset), offset);
    offset += Math.min(chunk.byteLength, merged.length - offset);
    if (offset >= merged.length) break;
  }
  return new TextDecoder().decode(merged);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseBingResults(html: string, limit: number): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = m[1];
    if (/\.bing\.com|go\.microsoft\.com/.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: m[2].replace(/<[^>]+>/g, "").trim() });
    if (out.length >= limit) break;
  }
  return out;
}

/** A tool that searches the web (best-effort) and returns result URLs + titles. */
export function createWebSearchTool(): ToolDefinition {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web and return a list of result URLs and titles. Use before web_fetch to find sources.",
    promptSnippet: "Search the web for sources",
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      count: Type.Optional(Type.Number({ description: "Max results (default 6)." })),
    }),
    async execute(_id, params: { query: string; count?: number }) {
      const limit = Math.min(Math.max(params.count ?? 6, 1), 10);
      try {
        const { status, body } = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(params.query)}`);
        const results = parseBingResults(body, limit);
        const text = results.length
          ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")
          : `No results parsed (HTTP ${status}). Try a different query or fetch a known URL directly.`;
        return { content: [{ type: "text", text }], details: { results } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `web_search failed: ${error instanceof Error ? error.message : error}` }],
          details: { results: [] as Array<{ url: string; title: string }> },
        };
      }
    },
  }) as unknown as ToolDefinition;
}

/** A tool that fetches a URL and returns readable text. */
export function createWebFetchTool(maxChars = 6000): ToolDefinition {
  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and return its readable text content (HTML stripped, truncated).",
    promptSnippet: "Fetch a URL's text",
    parameters: Type.Object({
      url: Type.String({ description: "The absolute URL to fetch." }),
    }),
    async execute(_id, params: { url: string }) {
      try {
        const { status, body } = await fetchText(params.url);
        const text = htmlToText(body).slice(0, maxChars);
        return {
          content: [{ type: "text", text: `HTTP ${status} ${params.url}\n\n${text}` }],
          details: { status, url: params.url },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `web_fetch failed for ${params.url}: ${error instanceof Error ? error.message : error}`,
            },
          ],
          details: { status: 0, url: params.url },
        };
      }
    },
  }) as unknown as ToolDefinition;
}

/** Both web tools, for injecting into a research workflow's agents. */
export function createWebTools(): ToolDefinition[] {
  return [createWebSearchTool(), createWebFetchTool()];
}
