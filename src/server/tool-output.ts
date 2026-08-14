const SHORT_STRING_MAX = 120
const MAX_INLINE_LINE = 240
const MAX_NESTED_DEPTH = 2

export function compactToolResult(result: unknown): unknown {
  if (!isRecord(result) || result.structuredContent === undefined) return result
  const rendered = renderStructuredContent(result.structuredContent)
  const compact = { ...result }
  delete compact.structuredContent
  if (!rendered) return compact
  compact.content = appendTextContent(compact.content, rendered)
  return compact
}

export function appendToolEvents(result: unknown, events: readonly string[]): unknown {
  if (events.length === 0 || !isRecord(result)) return result
  return {
    ...result,
    content: appendTextContent(result.content, events.join("\n")),
  }
}

export function renderStructuredContent(value: unknown): string {
  if (isRecord(value)) return renderRecord(value, 0)
  if (Array.isArray(value)) return renderArray(value, 0)
  return `result=${formatScalar(value)}`
}

/**
 * Render a record as a string, with nested records indented and arrays rendered as lists.
 * @param record - The record to render. Empty values are skipped.
 * @param depth - The depth of the record.
 * @returns The rendered record as a string.
 */
function renderRecord(record: Record<string, unknown>, depth: number): string {
  const inline: string[] = []
  const sections: string[] = []

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    if (isInlineScalar(value)) {
      inline.push(`${key}=${formatScalar(value)}`)
      continue
    }

    if (typeof value === "string") {
      sections.push(`${key}:${key === "output" ? "\n\n" : "\n"}${value}`)
      continue
    }

    if (Array.isArray(value)) {
      sections.push(`${key}:\n\n${renderArray(value, depth + 1)}`)
      continue
    }

    if (isRecord(value) && depth < MAX_NESTED_DEPTH) {
      const nested = renderRecord(value, depth + 1)
      sections.push(nested ? `${key}:\n${nested}` : `${key}={}`)
      continue
    }

    sections.push(`${key}=${minifiedJson(value)}`)
  }

  const inlineText = wrapInlineParts(inline)
  return [inlineText, ...sections].filter(Boolean).join("\n\n")
}

function renderArray(values: readonly unknown[], depth: number): string {
  if (values.length === 0) return "[]"
  if (values.every(isInlineScalar)) return minifiedJson(values)

  if (values.every(isSimpleRow)) {
    return values
      .map((value) => {
        const row = Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => `${key}=${formatScalar(item)}`)
          .join(" ")
        return `- ${row}`
      })
      .join("\n")
  }

  if (depth <= MAX_NESTED_DEPTH && values.every(isRecord)) {
    return values.map((value) => `- ${minifiedJson(value)}`).join("\n")
  }

  return minifiedJson(values)
}

function appendTextContent(content: unknown, text: string): unknown[] {
  const items = Array.isArray(content) ? [...content] : []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue
    items[index] = {
      ...item,
      text: item.text ? `${item.text}\n\n${text}` : text,
    }
    return items
  }
  items.push({ type: "text", text })
  return items
}

function wrapInlineParts(parts: readonly string[]): string {
  if (parts.length === 0) return ""
  const lines: string[] = []
  let line = ""
  for (const part of parts) {
    if (!line) {
      line = part
      continue
    }
    if (line.length + 1 + part.length <= MAX_INLINE_LINE) {
      line += ` ${part}`
      continue
    }
    lines.push(line)
    line = part
  }
  if (line) lines.push(line)
  return lines.join("\n")
}

function isInlineScalar(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return true
  return typeof value === "string" && !value.includes("\n") && value.length <= SHORT_STRING_MAX
}

function isSimpleRow(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(isInlineScalar)
}

function formatScalar(value: unknown): string {
  if (value === undefined) return "undefined"
  if (typeof value !== "string") return String(value)
  if (value === "") return '""'
  if (isAmbiguousBareString(value)) return JSON.stringify(value)
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function isAmbiguousBareString(value: string): boolean {
  if (value === "null" || value === "true" || value === "false" || value === "NaN" || value === "Infinity" || value === "-Infinity") return true
  return value.trim() === value && value !== "" && Number.isFinite(Number(value))
}

function minifiedJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
