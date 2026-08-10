# Persistent Shell Runtime

Verified 2026-08-06.

## Process Model

- The runtime spawns `/bin/sh -c 'exec "$1" -l 2>&1'` with the configured shell as `$1`, making the configured program a login shell (`src/tools/shell/session.ts`).
- POSIX children are detached into a process group so reset and close can signal the group, including background descendants (`src/tools/shell/session.ts`).
- The initial working directory and environment come from constructor options. Configured path prefixes are exported only after login-shell startup, preventing login initialization from overwriting them (`src/tools/shell/session.ts`).
- There is no PTY. Each command evaluates with stdin from `/dev/null`; stdout and stderr feed the same parser (`src/tools/shell/session.ts`).

## Command Protocol

Commands are passed into a fixed-name wrapper function, stored in a function-local single-quoted variable, optionally preceded by a validated absolute `cwd` change, evaluated in the existing shell, and followed by a randomized record-separator completion marker containing a safe-integer exit code plus the resulting `$PWD`. The parser records that directory on every snapshot, allowing explicit `cwd` selection and command-issued `cd` changes to remain persistent and observable. The random token is kept out of evaluated function state, readonly wrapper variables cannot poison later calls, and the parser removes ready/completion markers from user-visible output (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`, `test/shell-session.test.ts`, `test/mcp-integration.test.ts`).

Marker-safe prefix flushing preserves UTF-16 surrogate pairs before applying the UTF-8 command-output ceiling, preventing multibyte output corruption at chunk boundaries (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).

The wrapper clears `errexit` before and after evaluation so a prior `set -e` does not poison later calls. An explicit `exit` or a command that terminates the shell still destroys state (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).

## Output, Polling, and Retries

- `TranscriptBuffer` uses absolute JavaScript-string cursors and drops whole surrogate pairs at the rolling boundary. A cursor older than retained output is clamped and returns `cursor_expired` (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).
- Response and per-command ceilings are UTF-8 byte limits. Per-command loss returns `output_truncated` and `dropped_output_bytes`; discarded bytes are unrecoverable (`src/index.ts`, `src/tools/shell/session.ts`).
- Run waits for completion, abort, timeout, cursor expiry, or a full response. Poll waits on a versioned update when a running command has no new output (`src/tools/shell/session.ts`).
- Request IDs are scoped to a shell. Exact command retries return the retained record; changed text returns `request_conflict`. Command and reset maps are bounded by `MCP_RECORD_LIMIT` (`src/tools/shell/session.ts`, `src/tools/shell/session-manager.ts`).

## Concurrency

Each named shell accepts one foreground command. Different shell IDs run independently. Direct `apply_patch` processes bypass shell locks, transcripts, and request records (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`, `test/mcp-integration.test.ts`).

## Reset and Recovery

Reset records the stop reason, sends `SIGTERM`, waits 500 ms, sends `SIGKILL`, finalizes if close never arrives, and starts a new generation. Unexpected shell termination is also finalized and queues an automatic restart (`src/tools/shell/session.ts`).

Process-group kill failures such as macOS `EPERM` are deliberately swallowed so cleanup cannot crash the MCP server. Cleanup is therefore best effort; descendants may survive when the OS denies signaling (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).
