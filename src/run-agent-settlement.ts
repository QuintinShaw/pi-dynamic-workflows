import { WorkflowErrorCode } from "./errors.js";
import type { PersistedAgentState } from "./run-persistence.js";

export const INTERRUPTED_AGENT_CAUSE = { error: "interrupted", errorCode: WorkflowErrorCode.WORKFLOW_ABORTED };

export function agentHasNonTerminalStatus(status: PersistedAgentState["status"]): boolean {
  return status === "queued" || status === "running";
}

/** Display-only settlement; replay remains keyed by the committed journal. */
export function settleInterruptedPersistedAgents(
  agents: PersistedAgentState[],
  cause: { error: string; errorCode?: WorkflowErrorCode },
  endedAt: string,
): PersistedAgentState[] {
  return agents.map((agent) =>
    !agentHasNonTerminalStatus(agent.status)
      ? agent
      : {
          ...agent,
          status: "skipped",
          error: cause.error,
          errorCode: cause.errorCode,
          recoverable: false,
          endedAt: agent.endedAt ?? endedAt,
        },
  );
}
