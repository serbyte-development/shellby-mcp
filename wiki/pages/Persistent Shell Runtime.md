# Persistent Shell Runtime

Verified 2026-08-11.

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
- Response and per-command ceilings are UTF-8 byte limits. `output_truncated` means only the current response hit its read limit; the omitted retained output is recoverable through `next_cursor`. Permanent per-command capture loss is reported separately as `output_dropped` plus `dropped_output_bytes` (`src/index.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`).
- Run waits for completion, abort, timeout, cursor expiry, or a full response. Poll waits on a versioned update when a running command has no new output (`src/tools/shell/session.ts`).
- Request IDs are scoped to a shell. Exact command retries return the retained record; changed text returns `request_conflict`. Command and reset maps are bounded by `MCP_RECORD_LIMIT` (`src/tools/shell/session.ts`, `src/tools/shell/session-manager.ts`).

## Concurrency

Each named shell accepts one foreground command. Different shell IDs run independently. Direct `apply_patch` processes bypass shell locks, transcripts, and request records (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`, `test/mcp-integration.test.ts`).

### Parallel command envelope

`shell_run` supports multiple independent commands in one free-form payload without an array schema. Normal single-command input is unchanged. Parallel mode uses repeated directory-qualified run markers:

```text
*** Run: .
npm run lint
*** Run: ./
npm run type-check
*** Run: ./packages/api
npm test
*** Run: ../../shared
npm run check
*** Run: /tmp
pwd
```

Starting the command with `*** Run: <directory-or-relative-path>` means "run these command blocks independently and concurrently," not "concatenate them into one shell program." Every run declares its working directory. Relative values resolve from the batch `cwd` anchor, including `.`, `./`, `../`, and `../../`; absolute values such as `/tmp` are used directly. Lines beginning with `*** Run` are reserved as batch directives and malformed forms reject the whole batch instead of becoming shell text. Shell-level backgrounding such as `command & ...; wait` is deliberately not the implementation because it collapses the work back into one opaque shell execution (`src/tools/shell/parallel-runner.ts`).

Execution rules:

- Keep the feature entirely inside the existing `shell_run` / `shell_poll` contract. Do not add a `shell_parallel` tool and do not assign child shell IDs. One batch remains one outer `(shell_id, request_id)` operation.
- Capture the selected persistent shell's current exported environment once when the batch starts. An explicit call-level `cwd` first becomes the persistent shell's selected directory and the batch root; otherwise the current directory is the root. Every child inherits that environment snapshot, while state changes inside a child do not mutate the persistent shell or siblings.
- Require a directory on every `*** Run:` marker. Resolve relative paths from the batch `cwd` using normal path semantics, including `.`, `./`, `../`, and `../../`; pass absolute paths directly as the child process `cwd`. The batch `cwd` is an anchor, not a sandbox. The directory is execution metadata, not shell text, so callers do not need repeated `cd ... &&` prefixes.
- Treat the parent `shell_run` as occupying that named shell until the batch finishes, preserving the existing one-foreground-operation-per-shell mental model.
- Submit any number of sections in one tool call, but run at most **4 child processes concurrently process-wide**. Additional sections queue inside their owning request and start as slots become available.
- Keep one bounded output buffer per child. When a child becomes terminal, append one labeled output block to the batch transcript. The `commands` result array remains in submission order even if output blocks arrive in completion order, avoiding interleaved child streams while preserving normal cursor pagination.
- `shell_run` and `shell_poll` expose child states `queued`, `running`, `completed`, `timed_out`, `failed`, or `reset`. A nonzero child exit is a normal `completed` result and does not cancel siblings.
- Parallel children have a **10-minute hard runtime ceiling**. A timed-out child receives `SIGTERM`, then `SIGKILL` after the same 500 ms grace used elsewhere, and its global slot is released. Ordinary persistent-shell commands still have no hard runtime ceiling.
- `shell_reset` marks queued/running batch children reset, aborts queued scheduler entries, terminates running child process groups, and preserves already-completed output/results in the retained batch record.
- These workers are short-lived child processes, not named persistent shells, and therefore should not consume `ShellSessionManager` shell slots.
- Keep this deliberately below workflow-engine complexity: no DAGs, dependencies, per-command IDs, retries, or nested orchestration syntax.

`src/tools/shell/parallel-runner.ts` owns the batch parser, process-wide scheduler, bounded child execution, timeout, and process-group cleanup. `PersistentShellSession` owns the outer request record, environment capture through the existing persistent shell, relative-directory resolution, polling, retained grouped output, and reset integration (`src/tools/shell/parallel-runner.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`).

## Reset and Recovery

Reset records the stop reason, sends `SIGTERM`, waits 500 ms, sends `SIGKILL`, finalizes if close never arrives, and starts a new generation. Unexpected shell termination is also finalized and queues an automatic restart (`src/tools/shell/session.ts`).

Process-group kill failures such as macOS `EPERM` are deliberately swallowed so cleanup cannot crash the MCP server. Cleanup is therefore best effort; descendants may survive when the OS denies signaling (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).
