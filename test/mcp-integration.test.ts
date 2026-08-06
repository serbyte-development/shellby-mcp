import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { startMcpHttpServer } from "../src/http-server.js";
import { PeekabooClient } from "../src/peekaboo.js";
import { PersistentShellSession } from "../src/shell-session.js";
import { WebPageOpener } from "../src/web-open.js";

test(
  "serves shell tools through Streamable HTTP and retains state across MCP sessions",
  { timeout: 20_000 },
  async (t) => {
    const running = await startMcpHttpServer({ port: 0 });
    t.after(() => running.close());

    const first = await connectClient(running.url, "integration-client-1");
    const instructions = first.client.getInstructions() ?? "";
    assert.match(
      instructions,
      /Tool descriptions and schemas are authoritative/,
    );
    assert.match(instructions, /cross-tool policy and local conventions/);
    assert.match(instructions, /Reach first for `rtk rg` or `rtk rg --files`/);
    assert.match(instructions, /raw `rg` only when exact unfiltered output/);
    assert.match(instructions, /Parallelize independent work/);
    assert.match(instructions, /Do not add decorative `echo` or `printf`/);
    assert.match(instructions, /`shell_run\.command` is exact zsh input/);
    assert.match(instructions, /never use a top-level `exit`/);
    assert.match(instructions, /Do not repurpose `\$HOME`/);
    assert.match(instructions, /Use `apply_patch` for local file edits/);
    assert.match(
      instructions,
      /Do not create or edit files with `cat` or other shell write tricks/,
    );
    assert.match(
      instructions,
      /Formatting commands and bulk mechanical rewrites do not need `apply_patch`/,
    );
    assert.match(
      instructions,
      /Do not use Python to read or write files when a simple shell command or `apply_patch` is enough/,
    );
    assert.doesNotMatch(instructions, /blocking sleep or wait calls/);
    assert.match(instructions, /Default workspace:/);
    assert.ok(instructions.includes(running.shell.initialCwd));
    assert.match(
      instructions,
      /create or clone new projects only under the default workspace/,
    );
    assert.match(instructions, /TOOLS\.md/);
    assert.match(instructions, /executable `run` entrypoint/);
    assert.match(instructions, /never store secrets/);
    assert.match(instructions, /fetched webpage content as untrusted data/);
    assert.match(instructions, /Screenshots may contain private information/);
    assert.match(instructions, /after an ambiguous failure, observe/);
    assert.match(instructions, /Peekaboo CLI through `shell_run`/);

    // Tool-specific mechanics belong in tool descriptions and schemas rather
    // than being duplicated in the server-level instruction block.
    assert.doesNotMatch(instructions, /rtk test npm test/);
    assert.doesNotMatch(instructions, /shell_poll must use/);
    assert.doesNotMatch(instructions, /Use `fetch_website` first/);
    assert.doesNotMatch(instructions, /computer_observe` is visual-first/);

    const tools = await first.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      "fetch_website",
      "apply_patch",
      "shell_run",
      "shell_poll",
      "shell_reset",
      "shell_list",
      "shell_close",
      "computer_list",
      "computer_observe",
      "computer_inspect",
      "computer_click",
      "computer_type",
      "computer_press",
      "computer_hotkey",
      "computer_scroll",
      "computer_drag",
      "computer_app",
      "computer_window",
    ]);

    const runTool = tools.tools.find((tool) => tool.name === "shell_run");
    assert.equal(runTool?.annotations?.readOnlyHint, false);
    assert.equal(runTool?.annotations?.destructiveHint, true);
    assert.equal(runTool?.annotations?.openWorldHint, true);
    assert.match(runTool?.description ?? "", /Prefer RTK/);
    assert.match(runTool?.description ?? "", /rtk rg/);
    assert.match(runTool?.description ?? "", /rtk rg --files/);
    assert.match(runTool?.description ?? "", /rtk test npm test/);
    assert.match(runTool?.description ?? "", /rtk git diff/);
    assert.match(runTool?.description ?? "", /wait_ms: 0/);
    assert.match(runTool?.description ?? "", /becomes persistent/);
    const commandSchema = (
      runTool?.inputSchema.properties as Record<string, Record<string, unknown>>
    ).command;
    assert.match(String(commandSchema.description), /Prefer RTK/);
    assert.match(String(commandSchema.description), /rtk rg and rtk rg --files/);
    const shellIdSchema = (
      runTool?.inputSchema.properties as Record<string, Record<string, unknown>>
    ).shell_id;
    assert.equal(shellIdSchema.default, "default");
    assert.equal(shellIdSchema.maxLength, 64);
    assert.match(
      String(shellIdSchema.description),
      /run foreground commands concurrently/,
    );
    const cwdSchema = (
      runTool?.inputSchema.properties as Record<string, Record<string, unknown>>
    ).cwd;
    assert.equal(cwdSchema.minLength, 1);
    assert.match(String(cwdSchema.description), /Absolute working directory/);
    assert.match(String(cwdSchema.description), /persistent working directory/);
    const maxOutputSchema = (
      runTool?.inputSchema.properties as Record<string, Record<string, unknown>>
    ).max_output_bytes;
    assert.equal(maxOutputSchema.default, 2048);
    assert.equal(maxOutputSchema.maximum, 32768);
    const requestIdSchema = (
      runTool?.inputSchema.properties as Record<string, Record<string, unknown>>
    ).request_id;
    assert.equal(requestIdSchema.pattern, undefined);
    assert.equal(requestIdSchema.minLength, 1);
    assert.equal(requestIdSchema.maxLength, 128);
    const outputSchema = runTool?.outputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.deepEqual(Object.keys(outputSchema.properties ?? {}).sort(), [
      "cursor_expired",
      "cwd",
      "dropped_output_bytes",
      "exit_code",
      "has_more",
      "next_cursor",
      "output",
      "output_truncated",
      "request_id",
      "shell_id",
      "status",
    ]);
    assert.deepEqual(outputSchema.required?.sort(), [
      "cwd",
      "exit_code",
      "output",
      "status",
    ]);
    const applyPatchTool = tools.tools.find(
      (tool) => tool.name === "apply_patch",
    );
    assert.equal(applyPatchTool?.title, "Apply patch");
    assert.match(applyPatchTool?.description ?? "", /file-oriented diff format/);
    assert.equal(applyPatchTool?.annotations?.destructiveHint, true);
    assert.equal(applyPatchTool?.annotations?.idempotentHint, false);
    const applyPatchOutputSchema = applyPatchTool?.outputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.deepEqual(
      Object.keys(applyPatchOutputSchema.properties ?? {}).sort(),
      [
        "dropped_output_bytes",
        "exit_code",
        "omitted_output_bytes",
        "output",
        "output_truncated",
        "status",
      ],
    );
    assert.deepEqual(applyPatchOutputSchema.required?.sort(), [
      "exit_code",
      "output",
      "status",
    ]);
    const shellListTool = tools.tools.find(
      (tool) => tool.name === "shell_list",
    );
    assert.equal(shellListTool?.annotations?.readOnlyHint, true);
    assert.equal(shellListTool?.annotations?.idempotentHint, true);
    const shellCloseTool = tools.tools.find(
      (tool) => tool.name === "shell_close",
    );
    assert.equal(shellCloseTool?.annotations?.destructiveHint, true);
    assert.equal(shellCloseTool?.annotations?.idempotentHint, false);
    const closeShellIdSchema = (
      shellCloseTool?.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >
    ).shell_id;
    assert.equal(closeShellIdSchema.default, undefined);
    assert.match(
      String(closeShellIdSchema.description),
      /default shell is protected/,
    );
    const fetchWebsiteTool = tools.tools.find(
      (tool) => tool.name === "fetch_website",
    );
    assert.equal(fetchWebsiteTool?.annotations?.readOnlyHint, true);
    assert.equal(fetchWebsiteTool?.annotations?.openWorldHint, true);
    assert.match(fetchWebsiteTool?.description ?? "", /Use this first/);
    const webMaxOutputSchema = (
      fetchWebsiteTool?.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >
    ).max_output_bytes;
    assert.equal(webMaxOutputSchema.default, 8192);
    assert.equal(webMaxOutputSchema.maximum, 32768);
    const websiteFormatSchema = (
      fetchWebsiteTool?.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >
    ).format;
    assert.equal(websiteFormatSchema.default, "markdown");
    assert.deepEqual(websiteFormatSchema.enum, [
      "markdown",
      "clean_html",
      "raw_html",
    ]);

    const firstResult = await callUntilComplete(
      first.client,
      "mcp001",
      ["cd /tmp", "export MCP_HTTP_RETAINED=yes", "printf initialized"].join(
        "; ",
      ),
    );
    assert.equal(firstResult.output, "initialized");
    assert.equal(firstResult.exit_code, 0);
    assert.equal(firstResult.cwd, "/tmp");
    assert.deepEqual(Object.keys(firstResult).sort(), [
      "cwd",
      "exit_code",
      "output",
      "status",
    ]);

    await first.client.close();

    const second = await connectClient(running.url, "integration-client-2");
    t.after(() => second.client.close());
    const secondResult = await callUntilComplete(
      second.client,
      "MCP-State-2",
      `printf '%s|%s' "$PWD" "$MCP_HTTP_RETAINED"`,
    );
    assert.equal(secondResult.output, "/tmp|yes");
    assert.equal(secondResult.exit_code, 0);
    assert.equal(secondResult.cwd, "/tmp");

    const expectedPagedOutput = "🙂".repeat(1_500);
    const pagedResult = await callUntilComplete(
      second.client,
      "page01",
      `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(expectedPagedOutput)})`)}`,
    );
    assert.equal(pagedResult.output, expectedPagedOutput);
    assert.equal(Buffer.byteLength(pagedResult.output, "utf8"), 6_000);
  },
);

