---
summary: "Cross-cutting trust assumptions, external compatibility risks, and material validation gaps."
---

# Open Questions and Risks

Use owning pages for mechanics; this page records assumptions to reconsider when scope changes.

- **Deployment model:** local clients share host authority and named shells. Remote ownership relies on the ngrok origin policy plus subject binding. Exposing MCP or dashboard through another proxy, or adding multiple users, requires revisiting [HTTP Transport](../http-transport.md), not merely changing a listen address.
- **Private ChatGPT dependency:** authenticated browser state and private turn/history schemas can drift independently of repository changes. Deterministic tests cannot establish current compatibility. Use [CDP diagnostics](../subagents/chatgpt-cdp-transport.md) and targeted live validation; [completion](../subagents/subagent-completion.md) documents conservative recovery limits.
- **Resource authority:** orchestration/cache bounds do not sandbox child CPU/memory or host network access. [Fetching](../tools/fetch-url.md) has transient parse/render costs; [file transfer](../tools/files-and-images.md) buffers whole files without a tool byte ceiling; process cleanup is best effort. Revisit these owners before accepting untrusted/multiple tenants.
- **Persistent/private data:** audit, browser profile, and delegated mappings contain sensitive data. SQLite files lack explicit per-file mode enforcement. [Secret Handling](../operations/secret-handling.md) owns storage rules.
- **Operational evidence:** CI does not establish real PM2/ngrok recovery, macOS TCC/coordinate behavior, live cloning, or full browser restoration after restart. [Build and Test](../operations/build-and-test.md) distinguishes fixture coverage from live checks.

[Roadmap](./roadmap.md) holds optional experiments, not approved commitments. [Evaluation notes](./possible-evals.md) hold prior research, not a current benchmark inventory. Raw surveys remain dated evidence. README serves public setup; maintained pages route repository work.
