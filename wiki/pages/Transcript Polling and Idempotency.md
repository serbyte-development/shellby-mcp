# Transcript Polling and Idempotency

Verified 2026-08-06.

## What This Is

The shell runtime turns an unbounded byte stream into bounded, retry-safe command snapshots (`src/shell-session.ts`).

## Transcript and Cursors

`TranscriptBuffer` stores a rolling JavaScript string with an absolute base offset. When the configured length is exceeded it drops the oldest UTF-16 code units and advances that offset; if the boundary crosses a surrogate pair, it drops the whole pair rather than retaining an invalid half. A cursor older than the retained base is clamped and reported with `cursor_expired: true` (`src/shell-session.ts`, `test/shell-session.test.ts`).

Response limits are measured in UTF-8 bytes. `utf8BoundedEnd` advances by Unicode code point and never splits a surrogate pair or UTF-8 character. Cursors themselves remain JavaScript string offsets, not byte offsets (`src/shell-session.ts`, `test/shell-session.test.ts`).

Each active command retains at most `MCP_COMMAND_TRANSCRIPT_BYTES` UTF-8 bytes. The parser continues consuming all decoded output so it can find the completion marker, but excess confirmed command output is discarded. Internal snapshots track whether this happened and the saturated UTF-8 byte count dropped; model-facing results include those diagnostics only when output was actually discarded (`src/index.ts`, `src/shell-session.ts`, `src/mcp-server.ts`, `test/shell-session.test.ts`).

Each command stores start and terminal cursors. Poll rejects a cursor before the command start, and completed reads are upper-bounded by the terminal cursor, so a poll cannot consume earlier or later command output (`src/shell-session.ts`, `test/shell-session.test.ts`).

## Waiting and Polling

Run waits until completion, abort, timeout, cursor expiry, or a full output slice. Poll performs an immediate read and, when a running command has no output, waits on a versioned update notification up to `wait_ms` (`src/shell-session.ts`).

## Idempotency

Each shell runtime hashes commands with SHA-256 and stores them by request ID. Reusing an ID with the same command in the same shell returns the original record; reusing it with different text returns `request_conflict`. The same request ID may be used independently in another named shell. Reset uses the same rule with its reason string (`src/shell-session.ts`, `src/shell-session-manager.ts`).

Command and reset maps are independently bounded by `MCP_RECORD_LIMIT`. Once a completed record is pruned, its ID can execute again as a new operation (`src/index.ts`, `src/shell-session.ts`).

## Concurrency

Exactly one foreground command is admitted per named shell. A second command using that shell receives `busy`, while commands using different shell IDs can run concurrently (`src/shell-session.ts`, `src/shell-session-manager.ts`, `test/mcp-integration.test.ts`).

Native `apply_patch` directly spawns the prepared Codex executable and does not participate in shell foreground locks, request-ID records, transcripts, or polling. Patch calls and shell commands can therefore run concurrently (`src/mcp-server.ts`, `test/mcp-integration.test.ts`).

## Related

- [[pages/MCP Tool Surface]]
- [[pages/Persistent Shell Runtime]]
- [[pages/Configuration and Startup]]
