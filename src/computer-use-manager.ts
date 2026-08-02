import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { constants as fsConstants } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const COMPUTER_USE_CHILD_TOOL_NAMES = [
  "list_apps",
  "get_app_state",
  "click",
  "type_text",
  "scroll",
  "press_key",
] as const;

export type ComputerUseChildToolName =
  (typeof COMPUTER_USE_CHILD_TOOL_NAMES)[number];

const KNOWN_CHATGPT_LAUNCHER =
  "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/bin/computer-use-client-launcher";
const CHATGPT_PLUGIN_ROOT =
  "/Applications/ChatGPT.app/Contents/Resources/plugins";
const LAUNCHER_BASENAME = "computer-use-client-launcher";

interface ChildConnection {
  client: Client;
  transport: StdioClientTransport;
}

interface SchemaExpectation {
  required: string[];
  properties: Record<
    string,
    {
      type: string;
      enum?: string[];
    }
  >;
}

const EXPECTED_SCHEMAS: Record<ComputerUseChildToolName, SchemaExpectation> = {
  list_apps: {
    required: [],
    properties: {},
  },
  get_app_state: {
    required: ["app"],
    properties: {
      app: { type: "string" },
    },
  },
  click: {
    required: ["app"],
    properties: {
      app: { type: "string" },
      click_count: { type: "integer" },
      element_index: { type: "string" },
      mouse_button: {
        type: "string",
        enum: ["left", "right", "middle"],
      },
      x: { type: "number" },
      y: { type: "number" },
    },
  },
  type_text: {
    required: ["app", "text"],
    properties: {
      app: { type: "string" },
      text: { type: "string" },
    },
  },
  scroll: {
    required: ["app", "element_index", "direction"],
    properties: {
      app: { type: "string" },
      direction: { type: "string" },
      element_index: { type: "string" },
      pages: { type: "number" },
    },
  },
  press_key: {
    required: ["app", "key"],
    properties: {
      app: { type: "string" },
      key: { type: "string" },
    },
  },
};

export interface ResolveComputerUseLauncherOptions {
  env?: NodeJS.ProcessEnv;
  knownLauncherPath?: string;
  pluginRoot?: string;
}

export interface ComputerUseManagerOptions {
  launcherPath: string;
  args?: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  stderrLimitBytes?: number;
}

export class ComputerUseUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComputerUseUnavailableError";
  }
}

export class ComputerUseManager {
  readonly launcherPath: string;

  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly stderrLimitBytes: number;
  private readonly shutdownController = new AbortController();

  private connection: ChildConnection | undefined;
  private connecting: Promise<ChildConnection> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private disabledReason: string | undefined;
  private stderrTail = "";

  constructor(options: ComputerUseManagerOptions) {
    this.launcherPath = options.launcherPath;
    this.args = options.args ?? ["mcp"];
    this.env = buildChildEnvironment(options.env);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.stderrLimitBytes = options.stderrLimitBytes ?? 8 * 1024;
  }

  get shouldExposeTools(): boolean {
    return !this.closed && this.disabledReason === undefined;
  }

  get unavailableReason(): string | undefined {
    return this.disabledReason;
  }

  async callTool(
    name: ComputerUseChildToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const operation = async () => {
      if (this.closed) {
        throw new ComputerUseUnavailableError("Computer Use is closed.");
      }
      if (this.disabledReason) {
        throw new ComputerUseUnavailableError(this.disabledReason);
      }

      const requestSignal = signal
        ? AbortSignal.any([signal, this.shutdownController.signal])
        : this.shutdownController.signal;
      requestSignal.throwIfAborted();

      const connection = await this.ensureConnected(requestSignal);
      try {
        return (await connection.client.callTool(
          { name, arguments: args },
          undefined,
          {
            signal: requestSignal,
            timeout: this.requestTimeoutMs,
          },
        )) as CallToolResult;
      } catch (error) {
        await this.discardConnection(connection);
        throw new ComputerUseUnavailableError(
          this.describeFailure(`Computer Use tool ${name} failed`, error),
          { cause: error },
        );
      }
    };

    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdownController.abort();
    await this.queue;

    const connection = this.connection;
    this.connection = undefined;
    this.connecting = undefined;
    if (connection) await closeConnection(connection);
  }

