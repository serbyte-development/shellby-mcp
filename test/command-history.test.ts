import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compactTimestamp,
  createCommandHistoryRecorder,
} from "../src/command-history.js";

test("writes one compact line per command", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-command-history-"));
  const file = join(directory, "commands.log");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const timestamp = new Date(2026, 7, 5, 6, 25, 30);
  const record = createCommandHistoryRecorder(file, () => timestamp);
  record("rg -n foo src");
  record("python <<'PY'\nprint('x')\nPY");

  assert.equal(compactTimestamp(timestamp), "260805T062530");
  assert.equal(
    await readFile(file, "utf8"),
    [
      '260805T062530\t"rg -n foo src"',
      '260805T062530\t"python <<\'PY\'\\nprint(\'x\')\\nPY"',
      "",
    ].join("\n"),
  );
});
