import assert from "node:assert/strict"
import test from "node:test"

import { nonNegativeInteger, positiveInteger } from "../src/utils.js"

test("positiveInteger defaults only missing values", () => {
  assert.equal(positiveInteger(undefined, 4), 4)
  assert.equal(positiveInteger(2, 4), 2)

  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => positiveInteger(value, 4), /Expected a positive integer/)
  }
})

test("nonNegativeInteger defaults only missing values", () => {
  assert.equal(nonNegativeInteger(undefined, 4), 4)
  assert.equal(nonNegativeInteger(0, 4), 0)
  assert.equal(nonNegativeInteger(2, 4), 2)

  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => nonNegativeInteger(value, 4), /Expected a non-negative integer/)
  }
})
