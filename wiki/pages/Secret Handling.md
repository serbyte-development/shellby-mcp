# Secret Handling

Verified 2026-08-18.

## What This Is

This page defines what authentication, provider, audit-log, and machine-local information may enter the committed wiki.

## Current State

Remote ChatGPT ownership state is stored outside the repository in `~/.unhinged-agent/auth.json` with owner-only permissions. Treat the bound OpenAI subject as private authentication metadata; transport and binding mechanics are documented in [HTTP Transport](./HTTP%20Transport.md) (`src/auth/auth.ts`, `src/server/http-server.ts`).

Provider credentials such as ngrok, npm, or future CI tokens belong in provider/user configuration or a password manager, not repository Markdown (`package.json`).

## Rules

- Public wiki pages may list environment variable names, service names, and code paths.
- Local-only ownership or rotation pointers may go in `_private/secrets-map.local.md`.
- Never place actual values in logs, shell examples, tests, or uploaded context.
- Authentication errors must not echo the bound subject (`src/server/http-server.ts`).
- Treat `agent-commands.yaml` as sensitive local operational data because it can contain tool inputs and failed patch text. Exact retention behavior is canonical in [Audit Logging](./Audit%20Logging.md).

## Related

- [Project Overview](./Project%20Overview.md)
- [HTTP Transport](./HTTP%20Transport.md)
- [Configuration and Startup](./Configuration%20and%20Startup.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
- [Audit Logging](./Audit%20Logging.md)
