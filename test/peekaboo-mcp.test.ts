import assert from "node:assert/strict"
import test from "node:test"

import { countTokens } from "../src/tokenizer.js"
import { createPeekabooMcp, PEEKABOO_TOOL_NAMES, transformPeekabooResult } from "../src/tools/computer/peekaboo-mcp.js"

test("publishes the background-only Peekaboo catalog with agent-readable click properties", { timeout: 10_000 }, async (t) => {
  const previous = process.env.PEEKABOO_ALLOW_FOREGROUND
  delete process.env.PEEKABOO_ALLOW_FOREGROUND
  const child = createPeekabooMcp()
  if (previous === undefined) delete process.env.PEEKABOO_ALLOW_FOREGROUND
  else process.env.PEEKABOO_ALLOW_FOREGROUND = previous

  t.after(() => child.close())
  await child.start()

  assert.deepEqual(
    child.tools.map((tool) => tool.name),
    PEEKABOO_TOOL_NAMES.filter((name) => name !== "computer_drag")
  )
  assert.ok(countTokens(JSON.stringify(child.tools)) < 3_000)

  const click = child.tools.find((tool) => tool.name === "computer_click")
  const type = child.tools.find((tool) => tool.name === "computer_type")
  const app = child.tools.find((tool) => tool.name === "computer_app")
  const seeMaxElements = child.tools.find((tool) => tool.name === "computer_see")?.inputSchema.properties?.max_elements as { description?: unknown } | undefined
  const inspectMaxChildren = child.tools.find((tool) => tool.name === "computer_inspect_ui")?.inputSchema.properties?.max_children as
    { description?: unknown } | undefined

  assert.equal(click?.inputSchema.oneOf, undefined)
  assert.equal((click?.inputSchema as { allOf?: unknown } | undefined)?.allOf, undefined)
  for (const property of ["on", "query", "coords", "snapshot", "coordinate_reference", "coordinate_space", "foreground"]) {
    assert.ok(click?.inputSchema.properties?.[property], `computer_click is missing ${property}`)
  }
  assert.match(String((click?.inputSchema.properties?.coordinate_space as { description?: unknown })?.description), /global_display_points/)
  assert.deepEqual(type?.inputSchema.required, ["snapshot"])
  assert.match(String(seeMaxElements?.description), /defaults to 100/)
  assert.match(String(inspectMaxChildren?.description), /defaults to 25/)
  assert.deepEqual(app?.inputSchema.properties?.action, {
    enum: ["launch", "quit", "hide", "list"],
    type: "string",
  })
})

test("starts the vendored Peekaboo child with explicit foreground authority", { timeout: 10_000 }, async (t) => {
  const previous = process.env.PEEKABOO_ALLOW_FOREGROUND
  process.env.PEEKABOO_ALLOW_FOREGROUND = "1"
  const child = createPeekabooMcp()
  if (previous === undefined) delete process.env.PEEKABOO_ALLOW_FOREGROUND
  else process.env.PEEKABOO_ALLOW_FOREGROUND = previous

  t.after(() => child.close())
  await child.start()

  assert.deepEqual(
    child.tools.map((tool) => tool.name),
    PEEKABOO_TOOL_NAMES
  )
  const type = child.tools.find((tool) => tool.name === "computer_type")
  const press = child.tools.find((tool) => tool.name === "computer_press")
  assert.equal(type?.inputSchema.required, undefined)
  assert.equal(press?.inputSchema.required, undefined)
  assert.ok(type?.inputSchema.properties?.foreground)
  assert.ok(press?.inputSchema.properties?.foreground)
})

test("compresses Peekaboo image blocks without changing unrelated results", async () => {
  const result = await transformPeekabooResult("computer_window", {
    content: [
      { type: "text", text: "snapshot_id=snapshot-native" },
      {
        type: "image",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        mimeType: "image/png",
      },
    ],
    _meta: { source: "peekaboo" },
  })

  assert.deepEqual(result.content[0], { type: "text", text: "snapshot_id=snapshot-native" })
  assert.equal(result.content[1]?.type, "image")
  if (result.content[1]?.type !== "image") assert.fail("Expected compressed image block")
  assert.equal(result.content[1].mimeType, "image/jpeg")
  assert.equal(Buffer.from(result.content[1].data, "base64").subarray(0, 3).toString("hex"), "ffd8ff")
  assert.deepEqual(result._meta, { source: "peekaboo" })
})

test("replaces successful computer_see trees with a compact visual receipt", async () => {
  const result = await transformPeekabooResult("computer_see", {
    content: [
      {
        type: "text",
        text: "Snapshot ID: snapshot-1\nScreenshot: /tmp/capture.png\nAX tree\n[B1] Button: Continue\nWarning: AX tree truncated at 100 elements",
      },
      {
        type: "image",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        mimeType: "image/png",
      },
    ],
    _meta: {
      coordinate_context: {
        reference_id: "snapshot-1",
        delivered_image_size: { width: 1440, height: 900 },
      },
    },
  })

  assert.deepEqual(result.content[0], {
    type: "text",
    text: "Snapshot / coordinate_reference: snapshot-1\nImage: 1440x900 pixels\nScreenshot: /tmp/capture.png\nWarning: AX tree truncated at 100 elements",
  })
  assert.equal(
    result.content.some((block) => block.type === "text" && block.text.includes("[B1]")),
    false
  )
  assert.equal(result.content[1]?.type, "image")
  if (result.content[1]?.type !== "image") assert.fail("Expected compressed image block")
  assert.equal(result.content[1].mimeType, "image/jpeg")
})