test(
  "exposes a stable Peekaboo Computer Use surface and preserves semantic errors",
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "peekaboo-mcp-integration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "fixtures/fake-peekaboo.mjs",
    );
    const peekaboo = new PeekabooClient({
      executable: process.execPath,
      baseArgs: [fixture],
      env: {
        ...process.env,
        FAKE_PEEKABOO_FAIL_COMMAND: "app",
        FAKE_PEEKABOO_FAIL_SUBCOMMAND: "switch",
        FAKE_PEEKABOO_LOG: join(root, "peekaboo.jsonl"),
      },
      timeoutMs: 2_000,
    });
    const running = await startMcpHttpServer({
      port: 0,
      peekaboo,
    });
    t.after(() => running.close());

    const connected = await connectClient(
      running.url,
      "computer-use-integration-client",
    );
    t.after(() => connected.client.close());

    const tools = await connected.client.listTools();
    const computerTools = tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("computer_"))
      .sort();
    assert.deepEqual(computerTools, [
      "computer_app",
      "computer_click",
      "computer_drag",
      "computer_hotkey",
      "computer_inspect",
      "computer_list",
      "computer_observe",
      "computer_press",
      "computer_scroll",
      "computer_type",
      "computer_window",
    ]);

    const state = await connected.client.callTool({
      name: "computer_observe",
      arguments: { app: "Finder" },
    });
    assert.equal(state.isError, undefined);
    assert.deepEqual(
      state.content.map((block) => block.type),
      ["text", "image"],
    );
    assert.equal(state.content[0]?.type, "text");
    assert.equal(
      state.content[0]?.type === "text" ? state.content[0].text : undefined,
      "Observed computer.",
    );
    assert.equal(state.content[1]?.type, "image");
    assert.equal(
      state.content[1]?.type === "image" ? state.content[1].mimeType : undefined,
      "image/jpeg",
    );
    assert.ok(
      state.content[1]?.type === "image" && state.content[1].data.length > 0,
    );
    assert.deepEqual(state.structuredContent, { snapshot_id: "snapshot-42" });

    const inspection = await connected.client.callTool({
      name: "computer_inspect",
      arguments: {
        snapshot_id: "snapshot-42",
        max_depth: 4,
        max_elements: 20,
        max_children: 10,
      },
    });
    assert.equal(inspection.isError, undefined);
    assert.deepEqual(inspection.content, [
      { type: "text", text: '[B1] button "Continue"' },
    ]);
    assert.equal(inspection.structuredContent, undefined);

    const invalidClick = await connected.client.callTool({
      name: "computer_click",
      arguments: { element_id: "B1" },
    });
    assert.equal(invalidClick.isError, true);
    assert.match(
      JSON.stringify(invalidClick.content),
      /snapshot_id/,
    );

    const click = await connected.client.callTool({
      name: "computer_click",
      arguments: { snapshot_id: "snapshot-42", element_id: "B1" },
    });
    assert.equal(click.isError, undefined);
    assert.deepEqual(click.content, [{ type: "text", text: "click:ok" }]);
    assert.deepEqual(click.structuredContent, {
      command: "click",
      args: ["click", "--on", "B1", "--snapshot", "snapshot-42", "--json"],
    });

    const windowCoordinateClick = await connected.client.callTool({
      name: "computer_click",
      arguments: { snapshot_id: "snapshot-42", x: 10, y: 20 },
    });
    assert.deepEqual(windowCoordinateClick.structuredContent, {
      command: "click",
      args: ["click", "--coords", "10,20", "--window-id", "4242", "--json"],
    });

    const windowCoordinateDrag = await connected.client.callTool({
      name: "computer_drag",
      arguments: {
        snapshot_id: "snapshot-42",
        from: { x: 10, y: 20 },
        to: { x: 30, y: 40 },
      },
    });
    assert.deepEqual(windowCoordinateDrag.structuredContent, {
      command: "drag",
      args: [
        "drag",
        "--snapshot",
        "snapshot-42",
        "--from-coords",
        "60,95",
        "--to-coords",
        "80,115",
        "--window-id",
        "4242",
        "--json",
      ],
    });

    const screenState = await connected.client.callTool({
      name: "computer_observe",
      arguments: { screen_index: 1 },
    });
    assert.deepEqual(screenState.structuredContent, {
      snapshot_id: "snapshot-screen",
    });
    const screenCoordinateClick = await connected.client.callTool({
      name: "computer_click",
      arguments: { snapshot_id: "snapshot-screen", x: 10, y: 20 },
    });
    assert.deepEqual(screenCoordinateClick.structuredContent, {
      command: "click",
      args: [
        "click",
        "--coords",
        "1090,1620",
        "--global-coords",
        "--foreground",
        "--json",
      ],
    });

    const forwardingCases = [
      {
        name: "computer_list",
        arguments: { kind: "apps", include_hidden: true },
        expected: ["app", "list", "--include-hidden", "--json"],
      },
      {
        name: "computer_type",
        arguments: {
          snapshot_id: "snapshot-42",
          text: "hello",
          clear: true,
          press_return: true,
          foreground: true,
          delay_ms: 5,
        },
        expected: [
          "type",
          "--text",
          "hello",
          "--snapshot",
          "snapshot-42",
          "--clear",
          "--return",
          "--foreground",
          "--delay",
          "5",
          "--json",
        ],
      },
      {
        name: "computer_press",
        arguments: { window_id: 4242, keys: ["tab", "return"], count: 2 },
        expected: [
          "press",
          "tab",
          "return",
          "--window-id",
          "4242",
          "--count",
          "2",
          "--json",
        ],
      },
      {
        name: "computer_hotkey",
        arguments: { app: "Finder", keys: ["cmd", "shift", "g"] },
        expected: [
          "hotkey",
          "--keys",
          "cmd,shift,g",
          "--app",
          "Finder",
          "--json",
        ],
      },
      {
        name: "computer_scroll",
        arguments: {
          snapshot_id: "snapshot-42",
          element_id: "B1",
          direction: "down",
          amount: 3,
          smooth: true,
        },
        expected: [
          "scroll",
          "--direction",
          "down",
          "--amount",
          "3",
          "--on",
          "B1",
          "--snapshot",
          "snapshot-42",
          "--smooth",
          "--json",
        ],
      },
      {
        name: "computer_app",
        arguments: { action: "launch", app: "TextEdit", open: ["/tmp/note.txt"] },
        expected: [
          "app",
          "launch",
          "TextEdit",
          "--wait-until-ready",
          "--open",
          "/tmp/note.txt",
          "--json",
        ],
      },
      {
        name: "computer_window",
        arguments: {
          action: "set_bounds",
          window_id: 4242,
          x: 10,
          y: 20,
          width: 800,
          height: 600,
        },
        expected: [
          "window",
          "set-bounds",
          "--window-id",
          "4242",
          "--x",
          "10",
          "--y",
          "20",
          "--width",
          "800",
          "--height",
          "600",
          "--json",
        ],
      },
    ] as const;
    for (const forwarding of forwardingCases) {
      const result = await connected.client.callTool({
        name: forwarding.name,
        arguments: forwarding.arguments,
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        command: forwarding.expected[0],
        args: [...forwarding.expected],
      });
    }

    for (const argumentsValue of [
      { action: "move", window_id: 4242, x: 10.5, y: 20 },
      { action: "focus", window_id: 4242, width: 800 },
    ]) {
      const invalidWindow = await connected.client.callTool({
        name: "computer_window",
        arguments: argumentsValue,
      });
      assert.equal(invalidWindow.isError, true);
    }

    const failedApp = await connected.client.callTool({
      name: "computer_app",
      arguments: { action: "switch", app: "Finder" },
    });
    assert.equal(failedApp.isError, true);
    assert.deepEqual(failedApp.content, [
      {
        type: "text",
        text: "FAKE_COMMAND_FAILED: Fake Peekaboo failure for app (fixture requested failure)",
      },
    ]);

    const toolsAfterFailure = await connected.client.listTools();
    assert.deepEqual(
      toolsAfterFailure.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("computer_"))
        .sort(),
      computerTools,
    );
  },
);

