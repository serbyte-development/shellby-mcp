# Host App Binary Survey 2026-07-20

## Scope

Maintainer-workstation inspection of executable files bundled inside installed macOS applications. This is host evidence, not a claim that ChatGPT Local Shell MCP currently integrates every item.

## Commands Used

The survey used ordinary shell inspection such as:

```bash
find "/Applications/<App>.app/Contents" -type f -perm -111
"/Applications/<App>.app/Contents/<candidate>" --help
type -a codex web_search apply_patch
readlink <resolved-path>
```

No credentials or token values were recorded.

## Verified Host Observations

| Application               | Executable or interface                                                                                             | Observation                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT                   | `/Applications/ChatGPT.app/Contents/Resources/codex`                                                                | Native Codex executable. The workspace `apply_patch` command is a symlink to this binary. Codex dispatches to its patch implementation when invoked with `apply_patch` as `argv[0]`.                                                                                               |
| ChatGPT                   | `Contents/Resources/plugins/openai-bundled/plugins/latex/bin/tectonic`                                              | Standalone Tectonic LaTeX compiler candidate.                                                                                                                                                                                                                                      |
| ChatGPT                   | bundled browser and computer-use JavaScript clients                                                                 | Present, but likely coupled to ChatGPT plugin services, authorization, and local app state rather than being general standalone CLIs.                                                                                                                                              |
| Workspace wrapper         | `~/Desktop/chatgpt-workspace/bin/web_search`                                                                        | Standalone Rust wrapper built from `~/Desktop/codex/experiments/web-search-cli`. It uses Codex authentication and `codex_api::SearchClient` to call the internal `alpha/search` endpoint directly without starting `codex exec`. The endpoint is explicitly internal and unstable. |
| Craft Agents              | `craft-agent`, `pdf-tool`, `docx-tool`, `xlsx-tool`, `pptx-tool`, `img-tool`, `ical-tool`, `markitdown`, `doc-diff` | Bundled command wrappers. They require the environment normally injected by Craft, including `CRAFT_UV`, `CRAFT_SCRIPTS`, `CRAFT_BUN`, and a CLI entry variable.                                                                                                                   |
| LM Studio                 | `Contents/Resources/app/.webpack/lms`                                                                               | Working CLI for model search/download, load/unload, chat, local-server control, process status, imports, and logs.                                                                                                                                                                 |
| Screaming Frog SEO Spider | `Contents/MacOS/ScreamingFrogSEOSpiderLauncher`                                                                     | Working CLI for URL, sitemap, and list crawls plus configuration and export workflows.                                                                                                                                                                                             |
| Screen Studio             | `Contents/Resources/app.asar.unpacked/bin/ffmpeg-darwin-arm64`                                                      | Working FFmpeg 5.0.1 executable with common image, audio, and video codecs.                                                                                                                                                                                                        |
| Screen Studio             | `Contents/Resources/app.asar.unpacked/bin/whisper-darwin-arm64`                                                     | Working local Whisper CLI supporting transcription, translation, timestamps, and TXT/VTT/SRT/CSV output when supplied a compatible model.                                                                                                                                          |
| Visual Studio Code        | `Contents/Resources/app/bin/code`                                                                                   | Working supported editor CLI.                                                                                                                                                                                                                                                      |
| Visual Studio Code        | bundled `tgrep` and `rg` binaries                                                                                   | `tgrep` is a trigram-indexed code search utility with index, server, and search modes. Bundled Ripgrep 15 includes PCRE2.                                                                                                                                                          |
| Cursor                    | `Contents/Resources/app/bin/cursor`, bundled `rg`                                                                   | Working editor CLI and reusable search binary. No Codex-equivalent standalone Cursor agent binary was identified in this survey.                                                                                                                                                   |
| Docker Desktop            | `Contents/Resources/bin/docker`, `kubectl`, Compose and helper binaries                                             | Working supported infrastructure CLIs.                                                                                                                                                                                                                                             |
| GIMP                      | `Contents/MacOS/gimp-console`                                                                                       | Working headless and batch-capable image-processing entrypoint.                                                                                                                                                                                                                    |
| Firefox                   | `Contents/MacOS/firefox`                                                                                            | Working headless browser, screenshot, profile, and automation-oriented command options.                                                                                                                                                                                            |
| Google Chrome             | `Contents/MacOS/Google Chrome`                                                                                      | Browser executable usable with headless and remote-debugging flags, though `--help` forwarded to the existing GUI session during inspection.                                                                                                                                       |
| BBEdit                    | `Contents/Helpers/bbdiff`                                                                                           | Working file and directory comparison CLI.                                                                                                                                                                                                                                         |
| iTerm                     | `Contents/Resources/utilities/imgcat`, `it2copy`                                                                    | Working terminal display and clipboard utilities; lower value as MCP primitives.                                                                                                                                                                                                   |

## Weak Candidates

The primary executables for Claude Desktop, Postman, BetterDisplay, OpenSuperWhisper, DBeaver, and Obsidian appeared primarily useful as GUI launchers. They may expose URL schemes, AppleScript, local APIs, extension hosts, or XPC services, but no strong standalone general-purpose CLI was verified in this pass.

## Reliability Boundary

- Supported app CLIs are the strongest integration targets.
- Bundled third-party utilities are usually callable but can move or disappear on app update.
- Private helpers may require app-managed environment, authentication, IPC, code signing, or running services.
- Internal hosted endpoints such as `alpha/search` are version-coupled and can change without notice.
- Local invocation does not imply permission to copy or redistribute an application's binaries.
