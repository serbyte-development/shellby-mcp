import assert from "node:assert/strict"
import test from "node:test"
import {
  ChatGptTurnTracker,
  findSavedTurnAnswer,
  submittedTurn,
} from "../../../src/tools/delegation/turn-protocol.js"
import { mcpToolResponse } from "../../fixtures/chatgpt-tool-response.js"

function turnFrame(topicId: string, encodedItem: string): string {
  return JSON.stringify([
    {
      type: "message",
      topic_id: topicId,
      payload: {
        type: "conversation-turn-stream",
        payload: { type: "stream-item", encoded_item: encodedItem },
      },
    },
  ])
}

function message(
  role: "user" | "assistant",
  text: string,
  options: {
    id?: string
    conversationId?: string
    recipient?: string
    status?: string
    endTurn?: boolean | null
  } = {}
): string {
  return `event: delta\ndata: ${JSON.stringify({ conversation_id: options.conversationId, v: { message: { id: options.id ?? `${role}-1`, author: { role }, content: { content_type: "text", parts: [text] }, status: options.status ?? "finished_successfully", end_turn: options.endTurn ?? null, metadata: {}, recipient: options.recipient ?? "all" } } })}\n\n`
}

test("only fresh completed MCP results are reported; fork history, echoes, and other topics are ignored", () => {
  const responses: string[] = []
  const tracker = new ChatGptTurnTracker("submitted", {
    onToolResponse: (text) => responses.push(text),
  })
  const topic = "conversation-turn-current"
  const encode = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const send = (value: unknown, source = topic) =>
    tracker.ingestFrame(turnFrame(source, encode(value)))
  const tool = mcpToolResponse("current-tool", "result")
  send({ v: { message: tool } }) // Before the submitted user message: inherited history.
  send({
    type: "input_message",
    input_message: {
      id: "submitted",
      author: { role: "user" },
      content: { parts: ["new prompt"] },
      metadata: { working_turn_id: "fixture-turn" },
    },
  })
  send({ v: { message: tool } }, "conversation-turn-other")
  send({
    v: {
      message: {
        ...tool,
        id: "old-tool",
        metadata: {
          ...tool.metadata,
          working_turn_id: "inherited-turn",
        },
      },
    },
  })
  send({ v: { message: { ...tool, id: "echo", author: { role: "assistant" } } } })
  send({
    v: {
      message: { ...tool, id: "code-mode-echo", author: { role: "tool", name: "functions.exec" } },
    },
  })
  send({
    v: { message: { ...tool, id: "non-mcp-tool", metadata: { working_turn_id: "fixture-turn" } } },
  })
  assert.deepEqual(responses, [])
  send({
    v: { message: { ...tool, status: "in_progress", content: { ...tool.content, text: "" } } },
  })
  send({ p: "/message/content/text", o: "append", v: tool.content.text })
  assert.deepEqual(responses, [], "Incomplete results cannot establish identity")
  send({ p: "/message/status", o: "replace", v: "finished_successfully" })
  send({ v: { message: tool } })
  assert.deepEqual(responses, ["result"], "Replay is idempotent")
  tracker.ingestFrame(
    turnFrame(topic, message("assistant", "Actual final answer", { endTurn: true }))
  )
  const result = send({ type: "message_stream_complete" })
  assert.equal(result?.text, "Actual final answer")
  send({ v: { message: { ...tool, id: "after-completion" } } })
  assert.equal(responses.length, 1)
})

test("tool deltas never modify the prior assistant response", () => {
  const tracker = new ChatGptTurnTracker("user-1")
  tracker.ingestSse(message("user", "prompt"))
  tracker.ingestSse(message("assistant", "answer", { endTurn: true }))
  const tool = mcpToolResponse("tool", "irrelevant")
  tracker.ingestSse(`data: ${JSON.stringify({ v: { message: tool } })}\n\n`)
  tracker.ingestSse(
    'data: {"p":"/message/content/text","o":"append","v":"should not enter answer"}\n\n'
  )
  assert.equal(tracker.ingestSse('data: {"type":"message_stream_complete"}\n\n')?.text, "answer")
})

test("history recovery rejects an older identical prompt before the current turn appears", () => {
  const staleHistory = [savedUser("old-user", "repeat"), savedAnswer("old-answer", "old answer")]
  const submission = { messageId: "current-user", parentMessageId: "old-answer" }

  assert.equal(findSavedTurnAnswer({ messages: staleHistory }, submission), undefined)
  assert.equal(
    findSavedTurnAnswer(
      {
        messages: [
          ...staleHistory,
          savedUser("current-user", "repeat"),
          savedAnswer("new-answer", "new answer"),
        ],
      },
      submission
    )?.text,
    "new answer"
  )
})

