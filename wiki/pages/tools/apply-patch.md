---
summary: "Vendored patch execution, partial application, conservative summaries, and native quirks."
paths:
  - src/tools/apply-patch/
  - src/child-process-termination.ts
  - vendor/apply-patch/
  - test/apply-patch-vendor.test.ts
  - test/integrations/apply-patch.ts
---

# apply_patch

[apply-patch.ts](../../../src/tools/apply-patch/apply-patch.ts) invokes `vendor/apply-patch/apply_patch` directly with absolute existing-directory `cwd` and patch text on stdin. No shell lock, request record, or polling. The wrapper sets line-ending preservation and bounds failure diagnostics; abort escalates process-group termination with bounded forced settlement.

Public schema describes the patch envelope, add/update/delete sections, move modifier, context anchors, and EOF anchor. See `npm run schemas -- apply_patch` and [native integration cases](../../../test/integrations/apply-patch.ts) rather than treating undocumented parser tolerance as syntax.

## Partial failure matters

Native sections execute in order and stop at first failure. Earlier successful sections remain applied; later sections are not attempted. A single update section is atomic across its hunks, but the whole patch is not atomic.

[patch-summary.ts](../../../src/tools/apply-patch/patch-summary.ts) maps submitted sections and native first-failure diagnostics to `changed`/`failed`. Counts come from patch lines, not a post-write diff. Recognized prior changes produce `status=partial`; unrecognized failure mapping claims no prior changes. Failed and partial results both set MCP `isError=true`.

Failure mapping prefers the longest matching patch path and infers hunk only when evidence supports it. `output_dropped` means diagnostic truncation, not rollback or unknown file state.

## Native boundaries

`cwd` is a resolution base, not confinement; native paths may be absolute. Add can overwrite existing files, and add/move can create parent directories. Rename with context-only update works. Consecutive `@@` anchors fail despite older copied prompt examples. Preserve tested behavior when replacing the vendored binary; provenance/build owner is `vendor/apply-patch/provenance.json` and `scripts/vendor/build-apply-patch.sh`.

Tests: [vendor execution](../../../test/apply-patch-vendor.test.ts), [summary inference](../../../test/patch-summary.test.ts), and MCP integration. [Audit Logging](../operations/audit-logging.md) owns successful versus failed-patch retention.
