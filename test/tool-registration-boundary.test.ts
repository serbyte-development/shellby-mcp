import assert from "node:assert/strict"
import test from "node:test"

import { canonicalizeJsonSchema, compactToolAnnotations } from "../src/server/tool-registration-boundary.js"

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

  assert.deepEqual(Object.keys(schema), ["description", "type", "properties", "required"])

  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(properties), ["z", "type", "a"])
  assert.deepEqual(Object.keys(properties.z ?? {}), ["description", "type", "minLength", "maxLength"])
  assert.deepEqual(Object.keys(properties.type ?? {}), ["description", "type", "default"])
  assert.deepEqual(Object.keys(properties.a ?? {}), ["description", "type", "minimum", "maximum"])
})

test("removes schema metadata and artificial safe-integer bounds", () => {
  const schema = canonicalizeJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      unbounded: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      nonnegative: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      bounded: { type: "integer", minimum: 0, maximum: 255 },
      number: { type: "number", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    },
  }) as Record<string, unknown>

  assert.equal("$schema" in schema, false)
  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(properties.unbounded, { type: "integer" })
  assert.deepEqual(properties.nonnegative, { type: "integer", minimum: 0 })
  assert.deepEqual(properties.bounded, { type: "integer", minimum: 0, maximum: 255 })
  assert.deepEqual(properties.number, {
    type: "number",
    minimum: Number.MIN_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  })
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

test("omits default and irrelevant read-only annotations while preserving extension values", () => {
  assert.equal(
    compactToolAnnotations({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    }),
    undefined
  )
  assert.deepEqual(
    compactToolAnnotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: "Read records",
    }),
    {
      readOnlyHint: true,
      openWorldHint: false,
      title: "Read records",
    }
  )
})
