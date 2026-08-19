import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"

import { createShellSession } from "../../src/tools/shell/session.js"
import { createShellSessionManager } from "../../src/tools/shell/session-manager.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("applies real patches and reports partial native changes through MCP", { timeout: 20_000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-patch-result-")))
  const project = join(directory, "project")
  await mkdir(project, { recursive: true })
  await writeFile(join(project, "a.txt"), "one\ntwo\nthree\n")
  await writeFile(join(project, "b.txt"), "alpha\nbeta\n")

  const running = await startMcpHttpServer({ port: 0 })
  t.after(async () => {
    await running.close()
    await rm(directory, { recursive: true, force: true })
  })
  const connected = await connectClient(running.url, "patch-result-client")
  t.after(() => connected.client.close())

  const partialPatch = [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "@@ one",
    "-two",
    "+TWO",
    "*** Update File: b.txt",
    "@@ alpha",
    "-beta",
    "+BETA",
    "@@",
    "-missing",
    "+MISSING",
    "*** End Patch",
  ].join("\n")
  const partial = await connected.client.callTool({ name: "apply_patch", arguments: { cwd: project, patch: partialPatch } })
  assert.equal(partial.isError, true)
  const partialContent = partial.structuredContent as {
    status: "partial"
    exit_code: number
    changed: string
    failed: string
    output: string
  }
  assert.equal(partialContent.status, "partial")
  assert.equal(partialContent.changed, "a.txt +1 -1")
  assert.equal(partialContent.failed, "b.txt hunk 2")
  assert.match(partialContent.output, /Failed to find expected lines .*\/b\.txt:\nmissing/)
  assert.equal(await readFile(join(project, "a.txt"), "utf8"), "one\nTWO\nthree\n")
  assert.equal(await readFile(join(project, "b.txt"), "utf8"), "alpha\nbeta\n")

  const movePatch = ["*** Begin Patch", "*** Update File: a.txt", "*** Move to: nested/a.txt", "@@ one", "-TWO", "+two", "*** End Patch"].join("\n")
  const moved = await connected.client.callTool({ name: "apply_patch", arguments: { cwd: project, patch: movePatch } })
  assert.deepEqual(moved.structuredContent, {
    status: "completed",
    exit_code: 0,
    changed: "a.txt -> nested/a.txt +1 -1",
  })
  await assert.rejects(readFile(join(project, "a.txt")), { code: "ENOENT" })
  assert.equal(await readFile(join(project, "nested/a.txt"), "utf8"), "one\ntwo\nthree\n")
})

test("rejects a nonexistent apply_patch cwd clearly", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "patch-missing-cwd-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "apply_patch",
    arguments: { cwd: "/definitely/missing/apply-patch-cwd", patch: "*** Begin Patch\n*** End Patch" },
  })

  assert.equal(result.isError, true)
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /cwd does not exist:/)
})

test("aborting an MCP request force-kills a SIGTERM-resistant apply_patch", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-aborted-patch-")))
  const project = join(directory, "project")
  const bin = join(directory, "bin")
  await mkdir(project, { recursive: true })
  await mkdir(bin, { recursive: true })
  const executable = join(bin, "apply_patch")
  await writeFile(executable, "#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' \"$$\" > \"$PWD/patch.pid\"\ncat >/dev/null\nwhile :; do sleep 1; done\n")
  await import("node:fs/promises").then(({ chmod }) => chmod(executable, 0o755))

  const shell = createShellSession({ cwd: directory })
  const running = await startMcpHttpServer({
    port: 0,
    shellManager: createShellSessionManager({ defaultShell: shell }),
    applyPatchExecutable: executable,
  })
  let patchPid: number | undefined
  const requestRef: { current?: ReturnType<typeof httpRequest> } = {}
  t.after(async () => {
    requestRef.current?.destroy()
    if (patchPid) {
      try {
        process.kill(-patchPid, "SIGKILL")
      } catch {
        // Process may already be gone.
      }
    }
    await running.close()
    await rm(directory, { recursive: true, force: true })
  })

  const target = new URL(running.url)
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "apply_patch",
      arguments: { cwd: project, patch: "*** Begin Patch\n*** End Patch" },
    },
  })
  const request = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
        "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      },
    },
    (response) => response.resume()
  )
  requestRef.current = request
  request.on("error", () => {})
  request.end(body)

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      patchPid = Number.parseInt(await readFile(join(project, "patch.pid"), "utf8"), 10)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  assert.ok(patchPid && Number.isSafeInteger(patchPid), "fake apply_patch did not start")
  request.destroy()

  let exited = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(patchPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        exited = true
        break
      }
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(exited, true, "SIGTERM-resistant apply_patch process was not force-killed")
})
