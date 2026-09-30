import assert from "node:assert/strict"
import test from "node:test"

import { describeToolCall } from "../../ui/src/features/dashboard/tool-call-presentation.js"

function describe(tool: string, detail?: string, summary = "") {
  return describeToolCall({ tool, detail, summary })
}

test("patch summaries distinguish one file from multiple edits without reading patch contents as commands", () => {
  assert.equal(
    describe("apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch")
      .summary,
    "Updating file"
  )
  assert.equal(describe("apply_patch", "*** Add File: new.ts\n+hello").summary, "Creating file")
  assert.equal(describe("apply_patch", "*** Delete File: old.ts").summary, "Deleting file")
  assert.equal(
    describe("apply_patch", "*** Update File: a.ts\n+hello\n*** Add File: b.ts\n+world").summary,
    "Editing files"
  )
  assert.equal(
    describe("apply_patch", "*** Add File: patch.txt\n+*** Update File: a.ts").summary,
    "Creating file"
  )
  assert.equal(describe("apply_patch", "missing patch headers").summary, "Applying patch")
})

test("shell hints recognize common operations and stay generic for compound commands and scripts", () => {
  for (const command of [
    "cat README.md",
    "rg -n function src 2>&1 | head -c 4000",
    "sed -n '1,20p' file.ts",
    "ls -al",
    "pwd",
  ]) {
    assert.equal(describe("shell_run", command).summary, "Reading files", command)
  }
  for (const command of [
    "mkdir output",
    "cp a.ts b.ts",
    "sed -i '' s/a/b/ file",
    "echo hello > file",
  ]) {
    assert.equal(describe("shell_run", command).summary, "Editing files", command)
  }
  for (const command of [
    "cat a; rm b",
    "cat a\nrm b",
    "cat a | python edit.py",
    "find . -delete",
    "echo $(cat a)",
    "node task.js",
    "",
  ]) {
    assert.equal(describe("shell_run", command).summary, "Running commands", command)
  }
  assert.equal(describe("shell_run", "npm run test:ui").summary, "Running tests")
})

test("known capabilities use Tabler group icons and summaries even without captured input", () => {
  const examples = [
    ["shell_run", "IconTerminal2", "Running commands"],
    ["shell_poll", "IconTerminal2", "Checking command output"],
    ["image_view", "IconPhoto", "Viewing image"],
    ["fetch_url", "IconWorld", "Fetching website"],
    ["file_read", "IconFileText", "Reading file"],
    ["file_write", "IconFilePencil", "Writing file"],
    ["subagent_run", "IconRobot", "Running subagents"],
    ["skill_use", "IconBook", "Loading skill"],
    ["computer_click", "IconDeviceDesktop", "Clicking"],
  ]
  for (const [tool, icon, summary] of examples) {
    assert.ok(tool)
    const result = describe(tool)
    assert.equal(result.icon.name, icon, tool)
    assert.equal(result.summary, summary, tool)
  }
})

test("legacy and unfamiliar tools retain useful fallbacks", () => {
  assert.equal(describe("shell_run", undefined, "cat README.md").summary, "Reading files")
  assert.equal(
    describe("future_tool", undefined, "Useful captured summary").summary,
    "Useful captured summary"
  )
  assert.equal(describe("future_tool").summary, "Using tool")
  assert.equal(describe("constructor").icon.name, "IconTool")
})
