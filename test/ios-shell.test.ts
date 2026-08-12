import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { IosShellClient } from "../src/tools/ios/ios-shell.js"

test("IosShellClient sends authenticated command and returns structured result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ios-shell-test-"))
  const tokenFile = join(directory, "token.txt")
  await writeFile(tokenFile, "test-token\n")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const server = createServer((socket) => {
    let request = ""
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8")
      if (!request.includes("\n")) return
      const parsed = JSON.parse(request.slice(0, request.indexOf("\n"))) as { token: string; command: string }
      assert.deepEqual(parsed, { token: "test-token", command: "pwd" })
      socket.end(`${JSON.stringify({ stdout: "/iphone\n", stderr: "", exit_code: 0 })}\n`)
    })
  })
  server.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  server.unref()
  t.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address === "object")
  const client = new IosShellClient({ host: "127.0.0.1", port: address.port, tokenFile })

  assert.deepEqual(await client.execute("pwd"), {
    stdout: "/iphone\n",
    stderr: "",
    exit_code: 0,
  })
})

test("IosShellClient surfaces bridge errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ios-shell-error-test-"))
  const tokenFile = join(directory, "token.txt")
  await writeFile(tokenFile, "test-token\n")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const server = createServer((socket) => socket.end(`${JSON.stringify({ error: "unauthorized" })}\n`))
  server.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  server.unref()
  t.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address === "object")
  const client = new IosShellClient({ host: "127.0.0.1", port: address.port, tokenFile })

  await assert.rejects(() => client.execute("pwd"), /iPhone bridge: unauthorized/)
})
