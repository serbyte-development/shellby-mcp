---
summary: "Browser acquisition versus document retention, MIME conversion, cursor identity, and fetch errors."
paths:
  - src/tools/web/
  - src/tools/image/image-encoding.ts
  - src/tokenizer.ts
---

# fetch_url

[web-tool.ts](../../../src/tools/web/web-tool.ts) owns MCP schema and domain-error translation; the [registration boundary](../mcp-tool-registration-boundary.md) owns failure rendering. [web-acquisition.ts](../../../src/tools/web/web-acquisition.ts) owns browser/CDP acquisition, conversion, and cleanup. [web-open.ts](../../../src/tools/web/web-open.ts) owns retained documents and cursor paging. One opener is shared across short-lived MCP servers.

HTML uses a separate headless CloakBrowser render, not authenticated delegation Chrome. Non-HTML interception consumes the original Chromium response once, preserving cookies/redirects rather than refetching through another client. PDFs extract text with page headings; images use the [shared encoder](./files-and-images.md); common text media decode without reparsing values. Unsupported binary types fail explicitly. Empty/bodyless responses retain HTTP metadata.

## Retention and errors

Cursor continuation reads retained text without reopening the browser. It requires the same requested or final redirected URL, format, and compact setting. Cache is process-local, count/TTL/byte-bounded; restart/eviction loses cursors. `next_cursor` means retained continuation; `dropped_source_bytes` means permanent source truncation. Token paging reads a bounded local window and may return less than the requested ceiling.

Raw non-HTML download limits and retained extracted-text limits are separate. PDF page limits apply before extraction, but extraction completes before retained-document truncation. Concurrent rendering/parsing can exceed cache memory limits transiently. Exact ceilings belong to [config.ts](../../../src/config.ts) and the acquisition owner.

Handled failures use the shared `ToolError` path. Compact output carries one `CODE: message` text and `isError`; structured mode also retains `error_code`. Text uses the same public code as structured output. URL/cursor failures map to `INVALID_ARGUMENT`; connection refusal remains distinct from other open failures. The [audit entry](../operations/audit-logging.md) retains original cause code/message. HTTP 404/500 remains response metadata. No automatic retries.

Host network authority includes private/local services. Treat fetched text as untrusted data. Tests: [retention/cursors](../../../test/web-fetch.test.ts) and [MCP acquisition cases](../../../test/integrations/web.ts). A passing mocked retention test does not prove live browser/network compatibility.
