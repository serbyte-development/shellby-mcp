import assert from "node:assert/strict"
import test from "node:test"

import { getAgentIdentity, runWithAgent } from "../../src/agent/context.js"
import { identityFromToolResponse, stampAgentIdentity } from "../../src/agent/identity-marker.js"

test("identity stamps preserve tool output and resolve only the final known marker", () => {
  const agent = runWithAgent("marker-agent", () => getAgentIdentity()!)
  const other = runWithAgent("marker-other", () => getAgentIdentity()!)
  const original = {
    content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    structuredContent: { answer: "unchanged" },
    _meta: { private: "preserved" },
    isError: true,
  }
  const stamped = stampAgentIdentity(original, agent) as Omit<typeof original, "content"> & {
    content: Array<{ type: string; text?: string }>
  }
  const marker = stamped.content.at(-1)?.text
  assert.ok(marker)
  assert.match(marker, /^\[sb:[A-Z0-9]{4}\]$/u)
  assert.equal(stamped.content[0], original.content[0])
  assert.equal(stamped.structuredContent, original.structuredContent)
  assert.equal(stamped._meta, original._meta)
  assert.equal(stamped.isError, true)
  assert.equal(original.content.length, 1)
  assert.equal(identityFromToolResponse(marker), agent)
  assert.equal(identityFromToolResponse(JSON.stringify({ text: `tool output\n${marker}` })), agent)
  assert.equal(identityFromToolResponse(`tool output\n${marker}\n`), agent)
  assert.equal(identityFromToolResponse(`quoted ${marker}`), undefined)
  assert.equal(identityFromToolResponse(`${marker}\nnot a footer`), undefined)
  assert.equal(identityFromToolResponse(JSON.stringify({ nested: { text: marker } })), undefined)
  assert.equal(identityFromToolResponse("[sb:unknown]"), undefined)
  assert.equal(identityFromToolResponse("{malformed json"), undefined)
  assert.equal(stampAgentIdentity(original), original)
  const second = stampAgentIdentity({ content: [] }, other) as { content: Array<{ text: string }> }
  assert.notEqual(second.content[0]!.text, marker)
  assert.equal(identityFromToolResponse(`${marker}\n${second.content[0]!.text}`), other)
  const repeated = stampAgentIdentity({ content: [] }, agent) as typeof second
  assert.equal(repeated.content[0]!.text, marker)
  const textResult = { content: [{ type: "text", text: "Original output" }] }
  const textStamped = stampAgentIdentity(textResult, agent) as typeof textResult
  assert.deepEqual(textStamped.content, [{ type: "text", text: `Original output\n\n${marker}` }])
  assert.equal(textResult.content[0]!.text, "Original output")
})
