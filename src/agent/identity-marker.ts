import { randomInt } from "node:crypto"

import { appendTextContent } from "../mcp/tool-output.js"
import { asRecord } from "../utils.js"
import type { AgentIdentity } from "./context.js"

const CODE_SPACE = 36 ** 4
const codes = new Map<AgentIdentity, string>()
const identities = new Map<string, AgentIdentity>()
const MARKER = /(?:^|\n)\[sb:([A-Z0-9]{4})\]\s*$/u

/**
 * Identify an ordinary MCP response without asking the model to register or echo anything.
 * Codes are process-local correlation values, not credentials; they are unique and never recycled.
 * The caller must read them only from fresh MCP tool results in the submitted child turn.
 */
export function stampAgentIdentity(result: unknown, identity?: AgentIdentity): unknown {
  const response = asRecord(result)
  if (!response || !identity) return result
  let code = codes.get(identity)
  if (!code) {
    // Identity tracking must never prevent a tool response from being delivered.
    if (identities.size === CODE_SPACE) return result
    do {
      code = randomInt(CODE_SPACE).toString(36).toUpperCase().padStart(4, "0")
    } while (identities.has(code))
    codes.set(identity, code)
    identities.set(code, identity)
  }
  return {
    ...response,
    content: appendTextContent(response.content, `[sb:${code}]`),
  }
}

/** Accept the plain tool result or ChatGPT's JSON {text} wrapper; never search arbitrary nested content. */
export function identityFromToolResponse(text: string): AgentIdentity | undefined {
  let content = text
  try {
    const wrapped = asRecord(JSON.parse(text))
    if (typeof wrapped?.text === "string") content = wrapped.text
  } catch {
    // Plain text tool responses have no JSON wrapper.
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: RegExp.exec returns null for responses without a marker.
  const code = MARKER.exec(content)?.[1]
  return code ? identities.get(code) : undefined
}
