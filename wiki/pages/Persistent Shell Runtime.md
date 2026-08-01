# Persistent Shell Runtime

Verified 2026-07-19.

## What This Is

`PersistentShellSession` owns one non-PTY login shell and preserves its process state across MCP calls (`src/shell-session.ts`).

## Process Model

- The runtime spawns `/bin/sh -c 'exec "$1" -l 2>&1'` with the configured shell as `$1`, making the configured program a login shell (`src/shell-session.ts`).
- POSIX children are detached into a process group so reset and close can signal the group, including background descendants (`src/shell-session.ts`).
- The initial working directory and environment come from constructor options. Configured path prefixes are exported only after login-shell startup, preventing login initialization from overwriting them (`src/shell-session.ts`).
- There is no PTY. Each command evaluates with stdin from `/dev/null`; stdout and stderr feed the same parser (`src/shell-session.ts`).

## Command Protocol

Commands are passed into a fixed-name wrapper function, stored in a function-local single-quoted variable, evaluated in the existing shell, and followed by a randomized record-separator completion marker containing a safe-integer exit code. The random token is kept out of evaluated function state, readonly wrapper variables cannot poison later calls, and the parser removes ready/completion markers from user-visible output (`src/shell-session.ts`, `test/shell-session.test.ts`).

Marker-safe prefix flushing preserves UTF-16 surrogate pairs before applying the UTF-8 command-output ceiling, preventing multibyte output corruption at chunk boundaries (`src/shell-session.ts`, `test/shell-session.test.ts`).

The wrapper clears `errexit` before and after evaluation so a prior `set -e` does not poison later calls. An explicit `exit` or a command that terminates the shell still destroys state (`src/shell-session.ts`, `test/shell-session.test.ts`).

## Reset and Recovery

Reset records the stop reason, sends `SIGTERM`, waits 500 ms, sends `SIGKILL`, finalizes if close never arrives, and starts a new generation. Unexpected shell termination is also finalized and queues an automatic restart (`src/shell-session.ts`).

Process-group kill failures such as macOS `EPERM` are deliberately swallowed so cleanup cannot crash the MCP server. Cleanup is therefore best effort; descendants may survive when the OS denies signaling (`src/shell-session.ts`, `test/shell-session.test.ts`).

## Related

- [[pages/Architecture Map]]
- [[pages/Transcript Polling and Idempotency]]
- [[pages/Open Questions and Risks]]
