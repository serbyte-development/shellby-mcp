# Architecture Map

Verified 2026-08-11.

## Layers

| Layer                 | Responsibility                                                                                                 | Implementation                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Static MCP config     | Define server identity, shared tool metadata, runtime defaults, and global instructions                        | `src/config.ts`                |
| Process entry         | Parse configuration, prepare workspace tooling, compose dependencies, handle shutdown                          | `src/index.ts`                 |
| HTTP boundary         | Bind localhost, apply MCP Express HTTP guards, expose health and MCP routes, own request transports            | `src/server/http-server.ts`           |
| Remote authentication | Persist the bound ChatGPT subject outside the repo                                                             | `src/auth/auth.ts`                  |
| MCP audit log         | Record every `tools/call` request and compact completion metadata without affecting dispatch                   | `src/server/audit-log.ts`         |
| MCP composition       | Publish shared instructions and register capability tool modules                                               | `src/server/mcp-server.ts`            |
| Tool contracts        | Own tool schemas, descriptions, handlers, result shaping, and capability-specific errors                       | `src/tools/`                          |
| Feedback inbox        | Append agent-reported MCP problems and ideas to a repo-local JSONL inbox                                       | `src/tools/feedback.ts`              |
| Computer Use tools    | Publish eleven focused schemas, validate targets, and normalize compact MCP results                            | `src/tools/computer/computer-tools.ts`    |
| Peekaboo adapter      | Invoke the CLI without a shell, serialize calls, parse bounded JSON, and retain snapshot targets               | `src/tools/computer/peekaboo.ts`              |
| Shell manager         | Lazily create, route, limit, idle-evict, and close named shell runtimes                                        | `src/tools/shell/session-manager.ts` |
| Shell runtime         | Own the persistent child shell, marker protocol, transcripts, command/batch records, context capture, reset, and recovery | `src/tools/shell/session.ts` |
| Parallel shell runner | Parse `*** Run` batches, enforce four process-wide children, run isolated shell jobs, cap output, timeout, and clean process groups | `src/tools/shell/parallel-runner.ts` |
| Apply Patch            | Publish the first-class patch tool and execute the checked-in vendored binary directly                         | `src/tools/apply-patch/apply-patch.ts` |
| Skill catalog         | Discover and load reusable workspace `SKILL.md` files dynamically                                              | `src/tools/skills.ts`                |
| Website fetching      | Produce Markdown, cleaned HTML, or raw rendered HTML and retain bounded cursor-addressed documents             | `src/tools/web/web-open.ts`              |
| ChatGPT subagents     | Attach to debuggable Chrome, retain caller-named agent/page state, submit turns, and normalize final responses | `src/tools/subagent/chatgpt-subagent.ts`      |

## Request Lifecycle

1. `src/index.ts` parses configuration, ensures durable authentication state under `~/.shelly/auth.json`, prepares the workspace, and creates a `ShellSessionManager`, shared `PeekabooClient`, shared `ChatGptSubagentModule`, and repository-local `McpAuditLogger`; the HTTP boundary composes the shared `FeedbackStore` and webpage opener when not injected (`src/index.ts`, `src/auth/auth.ts`).
2. Exact `POST /mcp` serves both direct localhost clients and the ngrok tunnel. `createMcpExpressApp` provides JSON parsing plus localhost Host/Origin guards; ngrok remains the remote trust boundary and marks ChatGPT-origin-verified requests with `X-Shelly-Remote: 1`. The first marked `tools/call` binds `X-OpenAI-Subject` before dispatch and later marked tool calls require the same subject. Discovery does not bind. Each accepted POST creates a short-lived `McpServer` and stateless `NodeStreamableHTTPServerTransport` (`src/server/http-server.ts`, `src/auth/auth.ts`, `ngrok-traffic-policy.yml`).
3. Shell handlers resolve `shell_id` through the shared shell manager. `skill_list` and `skill_load` read `<workspace>/skills` directly on each call, so catalog changes require no server rebuild. `feedback_submit` appends through the shared process-level `FeedbackStore`, which serializes writes to `feedback/agent-feedback.jsonl`. `chatgpt_subagent` resolves caller-named `agent_id` through the shared process-level subagent module. `apply_patch` bypasses the shell manager and directly spawns the prepared Codex executable. All request-scoped Computer Use handlers share the same process-level `PeekabooClient`.
4. The adapter serializes Computer Use calls and invokes `peekaboo` with `execFile`, exact argv, `--json`, a 30-second timeout, and a 4 MiB process-output cap. It checks the JSON `success` field and does not retry failures (`src/tools/computer/peekaboo.ts`).
5. Each `PersistentShellSession` writes normal commands into its own child login shell and detects completion through randomized control markers. For a parallel envelope it first captures the shell's exported environment/cwd, then `parallel-runner.ts` schedules isolated short-lived shell children under the shared four-process ceiling; the outer session retains per-run state and paged grouped output.
6. `computer_observe` reads Peekaboo's temporary PNG and encodes it as a same-dimension quality-65 JPEG while returning only essential snapshot metadata. `computer_inspect` separately invokes bounded `inspect-ui` text retrieval for a snapshot when AX is actually needed. The adapter retains at most 64 snapshot-to-capture-target mappings, and coordinate actions resolve through that mapping before reaching Peekaboo (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

The named shell is the persistence boundary: callers using the same `shell_id` share state across independent MCP clients, while different IDs have independent cwd, environment, transcript, command records, reset lifecycle, and foreground-command lock (`src/server/http-server.ts`, `src/tools/shell/session-manager.ts`, `test/mcp-integration.test.ts`).

`src/config.ts` is the single static configuration surface for MCP identity, shared tool metadata, top-level runtime defaults, and global instructions. `src/index.ts` is the process composition root; `src/server/mcp-server.ts` composes the MCP surface, while each capability under `src/tools/` owns its model-facing contract and implementation helpers. Authentication is intentionally narrow: one durable ChatGPT owner for trusted tunnel tool calls, while localhost MCP remains agent-neutral. There is no database, hosted relay, login UI, OAuth flow, secret URL, or general multi-user authorization system (`src/config.ts`, `src/auth/auth.ts`, `src/server/http-server.ts`).
