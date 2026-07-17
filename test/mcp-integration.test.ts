import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { startMcpHttpServer } from "../src/http-server.js";

test("serves shell tools through Streamable HTTP and retains state across MCP sessions", { timeout: 20_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 });
  t.after(() => running.close());

  const first = await connectClient(running.url, "integration-client-1");
  const instructions = first.client.getInstructions() ?? "";
  assert.match(instructions, /Default workspace:/);
  assert.ok(instructions.includes(running.shell.initialCwd));
  assert.match(instructions, /clone repositories and create new project directories/);
  assert.match(instructions, /TOOLS\.md/);
  assert.match(instructions, /New filesystem tools do not require MCP metadata refresh/);
  assert.match(instructions, /Prefer RTK equivalents/);
  assert.match(instructions, /Output defaults to 4096 UTF-8 bytes/);

  const tools = await first.client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["shell_poll", "shell_reset", "shell_run"],
  );

  const runTool = tools.tools.find((tool) => tool.name === "shell_run");
  assert.equal(runTool?.annotations?.readOnlyHint, false);
  assert.equal(runTool?.annotations?.destructiveHint, true);
  assert.equal(runTool?.annotations?.openWorldHint, true);
  const maxOutputSchema = (
    runTool?.inputSchema.properties as Record<string, Record<string, unknown>>
  ).max_output_bytes;
  assert.equal(maxOutputSchema.default, 4096);
  assert.equal(maxOutputSchema.maximum, 32768);

  const firstResult = await callUntilComplete(first.client, "mcp-state-1", [
    "cd /tmp",
    "export MCP_HTTP_RETAINED=yes",
    "printf initialized",
  ].join("; "));
  assert.equal(firstResult.output, "initialized");
  assert.equal(firstResult.exit_code, 0);

  await first.client.close();

  const second = await connectClient(running.url, "integration-client-2");
  t.after(() => second.client.close());
  const secondResult = await callUntilComplete(
    second.client,
    "mcp-state-2",
    `printf '%s|%s' "$PWD" "$MCP_HTTP_RETAINED"`,
  );
  assert.equal(secondResult.output, "/tmp|yes");
  assert.equal(secondResult.exit_code, 0);
});

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
  request_id: string;
  status: "running" | "completed" | "shell_exited" | "reset";
  exit_code: number | null;
  output: string;
  next_cursor: number;
  has_more: boolean;
}

async function callUntilComplete(
  client: Client,
  requestId: string,
  command: string,
): Promise<ToolSnapshot> {
  let snapshot = snapshotFromResult(
    await client.callTool({
      name: "shell_run",
      arguments: {
        request_id: requestId,
        command,
        wait_ms: 1_000,
      },
    }),
  );
  let output = snapshot.output;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (snapshot.status !== "running" && !snapshot.has_more) {
      return { ...snapshot, output };
    }
    snapshot = snapshotFromResult(
      await client.callTool({
        name: "shell_poll",
        arguments: {
          request_id: requestId,
          cursor: snapshot.next_cursor,
          wait_ms: 100,
        },
      }),
    );
    output += snapshot.output;
  }

  throw new Error(`MCP command ${requestId} did not complete.`);
}

function snapshotFromResult(result: Awaited<ReturnType<Client["callTool"]>>): ToolSnapshot {
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  return result.structuredContent as unknown as ToolSnapshot;
}
