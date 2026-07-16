import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { extractValidated, resolveStructuredOutput, type StructuredSession } from "../src/agent.js";
import type { StructuredOutputCapture } from "../src/structured-output.js";

const literalSchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    items: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "number" as const },
          active: { type: "boolean" as const },
        },
        required: ["id", "active"],
      },
    },
  },
  required: ["name", "items"],
};

test("literal plain JSON Schema validates required object fields, arrays, and nested objects", async () => {
  const capture: StructuredOutputCapture = { called: false, value: undefined };
  const session: StructuredSession = {
    async prompt() {},
    messages: [],
  };
  const value = { name: "demo", items: [{ id: 1, active: true }] };

  const result = await resolveStructuredOutput(session, capture, literalSchema, { maxSchemaRetries: 0 }, () =>
    JSON.stringify(value),
  );
  assert.deepEqual(result, value);
});

test("literal plain JSON Schema rejects invalid nested output", () => {
  assert.equal(extractValidated('{"name":"demo","items":[{"id":1}]}', literalSchema), undefined);
  assert.equal(extractValidated('{"items":[]}', literalSchema), undefined);
  assert.equal(extractValidated('{"name":"demo","items":"not-an-array"}', literalSchema), undefined);
});

test("literal schemas support enum-only nodes and readonly as-const nested definitions", () => {
  const schema = {
    type: "object",
    properties: {
      status: { enum: ["ready", "blocked"] },
      nested: {
        type: "array",
        items: {
          type: "object",
          properties: { priority: { enum: [1, 2, 3] } },
          required: ["priority"],
        },
      },
    },
    required: ["status", "nested"],
  } as const;

  assert.deepEqual(extractValidated('{"status":"ready","nested":[{"priority":2}]}', schema), {
    status: "ready",
    nested: [{ priority: 2 }],
  });
  assert.equal(extractValidated('{"status":"unknown","nested":[{"priority":2}]}', schema), undefined);
  assert.equal(extractValidated('{"status":"ready","nested":[{"priority":4}]}', schema), undefined);
});

test("TypeBox schema behavior remains unchanged", () => {
  const typeBoxSchema = Type.Object({
    name: Type.String(),
    items: Type.Array(Type.Object({ id: Type.Number(), active: Type.Boolean() })),
  });
  assert.deepEqual(extractValidated('{"name":"demo","items":[{"id":1,"active":true}]}', typeBoxSchema), {
    name: "demo",
    items: [{ id: 1, active: true }],
  });
  assert.equal(extractValidated('{"name":"demo","items":[{"id":"bad","active":true}]}', typeBoxSchema), undefined);
});
