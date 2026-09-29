import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import type { Page } from "playwright-core"

import { observeAssistantResponse } from "../../../src/tools/delegation/response-observer.js"
import { mcpToolResponse } from "../../fixtures/chatgpt-tool-response.js"

for (const inlinePostData of [true, false]) {
  for (const transport of ["http", "websocket", "binary-websocket", "body"] as const) {
    test(`observer correlates ${transport} completion with ${inlinePostData ? "inline" : "retrieved"} submitted message identity`, {
      timeout: 2_000,
    }, async (t) => {
      const submitted: string[] = []
      const toolResponses: string[] = []
      const calls: string[] = []
      const postData = JSON.stringify({
        action: "next",
        messages: [{ id: "submitted-user", author: { role: "user" } }],
      })
      const toolText = "MCP response"
      const body = completedStream("submitted-user", "Exact result", toolText)
      const cdp = Object.assign(new EventEmitter(), {
        async send(method: string) {
          calls.push(method)
          if (method === "Network.getRequestPostData") {
            await setImmediate()
            return { postData }
          }
          if (method === "Network.getResponseBody") return { body, base64Encoded: false }
          if (method === "Network.streamResourceContent" && transport === "body")
            throw new Error("Streaming unavailable; completed-body fallback must still work")
          return {}
        },
        async detach() {},
      })
      const page = Object.assign(new EventEmitter(), {
        context: () => ({ newCDPSession: async () => cdp }),
      }) as unknown as Page
      const observation = await observeAssistantResponse(page, {
        onSubmitted: (id) => submitted.push(id),
        onToolResponse: (text) => toolResponses.push(text),
      })
      t.after(() => observation.dispose())

      cdp.emit("Network.requestWillBeSent", {
        requestId: "submitted-request",
        request: {
          method: "POST",
          url: "https://chatgpt.com/backend-api/f/conversation",
          ...(inlinePostData ? { postData } : {}),
        },
      })
      cdp.emit("Network.responseReceived", { requestId: "submitted-request" })
      // An old response containing identical text cannot bind to this turn.
      cdp.emit("Network.dataReceived", {
        requestId: "submitted-request",
        data: Buffer.from(
          completedStream("old-user", "Wrong result", "stale tool result")
        ).toString("base64"),
      })

      if (transport === "http") {
        cdp.emit("Network.dataReceived", {
          requestId: "submitted-request",
          data: Buffer.from(body).toString("base64"),
        })
      } else if (transport === "body") {
        cdp.emit("Network.loadingFinished", { requestId: "submitted-request" })
      } else {
        const payload = JSON.stringify({
          topic_id: "conversation-turn-current",
          payload: {
            type: "conversation-turn-stream",
            payload: { type: "stream-item", encoded_item: body },
          },
        })
        cdp.emit("Network.webSocketFrameReceived", {
          response: {
            opcode: transport === "binary-websocket" ? 2 : 1,
            payloadData:
              transport === "binary-websocket" ? Buffer.from(payload).toString("base64") : payload,
          },
        })
      }

      const result = await observation.response
      assert.equal(result.text, "Exact result")
      assert.deepEqual(submitted, ["submitted-user"])
      assert.deepEqual(toolResponses, [toolText])
      assert.equal(calls.includes("Network.getRequestPostData"), !inlinePostData)
    })
  }
}

for (const bufferedPrefix of [false, true]) {
  test(`HTTP observation preserves split UTF-8 with ${bufferedPrefix ? "buffered" : "streamed"} prefix`, {
    timeout: 2_000,
  }, async (t) => {
    const answer = "Correct: café 中文 🐚"
    const bytes = Buffer.from(completedStream("submitted-user", answer))
    const split = bytes.indexOf(Buffer.from("🐚")) + 2
    const prefix = bytes.subarray(0, split).toString("base64")
    let releaseStream!: () => void
    const streamReady = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const cdp = Object.assign(new EventEmitter(), {
      async send(method: string) {
        if (method === "Network.streamResourceContent") {
          await streamReady
          return { bufferedData: bufferedPrefix ? prefix : "" }
        }
        return {}
      },
      async detach() {},
    })
    const page = Object.assign(new EventEmitter(), {
      context: () => ({ newCDPSession: async () => cdp }),
    }) as unknown as Page
    const observation = await observeAssistantResponse(page, {})
    t.after(() => observation.dispose())
    cdp.emit("Network.requestWillBeSent", {
      requestId: "request",
      request: {
        method: "POST",
        url: "https://chatgpt.com/backend-api/f/conversation",
        postData: JSON.stringify({
          action: "next",
          messages: [{ id: "submitted-user", author: { role: "user" } }],
        }),
      },
    })
    cdp.emit("Network.responseReceived", { requestId: "request" })
    if (!bufferedPrefix) {
      releaseStream()
      await setImmediate()
      cdp.emit("Network.dataReceived", { requestId: "request", data: prefix })
    }
    // CDP delivers bytes, not complete Unicode characters. Queued events must
    // also wait for the buffered prefix returned by streamResourceContent.
    cdp.emit("Network.dataReceived", {
      requestId: "request",
      data: bytes.subarray(split).toString("base64"),
    })
    await setImmediate()
    releaseStream()
    assert.equal((await observation.response).text, answer)
  })
}

function completedStream(userMessageId: string, response: string, toolText?: string): string {
  return [
    {
      type: "input_message",
      input_message: {
        id: userMessageId,
        author: { role: "user" },
        content: {
          parts: ["Open [https://example.com/](https://example.com/) with \\`web.run\\`."],
        },
      },
    },
    ...(toolText ? [{ v: { message: mcpToolResponse("tool-result", toolText) } }] : []),
    {
      v: {
        message: {
          author: { role: "assistant" },
          content: { parts: [response] },
          status: "finished_successfully",
          end_turn: true,
          recipient: "all",
        },
      },
    },
    { type: "message_stream_complete" },
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .join("")
}
