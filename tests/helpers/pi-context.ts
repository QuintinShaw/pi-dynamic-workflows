import * as PiAi from "@earendil-works/pi-ai";

type PiAiCompatibility = typeof PiAi & {
  getCurrentSystemPrompt?: (messages: readonly unknown[]) => unknown;
};

/**
 * Read the rendered system prompt from both the pre-transcript and transcript
 * Pi context shapes. Keep the optional export structural so this compiles
 * against the 0.85.1 pi-ai declarations as well as 0.86.1.
 */
export function readProviderSystemPrompt(context: unknown): string {
  if (context === null || typeof context !== "object") {
    throw new Error("Provider context must be an object with a system prompt source");
  }

  const candidate = context as {
    systemPrompt?: unknown;
    messages?: unknown;
  };
  if (typeof candidate.systemPrompt === "string") {
    return candidate.systemPrompt;
  }

  if (Array.isArray(candidate.messages)) {
    const getCurrentSystemPrompt = (PiAi as PiAiCompatibility).getCurrentSystemPrompt;
    if (typeof getCurrentSystemPrompt === "function") {
      const rendered = getCurrentSystemPrompt(candidate.messages);
      if (typeof rendered === "string") {
        return rendered;
      }
      throw new Error("Pi-ai getCurrentSystemPrompt returned a non-string value");
    }
  }

  throw new Error("Provider context contains neither a string systemPrompt nor a compatible system-message renderer");
}
