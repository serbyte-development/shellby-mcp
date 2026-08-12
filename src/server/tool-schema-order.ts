import type { McpServer } from "@modelcontextprotocol/server"

const SCHEMA_KEY_ORDER = [
  "description",
  "type",
  "$ref",
  "anyOf",
  "oneOf",
  "allOf",
  "default",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "prefixItems",
  "contains",
  "minContains",
  "maxContains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
  "$defs",
  "definitions",
  "examples",
  "title",
] as const

const SCHEMA_KEY_RANK = new Map<string, number>(SCHEMA_KEY_ORDER.map((key, index) => [key, index]))
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"])
const SCHEMA_VALUE_KEYS = new Set([
  "additionalProperties",
  "propertyNames",
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
])
const SCHEMA_ARRAY_KEYS = new Set(["prefixItems", "allOf", "anyOf", "oneOf"])
const canonicalizedSchemas = new WeakSet<object>()

interface ToolRegistrationConfig {
  annotations?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
  [key: string]: unknown
}

const TOOL_ANNOTATION_DEFAULTS: Record<string, unknown> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

interface StandardSchemaJsonSource {
  jsonSchema?: {
    input: (options: unknown) => unknown
    output: (options: unknown) => unknown
  }
}

export function installCanonicalToolSchemaOrder(server: McpServer): void {
  const registerTool = server.registerTool.bind(server) as unknown as (name: string, config: ToolRegistrationConfig, callback: unknown) => unknown

  server.registerTool = ((name: string, config: ToolRegistrationConfig, callback: unknown) => {
    canonicalizeStandardSchema(config.inputSchema)
    canonicalizeStandardSchema(config.outputSchema)
    const annotations = compactToolAnnotations(config.annotations)
    if (annotations === undefined) delete config.annotations
    else config.annotations = annotations
    return registerTool(name, config, callback)
  }) as typeof server.registerTool
}

export function compactToolAnnotations(value: unknown): unknown {
  if (!isRecord(value)) return value

  const annotations = Object.fromEntries(Object.entries(value).filter(([key, annotation]) => TOOL_ANNOTATION_DEFAULTS[key] !== annotation))
  if (annotations.readOnlyHint === true) {
    delete annotations.destructiveHint
    delete annotations.idempotentHint
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined
}

export function canonicalizeJsonSchema(value: unknown): unknown {
  if (!isRecord(value)) return value

  const isIntegerSchema = value.type === "integer"
  const keys = Object.keys(value).sort((left, right) => {
    const leftRank = SCHEMA_KEY_RANK.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightRank = SCHEMA_KEY_RANK.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftRank - rightRank
  })
  const result: Record<string, unknown> = {}

  for (const key of keys) {
    const child = value[key]
    if (key === "$schema") continue
    if (isIntegerSchema && key === "minimum" && child === Number.MIN_SAFE_INTEGER) continue
    if (isIntegerSchema && key === "maximum" && child === Number.MAX_SAFE_INTEGER) continue

    if (SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
      result[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, canonicalizeJsonSchema(schema)]))
    } else if (SCHEMA_VALUE_KEYS.has(key)) {
      result[key] = canonicalizeJsonSchema(child)
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      result[key] = child.map((schema) => canonicalizeJsonSchema(schema))
    } else {
      result[key] = child
    }
  }

  return result
}

function canonicalizeStandardSchema(schema: unknown): void {
  if (!isRecord(schema) || canonicalizedSchemas.has(schema)) return
  const standard = schema["~standard"]
  if (!isRecord(standard)) return
  const source = standard as StandardSchemaJsonSource
  if (!source.jsonSchema) return

  const input = source.jsonSchema.input
  const output = source.jsonSchema.output
  source.jsonSchema = {
    input: (options) => canonicalizeJsonSchema(input(options)),
    output: (options) => canonicalizeJsonSchema(output(options)),
  }
  canonicalizedSchemas.add(schema)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
