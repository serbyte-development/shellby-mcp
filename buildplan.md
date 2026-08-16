# Build Plan

## Goal

Make named shell IDs behave like lightweight persistent sessions while keeping at most 16 live shell processes. Idle or capacity-evicted shells should retain only their working directory and exported environment, then transparently recreate from that cached state when reused.

## Build

- [x] Add cached shell state and transparent restoration for previously live shell IDs.
- [x] Manage live shells as an LRU working set: reclaim non-busy shells under capacity pressure and never automatically evict busy shells.
- [x] Reduce normal live-shell idle cleanup to 5 minutes while retaining cached logical shell state for 24 hours since last use.
- [x] Keep explicit shell closure destructive while preserving predictable reset, polling, and all-busy capacity behavior.
- [x] Keep cache cleanup lightweight without per-shell expiration timers.
- [x] Update the public shell lifecycle descriptions and configuration defaults to match the new behavior.
- [x] Add focused lifecycle and integration coverage for eviction, restoration, expiration, active-shell protection, and failure behavior.
- [x] Validate the completed shell workflow and update this plan to reflect the final implementation state.

## Assumptions

- Cached state contains only the current working directory and exported environment; running/background processes, command records, transcript state, shell functions, aliases, and other process-local state are intentionally not restored.
- The existing `default` shell remains protected from explicit close and automatic eviction unless implementation constraints require a clearly justified adjustment.

## Validation

- `npm test` - 191/191 passing.
- `npm run type-check` - passing.
- `npm run lint` - passing.
- `npm run build` - passing.
- `git diff --check` - passing.
