# iOS Shell

Verified 2026-08-23.

## What This Is

`shell_iOS` was an experimental iPhone command bridge built on stock a-Shell. Its disabled production implementation, configuration, and tests were removed on 2026-08-23. This page preserves the prototype design and findings; no iOS tool is available in the current MCP.

## Former Architecture

```text
ChatGPT
  → shell_iOS MCP tool
  → Mac
  → LAN
  → a-Shell bridge on iPhone
  → a-Shell command runtime
```

The prototype used a shared iCloud workspace named `chatgpt-workspace-ios`; a-Shell bookmarked it as `~mcp`. The bridge script was named `ios-bridge.py`. Its authentication token was stored separately in `bridge-token.txt` and must never be committed or copied into the wiki.

The bridge listened on TCP port `8765`, accepted an authenticated JSON command, and returned `stdout`, `stderr`, and `exit_code`. The removed host client used `MCP_IOS_HOST` and `MCP_IOS_TOKEN_FILE`, with a fixed five-second timeout.

## Historical Startup

From a-Shell:

```sh
cd ~mcp && python3 ios-bridge.py | sh
```

Python owned the authenticated socket server. Commands were emitted to the piped a-Shell `sh` process because launching normal shell subprocesses from Python was unreliable under iOS/a-Shell constraints.

## Prototype Transport

The prototype used macOS `/usr/bin/nc` for the LAN connection rather than Node's `node:net` socket API. During testing, `/usr/bin/nc` could reach the iPhone while direct Node and Python sockets on the Mac returned `EHOSTUNREACH`/`No route to host` for the same address and port.

## Observed Behavior

- Mac → iPhone TCP command execution worked.
- The first-class `shell_iOS` MCP tool worked end to end and repeated calls succeeded without restarting the bridge.
- `pwd` returned the iCloud `chatgpt-workspace-ios` directory from the iPhone.
- The prototype was intended for foreground-only use; background execution was not reliable.

## Findings

- a-Shell's real dispatcher is `ios_system`; its Shortcuts `Execute Command` action uses that path.
- a-Shell registers iOS-aware commands including `openurl`, `call`, and `text`.
- Basic shell commands work through the bridge, but UI/app-switching commands such as `openurl` can stall the wrapper and need a different handoff design.
- Direct Python `ios_system` calls and nested `jsc.system()` experiments were not reliable enough to keep.

Former tool contract:

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

If iPhone execution becomes a concrete product requirement, revisit the execution/handoff model from current constraints instead of restoring the removed code unchanged. Shortcuts remain the likely path for higher-level iOS capabilities such as Messages. Fork a-Shell only when stock a-Shell reaches a concrete limitation.

## Related

- [ROADMAP](./ROADMAP.md)
