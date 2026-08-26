# iOS Shell

Verified 2026-08-12.

## What This Is

`shell_iOS` is an experimental iPhone command bridge built on stock a-Shell. The implementation remains in-tree, but MCP registration is currently commented out while the feature is deferred (`src/tools/ios/ios-shell.ts`, `src/server/mcp-server.ts`).

## Architecture

```text
ChatGPT
  → shell_iOS MCP tool
  → Mac
  → LAN
  → a-Shell bridge on iPhone
  → a-Shell command runtime
```

The shared iCloud workspace is `chatgpt-workspace-ios`; a-Shell bookmarks it as `~mcp`. The bridge script lives there as `ios-bridge.py`. The authentication token is stored separately in `bridge-token.txt` and must never be committed or copied into the wiki.

The bridge listens on TCP port `8765`, accepts an authenticated JSON command, and returns `stdout`, `stderr`, and `exit_code`. Host and token-file location come from `MCP_IOS_HOST` and `MCP_IOS_TOKEN_FILE`; port `8765` and the five-second timeout are fixed in `MCP_CONFIG`. These values remain absent from the public tool schema (`src/config.ts`, `src/tools/ios/ios-shell.ts`).

## Starting the Bridge

From a-Shell:

```sh
cd ~mcp && python3 ios-bridge.py | sh
```

Python owns the authenticated socket server. Commands are emitted to the piped a-Shell `sh` process because launching normal shell subprocesses from Python is unreliable under iOS/a-Shell constraints.

## Mac Transport

The MCP uses macOS `/usr/bin/nc` for the LAN connection rather than Node's `node:net` socket API (`src/tools/ios/ios-shell.ts`). During testing, `/usr/bin/nc` could reach the iPhone while direct Node and Python sockets on the Mac returned `EHOSTUNREACH`/`No route to host` for the same address and port.

## Proven Behavior

- Mac → iPhone TCP command execution works.
- The first-class `shell_iOS` MCP tool works end to end and repeated calls succeed without restarting the bridge.
- `pwd` returned the iCloud `chatgpt-workspace-ios` directory from the iPhone.
- Intended behavior is foreground-only for now; do not rely on background execution.

## Findings

- a-Shell's real dispatcher is `ios_system`; its Shortcuts `Execute Command` action uses that path.
- a-Shell registers iOS-aware commands including `openurl`, `call`, and `text`.
- Basic shell commands work through the bridge, but UI/app-switching commands such as `openurl` can stall the wrapper and need a different handoff design.
- Direct Python `ios_system` calls and nested `jsc.system()` experiments were not reliable enough to keep.

Current tool contract:

```json
{ "command": "pwd" }
```

Result:

```json
{
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0
}
```

## Next

Revisit the execution/handoff model before re-enabling the MCP tool. Shortcuts remain the likely path for higher-level iOS capabilities such as Messages. Fork a-Shell only when stock a-Shell reaches a concrete limitation.

## Related

- [Roadmap](./roadmap.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Architecture Map](./architecture-map.md)
- [Open Questions and Risks](./open-questions-and-risks.md)
