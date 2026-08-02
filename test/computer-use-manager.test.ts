import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ComputerUseManager,
  ComputerUseUnavailableError,
  resolveComputerUseLauncher,
} from "../src/computer-use-manager.js";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-computer-use-mcp.mjs",
);

test("resolves an explicit executable launcher before fallback paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "computer-use-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const launcher = join(root, "launcher");
  await writeFile(launcher, "#!/bin/sh\nexit 0\n");
  await chmod(launcher, 0o755);

  assert.equal(
    await resolveComputerUseLauncher({
      env: { CHATGPT_COMPUTER_USE_LAUNCHER: launcher },
      knownLauncherPath: join(root, "missing-known-launcher"),
      pluginRoot: join(root, "missing-plugins"),
    }),
    launcher,
  );
});

test("launches lazily and preserves image, structured, and metadata blocks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "computer-use-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, "child.log");
  const manager = fakeManager({ FAKE_COMPUTER_USE_LOG: logPath });
  t.after(() => manager.close());

  await assert.rejects(readFile(logPath, "utf8"));

  const result = await manager.callTool("get_app_state", { app: "Finder" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    result.content.map((block) => block.type),
    ["text", "image"],
  );
  assert.deepEqual(result.structuredContent, {
    app: "Finder",
    accessibilityTree: [{ index: "42" }],
  });
  assert.equal(result._meta?.fake, true);

  const log = await readFile(logPath, "utf8");
  assert.equal(countLines(log, "process:start"), 1);
});

test("serializes child calls even when callers invoke the manager together", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "computer-use-serial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, "child.log");
  const manager = fakeManager({
    FAKE_COMPUTER_USE_LOG: logPath,
    FAKE_COMPUTER_USE_DELAY_MS: "30",
  });
  t.after(() => manager.close());

  await Promise.all([
    manager.callTool("type_text", { app: "TextEdit", text: "first" }),
    manager.callTool("press_key", { app: "TextEdit", key: "Return" }),
  ]);

  const relevant = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("tool:"));
  assert.deepEqual(relevant, [
    "tool:start:type_text",
    "tool:end:type_text",
    "tool:start:press_key",
    "tool:end:press_key",
  ]);
});

test("does not retry a mutating action after the child exits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "computer-use-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, "child.log");
  const manager = fakeManager({
    FAKE_COMPUTER_USE_LOG: logPath,
    FAKE_EXIT_BEFORE_RESPONSE_TOOL: "click",
  });
  t.after(() => manager.close());

  await assert.rejects(
    manager.callTool("click", { app: "Finder", element_index: "42" }),
    ComputerUseUnavailableError,
  );
  assert.equal(
    countLines(await readFile(logPath, "utf8"), "process:start"),
    1,
  );

  await manager.callTool("list_apps", {});
  assert.equal(
    countLines(await readFile(logPath, "utf8"), "process:start"),
    2,
  );
});

test("permanently disables wrappers after an incompatible child schema", async (t) => {
  const manager = fakeManager({
    FAKE_COMPUTER_USE_SCHEMA_MODE: "missing-click",
  });
  t.after(() => manager.close());

  await assert.rejects(
    manager.callTool("list_apps", {}),
    /missing tool click/,
  );
  assert.equal(manager.shouldExposeTools, false);
  assert.match(manager.unavailableReason ?? "", /missing tool click/);
});

function fakeManager(env: Record<string, string>): ComputerUseManager {
  return new ComputerUseManager({
    launcherPath: process.execPath,
    args: [fixture],
    env,
    requestTimeoutMs: 2_000,
  });
}

function countLines(value: string, target: string): number {
  return value.split("\n").filter((line) => line === target).length;
}
