---
summary: "Audit correlation, retained sensitive data, model I/O token counts, and failure markers."
paths:
  - src/server/audit/
  - src/server/http-server.ts
  - src/mcp/tool-registration-boundary.ts
  - src/tokenizer.ts
---

# Audit Logging

[Runtime Logging](./runtime-logging.md) owns operational diagnostics, background failures, and request timing. This page owns the human tool-usage record.

Audit headings use the [shared Pacific timestamp formatter](./runtime-logging.md#event-ownership), also used by reviews and runtime logs.

[audit-log.ts](../../../src/server/audit/audit-log.ts) appends completed tool calls and timestamped `tools/list` lines to gitignored `agent-commands.yaml`, with owner-only file permissions. Writes are best effort and must not change dispatch behavior. Other protocol requests are ignored.

[audit-request.ts](../../../src/server/audit/audit-request.ts) creates calls at HTTP entry; dispatch claims each by request ID/tool name. HTTP completion settles unclaimed calls using transport state. Remote authorization failures happen before audit creation. [Registration Boundary](../mcp-tool-registration-boundary.md) supplies original handler result and final model projection directly; audit does not buffer HTTP output.

## Retention and accounting

[audit-format.ts](../../../src/server/audit/audit-format.ts) owns exact ceilings and per-tool whitelists:

- Shell entries retain bounded original commands, shell/request identity, explicitly supplied wait/output controls, and compact execution/cursor metadata. Omitted defaults remain omitted.
- Successful patches retain cwd/size. Failed or partial patches can retain bounded patch text and failure diagnostics.
- Computer output retains selected target/snapshot metadata, excluding screenshots and inspection trees.
- File-write input retains destination and file metadata, excluding the temporary download URL. Embedded binary resource output is excluded.
- Generic arguments are bounded; ordinary tool output is counted, not persisted.

`in` counts serialized tool arguments. `out` counts final model-facing text/structured results after notices, excluding image/audio/binary resource payloads. Token counts use [tokenizer.ts](../../../src/tokenizer.ts); they measure MCP I/O, not model inference usage. Persistence truncation does not impose a token-accounting cap.

Identity labels come from [Agent Context](../agent-context.md). A call captures its label when it starts, so `start_here`'s own entry may lack the task slug it sets. Raw session values are omitted.

## Interpretation

`~` marks slow calls; `!` marks tool/HTTP/connection failures and nonzero `shell_run` exits. A nonzero exit seen only through `shell_poll` is not separately promoted. Source owns the slow threshold and formatting.

Treat the file as sensitive even with gitignore and restricted permissions: commands, prompt prefixes, URLs, computer input, and failed patches may reveal private data. [Secret Handling](./secret-handling.md) owns committed-data rules. Validate with [audit unit tests](../../../test/server/audit-log.test.ts) and [MCP audit cases](../../../test/integrations/audit.ts).
