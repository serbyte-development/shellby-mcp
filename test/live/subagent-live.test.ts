import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import process from "node:process"
import test from "node:test"
import { openLiveSubagentHarness } from "./subagent-live-harness.js"

// All entry points run the same source lifecycle against real, authenticated ChatGPT.
// Default: reuse artifacts/subagent-live-conversation.json; never silently create a chat.
// Fresh runs create one source and one fork. LIVE_SUBAGENT_FORK=1 forks a reused source.
// LIVE_SUBAGENT_START=<conversation-id> adopts an existing test conversation without forking.
const LIVE_TEST_ENABLED = process.env.RUN_LIVE_SUBAGENT_TESTS === "1" && !process.env.CI
const TEST_FORK =
  process.env.LIVE_SUBAGENT_START === "fresh" || process.env.LIVE_SUBAGENT_FORK === "1"
const LIVE_TIMEOUT_MS = 12 * 60_000
const LONG_WAIT_MS = 270_000

test("live MCP subagent lifecycle with optional real conversation fork", {
  skip: !LIVE_TEST_ENABLED,
  timeout: LIVE_TIMEOUT_MS,
}, async (t) => {
  const hardExitTimer = setTimeout(() => {
    console.error("Live subagent test exceeded its 13-minute process cap; forcing exit.")
    process.exit(124)
  }, LIVE_TIMEOUT_MS + 60_000)
  hardExitTimer.unref()

  const live = await openLiveSubagentHarness(t, Date.now() + LIVE_TIMEOUT_MS - 15_000)
  const contextKey = `document-${randomUUID()}`
  const waitMarker = `receipt-${randomUUID()}`
  const sourceCheckpoint = `revision-${randomUUID()}`
  const literal = "https://example.com/, `web.run`, --- and café 🧪 中文"
  const responses = new Map<string, string>()

  try {
    await live.stage("startup and real 4.5-minute tool wait")
    const first = await live.run(
      [
        "Keep a short working note for this conversation.",
        `Document ID: ${contextKey}`,
        `Sample text to preserve exactly: ${literal}`,
        "Measure one 4.5-minute interval in Code Mode with this JavaScript:",
        `const started = Date.now(); await new Promise(resolve => setTimeout(resolve, ${LONG_WAIT_MS})); text({ receipt: "${waitMarker}", elapsed_ms: Date.now() - started });`,
        "Give the call at least 290000 ms. If it yields, wait on that same call until it finishes.",
        "Then return the timer receipt, measured elapsed_ms, document ID, and sample text.",
        "If Code Mode cannot run the timer, let me know.",
      ].join("\n")
    )
    assert.equal(first.status, "running", first.error)
    assert.ok(first.turn_id)
    const firstTurnId = first.turn_id

    const initial = await live.poll(firstTurnId, 0)
    assert.equal(initial.status, "running", "The awaited tool call must still be running")
    const busy = await live.run("Add a one-line summary to the working note.")
    assert.equal(busy.status, "failed")
    assert.match(busy.error ?? "", /^AGENT_BUSY:/u)
    assert.equal(busy.turn_id, undefined)

    // A finished MCP request/client must not own the lifetime of the submitted browser turn.
    await live.reconnectClient()
    const firstResponse = await live.complete(firstTurnId)
    responses.set(firstTurnId, firstResponse)
    assert.ok(firstResponse.includes(contextKey), "First response must contain the context key")
    assert.ok(firstResponse.includes(waitMarker), "The timer must finish before the final response")
    assert.ok(
      firstResponse.includes("café 🧪 中文"),
      "Unicode must survive prompt and response transport"
    )
    live.assertLongTurn(firstTurnId, LONG_WAIT_MS)
    assert.equal(live.submissions.length, 1, "Busy rejection and polling must not submit messages")
    const firstSubmission = live.submissions[0]!
    for (const token of [contextKey, "https://example.com/", "web.run", "---", "café 🧪 中文"])
      assert.ok(firstSubmission.prompt.includes(token), `Submitted prompt lost ${token}`)
    await live.assertSavedConversation()

    await live.stage("same-page follow-up and stable completed results")
    const firstPage = live.page()
    const second = await live.run(contextPrompt("Note update 1"))
    assert.equal(second.status, "running", second.error)
    assert.ok(second.turn_id)
    assert.notEqual(second.turn_id, firstTurnId)
    assert.equal((await live.poll(firstTurnId, 0)).response, firstResponse)
    const secondResponse = await live.complete(second.turn_id)
    assertContext(secondResponse, "Note update 1")
    responses.set(second.turn_id, secondResponse)
    assert.equal(live.page(), firstPage, "A healthy follow-up should reuse its tab")
    await live.assertSavedConversation()

    await live.stage("reopen a closed tab using saved conversation identity")
    await firstPage.close()
    const third = await live.run(contextPrompt("Note update 2"))
    assert.equal(third.status, "running", third.error)
    assert.ok(third.turn_id)
    const thirdResponse = await live.complete(third.turn_id)
    assertContext(thirdResponse, "Note update 2")
    responses.set(third.turn_id, thirdResponse)
    assert.notEqual(live.page(), firstPage)
    await live.assertSavedConversation()
    await live.assertWaitExecuted(LONG_WAIT_MS)
    await live.stage("completion latency after a long turn and a short follow-up")
    // The existing reopen supplies independent saved-final timestamps for both turns.
    await live.assertCompletionLatency(firstTurnId)
    await live.assertCompletionLatency(second.turn_id)
    assert.equal((await live.poll(second.turn_id, 60_000)).response, secondResponse)
    for (const [turnId, response] of responses) {
      const repeated = await live.poll(turnId, 0)
      assert.equal(repeated.status, "completed")
      assert.equal(repeated.response, response, "Later turns must not replace an earlier result")
    }

    await live.stage("restart isolated harness with only the saved conversation URL")
    await live.restartFromConversation()
    const lostResult = await live.poll(firstTurnId, 0)
    assert.equal(lostResult.status, "failed")
    assert.match(lostResult.error ?? "", /^UNKNOWN_TURN:/u)
    const fourth = await live.run(
      contextPrompt("Note update 3") +
        (TEST_FORK
          ? `\nAlso save this revision code with our current note and include it in the recap: ${sourceCheckpoint}`
          : "")
    )
    assert.equal(fourth.status, "running", fourth.error)
    assert.ok(fourth.turn_id)
    assert.ok(!responses.has(fourth.turn_id), "Lost counters must not reuse an old turn ID")
    const fourthResponse = await live.complete(fourth.turn_id)
    assertContext(fourthResponse, "Note update 3")
    assert.equal((await live.poll(fourth.turn_id, 0)).response, fourthResponse)
    await live.assertSavedConversation()
    assert.equal(live.submissions.length, 4, "Exactly one submission per lifecycle step")
    if (TEST_FORK) {
      assert.ok(fourthResponse.includes(sourceCheckpoint))
      await testFork()
    }
    const expectedSubmissions = TEST_FORK ? 9 : 4
    assert.equal(
      live.submissions.length,
      expectedSubmissions,
      "Follow-ups and recovery must not duplicate submissions"
    )
    assert.equal(
      new Set(live.submissions.map((submission) => submission.message_id)).size,
      expectedSubmissions
    )
    await live.finish()
  } catch (error) {
    await live.fail(error)
    throw error
  }

  function contextPrompt(marker: string): string {
    return `Please recap our current working note from the conversation, without using tools. Use "${marker}" as the heading, followed by the document ID and the exact sample text we saved. Leave out the timer receipt and previous update headings.`
  }

  function assertContext(response: string, marker: string): void {
    assert.ok(response.includes(contextKey), "Must recall a key absent from this follow-up prompt")
    assert.ok(
      response.includes("café 🧪 中文"),
      "Conversation must preserve earlier Unicode context"
    )
    assert.ok(response.includes(marker), "Result must belong to the newly submitted turn")
    assert.ok(!response.includes(waitMarker), "Must not return the first turn's cached answer")
  }

  async function testFork(): Promise<void> {
    const sourceId = await live.assertSavedConversation()
    const sourcePage = live.page()
    const branchKey = `draft-${randomUUID()}`
    const forkTurns = new Map<string, string>()

    await live.stage("fork from the latest source turn through subagent_run start_from")
    const first = await forkTurn(
      `For this draft, keep this draft ID: ${branchKey}`,
      "Draft update 1",
      sourcePage.url()
    )
    const forkId = await live.assertSavedConversation("fork")
    assert.notEqual(forkId, sourceId, "Forking must persist a distinct conversation ID")
    assert.equal(await live.assertSavedConversation(), sourceId)
    assert.equal(live.page(), sourcePage, "Forking must leave the existing source tab alone")
    const forkPage = live.page("fork")

    await live.stage("follow up in the fork without start_from")
    await forkTurn("", "Draft update 2")
    assert.equal(live.page("fork"), forkPage)
    assert.equal((await live.poll(first.turn_id!, 0)).response, forkTurns.get(first.turn_id!))

    await live.stage("reopen the fork without creating another branch")
    await forkPage.close()
    await forkTurn("", "Draft update 3", sourceId)
    assert.notEqual(live.page("fork"), forkPage)
    assert.equal(await live.assertSavedConversation("fork"), forkId)

    await live.stage("resume the fork after losing local counters and results")
    await live.restartFromConversation()
    const lost = await live.poll(first.turn_id!, 0)
    assert.equal(lost.status, "failed")
    assert.match(lost.error ?? "", /^UNKNOWN_TURN:/u)
    await forkTurn("", "Draft update 4", sourceId)
    assert.equal(await live.assertSavedConversation("fork"), forkId)

    await live.stage("verify the source still works and contains no fork submissions")
    const source = await live.run(contextPrompt("Note update 4"))
    assert.equal(source.status, "running", source.error)
    assert.ok(source.turn_id)
    assertContext(await live.complete(source.turn_id), "Note update 4")
    assert.equal(await live.assertSavedConversation(), sourceId)
    await live.assertForkIsolated()

    async function forkTurn(instruction: string, marker: string, startSource?: string) {
      const turn = await live.run(
        [
          instruction,
          "Please recap our current draft from the conversation, without using tools.",
          `Use "${marker}" as the heading, followed by the document ID, latest revision code, draft ID, and exact sample text we saved. Leave out the timer receipt and previous update headings.`,
        ]
          .filter(Boolean)
          .join("\n"),
        { agent: "fork", startSource }
      )
      assert.equal(turn.status, "running", turn.error)
      assert.ok(turn.turn_id)
      assert.ok(
        !forkTurns.has(turn.turn_id) && !responses.has(turn.turn_id),
        "Every fork turn must have a unique polling ID"
      )
      const response = await live.complete(turn.turn_id)
      assertContext(response, marker)
      assert.ok(response.includes(sourceCheckpoint), "The fork must inherit the latest source turn")
      assert.ok(response.includes(branchKey), "Fork follow-ups must preserve their own context")
      forkTurns.set(turn.turn_id, response)
      await live.assertSavedConversation("fork")
      return turn
    }
  }
})
