---
summary: "Local binary transfer, ChatGPT file inputs, image encoding, and output/audit boundaries."
paths:
  - src/tools/file/file-tools.ts
  - src/tools/image/
  - src/mcp/tool-schema-presentation.ts
---

# Files and Images

[file-tools.ts](../../../src/tools/file/file-tools.ts) owns `file_read` and `file_write`; [image-tools.ts](../../../src/tools/image/image-tools.ts) owns `image_view`. Relative paths resolve from configured workspace, never from a named shell's current cwd. Absolute paths are accepted.

`file_read` embeds raw bytes as an MCP resource blob with a local file URI and generic binary MIME type. `file_write` advertises `openai/fileParams`, downloads the supplied file URL, then writes destination bytes. It overwrites existing files, does not create parent directories, and uses a direct write rather than atomic replacement. Both buffer entire files and currently impose no tool-specific byte cap. Request cancellation is passed to I/O; a failed/cancelled write is not a rollback guarantee.

These are binary-transfer contracts. They do not establish that every ChatGPT client exposes transferred files in a particular user interface or Python environment. Validate that separately when changing the integration.

## Shared image geometry

[image-encoding.ts](../../../src/tools/image/image-encoding.ts) serves local images, fetched images, and Computer Use captures. It lowers JPEG quality to fit a response budget without resizing or applying orientation transforms. If that fails, it returns an error. Preserve this invariant: [Computer Use](../computer-use.md) depends on capture coordinates matching returned pixels.

[Registration Boundary](../mcp-tool-registration-boundary.md) preserves native file/image content in both output modes. [Audit Logging](../operations/audit-logging.md) excludes binary blobs from persisted output/token counts and excludes file download URLs from input retention.

Tests: [file-transfer integration](../../../test/integrations/file-transfer.ts), [image encoding/geometry](../../../test/image-encoding.test.ts), and [MCP image cases](../../../test/integrations/image.ts).
