---
summary: "Mandatory context: purpose, authority, state ownership, and engineering approach."
---

# Project Overview

Shellby MCP connects ChatGPT Web to the owner's macOS machine. One backend process owns persistent shells, browser subagents and local capability services; HTTP requests use short-lived MCP server instances. Capability state must outlive those requests.

Tools run with the local user's filesystem, network, desktop and authenticated-browser authority. Workspace is an initial location, not a sandbox. Deployment assumes one remote owner; caller session identity scopes coordination, not authorization.

Engineering approach: one owner per rule/state, small contracts over forwarding layers, explicit failure/cleanup semantics. Keep adapters thin; test public behavior without exposing private state for tests. Let tool schemas carry argument details.

Use [index.md](../index.md) to route; [Architecture Map](./architecture-map.md) covers cross-system ownership. The optional dashboard has a separate build and [UI wiki](../../ui/wiki/AGENTS.md).
