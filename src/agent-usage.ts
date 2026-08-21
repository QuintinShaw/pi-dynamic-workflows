/** Token and cost usage for one subagent attempt or logical agent call. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/** Create an independent zero-valued agent usage record. */
export function createEmptyAgentUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

/** Add agent usage records without mutating either input. */
export function sumAgentUsage(...records: AgentUsage[]): AgentUsage {
  const total = createEmptyAgentUsage();
  for (const usage of records) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.total += usage.total;
    total.cost += usage.cost;
  }
  return total;
}

/** Cumulative display usage plus the exact attempt delta when usage becomes committed. */
interface AgentCallUsageUpdate {
  tokenUsage: AgentUsage;
  committedUsage?: AgentUsage;
}

/** Settled cumulative usage for one logical agent call, including retries. */
interface AgentUsageCommit {
  tokens: number;
  tokenUsage?: AgentUsage;
}

/**
 * Track provisional and committed usage for one logical agent call across retries.
 * Starting a new attempt closes older attempts so their late callbacks are ignored.
 */
export function createAgentCallUsageTracker(onUpdate: (update: AgentCallUsageUpdate) => void) {
  let committedCallUsage = createEmptyAgentUsage();
  let activeAttempt = 0;

  return {
    startAttempt() {
      const attemptId = ++activeAttempt;
      let attemptUsage = createEmptyAgentUsage();
      let terminalUsage: AgentUsage | undefined;
      let closed = false;
      const isOpen = () => !closed && attemptId === activeAttempt;
      const emitProgress = () => {
        onUpdate({ tokenUsage: sumAgentUsage(committedCallUsage, attemptUsage) });
      };
      const commitUsage = (usage: AgentUsage): AgentUsageCommit => {
        if (!isOpen()) {
          return { tokens: 0 };
        }
        closed = true;
        committedCallUsage = sumAgentUsage(committedCallUsage, usage);
        onUpdate({ tokenUsage: committedCallUsage, committedUsage: usage });
        return { tokens: committedCallUsage.total, tokenUsage: committedCallUsage };
      };

      return {
        reportProgress(usage: AgentUsage) {
          if (!isOpen() || agentUsageEquals(attemptUsage, usage)) {
            return;
          }
          attemptUsage = usage;
          emitProgress();
        },
        reportTerminal(usage: AgentUsage) {
          if (!isOpen()) {
            return;
          }
          terminalUsage = usage;
          if (!agentUsageEquals(attemptUsage, usage)) {
            attemptUsage = usage;
            emitProgress();
          }
        },
        commitWithFallback(fallbackTotal: number) {
          if (terminalUsage && (terminalUsage.total > 0 || terminalUsage.cost > 0)) {
            return commitUsage(terminalUsage);
          }
          return commitUsage({ ...createEmptyAgentUsage(), total: Math.max(0, fallbackTotal) });
        },
        commitTerminalUsage() {
          if (!terminalUsage) {
            closed = true;
            return { tokens: 0 };
          }
          return commitUsage(terminalUsage);
        },
      };
    },
  };
}

/** Return whether two complete agent usage records contain the same values. */
export function agentUsageEquals(left: AgentUsage, right: AgentUsage): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.total === right.total &&
    left.cost === right.cost
  );
}