  private async ensureConnected(signal: AbortSignal): Promise<ChildConnection> {
    if (this.connection) return this.connection;
    if (this.connecting) return this.connecting;

    const connecting = this.connect(signal);
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  private async connect(signal: AbortSignal): Promise<ChildConnection> {
    this.stderrTail = "";
    const transport = new StdioClientTransport({
      command: this.launcherPath,
      args: this.args,
      env: this.env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      this.appendStderr(chunk.toString());
    });

    const client = new Client({
      name: "chatgpt-local-shell-computer-use-bridge",
      version: "0.1.0",
    });
    let connection: ChildConnection | undefined;
    client.onclose = () => {
      if (connection && this.connection === connection) {
        this.connection = undefined;
      }
    };

    try {
      await client.connect(transport, {
        signal,
        timeout: this.requestTimeoutMs,
      });
      const listed = await client.listTools({}, {
        signal,
        timeout: this.requestTimeoutMs,
      });
      const incompatibility = validateExpectedTools(listed.tools);
      if (incompatibility) {
        this.disabledReason = `Computer Use was disabled because the bundled child MCP schema is incompatible: ${incompatibility}`;
        throw new ComputerUseUnavailableError(this.disabledReason);
      }

      connection = { client, transport };
      this.connection = connection;
      return connection;
    } catch (error) {
      try {
        await client.close();
      } catch {
        await transport.close().catch(() => undefined);
      }

      if (error instanceof ComputerUseUnavailableError) throw error;
      throw new ComputerUseUnavailableError(
        this.describeFailure("Could not connect to the Computer Use child MCP", error),
        { cause: error },
      );
    }
  }

  private async discardConnection(connection: ChildConnection): Promise<void> {
    if (this.connection === connection) this.connection = undefined;
    await closeConnection(connection);
  }

  private appendStderr(value: string): void {
    this.stderrTail += value;
    const bytes = Buffer.byteLength(this.stderrTail, "utf8");
    if (bytes <= this.stderrLimitBytes) return;

    const buffer = Buffer.from(this.stderrTail, "utf8");
    this.stderrTail = buffer
      .subarray(buffer.byteLength - this.stderrLimitBytes)
      .toString("utf8");
  }

  private describeFailure(prefix: string, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    const stderr = this.stderrTail.trim();
    return stderr
      ? `${prefix}: ${detail}. Child stderr: ${stderr}`
      : `${prefix}: ${detail}`;
  }
}

export async function createComputerUseManager(
  options: ResolveComputerUseLauncherOptions = {},
): Promise<ComputerUseManager | null> {
  const launcherPath = await resolveComputerUseLauncher(options);
  return launcherPath ? new ComputerUseManager({ launcherPath }) : null;
}

export async function resolveComputerUseLauncher(
  options: ResolveComputerUseLauncherOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const candidates = [
    env.CHATGPT_COMPUTER_USE_LAUNCHER,
    options.knownLauncherPath ?? KNOWN_CHATGPT_LAUNCHER,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const expanded = expandHome(candidate);
    if (await isExecutable(expanded)) return resolve(expanded);
  }

  return findLauncher(
    options.pluginRoot ?? CHATGPT_PLUGIN_ROOT,
    LAUNCHER_BASENAME,
  );
}

function buildChildEnvironment(
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const key of ["HOME", "CODEX_HOME", "TMPDIR"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...overrides };
}

async function closeConnection(connection: ChildConnection): Promise<void> {
  try {
    await connection.client.close();
  } catch {
    await connection.transport.close().catch(() => undefined);
  }
}

function validateExpectedTools(tools: Tool[]): string | null {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const name of COMPUTER_USE_CHILD_TOOL_NAMES) {
    const tool = byName.get(name);
    if (!tool) return `missing tool ${name}`;

    const expected = EXPECTED_SCHEMAS[name];
    const schema = tool.inputSchema;
    if (schema.type !== "object") return `${name} input is not an object`;

    const required = [...(schema.required ?? [])].sort();
    const expectedRequired = [...expected.required].sort();
    if (JSON.stringify(required) !== JSON.stringify(expectedRequired)) {
      return `${name} required fields changed`;
    }

    const properties = schema.properties ?? {};
    for (const [propertyName, propertyExpectation] of Object.entries(
      expected.properties,
    )) {
      const property = properties[propertyName] as
        | { type?: unknown; enum?: unknown }
        | undefined;
      if (!property) return `${name}.${propertyName} is missing`;
      if (property.type !== propertyExpectation.type) {
        return `${name}.${propertyName} type changed`;
      }
      if (
        propertyExpectation.enum &&
        JSON.stringify(property.enum) !== JSON.stringify(propertyExpectation.enum)
      ) {
        return `${name}.${propertyName} enum changed`;
      }
    }
  }

  return null;
}

async function findLauncher(
  root: string,
  targetBasename: string,
): Promise<string | null> {
  const pending: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ];

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = join(current.path, entry.name);
      if (
        entry.isFile() &&
        basename(entryPath) === targetBasename &&
        (await isExecutable(entryPath))
      ) {
        return resolve(entryPath);
      }
      if (entry.isDirectory() && current.depth < 8) {
        pending.push({ path: entryPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
}
