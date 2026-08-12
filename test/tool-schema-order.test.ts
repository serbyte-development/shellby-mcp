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

  assert.deepEqual(Object.keys(schema), ["type", "description", "properties", "required", "$schema"])

  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(properties), ["z", "type", "a"])
  assert.deepEqual(Object.keys(properties.z ?? {}), ["type", "description", "minLength", "maxLength"])
  assert.deepEqual(Object.keys(properties.type ?? {}), ["type", "description", "default"])
  assert.deepEqual(Object.keys(properties.a ?? {}), ["type", "description", "minimum", "maximum"])
})

test("does not reorder objects stored as schema data", () => {
  const defaultValue = { type: "literal", z: 1, a: 2 }
  const schema = canonicalizeJsonSchema({ default: defaultValue, type: "object" }) as Record<string, unknown>

  assert.deepEqual(Object.keys(schema), ["type", "default"])
  assert.equal(schema.default, defaultValue)
  assert.deepEqual(Object.keys(schema.default as Record<string, unknown>), ["type", "z", "a"])
})
