export type AgentHistoryRole = "user" | "assistant" | "tool";

export type AgentHistoryKind = "text" | "toolCall" | "toolResult" | "error";

export interface AgentHistoryEntry {
  role: AgentHistoryRole;
  kind: AgentHistoryKind;
  text: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

export interface AgentHistoryOptions {
  maxEntries?: number;
  maxTextChars?: number;
  maxTotalChars?: number;
}

const DEFAULT_MAX_ENTRIES = 40;
const DEFAULT_MAX_TEXT_CHARS = 2000;
const DEFAULT_MAX_TOTAL_CHARS = 20000;

export function compactAgentHistory(messages: unknown[], options: AgentHistoryOptions = {}): AgentHistoryEntry[] {
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxTextChars = positiveInt(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
  const maxTotalChars = positiveInt(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
  const entries: AgentHistoryEntry[] = [];

  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = message.role;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;

    if (role === "user") {
      const text = textFromContent(message.content);
      if (text.trim()) entries.push({ role: "user", kind: "text", text, timestamp });
      continue;
    }

    if (role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const block = asRecord(part);
        if (!block || typeof block.type !== "string") continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          entries.push({ role: "assistant", kind: "text", text: block.text, timestamp });
        } else if (block.type === "toolCall" && typeof block.name === "string") {
          entries.push({
            role: "assistant",
            kind: "toolCall",
            toolName: block.name,
            text: stringifyCompact(block.arguments ?? {}),
            timestamp,
          });
        }
      }
      if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
        entries.push({ role: "assistant", kind: "error", text: message.errorMessage, isError: true, timestamp });
      }
      continue;
    }

    if (role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
      const text = textFromContent(message.content) || "(no text output)";
      entries.push({
        role: "tool",
        kind: message.isError ? "error" : "toolResult",
        toolName,
        text,
        isError: Boolean(message.isError),
        timestamp,
      });
    }
  }

  return fitEntries(entries, maxEntries, maxTextChars, maxTotalChars);
}

function fitEntries(
  entries: AgentHistoryEntry[],
  maxEntries: number,
  maxTextChars: number,
  maxTotalChars: number,
): AgentHistoryEntry[] {
  const fitted: AgentHistoryEntry[] = [];
  let total = 0;

  for (const entry of entries.slice(-maxEntries).reverse()) {
    const remaining = maxTotalChars - total;
    if (remaining <= 0) break;
    const text = truncateText(entry.text, Math.min(maxTextChars, remaining));
    fitted.unshift({ ...entry, text });
    total += text.length;
  }

  return fitted;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("");
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 20) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 20)}... [truncated]`;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