test("history recovery uses message identity after composer serialization", () => {
  const payload = {
    messages: [savedUser("submitted", "Use \\`web.run\\`."), savedAnswer("answer", "done")],
  }
  assert.equal(findSavedTurnAnswer(payload, { messageId: "submitted" })?.text, "done")
  assert.equal(findSavedTurnAnswer(payload, undefined), undefined)
})

test("history recovery includes manual follow-ups but waits for the latest user to be answered", () => {
  const inherited = Array.from({ length: 10 }, (_, index) => [
    savedUser(`inherited-user-${index}`),
    savedAnswer(`inherited-answer-${index}`),
  ]).flat()
  const submission = { messageId: "submitted", parentMessageId: "inherited-answer-9" }
  const messages = [...inherited, savedUser("submitted"), savedAnswer("initial-answer")]
  messages.push(savedUser("manual-continue", "continue"))
  assert.equal(findSavedTurnAnswer({ messages }, submission), undefined)
  messages.push(savedAnswer("recovered-answer", "recovered answer"))
  assert.equal(findSavedTurnAnswer({ messages }, submission)?.text, "recovered answer")
  messages.push(savedUser("manual-follow-up", "one more thing"))
  assert.equal(findSavedTurnAnswer({ messages }, submission), undefined)
})

test("history recovery preserves image-only user boundaries and requires a completed final reply", () => {
  const payload = {
    messages: [
      savedUser("submitted"),
      savedAnswer("old-answer"),
      { id: "image", author: { role: "user" }, content: { parts: [{ image: "attachment" }] } },
    ],
  }
  const submission = { messageId: "submitted" }
  for (const incomplete of [
    { status: "in_progress" },
    { end_turn: false },
    { recipient: "web.run" },
    { content: { parts: [""] } },
  ]) {
    assert.equal(
      findSavedTurnAnswer(
        {
          messages: [
            ...payload.messages,
            {
              ...savedAnswer("partial"),
              ...incomplete,
            },
          ],
        },
        submission
      ),
      undefined
    )
  }
  assert.equal(
    findSavedTurnAnswer(
      { messages: [...payload.messages, savedAnswer("image-answer")] },
      submission
    )?.id,
    "image-answer"
  )
})

test("an edited submission uses its captured parent, even when the answer text is unchanged", () => {
  const submission = { messageId: "original-user", parentMessageId: "previous-answer" }
  const messages = [
    savedUser("previous-user"),
    savedAnswer("previous-answer", "same text"),
    savedUser("edited-user"),
    savedAnswer("edited-answer", "same text"),
  ]
  assert.equal(findSavedTurnAnswer({ messages }, submission)?.id, "edited-answer")
  assert.equal(findSavedTurnAnswer({ messages: messages.slice(0, 2) }, submission), undefined)
  assert.equal(findSavedTurnAnswer({ messages: messages.slice(0, 3) }, submission), undefined)
  for (const parentMessageId of [undefined, "unknown-parent"]) {
    assert.equal(findSavedTurnAnswer({ messages }, { ...submission, parentMessageId }), undefined)
  }
  // Prefer the original user ID when it is still present, regardless of parent history.
  assert.equal(
    findSavedTurnAnswer({ messages: [...messages, savedUser("original-user")] }, submission),
    undefined
  )
})

test("fresh-chat edits accept the captured root sentinel, and system parents remain usable", () => {
  // Observed first-send parent is client-created-root; saved history has a real
  // system root instead, and editing replaces the original user ID entirely.
  const root = { id: "saved-root", author: { role: "system" } }
  const messages = [root, savedUser("edited-user"), savedAnswer("edited-answer")]
  for (const parentMessageId of ["client-created-root", "saved-root"]) {
    const submission = { messageId: "original-user", parentMessageId }
    assert.equal(findSavedTurnAnswer({ messages }, submission)?.id, "edited-answer")
    assert.equal(findSavedTurnAnswer({ messages: [root] }, submission), undefined)
  }
})

