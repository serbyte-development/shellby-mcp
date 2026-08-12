import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

const helperUrl = new URL("../scripts/preflight.mjs", import.meta.url).href

test("requires Node.js 22.13.0 or newer", () => {
  assert.equal(supportsVersion("22.12.9"), false)
  assert.equal(supportsVersion("22.13.0"), true)
  assert.equal(supportsVersion("23.0.0"), true)
})

function supportsVersion(version: string): boolean {
  const script = `import { isSupportedNodeVersion } from ${JSON.stringify(helperUrl)}; console.log(isSupportedNodeVersion(process.argv[1]))`
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, version], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim() === "true"
}
