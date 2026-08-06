# Secret Handling

Verified 2026-08-04.

## Current State

The server requires no credential environment variables and implements no authentication (`src/index.ts`, `src/http-server.ts`, `src/mcp-server.ts`). Its environment inputs are runtime configuration, not secrets.

The ngrok CLI may use credentials stored outside this repository. npm registry credentials and any future CI tokens also belong in their provider configuration, user-level config, or a password manager—not in repository Markdown (`package.json`).

## Rules

- Public wiki pages may list environment variable names, service names, and code paths.
- Local-only ownership or rotation pointers may go in `_private/secrets-map.local.md`.
- Never place actual values in logs, shell examples, tests, or uploaded context.
- Command text is appended without redaction to gitignored `agent-commands.log`; `MCP_LOG_COMMANDS` separately controls terminal logging (`src/index.ts`, `src/command-history.ts`, `src/shell-session.ts`).
