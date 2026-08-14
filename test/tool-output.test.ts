import assert from "node:assert/strict"
import test from "node:test"

import { compactToolResult, renderStructuredContent } from "../src/server/tool-output.js"
import { countTokens } from "../src/tokenizer.js"

test("renders compact scalar metadata and multiline strings without losing values", () => {
  const structured = {
    status: "completed",
    exit_code: 0,
    cwd: "/workspace",
    output: "line one\nline two",
  }
  const rendered = renderStructuredContent(structured)

  assert.equal(rendered, "status=completed exit_code=0 cwd=/workspace\n\noutput:\n\nline one\nline two")
  assert.match(rendered, /completed/)
  assert.match(rendered, /\/workspace/)
  assert.match(rendered, /line one\nline two/)
  assert.ok(countTokens(rendered) < countTokens(JSON.stringify(structured)))
})

test("quotes strings that would otherwise be indistinguishable from non-string scalars", () => {
  assert.equal(
    renderStructuredContent({
      string_false: "false",
      boolean_false: false,
      string_null: "null",
      null_value: null,
      string_number: "123",
      number_value: 123,
    }),
    'string_false="false" boolean_false=false string_null="null" null_value=null string_number="123" number_value=123'
  )
})

test("renders arrays of simple objects as compact rows and nested objects recursively", () => {
  assert.equal(
    renderStructuredContent({
      turns: [
        { turn_id: "a", status: "running" },
        { turn_id: "b", status: "completed" },
      ],
      metadata: { count: 2, source: "chatgpt" },
    }),
    "turns:\n- turn_id=a status=running\n- turn_id=b status=completed\n\nmetadata:\ncount=2 source=chatgpt"
  )
})

test("falls back to minified JSON for unusual nested arrays", () => {
  const nested = { items: [[{ value: 1 }], [{ value: 2 }]] }
  assert.equal(renderStructuredContent(nested), 'items:\n[[{"value":1}],[{"value":2}]]')
})

test("compact result preserves existing content and removes structuredContent", () => {
  const compact = compactToolResult({
    structuredContent: { status: "completed", output: "hello" },
    content: [{ type: "text", text: "Command finished." }],
  }) as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }

  assert.equal(compact.structuredContent, undefined)
  assert.deepEqual(compact.content, [{ type: "text", text: "Command finished.\n\nstatus=completed output=hello" }])
})

test("preserves representative values from every non-Computer tool family", () => {
  const examples = [
    { status: "completed", exit_code: 0, cwd: "/workspace", output: "shell output" },
    { status: "failed", exit_code: 1, output: "patch diagnostic", output_dropped: true },
    { url: "https://example.com", title: "Example Page", content: "web body", next_cursor: "cursor-2" },
    { skills: [{ name: "create-wiki", description: "Create a wiki" }] },
    { id: "fb_123", created_at: "2026-08-14T00:00:00.000Z" },
    { turns: [{ turn_id: "review_turn_1", status: "completed", response: "subagent answer" }] },
  ]

  const rendered = examples.map(renderStructuredContent)
  for (const value of [
    "/workspace",
    "shell output",
    "patch diagnostic",
    "https://example.com",
    "web body",
    "create-wiki",
    "fb_123",
    "review_turn_1",
    "subagent answer",
  ]) {
    assert.ok(rendered.some((output) => output.includes(value)), `missing ${value}`)
  }
})
