# Unhinged Agent Public Release Checklist

- [x] Rename the private GitHub repository to `Serbyte-Development/unhinged-agent` and update the local remote.
- [x] Lock the public identity everywhere: **Unhinged Agent**, category **agent harness for ChatGPT Web**, primary keyword **agent harness**, secondary terms **ChatGPT agent**, **AI coding agent**, **MCP agent**.
- [x] Use the tagline: **Turn ChatGPT Web into an unhinged local coding agent. Full computer access. Persistent tools. Multi-agent capabilities.**
- [x] Update GitHub topics around the agent-harness positioning.
- [x] Rename public package/repository metadata, clone commands, CI badge URLs, asset names, and current documentation from the old Shelly / `chatgpt-local-shell-mcp` identity.
- [x] Rename current runtime branding and local state from Shelly to Unhinged Agent, including auth types/messages, trusted remote marker, PM2 process names, `~/.shelly/auth.json`, and `~/.shelly/chatgpt-chrome`.
- [x] Standardize the default and local workspace on `~/Desktop/agent-workspace`, including renaming Austin's existing broader workspace and updating live configuration/references.
- [x] Scan the repository, agent workspace, live PM2 environment, local tool/skill symlinks, and related current docs for Shelly, the old repo slug, and old workspace paths; fix live references and leave only intentional historical/cache artifacts.
- [x] Rework the README around the product: result first, architecture visual, capabilities, install, how it works, security/limitations, then deeper maintainer documentation. Present MCP as infrastructure, not the product category.
- [x] Update the architecture diagram to center **ChatGPT Web → Unhinged Agent → local computer**, including persistent tools and multi-agent capability.
- [x] Prepare a 1280×640 GitHub social-preview asset using the same Unhinged Agent visual identity.
- [x] Keep current Apple Silicon macOS support explicit as a compatibility limitation, not the product identity; record broader host portability as future work.
- [x] Rename the local repository folder to `/Users/austinserb/Desktop/unhinged-agent`.
- [x] Run release validation: lint, type-check, tests, build, `git diff --check`, gitleaks history scan, production dependency audit, diagram checks, and GitHub CI.
- [x] Verify the private GitHub repository metadata/readme after the rename and leave public visibility behind the separate explicit approval gate.
