import assert from "node:assert/strict";
import { chmod, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareApplyPatch } from "../src/workspace-tools.js";

test("creates a stable workspace apply_patch symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-apply-patch-"));
  const codexBinary = join(directory, "codex");
  await writeFile(codexBinary, "#!/bin/sh\nexit 0\n");
  await chmod(codexBinary, 0o755);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const setup = await prepareApplyPatch(join(directory, "workspace"), codexBinary);

  assert.equal(setup.available, true);
  assert.equal(await readlink(setup.executable), codexBinary);
});

test("warns without preventing startup when the Codex binary is absent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-apply-patch-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const missingBinary = join(directory, "missing-codex");
  const setup = await prepareApplyPatch(join(directory, "workspace"), missingBinary);

  assert.equal(setup.available, false);
  assert.match(setup.warning ?? "", /Codex binary is not executable/);
});
