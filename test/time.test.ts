import assert from "node:assert/strict"
import test from "node:test"
import { getTimeStamp } from "../src/time.js"

test("formats Pacific time across midnight, noon, and daylight-saving transitions", (t) => {
  t.mock.timers.enable({ apis: ["Date"] })
  const cases = [
    ["2026-01-01T07:59:00Z", "Dec 31 11:59 PM"],
    ["2026-01-01T08:00:00Z", "Jan 1 12:00 AM"],
    ["2026-01-01T20:05:00Z", "Jan 1 12:05 PM"],
    ["2026-09-23T19:05:00Z", "Sep 23 12:05 PM"],
    ["2026-03-08T09:59:00Z", "Mar 8 1:59 AM"],
    ["2026-03-08T10:00:00Z", "Mar 8 3:00 AM"],
    ["2026-11-01T08:59:00Z", "Nov 1 1:59 AM"],
    ["2026-11-01T09:00:00Z", "Nov 1 1:00 AM"],
  ] as const
  for (const [instant, expected] of cases) {
    t.mock.timers.setTime(new Date(instant).getTime())
    assert.equal(getTimeStamp(), expected, instant)
  }
})