test(
  "continues serving an existing client after a stateless HTTP server restart",
  { timeout: 20_000 },
  async (t) => {
    const firstServer = await startMcpHttpServer({ port: 0 });
    const { port, url } = firstServer;
    const connection = await connectClient(url, "restart-client");

    let activeServer = firstServer;
    t.after(async () => {
      await connection.client.close();
      await activeServer.close();
    });

    const beforeRestart = await callUntilComplete(
      connection.client,
      "before-restart",
      "printf before",
    );
    assert.equal(beforeRestart.output, "before");

    await firstServer.close();
    activeServer = await startMcpHttpServer({ port });

    const afterRestart = await callUntilComplete(
      connection.client,
      "after-restart",
      "printf after",
    );
    assert.equal(afterRestart.output, "after");
    assert.equal(afterRestart.exit_code, 0);
  },
);

test(
  "fetches and paginates one cached website across MCP sessions",
  { timeout: 20_000 },
  async (t) => {
    const expected = "🙂".repeat(200);
    let renders = 0;
    const webPageOpener = new WebPageOpener({
      renderPage: async () => {
        renders += 1;
        return {
          url: "https://example.com/final",
          title: "Example page",
          content: expected,
        };
      },
    });
    const running = await startMcpHttpServer({
      port: 0,
      webPageOpener,
    });
    t.after(() => running.close());

    const first = await connectClient(running.url, "fetch-website-client-1");
    const firstResult = await first.client.callTool({
      name: "fetch_website",
      arguments: {
        url: "https://example.com/start",
        format: "clean_html",
        max_output_bytes: 256,
      },
    });
    assert.equal(firstResult.isError, undefined);
    const firstContent = firstResult.structuredContent as {
      url: string;
      title: string;
      format: string;
      content: string;
      next_cursor?: string;
    };
    assert.equal(firstContent.url, "https://example.com/final");
    assert.equal(firstContent.title, "Example page");
    assert.equal(firstContent.format, "clean_html");
    assert.equal(Buffer.byteLength(firstContent.content, "utf8"), 256);
    assert.ok(firstContent.next_cursor);
    await first.client.close();

    const second = await connectClient(running.url, "fetch-website-client-2");
    t.after(() => second.client.close());
    const secondResult = await second.client.callTool({
      name: "fetch_website",
      arguments: {
        url: "https://example.com/start",
        format: "clean_html",
        cursor: firstContent.next_cursor,
        max_output_bytes: 1024,
      },
    });
    assert.equal(secondResult.isError, undefined);
    const secondContent = secondResult.structuredContent as {
      content: string;
      next_cursor?: string;
    };
    assert.equal(firstContent.content + secondContent.content, expected);
    assert.equal(secondContent.next_cursor, undefined);
    assert.equal(renders, 1);
  },
);

