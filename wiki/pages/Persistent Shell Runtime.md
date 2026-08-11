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
- Response and per-command ceilings are UTF-8 byte limits. Per-command loss returns `output_truncated` and `dropped_output_bytes`; discarded bytes are unrecoverable (`src/index.ts`, `src/tools/shell/session.ts`).
- Run waits for completion, abort, timeout, cursor expiry, or a full response. Poll waits on a versioned update when a running command has no new output (`src/tools/shell/session.ts`).
- Request IDs are scoped to a shell. Exact command retries return the retained record; changed text returns `request_conflict`. Command and reset maps are bounded by `MCP_RECORD_LIMIT` (`src/tools/shell/session.ts`, `src/tools/shell/session-manager.ts`).

## Concurrency

Each named shell accepts one foreground command. Different shell IDs run independently. Direct `apply_patch` processes bypass shell locks, transcripts, and request records (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`, `test/mcp-integration.test.ts`).

### Proposed parallel command envelope

`shell_run` could support multiple independent commands in one intuitive free-form payload without adding an array schema. Normal single-command input would remain unchanged. Parallel mode would use an `apply_patch`-style envelope:

```text
*** Begin Commands
*** Command
npm run lint
*** Command
npm run type-check
*** Command
npm test
*** End Commands
```

The envelope would mean "run these command blocks independently and concurrently," not "concatenate them into one shell program." The MCP process would parse the blocks and spawn separate short-lived child processes so each command retains its own stdout/stderr, exit code, output ceiling, cancellation state, and result. Shell-level backgrounding such as `command & ...; wait` is deliberately not the implementation because it collapses those commands back into one opaque shell execution.

Proposed execution rules:

- Keep the feature entirely inside the existing `shell_run` / `shell_poll` contract. Do not add a `shell_parallel` tool and do not assign child shell IDs. One batch remains one outer `(shell_id, request_id)` operation.
- Snapshot the selected persistent shell's current cwd and exported environment once when the batch starts. Every child begins from that same snapshot; state changes inside a child do not mutate the persistent shell or sibling commands.
- Treat the parent `shell_run` as occupying that named shell until the batch finishes, preserving the existing one-foreground-operation-per-shell mental model.
- Allow the caller to submit any reasonable number of command blocks in one tool call, but run at most **4 child processes concurrently**. Additional blocks queue inside that request and start as slots become available.
- Prefer a process-wide four-child semaphore rather than four children per request so multiple agents cannot multiply the intended concurrency ceiling.
- Preserve submission order in the returned grouped results even if commands finish in a different order. Each child keeps an independent bounded output buffer so concurrent output is never interleaved into one transcript.
- `shell_run` and later `shell_poll` calls return the state of the same outer request, with per-child states such as queued, running, completed, or timed out. Completed child results remain available while siblings continue running.
- A nonzero child exit is a normal command result, not an MCP/tool failure, and does not cancel unrelated siblings. The outer response should expose the child's exit code while allowing the batch to continue.
- Give parallel children a generous hard runtime ceiling (proposed: **10 minutes per child**) so four hung commands cannot permanently occupy the process-wide semaphore. A timed-out child is killed, marked timed out, and frees its slot for queued work. This limit would apply only to parallel children, not ordinary persistent-shell commands.
- Aborting or resetting the parent operation kills all still-running children and discards queued blocks. Already-completed child results should remain in the retained request record for later inspection.
- These workers are short-lived child processes, not named persistent shells, and therefore should not consume `ShellSessionManager` shell slots.
- Keep this deliberately below workflow-engine complexity: no DAGs, dependencies, per-command IDs, retries, or nested orchestration syntax.

The likely implementation boundary is a small parallel runner owned by the shell capability: parse the command envelope, obtain a cwd/environment snapshot from the current `PersistentShellSession`, launch up to four independent shell children through Node process APIs, retain one result record per command, and adapt the existing `shell_run` / `shell_poll` response path to grouped batch results. The exact snapshot mechanism, child process invocation, timeout cleanup, and interaction with the existing command transcript/record model should be validated before implementation (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`, `src/tools/shell/session-manager.ts`).

## Reset and Recovery

Reset records the stop reason, sends `SIGTERM`, waits 500 ms, sends `SIGKILL`, finalizes if close never arrives, and starts a new generation. Unexpected shell termination is also finalized and queues an automatic restart (`src/tools/shell/session.ts`).

Process-group kill failures such as macOS `EPERM` are deliberately swallowed so cleanup cannot crash the MCP server. Cleanup is therefore best effort; descendants may survive when the OS denies signaling (`src/tools/shell/session.ts`, `test/shell-session.test.ts`).
