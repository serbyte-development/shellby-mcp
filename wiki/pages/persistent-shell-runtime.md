---
summary: "Shell process protocol, arbitration, transcript cursors, hibernation, and cleanup ownership."
paths:
  - src/tools/shell/
  - src/child-process-termination.ts
  - src/tokenizer.ts
---

# Persistent Shell Runtime

Caller semantics: [shell_run / shell_poll](./tools/shell-run.md). Source ownership:

| Owner | Responsibility |
| --- | --- |
| [session-manager.ts](../../src/tools/shell/session-manager.ts) | Named live/cache state, lifecycle lock, leases, idle/LRU eviction |
| [session.ts](../../src/tools/shell/session.ts) | Foreground arbitration, single-command records, retry identity, snapshots/waits |
| [shell-process.ts](../../src/tools/shell/shell-process.ts) | Child shell, protocol parsing, cwd/env capture, generation/reset |
| [parallel-session.ts](../../src/tools/shell/parallel-session.ts) | Batch records, grouped output, retries, settlement/cancellation |
| [parallel-runner.ts](../../src/tools/shell/parallel-runner.ts) | Per-shell scheduling, isolated child execution, output caps, timeouts |
| [transcript.ts](../../src/tools/shell/transcript.ts) | Rolling retained text and absolute JavaScript-string cursors |

## Process and output invariants

Shells are noninteractive, have no PTY, and use `-f` startup. Do not assume Terminal aliases or login-script PATH changes. A randomized completion marker carries status and cwd after evaluation; protocol stdin is isolated from command input. Wrapper clears `errexit` around evaluation. Explicit `exit` still loses shell state.

Parser streams ordinary output while withholding only a possible marker suffix. UTF-8 decoding and surrogate boundaries must survive chunk splits. Transcript cursors remain absolute as old text is discarded; backing storage compacts in batches. [tokenizer.ts](../../src/tokenizer.ts) tokenizes bounded local windows for pagination rather than rescanning whole transcripts. Capture is byte-bounded; response pages are token-bounded.

Wait loops follow execution state, not page fullness. Preserve this separation when changing streaming; otherwise short commands return misleading `running` snapshots merely because output filled a page.

[rtk.ts](../../src/tools/shell/rtk.ts) rewrites only at execution. Original input remains retry/audit/preview identity. Rewritten evaluation temporarily sets RTK's PATH and disables separate tee, telemetry, and history persistence; unsupported/failed rewrites run original text. Both single and parallel execution use this boundary.

## Lifecycle and cleanup

Manager leases protect shells while callers use them. Eviction excludes busy/leased shells and `default`; it fails admission when no safe slot exists. Capture failure leaves the live shell intact. Hibernation caches only cwd/exported env, then closes the process. Missing cached cwd falls back to a clean baseline. Cache age is measured from last use and expires in the shared sweep.

Reset/close signal detached POSIX process groups through [child-process-termination.ts](../../src/child-process-termination.ts). TERM-to-KILL escalation is shared; generation, forced settlement, and recovery remain with each owner. Signaling is best effort; OS-denied cleanup must not crash MCP, but descendants may survive.

Tests: [session](../../test/shell-session.test.ts), [manager](../../test/shell-session-manager.test.ts), [parallel](../../test/shell-parallel.test.ts), [RTK](../../test/rtk.test.ts). Direct `apply_patch` execution bypasses shell locks and records.
