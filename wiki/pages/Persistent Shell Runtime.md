# Persistent Shell Runtime

Verified 2026-08-18.

## What This Is

Implementation notes for the stateful named-shell runtime behind `shell_run` and `shell_poll`. Caller-facing behavior and syntax live in [shell_run](./tools/shell_run.md).

## Process Model

- The runtime spawns `/bin/sh -c 'exec "$1" -l 2>&1'` with the configured shell as `$1`, making the configured program a login shell (`src/tools/shell/session.ts`).
- POSIX children are detached into a process group so reset and close can signal the group, including background descendants (`src/tools/shell/session.ts`).
- The initial working directory and environment come from constructor options. Configured path prefixes are exported only after login-shell startup, preventing login initialization from overwriting them (`src/tools/shell/session.ts`).
- There is no PTY. Each command evaluates with stdin from `/dev/null`; stdout and stderr feed the same parser (`src/tools/shell/session.ts`).

## Command Protocol

Commands are passed into a fixed-name wrapper function, stored in a function-local single-quoted variable, optionally preceded by a validated absolute `cwd` change, evaluated in the existing shell, and followed by a randomized record-separator completion marker containing a safe-integer exit code plus the resulting `$PWD`. The parser records that directory on every snapshot, allowing explicit `cwd` selection and command-issued `cd` changes to remain persistent and observable. The random token is kept out of evaluated function state, readonly wrapper variables cannot poison later calls, and the parser removes ready/completion markers from user-visible output (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`, `test/shell-session.test.ts`, `test/mcp-integration.test.ts`).

Marker-safe prefix flushing preserves UTF-16 surrogate pairs before applying the UTF-8 command-output ceiling, preventing multibyte output corruption at chunk boundaries (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).

The wrapper clears `errexit` before and after evaluation so a prior `set -e` does not poison later calls. An explicit `exit` or a command that terminates the shell still destroys state (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).

## Output Storage and Request Records

- `TranscriptBuffer` uses absolute JavaScript-string cursors, advances a logical retained-output head as the rolling window fills, and compacts discarded backing text in batches instead of slicing the full retained string on every append. It drops whole surrogate pairs at the rolling boundary. A cursor older than retained output is clamped and returns `cursor_expired` (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).
- Response ceilings use `o200k_base` token counts. Transcript reads tokenize only a bounded local character window instead of the entire remaining transcript, so polling large retained output does not repeatedly rescan megabytes. Per-command capture remains byte-based because it protects retained memory (`src/tokenizer.ts`, `src/index.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`). See [shell_run](./tools/shell_run.md) for caller-visible pagination/loss semantics.
- Run waits for completion, abort, timeout, cursor expiry, or a full response. Poll waits on a versioned update when a running command has no new output; completed polls skip that preliminary transcript read and render the result once (`src/tools/shell/session.ts`).
- Request IDs are scoped to a shell. Exact command retries return the retained record; changed text returns `request_conflict`. Command and reset maps are bounded by the config-only `MCP_CONFIG.shell.recordLimit` (`src/config.ts`, `src/tools/shell/session.ts`, `src/tools/shell/session-manager.ts`).

## Concurrency

Each named shell accepts one foreground command. Different shell IDs run independently. Direct `apply_patch` processes bypass shell locks, transcripts, and request records (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`, `test/mcp-integration.test.ts`).

## Live Shells, Hibernation, and Restoration

Named live shells form an LRU working set. When a live slot is needed, the least-recently-used non-busy named shell may be hibernated; busy shells and `default` are protected. If no eligible slot exists, creation fails instead of killing active work (`src/tools/shell/session-manager.ts`). Configuration values are canonical in [Configuration and Startup](./Configuration%20and%20Startup.md).

Idle hibernation captures only current cwd and exported environment, closes the live shell/process group, and drops command records, transcript state, functions, aliases, and running/background processes. Reusing a still-cached `shell_id` transparently creates a fresh shell restored from cached cwd/environment. Cache expiry uses the manager's shared lifecycle sweep (`src/tools/shell/session-manager.ts`, `src/tools/shell/session.ts`). Caller-visible consequences are canonical in [`shell_run` / `shell_poll`](./tools/shell_run.md).

Cached state is process-local and disappears on MCP restart. If a cached cwd no longer exists when restoration is attempted, that cached state is discarded and the shell starts from its configured baseline instead of entering a failed restart loop (`src/tools/shell/session.ts`, `test/shell-session-manager.test.ts`).

`shell_close` is intentionally destructive: it terminates a non-default live shell, removes any cached state for that ID, and frees its live slot. Automatic idle/LRU hibernation is the only path that preserves cwd/exported environment. `shell_poll` cannot continue old command records after hibernation or close because those records belong to the destroyed live process. `shell_reset` deliberately discards any live or cached recoverable state and starts clean. The `default` shell remains live and protected from explicit close and automatic eviction (`src/tools/shell/session-manager.ts`, `src/tools/shell/shell-tools.ts`).

### Batch Runtime

Caller syntax and result semantics: [shell_run](./tools/shell_run.md).

Internally, one batch remains one outer `(shell_id, request_id)` record. `parallel-runner.ts` owns parsing, bounded scheduling/output, child timeout, and process-group cleanup. `PersistentShellSession` captures cwd/exported environment, resolves child directories, owns grouped retained output/polling, and integrates reset. Children are short-lived processes, do not consume named-shell slots, do not mutate persistent/sibling state, and do not cancel siblings on nonzero exit (`src/tools/shell/parallel-runner.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`). Exact caller limits are in [`shell_run` / `shell_poll`](./tools/shell_run.md).

## Reset and Recovery

Reset records the stop reason, sends `SIGTERM`, waits 500 ms, sends `SIGKILL`, finalizes if close never arrives, and starts a new generation. Unexpected shell termination is also finalized and queues an automatic restart (`src/tools/shell/session.ts`).

Process-group kill failures such as macOS `EPERM` are deliberately swallowed so cleanup cannot crash the MCP server. Cleanup is therefore best effort; descendants may survive when the OS denies signaling (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).

## Related

- [shell_run](./tools/shell_run.md)
- [MCP Tool Surface](./MCP%20Tool%20Surface.md)
- [Architecture Map](./Architecture%20Map.md)
- [Workspace Tooling](./Workspace%20Tooling.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
