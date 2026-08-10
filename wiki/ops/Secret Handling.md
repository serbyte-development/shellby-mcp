# Secret Handling

Verified 2026-08-09.

## Current State

Remote ChatGPT access uses durable local state at `~/.shelly/auth.json` containing only a version and one bound OpenAI subject. The file and its parent directory are forced to owner-only permissions. Direct localhost `/mcp` access remains unauthenticated (`src/auth.ts`, `src/http-server.ts`, `src/index.ts`).

The ngrok CLI may use credentials stored outside this repository. npm registry credentials and any future CI tokens also belong in their provider configuration, user-level config, or a password manager—not in repository Markdown (`package.json`).

## Rules

- Public wiki pages may list environment variable names, service names, and code paths.
- Local-only ownership or rotation pointers may go in `_private/secrets-map.local.md`.
- Never place actual values in logs, shell examples, tests, or uploaded context.
- The checked-in ngrok commands disable local HTTP inspection. There is no secret in the MCP URL; ngrok remains part of the trusted network boundary because it verifies ChatGPT origin and adds the internal remote marker (`package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).
- Treat the bound OpenAI subject as private authentication metadata. Authentication errors must not echo it, and the MCP audit logger begins only after remote authorization succeeds (`src/http-server.ts`, `src/mcp-audit-log.ts`).
- MCP `tools/call` inputs are appended without general redaction to gitignored `agent-commands.log`; this can include shell commands, subagent prompts, URLs, and Computer Use inputs. `apply_patch` is the exception: its patch body is omitted while its size and other arguments are retained. Completion lines contain output character counts and metadata only, not output bodies. `MCP_LOG_COMMANDS` separately controls shell console logging (`src/index.ts`, `src/http-server.ts`, `src/mcp-audit-log.ts`, `src/shell-session.ts`).
