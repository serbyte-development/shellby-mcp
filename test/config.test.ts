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

test("loads supported environment overrides", () => {
  const configured = loadMcpConfig({
    MCP_CHATGPT_PROJECT_URL: "https://chatgpt.com/g/example/project",
    MCP_DEFAULT_OUTPUT_TOKENS: "2048",
    MCP_MAX_OUTPUT_TOKENS: "4096",
    MCP_MAX_SHELLS: "12",
    MCP_SHELL_IDLE_TTL_MS: "1234",
    MCP_SHELL_CACHE_TTL_MS: "5678",
    MCP_TOOL_OUTPUT_STRUCTURED: "optional",
  })
  assert.equal(configured.chatGpt.projectUrl, "https://chatgpt.com/g/example/project")
  assert.equal(configured.shell.defaultOutputTokens, 2_048)
  assert.equal(configured.shell.maxOutputTokens, 4_096)
  assert.equal(configured.shell.maxShells, 12)
  assert.equal(configured.shell.idleTimeoutMs, 1_234)
  assert.equal(configured.shell.cacheTimeoutMs, 5_678)
  assert.equal(configured.toolOutputStructured, "optional")
})

test("blank ChatGPT project URL falls back to normal ChatGPT", () => {
  assert.equal(loadMcpConfig({ MCP_CHATGPT_PROJECT_URL: "" }).chatGpt.projectUrl, "https://chatgpt.com/")
  assert.equal(loadMcpConfig({ MCP_CHATGPT_PROJECT_URL: "   " }).chatGpt.projectUrl, "https://chatgpt.com/")
})

test("ignores unsupported environment overrides", () => {
  const defaults = loadMcpConfig({})
  const configured = loadMcpConfig({
    HOST: "0.0.0.0",
    PORT: "9999",
    MCP_TRANSCRIPT_CHARS: "1",
    MCP_COMMAND_TRANSCRIPT_BYTES: "1",
    MCP_RECORD_LIMIT: "1",
  })
  assert.equal(configured.shell.transcriptChars, defaults.shell.transcriptChars)
  assert.equal(configured.shell.commandTranscriptBytes, defaults.shell.commandTranscriptBytes)
  assert.equal(configured.shell.recordLimit, defaults.shell.recordLimit)
  assert.equal(configured.host, defaults.host)
  assert.equal(configured.port, defaults.port)
})

test("rejects invalid tool output modes", () => {
  assert.throws(() => loadMcpConfig({ MCP_TOOL_OUTPUT_STRUCTURED: "sometimes" }), /must be one of/)
})

test("rejects a default shell output cap above the maximum", () => {
  assert.throws(
    () => loadMcpConfig({ MCP_DEFAULT_OUTPUT_TOKENS: "4096", MCP_MAX_OUTPUT_TOKENS: "1024" }),
    /MCP_DEFAULT_OUTPUT_TOKENS cannot exceed MCP_MAX_OUTPUT_TOKENS/
  )
})

test("rejects partially parsed and fractional integer configuration", () => {
  for (const value of ["12junk", "1.5", "0", "", " "]) {
    assert.throws(() => loadMcpConfig({ MCP_MAX_SHELLS: value }), /Expected a positive integer/)
  }
  for (const value of ["12junk", "1.5", "", " "]) {
    assert.throws(() => loadMcpConfig({ MCP_SHELL_IDLE_TTL_MS: value }), /Expected a non-negative integer/)
  }
  assert.equal(loadMcpConfig({ MCP_SHELL_IDLE_TTL_MS: "0" }).shell.idleTimeoutMs, 0)
})
