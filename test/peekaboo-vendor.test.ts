import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const peekaboo = fileURLToPath(new URL("../vendor/peekaboo/peekaboo", import.meta.url))

test("executes the vendored Peekaboo binary on the host architecture", () => {
  const architectures = spawnSync("lipo", ["-archs", peekaboo], { encoding: "utf8" })
  assert.equal(architectures.status, 0, architectures.stderr)
  assert.match(architectures.stdout, /arm64/)
  assert.match(architectures.stdout, /x86_64/)

  const version = spawnSync(peekaboo, ["--version"], { encoding: "utf8" })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /Peekaboo 4\.2\.3/)

  const mcpHelp = spawnSync(peekaboo, ["mcp", "serve", "--help"], { encoding: "utf8" })
  assert.equal(mcpHelp.status, 0, mcpHelp.stderr)
  assert.match(mcpHelp.stdout, /--allow-foreground/)
})
