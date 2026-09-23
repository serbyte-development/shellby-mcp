---
summary: "Operational event ownership, local rotation, correlation, and logging failure behavior."
paths:
  - src/public-config.cts
  - src/logging.ts
  - src/time.ts
  - src/index.ts
  - src/server/http-server.ts
  - src/mcp/tool-registration-boundary.ts
  - src/tools/shell/session.ts
  - src/tools/shell/shell-process.ts
  - src/tools/shell/parallel-session.ts
  - src/tools/shell/session-manager.ts
  - src/tools/delegation/lifecycle.ts
  - src/tools/delegation/chatgpt-service.ts
  - src/tools/delegation/store.ts
  - src/tools/computer/cursor-host.ts
  - scripts/runtime-logs.ts
---

# Runtime Logging

[logging.ts](../../../src/logging.ts) owns Pino configuration, rotating local files, bounded Error serialization, async context, and stderr fallback. When enabled, [index.ts](../../../src/index.ts) starts one writer before runtime services, flushes after shutdown, and observes fatal exceptions without changing Node's exit behavior. Imports alone perform no file I/O.

`logging.enabled` in `.shellby/config.toml` defaults to `false`. Set `enabled = true` under `[logging]` and restart to activate runtime logging. Disabled logging opens no destination and installs no fatal-exception listener. The separate audit record keeps its existing behavior. The public schema also supplies this disabled default to newly generated configs.

Run `npm run logs:runtime` to follow the current file under configured `stateDir/logs/`. Rotations retain matching files across process restarts; source owns size/count policy. File size can exceed its rotation threshold by a write. Files use owner-only permissions. Writes are asynchronous and best effort; orderly close flushes pending records. Sudden termination can lose buffered records. A file failure switches subsequent events to stderr; buffer overflow reports dropped records. PM2 captures fallback output.

## Event ownership

[time.ts](../../../src/time.ts) owns the shared Pacific timestamp format for runtime `time`, review `created_at`, and audit headings: `Sep 23 12:05 PM`. It formats `America/Los_Angeles` directly, including daylight-saving changes, independently of the host timezone. New records use this format; existing records remain unchanged.

HTTP logs request start and transport completion/disconnect, including requests rejected by parsing or authentication. Shared tool registrar logs execution start, returned failures, duration, and original thrown errors. Caller initialization rejection has its own event. Request and tool-call IDs correlate concurrent activity; agent/task labels derive from existing context.

Shell owners log command and parallel-run completion, exit status, hibernation, and cleanup failures. Delegation lifecycle logs submitted, recovering, completed, and failed turns with explicit parent/agent/turn identity. Persistence and native cursor process owners report their failures. Startup and shutdown report service outcomes.

Tool completion describes execution inside the registrar. SDK input/output validation can reject a call outside that boundary; HTTP 200 alone establishes transport completion. This implementation does not intercept protocol response bodies.

Events retain selected identifiers, statuses, timings, bounded tool error text, and Error stacks/causes. Raw arguments, prompts, command output, and binary payloads are omitted. Error text can contain private data. [Audit Logging](./audit-logging.md) owns the separate human tool-usage record.

[Logging tests](../../../test/logging.test.ts) cover concurrent identity, serialization, restart append, file permissions, flush, unavailable-directory fallback, and correlation through an HTTP request whose tool throws.

