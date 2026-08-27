---
summary: "Repository-local MCP audit logging, retention limits, token accounting, status markers, and sensitivity rules."
paths:
  - src/server/audit-log.ts
  - src/tokenizer.ts
  - test/mcp-audit-log.test.ts
---

# Audit Logging

## What This Is

Canonical behavior for the repository-local MCP tool audit log.

## Storage and Scope

Production injects one `McpAuditLogger` and appends completed `tools/call` activity plus one timestamped line for each `tools/list` request to gitignored `agent-commands.yaml`. Other non-tool MCP requests are ignored. The file is created or repaired with owner-only `0600` permissions. Audit failures are best-effort and never change MCP dispatch (`src/index.ts`, `src/server/http-server.ts`, `src/server/audit-log.ts`, `test/mcp-audit-log.test.ts`).

Each call is one compact YAML document containing the tool name, duration, bounded input context, and model-facing token counts when they can be derived safely. Ordinary tool output is not persisted (`src/server/audit-log.ts`).

## Retention Rules

- `shell_run` command text is retained as a block scalar capped at 2,000 characters.
- `shell_run` entries retain `shell_id/request_id` as one `shell` key plus optional cwd; `shell_poll` entries retain the same shell/request identity plus the requested cursor. Failed shell calls also retain their MCP failure message capped at 1,000 characters.
- Ordinary tool arguments are capped at 600 characters.
- Successful `apply_patch` calls retain cwd and patch size, not patch text.
- Failed `apply_patch` calls may retain the bounded failure message and up to 32,000 patch characters.
- A bounded complete response body may be captured temporarily to calculate output tokens, then is discarded. If capture is incomplete, the output-token count is omitted rather than guessed.
- Response byte/KB size is not logged (`src/server/audit-log.ts`, `src/server/http-server.ts`).

The logger records serialized tool arguments as model-facing `in` tokens. For ordinary non-Computer tools, `out` counts the final projected text plus any structured result after compact/structured projection and completion-event injection. These are MCP I/O counts, not model-inference usage (`src/server/audit-log.ts`, `src/tokenizer.ts`, `test/mcp-audit-log.test.ts`).

## Status Markers and Sensitivity

Calls lasting at least five seconds use `~`; tool, HTTP, and connection failures use `!`; normal calls have no Better Comments marker. Explicit `structured=true` and `max_output_tokens` arguments are surfaced in the heading, and abnormal HTTP completion adds `HTTP <status> <finished|closed>` so transport failures can be identified directly (`src/server/audit-log.ts`, `test/mcp-audit-log.test.ts`).

The log can contain shell commands, prompt prefixes, URLs, Computer Use inputs, and failed patch text. Treat the entire file as sensitive local operational data even though it is gitignored and permission-restricted. See [Secret Handling](./secret-handling.md).

## Related

- [HTTP Transport](../http-transport.md)
- [Configuration and Startup](./configuration-and-startup.md)
- [Secret Handling](./secret-handling.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
- [apply_patch](../tools/apply-patch.md)