test(
  "isolates named shell state and allows foreground commands in parallel",
  { timeout: 20_000 },
  async (t) => {
    const running = await startMcpHttpServer({ port: 0 });
    t.after(() => running.close());
    const connected = await connectClient(running.url, "named-shell-client");
    t.after(() => connected.client.close());

    const explicitCwd = await mkdtemp(join(tmpdir(), "mcp-explicit-cwd-"));
    t.after(() => rm(explicitCwd, { recursive: true, force: true }));

    const explicitResult = snapshotFromResult(
      await connected.client.callTool({
        name: "shell_run",
        arguments: {
          shell_id: "cwd-shell",
          request_id: "cwd001",
          cwd: explicitCwd,
          command: "printf '%s' \"$PWD\"",
          wait_ms: 1_000,
        },
      }),
    );
    assert.equal(explicitResult.status, "completed");
    assert.equal(explicitResult.output, explicitCwd);
    assert.equal(explicitResult.cwd, explicitCwd);

    const retainedCwd = await callUntilComplete(
      connected.client,
      "cwd002",
      "printf '%s' \"$PWD\"",
      "cwd-shell",
    );
    assert.equal(retainedCwd.output, explicitCwd);
    assert.equal(retainedCwd.cwd, explicitCwd);

    const closedCwdShell = await connected.client.callTool({
      name: "shell_close",
      arguments: { shell_id: "cwd-shell" },
    });
    assert.equal(closedCwdShell.isError, undefined);

    const alphaState = await callUntilComplete(
      connected.client,
      "shared-request",
      "cd /tmp && export NAMED_STATE=alpha && printf alpha-ready",
      "alpha",
    );
    const betaState = await callUntilComplete(
      connected.client,
      "shared-request",
      `printf '%s|%s' "$PWD" "\${NAMED_STATE-unset}"`,
      "beta",
    );
    assert.equal(alphaState.output, "alpha-ready");
    assert.equal(alphaState.shell_id, "alpha");
    assert.match(betaState.output, /\|unset$/);
    assert.equal(betaState.shell_id, "beta");

    const slowAlpha = connected.client.callTool({
      name: "shell_run",
      arguments: {
        shell_id: "alpha",
        request_id: "slow01",
        command: "sleep 0.3; printf alpha-done",
        wait_ms: 0,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const betaWhileAlphaRuns = await callUntilComplete(
      connected.client,
      "parallel",
      "printf beta-done",
      "beta",
    );
    assert.equal(betaWhileAlphaRuns.output, "beta-done");

    const alphaBusy = await connected.client.callTool({
      name: "shell_run",
      arguments: {
        shell_id: "alpha",
        request_id: "blocked",
        command: "printf should-not-run",
      },
    });
    assert.equal(alphaBusy.isError, true);
    assert.match(JSON.stringify(alphaBusy.content), /busy/);

    let alphaSnapshot = snapshotFromResult(await slowAlpha);
    assert.equal(alphaSnapshot.shell_id, "alpha");
    let alphaOutput = alphaSnapshot.output;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (alphaSnapshot.status !== "running" && !alphaSnapshot.has_more) break;
      assert.ok(alphaSnapshot.request_id);
      assert.notEqual(alphaSnapshot.next_cursor, undefined);
      alphaSnapshot = snapshotFromResult(
        await connected.client.callTool({
          name: "shell_poll",
          arguments: {
            shell_id: "alpha",
            request_id: alphaSnapshot.request_id,
            cursor: alphaSnapshot.next_cursor,
            wait_ms: 100,
          },
        }),
      );
      assert.equal(alphaSnapshot.shell_id, "alpha");
      alphaOutput += alphaSnapshot.output;
    }
    assert.equal(alphaSnapshot.status, "completed");
    assert.equal(alphaOutput, "alpha-done");

    await connected.client.callTool({
      name: "shell_reset",
      arguments: {
        shell_id: "alpha",
        request_id: "reset1",
        reason: "test reset isolation",
      },
    });
    const betaAfterReset = await callUntilComplete(
      connected.client,
      "after-reset",
      "printf beta-still-ready",
      "beta",
    );
    assert.equal(betaAfterReset.output, "beta-still-ready");

    const listed = await connected.client.callTool({ name: "shell_list" });
    assert.equal(listed.isError, undefined);
    const listedContent = listed.structuredContent as {
      shells: Array<{
        shell_id: string;
        status: "idle" | "active";
        is_default: boolean;
        can_close: boolean;
        idle_ms: number;
      }>;
      count: number;
      limit: number;
      idle_timeout_ms: number;
    };
    assert.deepEqual(
      listedContent.shells.map((shell) => shell.shell_id),
      ["default", "alpha", "beta"],
    );
    assert.equal(listedContent.count, 3);
    assert.equal(listedContent.limit, 8);
    assert.equal(listedContent.idle_timeout_ms, 1_800_000);
    assert.deepEqual(
      listedContent.shells.find((shell) => shell.shell_id === "default"),
      {
        shell_id: "default",
        status: "idle",
        is_default: true,
        can_close: false,
        idle_ms: listedContent.shells[0].idle_ms,
      },
    );

    const closed = await connected.client.callTool({
      name: "shell_close",
      arguments: { shell_id: "alpha" },
    });
    assert.equal(closed.isError, undefined);
    assert.deepEqual(closed.structuredContent, {
      shell_id: "alpha",
      closed: true,
    });

    const closeDefault = await connected.client.callTool({
      name: "shell_close",
      arguments: { shell_id: "default" },
    });
    assert.equal(closeDefault.isError, true);
    assert.match(JSON.stringify(closeDefault.content), /protected_shell/);
    assert.match(JSON.stringify(closeDefault.content), /shell_reset/);

    const resetDefault = await connected.client.callTool({
      name: "shell_reset",
      arguments: {
        shell_id: "default",
        request_id: "default-reset",
        reason: "prove protected shell remains resettable",
      },
    });
    assert.equal(resetDefault.isError, undefined);
    assert.equal(
      (resetDefault.structuredContent as { status: string }).status,
      "ready",
    );

    const afterClose = await connected.client.callTool({ name: "shell_list" });
    assert.deepEqual(
      (
        afterClose.structuredContent as {
          shells: Array<{ shell_id: string }>;
        }
      ).shells.map((shell) => shell.shell_id),
      ["default", "beta"],
    );
  },
);

test(
  "applies patches through the native MCP tool",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-native-patch-"));
    const project = join(directory, "project with ' quote");
    const bin = join(directory, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(bin, { recursive: true });
    const executable = join(bin, "apply_patch");
    await writeFile(
      executable,
      '#!/bin/sh\npatch=$(cat)\ncase "$patch" in *SLOW_PATCH*) sleep 0.2 ;; esac\nprintf \'cwd=%s\\n%s\' "$PWD" "$patch"\n',
    );
    await chmod(executable, 0o755);

    const shell = new PersistentShellSession({ cwd: directory });
    const running = await startMcpHttpServer({
      port: 0,
      shell,
      applyPatchExecutable: executable,
    });
    t.after(async () => {
      await running.close();
      await rm(directory, { recursive: true, force: true });
    });
    const connected = await connectClient(running.url, "native-patch-client");
    t.after(() => connected.client.close());

    const patch = [
      "*** Begin Patch",
      "*** Add File: example.txt",
      "+literal $() `ticks` 'quotes'",
      "+__MCP_PATCH_not_the_random_token__",
      "*** End Patch",
    ].join("\n");
    const result = await connected.client.callTool({
      name: "apply_patch",
      arguments: { cwd: project, patch },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      status: "completed",
      exit_code: 0,
      output: `cwd=${project}\n${patch}`,
    });
    assert.doesNotMatch(JSON.stringify(result.content), /literal \$\(\)/);
    assert.match(
      JSON.stringify(result.content),
      /apply_patch completed, exit=0/,
    );

    const noisyPatch = [
      "*** Begin Patch",
      "*** Add File: noisy.txt",
      `+${"x".repeat(400)}`,
      "*** End Patch",
    ].join("\n");
    const noisyResult = await connected.client.callTool({
      name: "apply_patch",
      arguments: { cwd: project, patch: noisyPatch, max_output_bytes: 256 },
    });
    const noisyContent = noisyResult.structuredContent as {
      output: string;
      output_truncated?: true;
      dropped_output_bytes?: number;
      omitted_output_bytes?: number;
    };
    const fullNoisyOutput = `cwd=${project}\n${noisyPatch}`;
    assert.equal(Buffer.byteLength(noisyContent.output, "utf8"), 256);
    assert.equal(noisyContent.output_truncated, true);
    assert.equal(noisyContent.dropped_output_bytes, undefined);
    assert.equal(
      noisyContent.omitted_output_bytes,
      Buffer.byteLength(fullNoisyOutput, "utf8") - 256,
    );

    const invalid = await connected.client.callTool({
      name: "apply_patch",
      arguments: { cwd: "relative/project", patch },
    });
    assert.equal(invalid.isError, true);
    assert.match(
      JSON.stringify(invalid.content),
      /cwd must be an absolute path/,
    );

    const slowPatch = connected.client.callTool({
      name: "apply_patch",
      arguments: { cwd: project, patch: `${patch}\nSLOW_PATCH` },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const concurrent = await connected.client.callTool({
      name: "shell_run",
      arguments: {
        request_id: "during-patch",
        command: "printf should-not-run",
      },
    });
    assert.equal(concurrent.isError, true);
    assert.match(JSON.stringify(concurrent.content), /busy/);
    assert.equal((await slowPatch).isError, undefined);

    const namedSlowPatch = connected.client.callTool({
      name: "apply_patch",
      arguments: {
        shell_id: "patch-shell",
        cwd: project,
        patch: `${patch}\nSLOW_PATCH`,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const otherShell = await callUntilComplete(
      connected.client,
      "parallel-patch",
      "printf other-shell-ready",
      "other-shell",
    );
    assert.equal(otherShell.output, "other-shell-ready");

    const selectedShellBusy = await connected.client.callTool({
      name: "shell_run",
      arguments: {
        shell_id: "patch-shell",
        request_id: "patch-busy",
        command: "printf should-not-run",
      },
    });
    assert.equal(selectedShellBusy.isError, true);
    assert.match(JSON.stringify(selectedShellBusy.content), /busy/);
    assert.equal((await namedSlowPatch).isError, undefined);
  },
);

test("rejects a mismatched HTTP Host", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 });
  t.after(() => running.close());

  const status = await postWithHost(running.url, "attacker.example", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "host-validation-test", version: "1.0.0" },
    },
  });

  assert.equal(status, 403);
});

function postWithHost(
  url: string,
  host: string,
  value: unknown,
): Promise<number> {
  const target = new URL(url);
  const body = JSON.stringify(value);

  return new Promise((resolve, reject) => {
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
          host,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function connectClient(url: string, name: string) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}

interface ToolSnapshot {
  shell_id?: string;
  status: "running" | "completed" | "shell_exited" | "reset";
  exit_code: number | null;
  cwd: string;
  output: string;
  request_id?: string;
  next_cursor?: number;
  has_more?: true;
  cursor_expired?: true;
  output_truncated?: true;
  dropped_output_bytes?: number;
}

async function callUntilComplete(
  client: Client,
  requestId: string,
  command: string,
  shellId?: string,
): Promise<ToolSnapshot> {
  let snapshot = snapshotFromResult(
    await client.callTool({
      name: "shell_run",
      arguments: {
        ...(shellId ? { shell_id: shellId } : {}),
        request_id: requestId,
        command,
        wait_ms: 1_000,
      },
    }),
  );
  let output = snapshot.output;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (snapshot.status !== "running" && snapshot.has_more !== true) {
      return { ...snapshot, output };
    }
    assert.ok(snapshot.request_id);
    assert.notEqual(snapshot.next_cursor, undefined);
    snapshot = snapshotFromResult(
      await client.callTool({
        name: "shell_poll",
        arguments: {
          ...(shellId ? { shell_id: shellId } : {}),
          request_id: snapshot.request_id,
          cursor: snapshot.next_cursor,
          wait_ms: 100,
        },
      }),
    );
    output += snapshot.output;
  }

  throw new Error(`MCP command ${requestId} did not complete.`);
}

function snapshotFromResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): ToolSnapshot {
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  return result.structuredContent as unknown as ToolSnapshot;
}
