# Secret Handling

Verified 2026-08-04.

Use this vault to document credential locations and purpose, never values. Do not commit secret values anywhere in the vault, including `_private/`.

## MCP Bearer Token

The server requires `MCP_AUTH_TOKEN`, an exact 32-character base64url shared secret. It is sent as `Authorization: Bearer <token>` and gates every `/mcp` method; `/healthz` remains public (`src/index.ts`, `src/http-server.ts`). Generate one with `openssl rand -hex 16`.

Keep the value in the repository-root `.env`, the launch environment, or a password manager. `.env` is gitignored and loaded automatically when present (`.gitignore`, `src/index.ts`). Do not put the value in source, `ecosystem.config.cjs`, README examples, tests, PM2 logs, or any wiki file. Rotating it requires restarting the MCP server with the new value and updating the client header.

The ngrok CLI may use credentials stored outside this repository. npm registry credentials and any future CI tokens also belong in their provider configuration, user-level config, or a password manager—not in repository Markdown (`package.json`).

## Pattern

- Public wiki pages may list environment variable names, service names, and code paths.
- Local-only ownership or rotation pointers may go in `_private/secrets-map.local.md`.
- Never place actual values in logs, shell examples, tests, or uploaded context.
- Remember that raw command logging can print secrets embedded in command text when `MCP_LOG_COMMANDS=true` (`src/shell-session.ts`).

## Related

- [[pages/Configuration and Startup]]
- [[pages/Open Questions and Risks]]
