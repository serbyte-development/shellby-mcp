---
summary: "Sensitive runtime files, permission boundaries, and what may enter committed context."
paths:
  - src/auth/store.ts
  - src/tools/delegation/store.ts
  - src/server/audit/audit-log.ts
  - .gitignore
---

# Secret Handling

Keep actual credentials, bound subjects, conversation identifiers, and private tool data out of committed wiki/examples. Names of settings, services, and source paths are safe routing context. Provider credentials stay in provider/user configuration or a password manager.

| Local state | Sensitivity and owner |
| --- | --- |
| `<state_dir>/auth.json` | Bound OpenAI subject; [auth store](../../../src/auth/store.ts) enforces private directory/file permissions. HTTP errors do not echo it. |
| `<state_dir>/subagents.sqlite` and sidecars | Parent session IDs, conversation URLs/counts, agent kind. [Delegation store](../../../src/tools/delegation/store.ts) does not explicitly chmod SQLite files; preserve directory protection. |
| `agent-commands.yaml` | Tool inputs and failed patch material; [Audit Logging](./audit-logging.md) owns retention/exclusions. |
| `<state_dir>/logs/` | Error messages/stacks can contain private data; [Runtime Logging](./runtime-logging.md) owns bounded records, private files, and rotation. |
| `test/live/artifacts/` | Browser probes/canary diagnostics may contain private prompts and answers despite header redaction. |
| Managed Chrome profile | Authenticated account state under `state_dir`; do not copy into repository evidence. |

[.gitignore](../../../.gitignore) excludes local config, audit, live artifacts, and `wiki/_private/`. Local ownership pointers may live in `_private/secrets-map.local.md`; it is not a credential store. Gitignore is not redaction: inspect material before committing or sharing it.