test("edited fork recovery follows the active branch and ignores abandoned original answers", () => {
  const payload = {
    current_node: "edited-answer",
    mapping: {
      parent: { parent: null, message: savedAnswer("parent", "inherited") },
      original: { parent: "parent", message: savedUser("original") },
      abandoned: { parent: "original", message: savedAnswer("abandoned", "wrong branch") },
      edited: { parent: "parent", message: savedUser("edited") },
      "edited-answer": {
        parent: "edited",
        message: savedAnswer("edited-answer", "correct branch"),
      },
    },
  }
  const submission = { messageId: "original", parentMessageId: "parent" }
  assert.equal(findSavedTurnAnswer(payload, submission)?.text, "correct branch")
  assert.equal(findSavedTurnAnswer({ ...payload, current_node: "edited" }, submission), undefined)
  assert.equal(findSavedTurnAnswer({ ...payload, current_node: "parent" }, submission), undefined)
})

test("outgoing request identity ignores malformed requests and non-submission actions", () => {
  const user = { id: "submitted", author: { role: "user" } }
  const assistant = { id: "assistant", author: { role: "assistant" } }
  assert.equal(submittedTurn("not JSON"), undefined)
  assert.equal(submittedTurn(JSON.stringify({ action: "continue", messages: [user] })), undefined)
  assert.equal(submittedTurn(JSON.stringify({ action: "next", messages: [assistant] })), undefined)
  for (const parentMessageId of [undefined, "client-created-root", "fork-parent"]) {
    assert.deepEqual(
      submittedTurn(
        JSON.stringify({
          action: "next",
          parent_message_id: parentMessageId,
          messages: [assistant, user],
        })
      ),
      { messageId: "submitted", parentMessageId }
    )
  }
  assert.deepEqual(
    submittedTurn(JSON.stringify({ action: "next", parent_message_id: 12, messages: [user] })),
    { messageId: "submitted", parentMessageId: undefined }
  )
  assert.equal(
    submittedTurn(JSON.stringify({ action: "next", messages: [{ author: { role: "user" } }] })),
    undefined
  )
})

function savedUser(id: string, text = "prompt") {
  return { id, author: { role: "user" }, content: { parts: [text] } }
}

function savedAnswer(id: string, text = "answer") {
  return {
    id,
    author: { role: "assistant" },
    content: { parts: [text] },
    status: "finished_successfully",
    end_turn: true,
    recipient: "all",
  }
}

test("CDP tracker binds only the submitted user-message ID and reconstructs exact final Markdown", () => {
  const activities: string[] = []
  const conversationIds: string[] = []
  const tracker = new ChatGptTurnTracker("user-1", {
    onActivity: (activity) => activities.push(activity),
    onConversationId: (conversationId) => conversationIds.push(conversationId),
  })
  const topic = "conversation-turn-turn-1"

  tracker.ingestFrame(
    turnFrame(
      "conversation-turn-other",
      message("user", "review", { id: "other-user", conversationId: "wrong-conversation" })
    )
  )
  tracker.ingestFrame(
    turnFrame(topic, message("user", "review", { conversationId: "conversation-1" }))
  )
  tracker.ingestFrame(
    turnFrame(
      topic,
      message("assistant", "searching", {
        recipient: "web.run",
        status: "in_progress",
        endTurn: false,
      })
    )
  )
  tracker.ingestFrame(
    turnFrame(topic, message("assistant", "", { status: "in_progress", endTurn: null }))
  )
  tracker.ingestFrame(
    turnFrame(
      topic,
      'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"## Findings\\n\\n"}\n\n'
    )
  )
  tracker.ingestFrame(turnFrame(topic, 'event: delta\ndata: {"v":"- exact server response"}\n\n'))
  tracker.ingestFrame(
    turnFrame(
      topic,
      'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}\n\n'
    )
  )
  const result = tracker.ingestFrame(
    turnFrame(
      topic,
      'data: {"type":"message_stream_complete","conversation_id":"conversation-1"}\n\n'
    )
  )

  assert.deepEqual(result, {
    text: "## Findings\n\n- exact server response",
    conversationId: "conversation-1",
    turnId: "turn-1",
  })
  assert.deepEqual(conversationIds, ["conversation-1"])
  assert.ok(activities.includes("Searching the web"))
  assert.ok(activities.includes("Generating response"))
  assert.equal(activities.filter((activity) => activity === "Working").length, 1)
})

test("HTTP SSE tracker reconstructs the same final assistant response", () => {
  const tracker = new ChatGptTurnTracker("user-1")
  const sse = [
    message("user", "review"),
    message("assistant", "", { status: "in_progress", endTurn: null }),
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"HTTP exact"}\n\n',
    'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}\n\n',
    'data: {"type":"message_stream_complete","conversation_id":"conversation-http"}\n\n',
  ].join("")
  assert.deepEqual(tracker.ingestSse(sse), {
    text: "HTTP exact",
    conversationId: "conversation-http",
    turnId: undefined,
  })
})

