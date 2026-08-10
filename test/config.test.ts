import assert from "node:assert/strict"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

import { MCP_CONFIG, resolveWorkspacePath } from "../src/config.js"

test("resolves configured workspace paths to absolute paths", () => {
  assert.equal(resolveWorkspacePath(MCP_CONFIG.defaults.workspace), join(homedir(), "Desktop", "chatgpt-workspace"))
  assert.equal(resolveWorkspacePath("~"), homedir())
  assert.equal(resolveWorkspacePath("~/custom-workspace"), join(homedir(), "custom-workspace"))
  assert.equal(resolveWorkspacePath("relative-workspace"), resolve("relative-workspace"))
  assert.equal(resolveWorkspacePath(tmpdir()), tmpdir())
})
