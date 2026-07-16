import type { AgentUsage } from "./agent.js";
import type { PersistedRunState } from "./run-persistence.js";

function number(value: number): string {
  return value.toLocaleString("en-US");
}

function cost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function cacheRatio(usage: Pick<AgentUsage, "input" | "cacheRead">): string {
  const denominator = usage.input + usage.cacheRead;
  return denominator > 0 ? `${((usage.cacheRead / denominator) * 100).toFixed(1)}%` : "n/a";
}

function usageText(usage: AgentUsage): string {
  return [
    `input ${number(usage.input)}`,
    `output ${number(usage.output)}`,
    `cache read ${number(usage.cacheRead)}`,
    `cache write ${number(usage.cacheWrite)}`,
    `total ${number(usage.total)}`,
    `cache ${cacheRatio(usage)}`,
    cost(usage.cost),
  ].join(" · ");
}

function persistedUsageText(usage: NonNullable<PersistedRunState["tokenUsage"]>): string {
  const cache =
    usage.cacheRead === undefined || usage.cacheWrite === undefined
      ? "cache unavailable"
      : `cache read ${number(usage.cacheRead)} · cache write ${number(usage.cacheWrite)} · cache ${cacheRatio({ input: usage.input, cacheRead: usage.cacheRead })}`;
  return `input ${number(usage.input)} · output ${number(usage.output)} · ${cache} · total ${number(usage.total)} · ${usage.cost === undefined ? "cost unavailable" : cost(usage.cost)}`;
}

function sumUsage(values: AgentUsage[]): AgentUsage {
  return values.reduce<AgentUsage>(
    (sum, value) => ({
      input: sum.input + value.input,
      output: sum.output + value.output,
      cacheRead: sum.cacheRead + value.cacheRead,
      cacheWrite: sum.cacheWrite + value.cacheWrite,
      total: sum.total + value.total,
      cost: sum.cost + value.cost,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  );
}

/** Deterministic persistent report formatter used by `/workflows report <runId>`. */
export function formatWorkflowReport(run: PersistedRunState): string {
  const capturedUsage = run.agents.flatMap((agent) => (agent.telemetry?.usage ? [agent.telemetry.usage] : []));
  const aggregate = capturedUsage.length > 0 ? sumUsage(capturedUsage) : undefined;
  const missingUsageCount = run.agents.length - capturedUsage.length;
  const incompleteAccountingCount = run.agents.filter(
    (agent) => agent.telemetry?.accountingStatus === "incomplete",
  ).length;
  const currentTelemetryAgents = run.agents.filter((agent) => agent.telemetry?.execution === "live");
  const incompleteMissingUsage = currentTelemetryAgents.some(
    (agent) => agent.telemetry?.accountingStatus === "incomplete" && agent.telemetry.usage === undefined,
  );
  const currentTelemetryMissingUsage = currentTelemetryAgents.length > 0 && capturedUsage.length === 0;
  const usageUnavailable = incompleteMissingUsage || currentTelemetryMissingUsage;
  const partialReasons = [
    incompleteAccountingCount > 0
      ? `accounting incomplete for ${number(incompleteAccountingCount)} agent${incompleteAccountingCount === 1 ? "" : "s"}`
      : undefined,
    missingUsageCount > 0
      ? `${number(missingUsageCount)} agent${missingUsageCount === 1 ? "" : "s"} missing usage`
      : undefined,
  ].filter((reason): reason is string => reason !== undefined);
  const lines = [`Workflow report: ${run.workflowName} (${run.runId}) [${run.status}]`];
  const persistedSupersedesTelemetry = Boolean(
    run.tokenUsage &&
      aggregate &&
      (run.tokenUsage.total > aggregate.total ||
        run.tokenUsage.input > aggregate.input ||
        run.tokenUsage.output > aggregate.output ||
        (run.tokenUsage.cacheRead ?? 0) > aggregate.cacheRead ||
        (run.tokenUsage.cacheWrite ?? 0) > aggregate.cacheWrite ||
        (run.tokenUsage.cost ?? 0) > aggregate.cost),
  );
  if (persistedSupersedesTelemetry && run.tokenUsage) {
    const qualifier = partialReasons.length > 0 ? `partial (${partialReasons.join("; ")}) · ` : "";
    lines.push(`Usage: ${qualifier}${persistedUsageText(run.tokenUsage)}`);
  } else if (aggregate && !usageUnavailable) {
    const qualifier = partialReasons.length > 0 ? `partial (${partialReasons.join("; ")}) · ` : "";
    lines.push(`Usage: ${qualifier}${usageText(aggregate)}`);
  } else if (!usageUnavailable && run.tokenUsage) {
    lines.push(`Usage: ${persistedUsageText(run.tokenUsage)}`);
  } else {
    const qualifier = usageUnavailable && partialReasons.length > 0 ? ` (${partialReasons.join("; ")})` : "";
    lines.push(`Usage: unavailable${qualifier}`);
  }
  lines.push(`Agents: ${run.agents.length}`);

  for (const agent of run.agents) {
    const telemetry = agent.telemetry;
    if (!telemetry) {
      lines.push(`[${agent.id}] ${agent.label} · telemetry unavailable`);
      continue;
    }
    const execution = telemetry.execution ?? "legacy";
    const hasCapturedTelemetry =
      telemetry.resolvedModel !== undefined ||
      telemetry.effectiveThinkingLevel !== undefined ||
      telemetry.skillsEnabled !== undefined ||
      telemetry.activeToolCount !== undefined ||
      telemetry.systemPromptChars !== undefined ||
      telemetry.projectContextFileCount !== undefined ||
      telemetry.usage !== undefined ||
      telemetry.accountingStatus !== undefined;
    if (!hasCapturedTelemetry) {
      lines.push(
        `[${agent.id}] ${agent.label} · ${execution} · requested ${telemetry.requestedModelSpec ?? "(default)"} · telemetry unavailable`,
      );
      continue;
    }
    const route = `${telemetry.requestedModelSpec ?? "(default)"} -> ${telemetry.resolvedModel ?? "unknown"}`;
    const skills =
      telemetry.skillsEnabled === undefined
        ? "skills unknown"
        : `skills ${telemetry.skillsEnabled ? "on" : "off"} (${telemetry.loadedSkillCount ?? "?"})`;
    const tools = telemetry.activeToolCount ?? telemetry.activeToolNames?.length;
    const contextChars =
      telemetry.projectContextChars === undefined ? "unknown" : number(telemetry.projectContextChars);
    const context = `${telemetry.projectContextFileCount ?? "?"} files/${contextChars} chars`;
    const incompleteAttempts = telemetry.accountingIncompleteAttempts;
    const accounting =
      telemetry.accountingStatus === "incomplete"
        ? `accounting incomplete${
            incompleteAttempts ? ` (${number(incompleteAttempts)} attempt${incompleteAttempts === 1 ? "" : "s"})` : ""
          }`
        : undefined;
    lines.push(
      [
        `[${agent.id}] ${agent.label}`,
        execution,
        route,
        `thinking ${telemetry.effectiveThinkingLevel ?? "unknown"}`,
        skills,
        `tools ${tools ?? "?"}`,
        `system ${telemetry.systemPromptChars === undefined ? "unknown" : number(telemetry.systemPromptChars)} chars`,
        `context ${context}`,
        accounting,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · "),
    );
    lines.push(`    usage: ${telemetry.usage ? usageText(telemetry.usage) : "unavailable"}`);
    if (telemetry.activeToolNames?.length) lines.push(`    tools: ${telemetry.activeToolNames.join(", ")}`);
  }

  return lines.join("\n");
}
