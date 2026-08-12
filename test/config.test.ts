import assert from "node:assert/strict"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

import { loadMcpConfig, resolveWorkspacePath } from "../src/config.js"

test("resolves configured workspace paths to absolute paths", () => {
  assert.equal(resolveWorkspacePath("~"), homedir())
  assert.equal(resolveWorkspacePath("~/custom-workspace"), join(homedir(), "custom-workspace"))
  assert.equal(resolveWorkspacePath("relative-workspace"), resolve("relative-workspace"))
  assert.equal(resolveWorkspacePath(tmpdir()), tmpdir())
})

test("loads runtime configuration from one environment boundary", () => {
  const defaults = loadMcpConfig({})
  assert.equal(defaults.workspace, join(homedir(), "Desktop", "chatgpt-workspace"))
  assert.equal(defaults.shell.transcriptChars, 1024 * 1024)
  assert.equal(defaults.shell.commandTranscriptBytes, 256 * 1024)
  assert.equal(defaults.shell.outputBytes, 4 * 1024)
  assert.equal(defaults.shell.maxOutputBytes, 64 * 1024)
  assert.equal(defaults.shell.recordLimit, 1024)

  const configured = loadMcpConfig({
    MCP_DEFAULT_OUTPUT_BYTES: "8192",
    MCP_MAX_OUTPUT_BYTES: "16384",
    MCP_MAX_SHELLS: "12",
    MCP_TRANSCRIPT_CHARS: "1",
    MCP_COMMAND_TRANSCRIPT_BYTES: "1",
    MCP_RECORD_LIMIT: "1",
  })
  assert.equal(configured.shell.transcriptChars, defaults.shell.transcriptChars)
  assert.equal(configured.shell.commandTranscriptBytes, defaults.shell.commandTranscriptBytes)
  assert.equal(configured.shell.outputBytes, 8 * 1024)
  assert.equal(configured.shell.maxOutputBytes, 16 * 1024)
  assert.equal(configured.shell.recordLimit, defaults.shell.recordLimit)
  assert.equal(configured.shell.maxShells, 12)
})

test("rejects a default shell output cap above the maximum", () => {
  assert.throws(
    () => loadMcpConfig({ MCP_DEFAULT_OUTPUT_BYTES: "32768", MCP_MAX_OUTPUT_BYTES: "4096" }),
    /MCP_DEFAULT_OUTPUT_BYTES cannot exceed MCP_MAX_OUTPUT_BYTES/
  )
})
