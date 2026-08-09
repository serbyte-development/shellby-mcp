# ChatGPT Local Shell MCP Wiki

This wiki is the concise source of truth for maintaining the server; start with [[pages/Architecture Map]], then open only the page relevant to the code you are changing.

## Pages

- [[pages/Architecture Map]] — system layers and request lifecycle.
- [[pages/HTTP Transport]] — Express, Streamable HTTP, host validation, and connection lifecycle.
- [[pages/MCP Tool Surface]] — core, skills, shell, webpage, patch, and Computer Use contracts.
- [[pages/Persistent Shell Runtime]] — shell protocol, output bounds, retries, concurrency, and recovery.
- [[pages/Workspace Tooling]] — workspace conventions, dynamic skills, and vendored `apply_patch`.
- [[pages/Configuration and Startup]] — environment parsing, startup composition, shutdown, and tunnel helper.
- [[pages/Build and Test]] — validation commands, coverage, and gaps.
- [[pages/Open Questions and Risks]] — unresolved operational and architectural risks.
- [[pages/Browser ChatGPT Subagents]] — implemented CDP-backed ChatGPT delegation, caller-named agents, tab continuity, response tracking, and MCP contract.

## Supporting Files

- [[ops/Secret Handling]] — credential and logging rules.
- [[raw/source-manifest]] — evidence inventory and staleness notes.
- [[log]] — append-only wiki maintenance history.
