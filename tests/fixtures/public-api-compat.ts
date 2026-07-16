import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  type AgentOptions,
  type AgentRunResult,
  type AgentTypePolicy,
  createStructuredOutputTool,
  type LiteralJsonSchema,
  runWorkflow,
  type StructuredOutputCapture,
  WorkflowManager,
  type WorkflowRunOptions,
  type WorkflowScriptDescriptor,
} from "../../src/index.js";

const descriptor: WorkflowScriptDescriptor = { scriptPath: "workflows/child.js" };
const policy: AgentTypePolicy = "error";
const schema: LiteralJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    },
  },
  required: ["title", "rows"],
};
const readonlyLiteralSchema = {
  type: "object",
  properties: {
    status: { enum: ["ready", "blocked"] },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { priority: { enum: [1, 2, 3] } },
        required: ["priority"],
      },
    },
  },
  required: ["status", "rows"],
} as const satisfies LiteralJsonSchema;
const agentOptions: AgentOptions = { schema: readonlyLiteralSchema, effort: "max" };
const runOptions: WorkflowRunOptions = { agentTypePolicy: policy };

const upstreamSchema = Type.Object({ ok: Type.Boolean() });
const upstreamCapture: StructuredOutputCapture<Static<typeof upstreamSchema>> = {
  called: false,
  value: undefined,
};
const exactUpstreamTool: ToolDefinition<
  typeof upstreamSchema,
  Static<typeof upstreamSchema>
> = createStructuredOutputTool({ schema: upstreamSchema, capture: upstreamCapture });

const unsafeSchema = Type.Unsafe<{ exactUnsafe: string }>(Type.Object({ exactUnsafe: Type.String() }));
type UnsafeAgentResult = AgentRunResult<typeof unsafeSchema>;
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
const exactUnsafeInference: Equal<UnsafeAgentResult, { exactUnsafe: string }> = true;
const unsafeCapture: StructuredOutputCapture<Static<typeof unsafeSchema>> = {
  called: false,
  value: undefined,
};
const exactUnsafeTool: ToolDefinition<typeof unsafeSchema, Static<typeof unsafeSchema>> = createStructuredOutputTool({
  schema: unsafeSchema,
  capture: unsafeCapture,
});

const literalCapture: StructuredOutputCapture<{
  status: "ready" | "blocked";
  rows: Array<{ priority: 1 | 2 | 3 }>;
}> = { called: false, value: undefined };
const literalTool = createStructuredOutputTool({ schema: readonlyLiteralSchema, capture: literalCapture });

void descriptor;
void schema;
void agentOptions;
void exactUpstreamTool;
void exactUnsafeInference;
void exactUnsafeTool;
void literalTool;
void runWorkflow("export const meta = { name: 'compile', description: 'compile' }\nreturn true", runOptions);
void new WorkflowManager().resume("run-id", { argsPatch: { supplied: true } });
