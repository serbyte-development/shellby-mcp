# Architecture Map

Verified 2026-08-22.

## What This Is

This page maps the process-level components and follows one request from the HTTP boundary into shared runtime state and capability handlers.

## Layers

| Layer                 | Responsibility                                                                                                                                | Implementation                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Static MCP config     | Define server identity, shared tool metadata, runtime defaults, and global instructions                                                       | `src/config.ts`                          |
| Process entry         | Consume static configuration, prepare workspace state, compose dependencies, handle shutdown                                                  | `src/index.ts`                           |
| HTTP boundary         | Bind localhost, apply MCP Express HTTP guards, expose health and MCP routes, own request transports                                           | `src/server/http-server.ts`              |
| Remote authentication | Persist the bound ChatGPT subject outside the repo                                                                                            | `src/auth/auth.ts`                       |
| MCP audit log         | Record every `tools/call` request and compact completion metadata without affecting dispatch                                                  | `src/server/audit-log.ts`                |
| MCP composition       | Publish shared instructions and register capability tool modules                                                                              | `src/server/mcp-server.ts`               |
| Tool contracts        | Own tool schemas, descriptions, handlers, result shaping, and capability-specific errors                                                      | `src/tools/`                             |
| Computer Use tools    | Publish eleven focused schemas, validate targets, and normalize compact MCP results                                                           | `src/tools/computer/computer-tools.ts`   |
| Peekaboo adapter      | Invoke the CLI without a shell, serialize calls, parse bounded JSON, and retain snapshot targets                                              | `src/tools/computer/peekaboo.ts`         |
| Shell manager         | Lazily create/restore named shells, manage live LRU capacity, hibernate idle shells, and expire cached recoverable state                      | `src/tools/shell/session-manager.ts`     |
| Shell runtime         | Own the persistent child shell, marker protocol, transcripts, command/batch records, context capture, reset, and recovery                     | `src/tools/shell/session.ts`             |
| Parallel shell runner | Parse `*** Run` batches, enforce four children per shell, run isolated shell jobs, cap output, timeout, and clean process groups              | `src/tools/shell/parallel-runner.ts`     |
| Apply Patch           | Publish the first-class patch tool and execute the checked-in vendored binary directly                                                        | `src/tools/apply-patch/apply-patch.ts`   |
| Skill catalog         | Discover and load reusable workspace `SKILL.md` files dynamically                                                                             | `src/tools/skills.ts`                    |
| Website fetching      | Produce Markdown, cleaned HTML, or raw rendered HTML and retain bounded cursor-addressed documents                                            | `src/tools/web/web-open.ts`              |
| ChatGPT subagents     | Attach to debuggable Chrome, run up to three detached generations, reconcile polls, idle-evict runtime state, and recover saved conversations | `src/tools/subagent/chatgpt-subagent.ts` |

## Request Lifecycle

1. `src/index.ts` parses configuration, prepares durable/process-level state, and composes shared runtime services (`src/index.ts`, `src/config.ts`).
2. `src/server/http-server.ts` accepts an MCP request, applies the transport/ownership boundary, and creates a short-lived MCP server/transport around shared process services. See [HTTP Transport](./HTTP%20Transport.md).
3. `src/server/mcp-server.ts` registers the model-facing tools; the selected capability module under `src/tools/` owns its schema, handler, result, and domain errors.
4. Stateful capabilities retain only their intended process-level boundary: named shells in the shell manager, webpage documents in the opener cache, browser conversations in the subagent runtime service, and Computer Use capture targets in the Peekaboo adapter. Dedicated pages document those lifecycles.

## Related

- [Project Overview](./Project%20Overview.md)
- [HTTP Transport](./HTTP%20Transport.md)
- [MCP Tool Surface](./MCP%20Tool%20Surface.md)
- [Configuration and Startup](./Configuration%20and%20Startup.md)
- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
- [Audit Logging](./Audit%20Logging.md)
