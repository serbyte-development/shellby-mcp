# Secret Handling

Verified 2026-08-15.

## What This Is

This page defines what authentication, provider, audit-log, and machine-local information may enter the committed wiki.

## Current State

Remote ChatGPT access uses durable local state at `~/.unhinged-agent/auth.json` containing only a version and one bound OpenAI subject. The file and its parent directory are forced to owner-only permissions. Direct localhost `/mcp` access remains unauthenticated (`src/auth/auth.ts`, `src/server/http-server.ts`, `src/index.ts`).

The ngrok CLI may use credentials stored outside this repository. npm registry credentials and any future CI tokens also belong in their provider configuration, user-level config, or a password manager—not in repository Markdown (`package.json`).

## Rules

- Public wiki pages may list environment variable names, service names, and code paths.
- Local-only ownership or rotation pointers may go in `_private/secrets-map.local.md`.
- Never place actual values in logs, shell examples, tests, or uploaded context.
- The checked-in ngrok commands disable local HTTP inspection. There is no secret in the MCP URL; ngrok remains part of the trusted network boundary because it verifies ChatGPT origin and adds the internal remote marker (`package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).
- Treat the bound OpenAI subject as private authentication metadata. Authentication errors must not echo it, and the MCP audit logger begins only after remote authorization succeeds (`src/server/http-server.ts`, `src/server/audit-log.ts`).
- MCP `tools/call` inputs are appended in bounded form to gitignored `agent-commands.yaml`, which is created or repaired with owner-only `0600` permissions; this can include shell commands, prompt prefixes, URLs, Computer Use inputs, and failed patch text. Ordinary arguments are capped at 600 characters, shell commands at 2,000 characters, and failed patches at 32,000 characters. Successful `apply_patch` calls retain only cwd and patch size. Ordinary tool output is not persisted; the HTTP layer derives model-facing output token counts from a bounded complete response body when available and discards the body after logging (`src/index.ts`, `src/server/http-server.ts`, `src/server/audit-log.ts`).

## Related

- [[pages/Project Overview]]
- [[pages/HTTP Transport]]
- [[pages/Configuration and Startup]]
- [[pages/Open Questions and Risks]]
