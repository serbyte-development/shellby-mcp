import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import type { Page } from "playwright-core"

import { observeAssistantResponse } from "../../../src/tools/delegation/response-observer.js"

for (const inlinePostData of [true, false]) {
  for (const transport of ["http", "websocket", "body"] as const) {
    test(`observer correlates ${transport} completion with ${inlinePostData ? "inline" : "retrieved"} submitted message identity`, {
      timeout: 2_000,
    }, async (t) => {
      const submitted: string[] = []
      const calls: string[] = []
      const postData = JSON.stringify({
        action: "next",
        messages: [{ id: "submitted-user", author: { role: "user" } }],
      })
      const body = completedStream("submitted-user", "Exact result")
      const cdp = Object.assign(new EventEmitter(), {
        async send(method: string) {
          calls.push(method)
          if (method === "Network.getRequestPostData") {
            await setImmediate()
            return { postData }
          }
          if (method === "Network.getResponseBody") return { body, base64Encoded: false }
          return {}
        },
        async detach() {},
      })
      const page = Object.assign(new EventEmitter(), {
        context: () => ({ newCDPSession: async () => cdp }),
      }) as unknown as Page
      const observation = await observeAssistantResponse(page, {
        onSubmitted: (id) => submitted.push(id),
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
      // An old response containing identical text cannot bind to this turn.
      cdp.emit("Network.dataReceived", {
        requestId: "submitted-request",
        data: Buffer.from(completedStream("old-user", "Wrong result")).toString("base64"),
      })

      if (transport === "http") {
        cdp.emit("Network.dataReceived", {
          requestId: "submitted-request",
          data: Buffer.from(body).toString("base64"),
        })
      } else if (transport === "body") {
        cdp.emit("Network.loadingFinished", { requestId: "submitted-request" })
      } else {
        cdp.emit("Network.webSocketFrameReceived", {
          response: {
            payloadData: JSON.stringify({
              topic_id: "conversation-turn-current",
              payload: {
                type: "conversation-turn-stream",
                payload: { type: "stream-item", encoded_item: body },
              },
            }),
          },
        })
      }

      const result = await observation.response
      assert.equal(result.text, "Exact result")
      assert.deepEqual(submitted, ["submitted-user"])
      assert.equal(calls.includes("Network.getRequestPostData"), !inlinePostData)
    })
  }
}

function completedStream(userMessageId: string, response: string): string {
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
