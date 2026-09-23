---
summary: "Evaluation goals and prior benchmark-fit findings; revalidate upstream choices before use."
---

# Possible Evals

Desired comparison: ChatGPT Web + Shellby versus Codex on identical real engineering work. Prefer a recoverable pre-task repository, one user request, one autonomous attempt, and external grading of final code. Decide whether comparison covers full systems or matched shell/files capabilities before running it. Hold checkpoint, prompt, time/attempt budget, solution-access rules, and grader constant.

## Prior investigation

These are retained research findings, not refreshed upstream claims:

- **SWE-Lancer IC:** fit the one-shot protocol, but bare-macOS execution was blocked by the shared browser/network-replay grader environment. Reconstructing task source was easier than porting the verifier. A custom macOS grader would require separate equivalence validation; avoid that work unless this benchmark specifically matters. Sources to recheck: [paper](https://arxiv.org/abs/2502.12115), [evaluation repository](https://github.com/openai/frontier-evals/tree/main/project/swelancer).
- **SWE-Together:** fit real interactive coding trajectories, but canonical interaction progressively supplies later user intent. Flattening requirements into one prompt changes the protocol and can invalidate process-sensitive grading. Revisit when multi-turn replay is practical. Sources to recheck: [paper](https://arxiv.org/abs/2606.29957), [repository](https://github.com/Togetherbench/SWE-Together).

Neither is an approved evaluation plan. Before selection, verify current task availability, execution environment, grader, and protocol from primary sources. Preserve the distinction between a custom paired comparison and a run comparable to published benchmark scores.
