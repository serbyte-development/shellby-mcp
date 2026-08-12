import assert from "node:assert/strict"
import test from "node:test"

import { canonicalizeJsonSchema } from "../src/server/tool-schema-order.js"

test("canonicalizes schema keywords while preserving property order", () => {
  const schema = canonicalizeJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description: "Example",
    required: ["z", "type"],
    properties: {
      z: { maxLength: 64, description: "Z", type: "string", minLength: 1 },
      type: { default: "example", description: "Named type", type: "string" },
      a: { maximum: 10, type: "integer", description: "A", minimum: 1 },
    },
    type: "object",
  }) as Record<string, unknown>

  assert.deepEqual(Object.keys(schema), ["description", "type", "properties", "required", "$schema"])

  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(properties), ["z", "type", "a"])
  assert.deepEqual(Object.keys(properties.z ?? {}), ["description", "type", "minLength", "maxLength"])
  assert.deepEqual(Object.keys(properties.type ?? {}), ["description", "type", "default"])
  assert.deepEqual(Object.keys(properties.a ?? {}), ["description", "type", "minimum", "maximum"])
})

test("prioritizes shape before defaults and exact choices", () => {
  const schema = canonicalizeJsonSchema({
    const: "a",
    enum: ["a", "b"],
    default: "a",
    oneOf: [{ type: "string" }],
    anyOf: [{ type: "string" }],
    allOf: [{ type: "string" }],
    type: "string",
    description: "Example",
  }) as Record<string, unknown>

  assert.deepEqual(Object.keys(schema), ["description", "type", "anyOf", "oneOf", "allOf", "default", "enum", "const"])
})

test("does not reorder objects stored as schema data", () => {
  const defaultValue = { type: "literal", z: 1, a: 2 }
  const schema = canonicalizeJsonSchema({ default: defaultValue, type: "object" }) as Record<string, unknown>

  assert.deepEqual(Object.keys(schema), ["type", "default"])
  assert.equal(schema.default, defaultValue)
  assert.deepEqual(Object.keys(schema.default as Record<string, unknown>), ["type", "z", "a"])
})
