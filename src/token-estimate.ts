/** Lightweight token estimates for live progress displays.
 *
 * Providers generally report exact usage only after a turn finishes. While a
 * subagent is still streaming/thinking, use the common ~4 chars/token heuristic
 * so the UI can show activity. Final accounting still uses provider usage when
 * available.
 */
export function estimateTextTokens(text: string): number {
  return estimateCharCountTokens(text.length);
}

export function estimateCharCountTokens(charCount: number): number {
  if (!charCount || charCount <= 0) return 0;
  return Math.max(1, Math.ceil(charCount / 4));
}

export function estimateTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value ?? ""));
}
