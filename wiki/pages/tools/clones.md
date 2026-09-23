---
summary: "Conversation branching and clone reuse; differences from the shared subagent contract."
paths:
  - src/tools/delegation/clone-tools.ts
  - src/tools/delegation/chatgpt-service.ts
  - src/tools/delegation/chatgpt-browser.ts
  - src/tools/delegation/lifecycle.ts
  - src/tools/delegation/turn-results.ts
---

# Clones

[clone-tools.ts](../../../src/tools/delegation/clone-tools.ts) adapts the same [delegation runtime](../subagents/browser-chatgpt-subagents.md). `clone_id` and `agent_id` share caller scope and admission capacity.

`clone_self` opens the supplied conversation, branches its latest forkable assistant turn through ChatGPT UI, closes the temporary source page when separate, then submits the first prompt in the branch. Existing clone IDs are rejected. Failed creation releases its reservation and closes pages created by the attempt.

`clone_run` reuses a live clone or restores a saved mapping with kind `clone`; ordinary subagent mappings cannot pass that restore path. Clones keep memory and branched context without ordinary subagents' first-turn instruction injection.

`clone_result` shares concurrent local polling through [turn-results.ts](../../../src/tools/delegation/turn-results.ts). Recovery/result lifetime follow [Subagent Completion](../subagents/subagent-completion.md). Failed submissions and any failed polled entry set top-level `isError=true`; mixed results preserve successful answers. Clone failures still expose backend error codes/messages, while ordinary subagents project them into caller guidance.

[chatgpt-browser.ts](../../../src/tools/delegation/chatgpt-browser.ts) owns UI branching; [MCP delegation cases](../../../test/integrations/subagent.ts) cover the public adapter. Real upstream branching/recovery needs targeted live validation.
