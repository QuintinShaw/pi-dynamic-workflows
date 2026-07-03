/**
 * Standing `/effort` opt-in (pi's answer to CC's ultracode): a session toggle that
 * auto-arms a workflow for substantive interactive messages, with effort-tier
 * guidance nudging fan-out breadth and the hard caps (tokenBudget / maxAgents) the
 * model should set on the workflow tool call.
 *
 * Honest scope: the runtime cannot enforce "reviewer N / loop K" — those live in
 * the script the model writes — so the tiers are guidance plus the model setting
 * the real hard caps (tokenBudget/maxAgents are genuine runtime ceilings). The
 * pre-flight ceiling-confirm dialog (roadmap P1-5 #4) is a downscope point: an
 * `input` hook transforms synchronously and can't await a confirm, so it is left
 * to a follow-up; `/effort` is explicit opt-in, which is the safety valve.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type EffortLevel = "off" | "high" | "ultra";

export interface EffortState {
  level: EffortLevel;
}

export function createEffortState(): EffortState {
  return { level: "off" };
}

const HIGH_DIRECTIVE =
  "Effort: HIGH. Be thorough — use a few parallel reviewers/perspectives and an adversarial verify pass (see verify()/judgePanel()); set a moderate tokenBudget and maxAgents on the workflow tool call.";
const ULTRA_DIRECTIVE =
  "Effort: ULTRA. Be exhaustive — fan out widely (more reviewers/judges, deeper loopUntilDry rounds, a completenessCheck at the end), and prefer the big tier for synthesis. This can spend a lot of tokens quickly, so set explicit caps you're comfortable paying for (a generous but bounded tokenBudget and a high maxAgents) on the workflow tool call rather than leaving them unbounded.";

/** The extra directive appended to the forced-workflow prompt for an effort level. */
export function effortDirective(level: EffortLevel): string | undefined {
  if (level === "high") return HIGH_DIRECTIVE;
  if (level === "ultra") return ULTRA_DIRECTIVE;
  return undefined;
}

/**
 * Whether a message should auto-arm under effort mode: a real interactive request,
 * not a terse acknowledgement or a slash command. (hasTrigger handles the explicit
 * "workflow(s)" keyword separately.)
 */
export function isSubstantive(text: string): boolean {
  const t = text.trim();
  return t.length >= 16 && !t.startsWith("/");
}

export function registerEffortCommand(pi: ExtensionAPI, state: EffortState): void {
  pi.registerCommand("effort", {
    description: "Standing workflow effort: off | high | ultra — auto-arms a workflow for substantive messages",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "effort", content, display: true });
      if (arg === "off" || arg === "high" || arg === "ultra") {
        state.level = arg;
        await say(
          arg === "off"
            ? "Effort off — messages are no longer auto-armed as workflows."
            : `Effort ${arg} — substantive messages now auto-arm a workflow (${arg === "ultra" ? "exhaustive" : "thorough"} fan-out). Use /effort off to stop.`,
        );
        return;
      }
      await say(`Effort is currently "${state.level}". Usage: /effort off | high | ultra`);
    },
  });

  // `/ultracode` — the headline name for the maximal-effort mode (Pi's ultracode):
  // `/ultracode` turns it on, `/ultracode off` turns it off. Alias for /effort ultra.
  pi.registerCommand("ultracode", {
    description:
      "Ultracode: standing maximal-effort mode (this session only, never persisted) — auto-arms an exhaustive workflow for substantive messages. /ultracode off to stop.",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "effort", content, display: true });
      if (arg === "off") {
        state.level = "off";
        await say("Ultracode off — messages are no longer auto-armed as workflows.");
        return;
      }
      state.level = "ultra";
      await say(
        "Ultracode ON — substantive messages now auto-arm an exhaustive workflow (wide fan-out, big-tier synthesis). Use /ultracode off to stop.",
      );
    },
  });
}
