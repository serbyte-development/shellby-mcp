---
summary: "Mandatory context: purpose, authority, state ownership, and engineering approach."
---

# Project Overview

Shellby MCP connects ChatGPT Web to a local macOS user's machine for sustained engineering work. One backend process owns persistent shells, browser delegation, and local tool services; HTTP requests use short-lived MCP server instances. Optional human dashboard has its own [UI wiki](../../ui/wiki/AGENTS.md).

Tools inherit the macOS user's filesystem, network, desktop, and authenticated browser authority. Workspace is an initial location, not a sandbox. Deployment assumes one remote owner; caller session identity scopes coordination, not authorization.

Engineering approach, from the project's coding principles:

- Minimize caller knowledge, change amplification, and hidden dependencies. Put each rule or representation behind one clear owner.
- Prefer small contracts over extra layers, options, or duplicated state. Favor functional TypeScript when clearer; keep cohesive code together.
- Establish invariants at boundaries. Make successful returns, failures, cleanup, and retry behavior explicit.
- Let tool names and schemas carry obvious meaning; descriptions add selection and usage semantics.
- Test observable behavior without reshaping production architecture solely for test injection. Keep consequential decisions changeable and unrelated structure untouched.

Use [index.md](../index.md) to route; open [Architecture Map](./architecture-map.md) when a task crosses subsystem boundaries.
