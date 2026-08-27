---
summary: "Sanitized 2026-08-09 observation of OpenAI ChatGPT MCP identity metadata and its stability across sampled conversations."
---

# OpenAI ChatGPT MCP Identity Metadata, 2026-08-09

- Role: OpenAI developer documentation plus direct inspection of live ChatGPT-to-MCP requests for identity metadata available to remote servers.
- Reliability: OpenAI documentation defines the intended semantics; live request shape is point-in-time behavior and may change.
- Observed: `X-OpenAI-Subject` and `X-OpenAI-Session` were present as HTTP headers; `openai/subject`, `openai/session`, and `openai/organization` were present in MCP tool-call `_meta`. Subject stayed stable across sampled conversations while session changed. Actual identifier values were not stored in the wiki.
- OpenAI semantics: subject is an anonymized user ID for rate limiting and identification; session is an anonymized conversation ID; organization is an anonymized organization ID when available.
- Secret handling: no actual identifier values were retained.
