# Secret Handling

Verified 2026-08-07.

## Current State

The server requires no credential environment variables and implements no authentication (`src/index.ts`, `src/http-server.ts`, `src/mcp-server.ts`). Its environment inputs are runtime configuration, not secrets.

The ngrok CLI may use credentials stored outside this repository. npm registry credentials and any future CI tokens also belong in their provider configuration, user-level config, or a password manager—not in repository Markdown (`package.json`).

## Rules

- Public wiki pages may list environment variable names, service names, and code paths.
- Local-only ownership or rotation pointers may go in `_private/secrets-map.local.md`.
- Never place actual values in logs, shell examples, tests, or uploaded context.
- MCP `tools/call` inputs are appended without general redaction to gitignored `agent-commands.log`; this can include shell commands, subagent prompts, URLs, and Computer Use inputs. `apply_patch` is the exception: its patch body is omitted while its size and other arguments are retained. Completion lines contain output character counts and metadata only, not output bodies. `MCP_LOG_COMMANDS` separately controls shell console logging (`src/index.ts`, `src/http-server.ts`, `src/mcp-audit-log.ts`, `src/shell-session.ts`).