for (const transport of ["http", "websocket"] as const) {
  test(`${transport} heartbeats and metadata cannot masquerade as turn activity`, () => {
    const activities: string[] = []
    const tracker = new ChatGptTurnTracker("user-1", {
      onActivity: (activity) => activities.push(activity),
    })
    const ingest = (payload: string) =>
      transport === "http"
        ? tracker.ingestSse(payload)
        : tracker.ingestFrame(turnFrame("conversation-turn-current", payload))

    ingest(": ping - before-bind\r\n\r\n")
    assert.deepEqual(activities, [])
    ingest(message("user", "review"))
    ingest(message("assistant", "", { status: "in_progress" }))
    ingest('data: {"p":"/message/content/parts/0","o":"append","v":"Working"}\n\n')
    const observed = [...activities]

    for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
      ingest(": ping - transport-only\r\n\r\n")
      ingest('data: {"type":"safety_review_update","active":true}\n\n')
      ingest('data: {"type":"metadata","conversation_id":"conversation-current"}\n\n')
      ingest('data: {"p":"/message/content/parts/0","o":"append","v":""}\n\n')
    }
    assert.deepEqual(activities, observed, "Connection traffic must not refresh activity age")

    ingest('data: {"p":"/message/content/parts/0","o":"append","v":" on the task"}\n\n')
    assert.deepEqual(activities, [...observed, "Generating response"])
  })
}

test("message and execution-state changes count as activity, unchanged state does not", () => {
  const activities: string[] = []
  const tracker = new ChatGptTurnTracker("user-1", {
    onActivity: (activity) => activities.push(activity),
  })
  tracker.ingestSse(message("user", "review"))
  activities.length = 0
  tracker.ingestSse(message("assistant", "query", { recipient: "web.run", status: "in_progress" }))
  tracker.ingestSse('data: {"p":"/message/status","o":"replace","v":"finished_successfully"}\n\n')
  tracker.ingestSse('data: {"p":"/message/recipient","o":"replace","v":"all"}\n\n')
  tracker.ingestSse('data: {"p":"/message/end_turn","o":"replace","v":true}\n\n')
  assert.deepEqual(activities, [
    "Searching the web",
    "Searching the web",
    "Generating response",
    "Generating response",
  ])
  const observed = [...activities]
  tracker.ingestSse('data: {"p":"/message/status","o":"replace","v":"finished_successfully"}\n\n')
  tracker.ingestSse('data: {"p":"/message/recipient","o":"replace","v":"all"}\n\n')
  tracker.ingestSse('data: {"p":"/message/end_turn","o":"replace","v":true}\n\n')
  assert.deepEqual(activities, observed)

  tracker.ingestSse(
    `data: ${JSON.stringify({ v: { message: mcpToolResponse("tool", "result") } })}\n\n`
  )
  assert.deepEqual(activities, [...observed, "Working"])
})

test("CDP tracker accepts composer serialization through the submitted user-message ID", () => {
  const tracker = new ChatGptTurnTracker("user-1")
  const topic = "conversation-turn-turn-normalized"

  tracker.ingestFrame(
    turnFrame(
      topic,
      message("user", "Open [https://example.com/](https://example.com/) with \\`web.run\\`.")
    )
  )
  tracker.ingestFrame(turnFrame(topic, message("assistant", "done", { endTurn: true })))
  const result = tracker.ingestFrame(
    turnFrame(
      topic,
      'data: {"type":"message_stream_complete","conversation_id":"conversation-normalized"}\n\n'
    )
  )

  assert.deepEqual(result, {
    text: "done",
    conversationId: "conversation-normalized",
    turnId: "turn-normalized",
  })
})

test("CDP tracker does not complete a tool-call assistant message", () => {
  const tracker = new ChatGptTurnTracker("user-1")
  const topic = "conversation-turn-turn-2"
  tracker.ingestFrame(turnFrame(topic, message("user", "review")))
  tracker.ingestFrame(
    turnFrame(topic, message("assistant", "fast|query", { recipient: "web.run", endTurn: false }))
  )
  assert.equal(
    tracker.ingestFrame(
      turnFrame(
        topic,
        'data: {"type":"message_stream_complete","conversation_id":"conversation-2"}\n\n'
      )
    ),
    undefined
  )
})
