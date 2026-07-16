import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export type LiteralJsonPrimitive = string | number | boolean | null;

type LiteralSchemaMetadata = {
  readonly description?: string;
};

/** Plain, readonly-friendly JSON Schema subset accepted in workflow scripts. */
export type LiteralJsonSchema = LiteralSchemaMetadata &
  (
    | {
        readonly enum: readonly LiteralJsonPrimitive[];
        readonly type?: "string" | "number" | "integer" | "boolean" | "null";
      }
    | {
        readonly type: "object";
        readonly properties?: Readonly<Record<string, LiteralJsonSchema>>;
        readonly required?: readonly string[];
        readonly additionalProperties?: boolean;
      }
    | {
        readonly type: "array";
        readonly items: LiteralJsonSchema;
      }
    | { readonly type: "string" | "number" | "integer" | "boolean" | "null" }
  );

export type WorkflowSchema = TSchema | LiteralJsonSchema;

type LiteralRequiredKeys<
  TSchemaDef,
  TProperties extends Readonly<Record<string, LiteralJsonSchema>>,
> = TSchemaDef extends { readonly required: readonly (infer TRequired)[] }
  ? Extract<TRequired, keyof TProperties>
  : never;

type LiteralObjectOutput<TSchemaDef, TProperties extends Readonly<Record<string, LiteralJsonSchema>>> = {
  -readonly [TKey in LiteralRequiredKeys<TSchemaDef, TProperties>]-?: LiteralSchemaOutput<TProperties[TKey]>;
} & {
  -readonly [TKey in Exclude<keyof TProperties, LiteralRequiredKeys<TSchemaDef, TProperties>>]?: LiteralSchemaOutput<
    TProperties[TKey]
  >;
};

export type LiteralSchemaOutput<TSchemaDef> = TSchemaDef extends {
  readonly enum: readonly (infer TValue)[];
}
  ? TValue
  : TSchemaDef extends {
        readonly type: "object";
        readonly properties: infer TProperties extends Readonly<Record<string, LiteralJsonSchema>>;
      }
    ? LiteralObjectOutput<TSchemaDef, TProperties>
    : TSchemaDef extends { readonly type: "object" }
      ? Record<string, unknown>
      : TSchemaDef extends { readonly type: "array"; readonly items: infer TItems }
        ? LiteralSchemaOutput<TItems>[]
        : TSchemaDef extends { readonly type: "string" }
          ? string
          : TSchemaDef extends { readonly type: "number" | "integer" }
            ? number
            : TSchemaDef extends { readonly type: "boolean" }
              ? boolean
              : TSchemaDef extends { readonly type: "null" }
                ? null
                : unknown;

export type SchemaOutput<TSchemaDef extends WorkflowSchema> = TSchemaDef extends {
  readonly "~unsafe": unknown;
}
  ? Static<Extract<TSchemaDef, TSchema>>
  : TSchemaDef extends { readonly "~kind": string }
    ? Static<Extract<TSchemaDef, TSchema>>
    : LiteralSchemaOutput<TSchemaDef>;

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined;
  called: boolean;
}

/** Upstream TypeBox options contract. Keep this generic exact. */
export interface StructuredOutputToolOptions<TSchemaDef extends TSchema> {
  schema: TSchemaDef;
  capture: StructuredOutputCapture<Static<TSchemaDef>>;
  name?: string;
}

export interface LiteralStructuredOutputToolOptions<TSchemaDef extends LiteralJsonSchema> {
  schema: TSchemaDef extends { readonly "~kind": string } ? never : TSchemaDef;
  capture: StructuredOutputCapture<LiteralSchemaOutput<TSchemaDef>>;
  name?: string;
}

/**
 * Create a terminating tool that captures validated params as the subagent result.
 *
 * Pi validates `params` against `schema` before execute() is called. Returning
 * `terminate: true` lets the subagent finish on this tool call without paying for
 * an extra assistant follow-up turn.
 */
export function createStructuredOutputTool<const TSchemaDef extends LiteralJsonSchema>(
  options: LiteralStructuredOutputToolOptions<TSchemaDef>,
): ToolDefinition<TSchema, LiteralSchemaOutput<TSchemaDef>>;
export function createStructuredOutputTool<TSchemaDef extends TSchema>(
  options: StructuredOutputToolOptions<TSchemaDef>,
): ToolDefinition<TSchemaDef, Static<TSchemaDef>>;
export function createStructuredOutputTool({
  schema,
  capture,
  name = "structured_output",
}: {
  schema: WorkflowSchema;
  capture: StructuredOutputCapture<unknown>;
  name?: string;
}): ToolDefinition<TSchema, unknown> {
  return defineTool({
    name,
    label: "Structured Output",
    description: "Return the final machine-readable result for this subagent task.",
    promptSnippet: "Return final machine-readable output",
    promptGuidelines: [
      `${name} is the final answer channel for this task; call ${name} exactly once when done.`,
      `Do not write a prose final answer after calling ${name}.`,
    ],
    // Pi and TypeBox's value helpers accept this JSON-Schema subset at runtime;
    // the cast bridges TypeBox's symbol-bearing compile-time TSchema interface.
    parameters: schema as TSchema,
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
