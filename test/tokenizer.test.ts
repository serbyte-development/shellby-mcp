import assert from "node:assert/strict"
import test from "node:test"

import { countTokens, OUTPUT_TOKEN_ENCODING, tokenChunk, tokenPrefix } from "../src/tokenizer.js"

test("counts output with o200k_base", () => {
  assert.equal(OUTPUT_TOKEN_ENCODING, "o200k_base")
  assert.equal(countTokens("hello world"), 2)
})

test("returns the largest valid prefix within a token budget", () => {
  const value = "🙂éA ".repeat(100)
  const bounded = tokenPrefix(value, 64)

  assert.equal(value.startsWith(bounded.value), true)
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.value.length > 0)
  assert.ok(bounded.tokenCount <= 64)
  assert.equal(countTokens(bounded.value), bounded.tokenCount)
})

test("returns complete text when it already fits", () => {
  const value = "small output"
  assert.deepEqual(tokenPrefix(value, 64), {
    value,
    tokenCount: countTokens(value),
    truncated: false,
  })
})

test("chunks a bounded token window without losing content", () => {
  const value = "stdout line abcdefghijklmnopqrstuvwxyz 1234567890\n".repeat(10_000)
  let cursor = 0
  let rebuilt = ""

  while (cursor < value.length) {
    const chunk = tokenChunk(value, cursor, 256)
    assert.ok(chunk.value.length > 0)
    assert.ok(chunk.tokenCount <= 256)
    assert.equal(chunk.nextOffset > cursor, true)
    rebuilt += chunk.value
    cursor = chunk.nextOffset
  }

  assert.equal(rebuilt, value)
})
