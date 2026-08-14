# Unhinged Agent Public Release Checklist

- [x] Rename the private GitHub repository to `Serbyte-Development/unhinged-agent` and update the local remote.
- [x] Lock the public identity everywhere: **Unhinged Agent**, category **agent harness for ChatGPT Web**, primary keyword **agent harness**, secondary terms **ChatGPT agent**, **AI coding agent**, **MCP agent**.
- [x] Use the tagline: **Turn ChatGPT Web into an unhinged local coding agent. Full computer access. Persistent tools. Multi-agent capabilities.**
- [x] Update GitHub topics around the agent-harness positioning.
- [x] Rename public package/repository metadata, clone commands, CI badge URLs, asset names, and current documentation from the old Shelly / `chatgpt-local-shell-mcp` identity.
- [ ] Rename current runtime branding and local state from Shelly to Unhinged Agent, including auth types/messages, trusted remote marker, PM2 process names, `~/.shelly/auth.json`, and `~/.shelly/chatgpt-chrome`.
- [x] Change the default new-install workspace from `~/Desktop/chatgpt-workspace` to `~/Desktop/agent-workspace` without renaming Austin's existing broader `/Users/austinserb/Desktop/chatgpt-workspace`; preserve that current workspace through local configuration.
- [x] Rework the README around the product: result first, architecture visual, capabilities, install, how it works, security/limitations, then deeper maintainer documentation. Present MCP as infrastructure, not the product category.
- [x] Update the architecture diagram to center **ChatGPT Web → Unhinged Agent → local computer**, including persistent tools and multi-agent capability.
- [x] Prepare a 1280×640 GitHub social-preview asset using the same Unhinged Agent visual identity.
- [x] Keep current Apple Silicon macOS support explicit as a compatibility limitation, not the product identity; record broader host portability as future work.
- [ ] Rename the local repository folder to `/Users/austinserb/Desktop/unhinged-agent`.
- [ ] Run release validation: lint, type-check, tests, build, `git diff --check`, gitleaks history scan, production dependency audit, diagram checks, and GitHub CI.
- [ ] Verify the private GitHub repository metadata/readme after the rename and leave public visibility behind the separate explicit approval gate.
