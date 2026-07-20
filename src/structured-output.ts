import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined;
  called: boolean;
}

export interface StructuredOutputToolOptions<TSchemaDef extends TSchema> {
  schema: TSchemaDef;
  capture: StructuredOutputCapture<Static<TSchemaDef>>;
  name?: string;
}

/**
 * Create a terminating tool that captures validated params as the subagent result.
 *
 * Pi validates `params` against `schema` before execute() is called. Returning
 * `terminate: true` lets the subagent finish on this tool call without paying for
 * an extra assistant follow-up turn.
 */
export function createStructuredOutputTool<TSchemaDef extends TSchema>({
  schema,
  capture,
  name = "structured_output",
}: StructuredOutputToolOptions<TSchemaDef>): ReturnType<typeof defineTool<TSchemaDef, Static<TSchemaDef>>> {
  return defineTool({
    name,
    label: "Structured Output",
    description: "Return the final machine-readable result for this subagent task.",
    promptSnippet: "Return final machine-readable output",
    promptGuidelines: [
      `${name} is the final answer channel for this task; call ${name} exactly once when done.`,
      `Do not write a prose final answer after calling ${name}.`,
    ],
    parameters: schema,
    async execute(_toolCallId, params) {
      capture.value = params;
      capture.called = true;
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
        terminate: true,
      };
    },
  });
}
