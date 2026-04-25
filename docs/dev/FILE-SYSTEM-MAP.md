# GSD2 File System Map
# Maps every source file to its system/subsystem labels

---

## System Labels Reference

| Label | Description |
|-------|-------------|
| **Agent Core** | Core agent loop, session lifecycle, SDK factory |
| **AI Providers** | LLM provider implementations (Anthropic, OpenAI, Google, etc.) |
| **API Routes** | Next.js API route handlers (web server) |
| **AST** | Abstract Syntax Tree search/rewrite via tree-sitter + ast-grep |
| **Async Jobs** | Background bash job management |
| **Auth / OAuth** | Authentication, OAuth flows, token storage |
| **Auto Engine** | GSD autonomous execution loop, dispatch, supervision |
| **Bg Shell** | Background process / interactive shell management |
| **Browser Tools** | Playwright-based browser automation extension |
| **Build System** | Scripts for build, packaging, version management, CI |
| **CLI** | Command-line entry points and argument parsing |
| **CMux** | Tmux/multiplexer session integration |
| **Commands** | GSD slash/sub-command routing and handlers |
| **Compaction** | Context token reduction and summarization |
| **Config** | Paths, defaults, models, preferences, constants |
| **Context7** | Library documentation fetching extension |
| **Doctor / Diagnostics** | Health checks, forensics, skill health |
| **Event System** | Event bus, publication/subscription |
| **Extension Registry** | Extension discovery, manifests, enable/disable |
| **Extensions** | Extension loader, runner, project trust, hooks |
| **File Search** | grep, glob, fd — file and content discovery |
| **GSD Workflow** | Core GSD planning/execution workflow engine |
| **Google Search** | Web search via Google API |
| **Headless Mode** | Non-interactive / scripted command execution |
| **Image Processing** | Image decode, resize, encode, clipboard images |
| **Integration Tests** | Smoke, fixture, live, regression test suites |
| **Loader / Bootstrap** | Startup initialization, extension sync, tool bootstrap |
| **LSP** | Language Server Protocol client and multiplexer |
| **Mac Tools** | macOS-native utilities (Swift CLI) |
| **MCP Server/Client** | Model Context Protocol server and client |
| **Memory Extension** | In-session memory pipeline and storage |
| **Migration** | Data and config migration tools |
| **Modes** | Interactive TUI, Print, RPC, and Web modes |
| **Model System** | Model discovery, resolution, routing, registry |
| **Native / Rust Tools** | N-API Rust engine modules |
| **Node.js Bindings** | TypeScript wrappers around Rust N-API modules |
| **Onboarding** | First-run wizard and setup flows |
| **Permissions** | Permission management for tools and trust |
| **Remote Questions** | Remote prompting via Slack, Discord, Telegram |
| **Search the Web** | Brave/Jina/Tavily-based web search extension |
| **Session Management** | Session file I/O, branches, fork trees |
| **Skills** | Skill tool registration, health, telemetry |
| **Slash Commands** | Command boilerplate generators extension |
| **State Machine** | State, history, persistence, reactive graph |
| **Studio App** | Electron desktop app (renderer, main, preload) |
| **Subagent** | Parallel/serial subagent delegation |
| **Syntax Highlighting** | Syntect-backed ANSI code coloring |
| **Text Processing** | Diff, truncation, HTML→MD, ANSI, JSON parse |
| **Tool System** | Tool implementations (bash, edit, read, write, grep…) |
| **TTSR** | Time-Traveling Stream Rules regex guardrails |
| **TUI Components** | Terminal UI component library (pi-tui) |
| **Universal Config** | Multi-tool configuration file discovery |
| **Voice** | Voice input extension (Swift/Python) |
| **VS Code Extension** | VS Code sidebar, chat participant, RPC client |
| **Web Mode** | Web server service layer and RPC bridge |
| **Web UI** | Next.js frontend components, pages, hooks |
| **Worktree** | Git worktree lifecycle, sync, name generation |

---

## src/ — Core Application Files

| File | System Label(s) | Description |
|------|-----------------|-------------|
| src/app-paths.ts | Config | App directory paths (GSD_HOME, sessions, web PID, prefs) |
| src/app-paths.js | Config | Compiled JS version |
| src/bundled-extension-paths.ts | Extension Registry | Serializes/parses bundled extension directory paths |
| src/bundled-resource-path.ts | Loader/Bootstrap, Extension Registry | Resolves bundled raw resource files from package root |
| src/cli.ts | CLI | Main CLI entry point — arg parsing, mode detection, plugin init |
| src/cli-web-branch.ts | CLI, Web Mode | Web CLI branch; session dir resolution, legacy migration |
| src/extension-discovery.ts | Extension Registry | Discovers extension entry points from FS and package.json |
| src/extension-registry.ts | Extension Registry | Extension manifests, registry persistence, enable/disable |
| src/headless-answers.ts | Headless Mode | Pre-supply answers to extension UI requests in headless |
| src/headless-context.ts | Headless Mode | Context loading from stdin/files; project bootstrapping |
| src/headless-events.ts | Headless Mode | Event classification, terminal detection, idle timeouts |
| src/headless-query.ts | Headless Mode, CLI | Read-only snapshot query (state, dispatch preview, costs) |
| src/headless-ui.ts | Headless Mode | Extension UI auto-response, progress formatting |
| src/headless.ts | Headless Mode | Orchestrator for /gsd subcommands without TUI via RPC |
| src/help-text.ts | CLI | Generates help text for all subcommands |
| src/loader.ts | Loader/Bootstrap | Fast-path startup, extension discovery/validation, env setup |
| src/logo.ts | CLI | ASCII logo rendering for welcome screen and loader |
| src/mcp-server.ts | MCP Server/Client | Native MCP server over stdin/stdout for external AI clients |
| src/models-resolver.ts | Config, Auth/OAuth | Resolves models.json with fallback from Pi to GSD |
| src/onboarding.ts | Onboarding | First-run wizard — LLM auth, OAuth, API keys, tool setup |
| src/pi-migration.ts | Config, Auth/OAuth | Migrates provider credentials from Pi auth.json to GSD |
| src/project-sessions.ts | State Machine, CLI | Session-per-project directory paths from project CWD |
| src/remote-questions-config.ts | Config, Onboarding | Saves remote questions (Discord, Slack, Telegram) config |
| src/resource-loader.ts | Loader/Bootstrap, Extension Registry | Initializes, syncs, validates bundled resources |
| src/startup-timings.ts | CLI, Build System | Optional startup timing instrumentation |
| src/tool-bootstrap.ts | Loader/Bootstrap | Manages fd/rg availability, falls back to built-in |
| src/update-check.ts | CLI | Checks npm registry for new versions (cached) |
| src/update-cmd.ts | CLI | Executes npm install to update gsd-pi package |
| src/web-mode.ts | Web Mode | Launches/manages web server process (PID tracking, browser) |
| src/welcome-screen.ts | CLI | Welcome panel — logo, version, model info |
| src/wizard.ts | Onboarding, Config | Loads env keys from auth.json → hydrates process.env |
| src/worktree-cli.ts | Worktree, CLI | Worktree lifecycle: create, list, merge, clean, remove |
| src/worktree-name-gen.ts | Worktree | Generates random worktree names (adjective-verbing-noun) |

### src/web/ — Web Service Layer

| File | System Label(s) | Description |
|------|-----------------|-------------|
| src/web/auto-dashboard-service.ts | Web Mode, Auto Engine | Loads auto-mode dashboard state (active, paused, costs) |
| src/web/bridge-service.ts | Web Mode, State Machine | Central hub spawning RPC sessions, managing session state |
| src/web/captures-service.ts | Web Mode | Loads knowledge capture entries via child process bridge |
| src/web/cleanup-service.ts | Web Mode | Collects GSD branches and snapshot refs for cleanup |
| src/web/cli-entry.ts | Web Mode, CLI | Builds/resolves GSD CLI entry points for RPC/interactive |
| src/web/doctor-service.ts | Web Mode, Doctor/Diagnostics | Runs diagnostics, returns fixer operations |
| src/web/export-service.ts | Web Mode | Generates exported project reports (markdown/JSON) |
| src/web/forensics-service.ts | Web Mode, Doctor/Diagnostics | Loads forensic report data (traces, metrics, issues) |
| src/web/git-summary-service.ts | Web Mode | Provides git branch, commit history, diff summary |
| src/web/history-service.ts | Web Mode | Loads metrics ledger, aggregates history views |
| src/web/hooks-service.ts | Web Mode | Manages git hook registration and shell integration |
| src/web/inspect-service.ts | Web Mode | Detailed inspection of project state and traces |
| src/web/knowledge-service.ts | Web Mode | Reads and parses KNOWLEDGE.md |
| src/web/onboarding-service.ts | Web Mode, Onboarding, Auth/OAuth | Manages onboarding state, auth refresh, lock reasons |
| src/web/project-discovery-service.ts | Web Mode | Discovers and catalogs projects in filesystem |
| src/web/recovery-diagnostics-service.ts | Web Mode | Recovery suggestions for error states/blockers |
| src/web/settings-service.ts | Web Mode, Config | Loads preferences, routing config, budget, totals |
| src/web/skill-health-service.ts | Web Mode, Doctor/Diagnostics | Loads skill health report with capability assessments |
| src/web/undo-service.ts | Web Mode | Manages undo/snapshot and restoration |
| src/web/update-service.ts | Web Mode | Checks for and executes application updates |
| src/web/visualizer-service.ts | Web Mode | Generates visual representations of project state |
| src/web/web-auth-storage.ts | Web Mode, Auth/OAuth | OAuth and API key credential storage for web mode |

---

## packages/pi-agent-core/src/ — Agent Core

| File | System Label(s) | Description |
|------|-----------------|-------------|
| agent-loop.ts | Agent Core, State Machine | Core agent execution loop — tool calls and LLM interactions |
| agent.ts | Agent Core | Main Agent class wrapping loop with state management |
| proxy.ts | Agent Core | Proxy wrapper for agent functionality |
| types.ts | Agent Core | Type definitions for agent config, context, events |
| index.ts | Agent Core | Package exports |

---

## packages/pi-ai/src/ — AI Providers

| File | System Label(s) | Description |
|------|-----------------|-------------|
| index.ts | AI Providers | Main export hub for providers and streaming |
| api-registry.ts | AI Providers | Registry for managing multiple AI provider implementations |
| models.ts | AI Providers | Backward-compatible shim re-exporting the split model registry |
| models/index.ts | AI Providers | Primary model registry composition and lookup helpers |
| models/custom.ts | AI Providers | Manually curated providers not covered by models.dev |
| models/capability-patches.ts | AI Providers | Capability patch rules for generated/custom models |
| models/generated/index.ts | AI Providers | Auto-generated provider catalog aggregator |
| models/generated/*.ts | AI Providers | Auto-generated model lists split by provider |
| stream.ts | AI Providers | Main streaming interface dispatching to registered providers |
| types.ts | AI Providers | Core types for models, APIs, streaming options |
| env-api-keys.ts | AI Providers, Auth/OAuth | Environment variable API key resolution |
| web-runtime-env-api-keys.ts | AI Providers, Auth/OAuth | Web runtime API key handling |
| web-runtime-oauth.ts | AI Providers, Auth/OAuth | Web runtime OAuth token management |
| providers/register-builtins.ts | AI Providers | Registration of built-in provider implementations |
| providers/anthropic.ts | AI Providers | Anthropic API provider |
| providers/anthropic-shared.ts | AI Providers | Shared utilities for Anthropic provider variants |
| providers/anthropic-vertex.ts | AI Providers | Google Vertex AI Anthropic models |
| providers/amazon-bedrock.ts | AI Providers | AWS Bedrock LLM provider |
| providers/bedrock-provider.ts | AI Providers | Bedrock-specific streaming logic |
| providers/google.ts | AI Providers | Google Generative AI provider |
| providers/google-gemini-cli.ts | AI Providers | Google Gemini CLI authentication provider |
| providers/google-shared.ts | AI Providers | Shared Google provider utilities |
| providers/google-vertex.ts | AI Providers | Google Vertex AI provider |
| providers/mistral.ts | AI Providers | Mistral AI provider |
| providers/openai-completions.ts | AI Providers | OpenAI legacy completions API |
| providers/openai-responses.ts | AI Providers | OpenAI responses (chat) API |
| providers/openai-responses-shared.ts | AI Providers | Shared OpenAI responses utilities |
| providers/openai-shared.ts | AI Providers | Shared OpenAI utilities |
| providers/openai-codex-responses.ts | AI Providers | OpenAI Codex-specific response handling |
| providers/azure-openai-responses.ts | AI Providers | Azure OpenAI responses provider |
| providers/github-copilot-headers.ts | AI Providers | GitHub Copilot custom header construction |
| providers/simple-options.ts | AI Providers | Common options builder for simple streaming |
| providers/transform-messages.ts | AI Providers | Message transformation for provider compatibility |
| utils/oauth/index.ts | Auth/OAuth | OAuth utilities export hub |
| utils/oauth/types.ts | Auth/OAuth | OAuth credential and prompt types |
| utils/oauth/pkce.ts | Auth/OAuth | PKCE flow implementation |
| utils/oauth/github-copilot.ts | Auth/OAuth | GitHub Copilot OAuth flow |
| utils/oauth/google-oauth-utils.ts | Auth/OAuth | Shared Google OAuth utilities |
| utils/oauth/google-gemini-cli.ts | Auth/OAuth | Google Gemini CLI OAuth flow |
| utils/oauth/google-antigravity.ts | Auth/OAuth | Google Antigravity OAuth implementation |
| utils/oauth/openai-codex.ts | Auth/OAuth | OpenAI Codex OAuth flow |
| utils/oauth/anthropic.ts | Auth/OAuth | Anthropic OAuth flow |
| utils/event-stream.ts | AI Providers | Event stream parsing and handling |
| utils/hash.ts | AI Providers | Hashing utilities |
| utils/json-parse.ts | AI Providers | Resilient JSON parsing with recovery |
| utils/overflow.ts | AI Providers | Token/context overflow detection |
| utils/sanitize-unicode.ts | AI Providers | Unicode sanitization for API compatibility |
| utils/validation.ts | AI Providers | Request/response validation schemas |
| utils/typebox-helpers.ts | AI Providers | TypeBox schema helpers |

---

## packages/pi-tui/src/ — TUI Components

| File | System Label(s) | Description |
|------|-----------------|-------------|
| index.ts | TUI Components | Main TUI export hub |
| tui.ts | TUI Components | Core TUI renderer and component system |
| terminal.ts | TUI Components | Low-level terminal I/O and rendering |
| keys.ts | TUI Components | Keyboard key parsing and matching |
| keybindings.ts | TUI Components | Keybinding configuration and management |
| stdin-buffer.ts | TUI Components | Buffered stdin for batch key processing |
| editor-component.ts | TUI Components | Interface for custom editor implementations |
| autocomplete.ts | TUI Components | Autocomplete suggestion provider system |
| fuzzy.ts | TUI Components | Fuzzy matching algorithm |
| terminal-image.ts | TUI Components | Terminal image protocol (Kitty, iTerm2) |
| kill-ring.ts | TUI Components | Emacs-style kill ring buffer |
| undo-stack.ts | TUI Components | Undo/redo stack for editor operations |
| overlay-layout.ts | TUI Components | Overlay/modal dialog layout system |
| utils.ts | TUI Components | Text width calculation, ANSI utilities |
| components/box.ts | TUI Components | Box drawing with borders and styling |
| components/text.ts | TUI Components | Simple text display component |
| components/truncated-text.ts | TUI Components | Text with automatic truncation |
| components/spacer.ts | TUI Components | Vertical/horizontal spacing |
| components/input.ts | TUI Components | Single-line text input with history |
| components/loader.ts | TUI Components | Animated loading spinner |
| components/cancellable-loader.ts | TUI Components | Loading spinner with cancel |
| components/image.ts | TUI Components | Image display with theme support |
| components/select-list.ts | TUI Components | List selection UI with keyboard nav |
| components/settings-list.ts | TUI Components | Settings/preferences list display |
| components/editor.ts | TUI Components | Full multi-line editor with syntax awareness |
| components/markdown.ts | TUI Components | Markdown rendering to terminal |

---

## packages/pi-coding-agent/src/ — Coding Agent

### CLI

| File | System Label(s) | Description |
|------|-----------------|-------------|
| cli.ts | CLI | Main CLI entry point and argument routing |
| main.ts | CLI | CLI main entry with mode routing |
| cli/args.ts | CLI | CLI argument definition and parsing |
| cli/config-selector.ts | CLI | Interactive configuration selection |
| cli/file-processor.ts | CLI | File input processing for agent context |
| cli/list-models.ts | CLI, Model System | Model listing and discovery UI |
| cli/session-picker.ts | CLI | Session selection interface |

### Core — Session & State

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/agent-session.ts | Agent Core, State Machine | Core session abstraction, agent lifecycle, persistence |
| core/session-manager.ts | Session Management | Session file I/O, branch/fork tree management |
| core/event-bus.ts | Agent Core, Event System | Event publication and subscription |
| core/messages.ts | State Machine | Message type definitions and constructors |
| core/settings-manager.ts | Session Management, Config | Session-level settings persistence |

### Core — Tool System

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/tools/index.ts | Tool System | Tool registry and factory exports |
| core/tools/bash.ts | Tool System | Bash/shell command execution tool |
| core/tools/bash-interceptor.ts | Tool System | Bash command interception and filtering |
| core/tools/edit.ts | Tool System | File editing tool with line ranges |
| core/tools/edit-diff.ts | Tool System | Edit tool with diff-based operations |
| core/tools/read.ts | Tool System | File reading tool |
| core/tools/write.ts | Tool System | File writing tool |
| core/tools/find.ts | Tool System, File Search | File discovery tool |
| core/tools/grep.ts | Tool System, File Search | Pattern search tool |
| core/tools/ls.ts | Tool System | Directory listing tool |
| core/tools/truncate.ts | Tool System, Text Processing | Output truncation utility |
| core/tools/hashline.ts | Tool System | Hash-based line identification |
| core/tools/hashline-read.ts | Tool System | File reading with hash-based line ranges |
| core/tools/hashline-edit.ts | Tool System | File editing with hash-based line identification |
| core/tools/path-utils.ts | Tool System | Path normalization and validation |
| core/bash-executor.ts | Tool System | High-level bash execution with event handling |
| core/exec.ts | Tool System | Utility functions for command execution |

### Core — Model Management

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/model-registry.ts | Model System | Model metadata and capability registry |
| core/model-discovery.ts | Model System | Model discovery from external sources |
| core/model-resolver.ts | Model System | Model selection and resolution logic |
| core/models-json-writer.ts | Model System | Model metadata serialization |

### Core — AI & Context

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/prompt-templates.ts | Agent Core | Template system for prompt construction |
| core/system-prompt.ts | Agent Core | System prompt building and management |
| core/retry-handler.ts | AI Providers | Retry logic with exponential backoff |
| core/fallback-resolver.ts | Model System | Model fallback resolution on API failures |
| core/slash-commands.ts | Commands | Built-in slash command definitions and handlers |

### Core — Extensions & Skills

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/extensions/index.ts | Extensions | Extension system exports |
| core/extensions/types.ts | Extensions | Extension event and context types |
| core/extensions/loader.ts | Extensions | Extension discovery and loading |
| core/extensions/runner.ts | Extensions, Event System | Extension event dispatch and execution |
| core/extensions/wrapper.ts | Extensions, Tool System | Tool wrapping for extension monitoring |
| core/extensions/project-trust.ts | Extensions, Permissions | Project trust management for local extensions |
| core/skills.ts | Skills, Tool System | Skill tool registration and management |

### Core — Compaction

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/compaction-orchestrator.ts | Compaction | Orchestrates session compaction decisions |
| core/compaction/compaction.ts | Compaction | Context token reduction via summarization |
| core/compaction/branch-summarization.ts | Compaction | Branch history summarization for context limits |
| core/compaction/utils.ts | Compaction | Compaction utilities |

### Core — Configuration & Auth

| File | System Label(s) | Description |
|------|-----------------|-------------|
| config.ts | Config | Directory paths and version management |
| core/sdk.ts | Agent Core | Main SDK factory for creating agent sessions |
| core/resolve-config-value.ts | Config | Config value resolution from environment/files |
| core/resource-loader.ts | Config, Loader/Bootstrap | Extensible resource loading (tools, extensions, themes) |
| core/defaults.ts | Config | Default configuration values |
| core/constants.ts | Config | Global constants |
| core/auth-storage.ts | Auth/OAuth, Permissions | OAuth token storage and management |
| migrations.ts | Config, Migration | Configuration migration and deprecation handling |

### Core — Artifacts & Export

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/artifact-manager.ts | Agent Core | Artifact file management and metadata |
| core/blob-store.ts | Agent Core | Binary data storage for images and attachments |
| core/export-html/index.ts | Web Mode | Session export to HTML |
| core/export-html/ansi-to-html.ts | Web Mode | ANSI code to HTML conversion |
| core/export-html/tool-renderer.ts | Web Mode | HTML rendering for tool calls/results |

### Core — LSP

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/lsp/index.ts | LSP | LSP integration exports |
| core/lsp/client.ts | LSP | LSP client implementation |
| core/lsp/lspmux.ts | LSP | LSP server multiplexing |
| core/lsp/config.ts | LSP | LSP server configuration |
| core/lsp/edits.ts | LSP | LSP-based code editing operations |
| core/lsp/helpers.ts | LSP | LSP utility functions |
| core/lsp/types.ts | LSP | LSP type definitions |
| core/lsp/utils.ts | LSP | LSP utilities |

### Core — Utilities

| File | System Label(s) | Description |
|------|-----------------|-------------|
| core/fs-utils.ts | Tool System | File system utilities (atomic writes, temp files) |
| core/lock-utils.ts | Tool System | File locking for concurrent access |
| core/timings.ts | Build System | Performance timing measurement |
| core/diagnostics.ts | Doctor/Diagnostics | Diagnostic information collection |
| core/discovery-cache.ts | Model System | Model discovery result caching |
| core/keybindings.ts | TUI Components | Keybinding definitions |
| core/footer-data-provider.ts | TUI Components | Footer information provider |
| core/index.ts | Agent Core | Core module exports |
| index.ts | Agent Core | Package exports |
| utils/clipboard.ts | Tool System | Clipboard read/write |
| utils/clipboard-native.ts | Tool System | Native clipboard implementation |
| utils/clipboard-image.ts | Tool System | Clipboard image support |
| utils/error.ts | Agent Core | Error message extraction/formatting |
| utils/frontmatter.ts | Config | YAML frontmatter parsing |
| utils/git.ts | Tool System | Git information and utilities |
| utils/image-convert.ts | Image Processing | Image format conversion |
| utils/image-resize.ts | Image Processing | Image resizing and optimization |
| utils/mime.ts | Tool System | MIME type detection |
| utils/path-display.ts | TUI Components | Path formatting for display |
| utils/photon.ts | Agent Core | Photon scripting runtime support |
| utils/shell.ts | Tool System | Shell detection and execution |
| utils/changelog.ts | CLI | Changelog parsing |
| utils/sleep.ts | Agent Core | Async sleep/delay utility |
| utils/tools-manager.ts | Tool System | Tool discovery and management |
| package-manager.ts | Build System | npm/yarn/pnpm/bun abstraction |

### Modes

| File | System Label(s) | Description |
|------|-----------------|-------------|
| modes/index.ts | Modes | Mode system exports |
| modes/print-mode.ts | Modes | Non-interactive print mode |
| modes/rpc/rpc-mode.ts | Modes, MCP Server/Client | RPC server mode for remote access |
| modes/rpc/rpc-client.ts | Modes, MCP Server/Client | RPC client for remote agent interaction |
| modes/rpc/rpc-types.ts | Modes, MCP Server/Client | RPC protocol type definitions |
| modes/rpc/jsonl.ts | Modes | JSONL serialization for RPC |
| modes/rpc/remote-terminal.ts | Modes | Remote terminal output handling |
| modes/shared/command-context-actions.ts | Modes, Commands | Shared command context utilities |
| modes/interactive/interactive-mode.ts | Modes, TUI Components | Main interactive TUI mode orchestration |
| modes/interactive/interactive-mode-state.ts | Modes, TUI Components, State Machine | Interactive mode state management |
| modes/interactive/slash-command-handlers.ts | Modes, Commands | Interactive mode slash command handlers |
| modes/interactive/theme/theme.ts | TUI Components | Theme system and hot reloading |
| modes/interactive/theme/themes.ts | TUI Components | Built-in theme definitions |
| modes/interactive/utils/shorten-path.ts | TUI Components | Path shortening for display |
| modes/interactive/controllers/chat-controller.ts | Modes, TUI Components | Chat input and message submission |
| modes/interactive/controllers/input-controller.ts | Modes, TUI Components | Input handling and routing |
| modes/interactive/controllers/model-controller.ts | Modes, TUI Components, Model System | Model/provider/thinking configuration |
| modes/interactive/controllers/extension-ui-controller.ts | Modes, TUI Components, Extensions | Extension UI event handling |

### Modes — Interactive Components

| File | System Label(s) | Description |
|------|-----------------|-------------|
| components/index.ts | TUI Components | Interactive mode component exports |
| components/armin.ts | TUI Components | Assistant message rendering |
| components/assistant-message.ts | TUI Components | Assistant message display |
| components/user-message.ts | TUI Components | User message display |
| components/user-message-selector.ts | TUI Components | User message editing selector |
| components/bash-execution.ts | TUI Components, Tool System | Bash execution result display |
| components/tool-execution.ts | TUI Components, Tool System | Tool call and result display |
| components/custom-message.ts | TUI Components | Custom message type display |
| components/custom-editor.ts | TUI Components | Custom editor integration |
| components/skill-invocation-message.ts | TUI Components, Skills | Skill invocation display |
| components/branch-summary-message.ts | TUI Components, Compaction | Branch summary display |
| components/compaction-summary-message.ts | TUI Components, Compaction | Compaction summary display |
| components/diff.ts | TUI Components, Text Processing | Diff display component |
| components/tree-render-utils.ts | TUI Components, Session Management | Session tree rendering utilities |
| components/tree-selector.ts | TUI Components, Session Management | Session tree navigation UI |
| components/session-selector.ts | TUI Components, Session Management | Session selection UI |
| components/session-selector-search.ts | TUI Components, Session Management | Session search UI |
| components/model-selector.ts | TUI Components, Model System | Model selection UI |
| components/scoped-models-selector.ts | TUI Components, Model System | Scoped model selection |
| components/thinking-selector.ts | TUI Components, Model System | Thinking level selection |
| components/provider-manager.ts | TUI Components, AI Providers | Provider configuration UI |
| components/oauth-selector.ts | TUI Components, Auth/OAuth | OAuth provider selection/login |
| components/login-dialog.ts | TUI Components, Auth/OAuth | OAuth login dialog |
| components/theme-selector.ts | TUI Components | Theme selection UI |
| components/config-selector.ts | TUI Components, Config | Configuration selection UI |
| components/extension-selector.ts | TUI Components, Extensions | Extension selection UI |
| components/extension-editor.ts | TUI Components, Extensions | Extension code editor |
| components/extension-input.ts | TUI Components, Extensions | Extension input handling |
| components/settings-selector.ts | TUI Components, Config | Settings/preferences UI |
| components/show-images-selector.ts | TUI Components, Config | Image display toggle |
| components/bordered-loader.ts | TUI Components | Loading spinner with border |
| components/countdown-timer.ts | TUI Components | Countdown timer display |
| components/dynamic-border.ts | TUI Components | Dynamic border drawing |
| components/keybinding-hints.ts | TUI Components | Keybinding help display |
| components/footer.ts | TUI Components | Footer information display |
| components/daxnuts.ts | TUI Components | Special rendering effect |
| components/visual-truncate.ts | TUI Components | Visual text truncation |

### Resources — Memory Extension

| File | System Label(s) | Description |
|------|-----------------|-------------|
| resources/extensions/memory/index.ts | Memory Extension | Memory extension index and setup |
| resources/extensions/memory/pipeline.ts | Memory Extension | Memory processing pipeline |
| resources/extensions/memory/storage.ts | Memory Extension | Memory persistence storage |

---

## src/resources/extensions/ — Extension Subsystems

### GSD Extension (Core Workflow Engine)

| File | System Label(s) | Description |
|------|-----------------|-------------|
| gsd/index.ts | GSD Workflow | Main GSD extension bootstrap and registration |
| gsd/auto.ts | Auto Engine | Automatic workflow execution and loop management |
| gsd/auto-dashboard.ts | Auto Engine, Web Mode | Real-time dashboard for auto-run progress |
| gsd/auto-worktree.ts | Auto Engine, Worktree | Automatic worktree creation and branch management |
| gsd/auto-recovery.ts | Auto Engine | Recovery for crashed/stalled workflows |
| gsd/auto-start.ts | Auto Engine | Initialization sequence for automatic execution |
| gsd/auto-worktree-sync.ts | Auto Engine, Worktree | State sync between worktrees and main |
| gsd/auto-model-selection.ts | Auto Engine, Model System | Intelligent LLM model routing |
| gsd/auto-direct-dispatch.ts | Auto Engine | Direct command dispatching without planning |
| gsd/auto-dispatch.ts | Auto Engine | Task queueing and priority-based dispatch |
| gsd/auto-timeout-recovery.ts | Auto Engine | Timeout handling and recovery |
| gsd/auto-post-unit.ts | Auto Engine | Post-unit milestone completion processing |
| gsd/auto-unit-closeout.ts | Auto Engine | Unit finalization and archiving |
| gsd/auto-verification.ts | Auto Engine | Post-execution verification |
| gsd/auto-timers.ts | Auto Engine | Timeout and deadline management |
| gsd/auto-loop.ts | Auto Engine, State Machine | Execution loop state and cycle management |
| gsd/auto-supervisor.ts | Auto Engine | Supervision and oversight of autonomous runs |
| gsd/auto-budget.ts | Auto Engine | Token/cost budgeting and tracking |
| gsd/auto-observability.ts | Auto Engine | Observability hooks and telemetry |
| gsd/auto-tool-tracking.ts | Auto Engine | Tool usage instrumentation |
| gsd/doctor.ts | Doctor/Diagnostics | Health check and system diagnostics |
| gsd/doctor-checks.ts | Doctor/Diagnostics | Individual diagnostic checks |
| gsd/doctor-providers.ts | Doctor/Diagnostics | Diagnostic data source providers |
| gsd/doctor-format.ts | Doctor/Diagnostics | Diagnostic output formatting |
| gsd/state.ts | State Machine | Milestone and workflow state management |
| gsd/history.ts | State Machine | State history and versioning |
| gsd/json-persistence.ts | State Machine | JSON-based persistence layer |
| gsd/memory-store.ts | State Machine | In-memory state storage |
| gsd/reactive-graph.ts | State Machine | Reactive dependency graph for state |
| gsd/routing-history.ts | State Machine | History of routing decisions |
| gsd/cache.ts | State Machine | Caching layer for performance |
| gsd/model-router.ts | Model System | LLM model selection and routing logic |
| gsd/worktree.ts | Worktree | Worktree creation and management |
| gsd/worktree-manager.ts | Worktree | Higher-level worktree orchestration |
| gsd/worktree-resolver.ts | Worktree | Worktree path and reference resolution |
| gsd/unit-runtime.ts | Auto Engine | Unit-level execution runtime |
| gsd/activity-log.ts | GSD Workflow | Activity tracking and logging |
| gsd/debug-logger.ts | GSD Workflow | Debug output and verbose logging |
| gsd/commands.ts | Commands | Main command dispatcher |
| gsd/commands-handlers.ts | Commands | Command-specific handlers |
| gsd/commands-bootstrap.ts | Commands | Bootstrap and initialization commands |
| gsd/commands-config.ts | Commands, Config | Configuration management commands |
| gsd/commands-extensions.ts | Commands, Extensions | Extension discovery and management |
| gsd/commands-inspect.ts | Commands, Doctor/Diagnostics | Database and state inspection tools |
| gsd/commands-logs.ts | Commands | Log viewing and filtering |
| gsd/commands-workflow-templates.ts | Commands, GSD Workflow | Workflow template management |
| gsd/commands-cmux.ts | Commands, CMux | Tmux/cmux integration commands |
| gsd/exit-command.ts | Commands | Exit and cleanup commands |
| gsd/undo.ts | Commands | Undo and rollback functionality |
| gsd/kill.ts | Commands | Process termination and cleanup |
| gsd/worktree-command.ts | Commands, Worktree | Worktree subcommands |
| gsd/namespaced-resolver.ts | GSD Workflow | Namespace and scoped resource resolution |
| gsd/error-utils.ts | GSD Workflow | Error handling and formatting |
| gsd/errors.ts | GSD Workflow | Error type definitions |
| gsd/diff-context.ts | GSD Workflow | Diff-based context extraction |
| gsd/memory-extractor.ts | GSD Workflow | Memory and context extraction from state |
| gsd/structured-data-formatter.ts | GSD Workflow | Structured output formatting |
| gsd/export-html.ts | GSD Workflow | HTML export of milestone reports |
| gsd/reports.ts | GSD Workflow | Report generation and summaries |
| gsd/notifications.ts | GSD Workflow | User notification and messaging |
| gsd/triage-ui.ts | GSD Workflow | Triage interface for issue categorization |
| gsd/guided-flow.ts | GSD Workflow | User-guided workflow orchestration |
| gsd/env-utils.ts | GSD Workflow | Environment variable utilities |
| gsd/git-constants.ts | GSD Workflow | Git-related constants and paths |
| gsd/milestone-id-utils.ts | GSD Workflow | Milestone ID generation and parsing |
| gsd/resource-version.ts | GSD Workflow | Resource versioning helpers |
| gsd/atomic-write.ts | GSD Workflow | Atomic file write operations |
| gsd/captures.ts | GSD Workflow | Artifact capture and storage |
| gsd/changelog.ts | GSD Workflow | Changelog generation |
| gsd/claude-import.ts | GSD Workflow | Claude API/resource importing |
| gsd/collision-diagnostics.ts | Doctor/Diagnostics | Collision detection and diagnostics |
| gsd/prompt-loader.ts | GSD Workflow | Prompt template loading |
| gsd/file-watcher.ts | GSD Workflow | File system change monitoring |
| gsd/parallel-eligibility.ts | GSD Workflow | Parallel execution eligibility checks |
| gsd/plugin-importer.ts | GSD Workflow, Extensions | Custom plugin/extension importing |
| gsd/verification-gate.ts | GSD Workflow | Pre-execution verification checks |
| gsd/preference-models.ts | Config, Model System | Model preference configuration |
| gsd/preferences-skills.ts | Config, Skills | Skill preference configuration |
| gsd/post-unit-hooks.ts | GSD Workflow | Post-unit execution hooks |
| gsd/skill-telemetry.ts | Skills | Skill usage and performance telemetry |
| gsd/bootstrap/* | GSD Workflow, Loader/Bootstrap | Extension initialization and hook registration |
| gsd/auto/* | Auto Engine | Auto-execution engine components |
| gsd/commands/* | Commands | Command routing and handling |
| gsd/templates/* | GSD Workflow | Output templates and formatters |
| gsd/prompts/* | GSD Workflow | System prompts and instructions |
| gsd/workflow-templates/* | GSD Workflow | Workflow starter templates and registry |
| gsd/skills/* | Skills | Integrated skill configurations |
| gsd/migrate/* | Migration | Data migration and upgrade tools |

### Other Extensions

| File | System Label(s) | Description |
|------|-----------------|-------------|
| async-jobs/index.ts | Async Jobs | Background bash command execution extension |
| async-jobs/job-manager.ts | Async Jobs | Background job lifecycle management |
| async-jobs/async-bash-tool.ts | Async Jobs, Tool System | Tool for spawning background bash processes |
| async-jobs/await-tool.ts | Async Jobs, Tool System | Tool for waiting on job completion |
| async-jobs/cancel-job-tool.ts | Async Jobs, Tool System | Tool for cancelling background jobs |
| bg-shell/index.ts | Bg Shell | Interactive background process management extension |
| bg-shell/bg-shell-tool.ts | Bg Shell, Tool System | Tool for spawning background processes |
| bg-shell/bg-shell-command.ts | Bg Shell, Commands | Command handler for bg subcommands |
| bg-shell/bg-shell-lifecycle.ts | Bg Shell | Process lifecycle and state management |
| bg-shell/process-manager.ts | Bg Shell | Core process management implementation |
| bg-shell/readiness-detector.ts | Bg Shell | Startup readiness detection |
| bg-shell/interaction.ts | Bg Shell | Interactive process communication |
| bg-shell/output-formatter.ts | Bg Shell | Process output formatting |
| bg-shell/overlay.ts | Bg Shell, TUI Components | Terminal overlay for process monitoring |
| browser-tools/index.ts | Browser Tools | Playwright-based browser automation extension |
| browser-tools/core.ts | Browser Tools | Core Playwright instance management |
| browser-tools/lifecycle.ts | Browser Tools | Browser session lifecycle |
| browser-tools/capture.ts | Browser Tools | Screenshot and media capture |
| browser-tools/settle.ts | Browser Tools | Page settlement and readiness detection |
| browser-tools/refs.ts | Browser Tools | Reference-based element selection |
| browser-tools/state.ts | Browser Tools, State Machine | Browser state management |
| browser-tools/tools/navigation.ts | Browser Tools, Tool System | Navigation and page loading tool |
| browser-tools/tools/interaction.ts | Browser Tools, Tool System | Element interaction tool (click, type) |
| browser-tools/tools/screenshot.ts | Browser Tools, Tool System | Screenshot and visual capture tool |
| browser-tools/tools/inspection.ts | Browser Tools, Tool System | Page inspection tool |
| browser-tools/tools/session.ts | Browser Tools, Tool System | Session management and cookies tool |
| browser-tools/tools/pages.ts | Browser Tools, Tool System | Multi-page management tool |
| browser-tools/tools/forms.ts | Browser Tools, Tool System | Form filling and submission tool |
| browser-tools/tools/wait.ts | Browser Tools, Tool System | Wait conditions and polling tool |
| browser-tools/tools/assertions.ts | Browser Tools, Tool System | Visual and content assertions tool |
| browser-tools/tools/verify.ts | Browser Tools, Tool System | Verification checks tool |
| browser-tools/tools/extract.ts | Browser Tools, Tool System | Data extraction tool |
| browser-tools/tools/pdf.ts | Browser Tools, Tool System | PDF export/generation tool |
| browser-tools/tools/state-persistence.ts | Browser Tools, Tool System | State save/restore tool |
| browser-tools/tools/network-mock.ts | Browser Tools, Tool System | Network mocking/interception tool |
| browser-tools/tools/device.ts | Browser Tools, Tool System | Device emulation tool |
| browser-tools/tools/visual-diff.ts | Browser Tools, Tool System | Visual regression testing tool |
| browser-tools/tools/zoom.ts | Browser Tools, Tool System | Zoom and viewport manipulation tool |
| browser-tools/tools/codegen.ts | Browser Tools, Tool System | Test code generation tool |
| browser-tools/tools/action-cache.ts | Browser Tools | Action caching and replay |
| context7/index.ts | Context7, Tool System | Library documentation fetching extension |
| google-search/index.ts | Google Search, Tool System | Web search via Google API |
| search-the-web/index.ts | Search the Web | Brave/Jina/Tavily-based web search extension |
| search-the-web/provider.ts | Search the Web | Search provider abstraction |
| search-the-web/native-search.ts | Search the Web | Native Brave search implementation |
| search-the-web/tavily.ts | Search the Web | Tavily search provider |
| search-the-web/tool-search.ts | Search the Web, Tool System | Search tool implementation |
| search-the-web/tool-fetch-page.ts | Search the Web, Tool System | Page fetching tool |
| search-the-web/cache.ts | Search the Web | Search result caching |
| remote-questions/index.ts | Remote Questions | Remote question routing extension |
| remote-questions/manager.ts | Remote Questions | Question lifecycle management |
| remote-questions/slack-adapter.ts | Remote Questions | Slack messaging adapter |
| remote-questions/discord-adapter.ts | Remote Questions | Discord messaging adapter |
| remote-questions/telegram-adapter.ts | Remote Questions | Telegram messaging adapter |
| mcp-client/index.ts | MCP Server/Client | Model Context Protocol client integration |
| subagent/index.ts | Subagent, Agent Core | Parallel/serial subagent delegation extension |
| subagent/agents.ts | Subagent, Agent Core | Agent registry and discovery |
| subagent/isolation.ts | Subagent | Execution isolation and sandboxing |
| subagent/worker-registry.ts | Subagent | Worker process management |
| slash-commands/index.ts | Slash Commands, Commands | Command boilerplate generators extension |
| slash-commands/create-slash-command.ts | Slash Commands | Generator for new slash command scaffolding |
| slash-commands/create-extension.ts | Slash Commands, Extensions | Generator for new extension scaffolding |
| universal-config/index.ts | Universal Config | Multi-tool configuration file discovery |
| universal-config/discovery.ts | Universal Config | Configuration file discovery |
| universal-config/scanners.ts | Universal Config | Tool-specific config scanners |
| ttsr/index.ts | TTSR | TTSR regex engine — streaming output guardrails |
| ttsr/ttsr-manager.ts | TTSR | Streaming rule manager |
| ttsr/rule-loader.ts | TTSR | Rule loading and parsing |
| voice/index.ts | Voice | Voice input mode extension |
| voice/speech-recognizer.swift | Voice | macOS Swift speech recognizer |
| voice/speech-recognizer.py | Voice | Linux/Windows Python speech recognizer |
| cmux/index.ts | CMux | Tmux/multiplexer session management |
| mac-tools/index.ts | Mac Tools | macOS-specific utilities extension |
| mac-tools/swift-cli/Sources/main.swift | Mac Tools | macOS native tools Swift implementation |
| aws-auth/index.ts | Auth/OAuth | AWS authentication and credential handling |
| shared/ui.ts | TUI Components | Generic UI components and utilities |
| shared/tui.ts | TUI Components | Terminal UI helpers |
| shared/interview-ui.ts | TUI Components | Interview-style questionnaire UI |
| shared/confirm-ui.ts | TUI Components | Confirmation dialog UI |
| shared/terminal.ts | TUI Components | Terminal operations and formatting |
| shared/format-utils.ts | GSD Workflow | String formatting utilities |
| shared/sanitize.ts | GSD Workflow | Input sanitization |
| shared/frontmatter.ts | Config | YAML frontmatter parsing |

### src/resources/agents/

| File | System Label(s) | Description |
|------|-----------------|-------------|
| javascript-pro.md | Subagent | JavaScript specialist agent definition |
| typescript-pro.md | Subagent | TypeScript specialist agent definition |
| worker.md | Subagent | Generic worker agent definition |
| researcher.md | Subagent | Research and exploration agent definition |
| scout.md | Subagent | Scout/pathfinding agent definition |

### src/resources/skills/

| Skill Directory | System Label(s) | Description |
|-----------------|-----------------|-------------|
| react-best-practices/ | Skills | React development patterns (62 files) |
| userinterface-wiki/ | Skills | UI/UX guidelines and component reference (155 files) |
| create-skill/ | Skills | Skill creation scaffolding and templates (25 files) |
| create-gsd-extension/ | Skills, Extensions | GSD extension scaffolding (22 files) |
| code-optimizer/ | Skills | Performance optimization techniques (16 files) |
| agent-browser/ | Skills, Browser Tools | Browser automation guidance (11 files) |
| github-workflows/ | Skills | GitHub Actions workflow patterns (10 files) |
| debug-like-expert/ | Skills | Advanced debugging techniques (6 files) |
| make-interfaces-feel-better/ | Skills | UI/UX improvement patterns (5 files) |
| accessibility/ | Skills | WCAG and accessibility standards |
| core-web-vitals/ | Skills | Web performance metrics guidance |
| web-quality-audit/ | Skills | Quality audit procedures |
| best-practices/ | Skills | General development best practices |
| frontend-design/ | Skills | Frontend design principles |
| lint/ | Skills | Code linting standards |
| review/ | Skills | Code review guidelines |
| test/ | Skills | Testing strategies and patterns |
| web-design-guidelines/ | Skills | Web design principles |

---

## web/ — Web Frontend (Next.js)

### App Shell & Navigation

| File | System Label(s) | Description |
|------|-----------------|-------------|
| web/app/layout.tsx | Web UI | Root Next.js layout with theme provider and font |
| web/app/page.tsx | Web UI | Entry page loading GSDAppShell |
| web/components/gsd/app-shell.tsx | Web UI | Main app shell — sidebar, panels, terminal, commands |
| web/components/gsd/sidebar.tsx | Web UI | Multi-panel sidebar with milestone explorer |
| web/components/gsd/status-bar.tsx | Web UI | Status bar with workspace state and metrics |

### Main Views

| File | System Label(s) | Description |
|------|-----------------|-------------|
| web/components/gsd/dashboard.tsx | Web UI | Dashboard with workflow actions and metrics |
| web/components/gsd/chat-mode.tsx | Web UI | Chat interface for agent interaction |
| web/components/gsd/projects-view.tsx | Web UI | Project browser and selector |
| web/components/gsd/files-view.tsx | Web UI | File browser and explorer |
| web/components/gsd/activity-view.tsx | Web UI | Activity log and history view |
| web/components/gsd/roadmap.tsx | Web UI, GSD Workflow | Milestone roadmap visualization |
| web/components/gsd/visualizer-view.tsx | Web UI, Doctor/Diagnostics | Workflow visualization |
| web/components/gsd/project-welcome.tsx | Web UI | Welcome screen for new projects |
| web/components/gsd/knowledge-captures-panel.tsx | Web UI | Knowledge and capture management |

### Terminal

| File | System Label(s) | Description |
|------|-----------------|-------------|
| web/components/gsd/terminal.tsx | Web UI | Terminal widget with input mode handling |
| web/components/gsd/shell-terminal.tsx | Web UI | Shell terminal with PTY integration |
| web/components/gsd/main-session-terminal.tsx | Web UI | Main session terminal display |
| web/components/gsd/dual-terminal.tsx | Web UI | Side-by-side terminal layout |

### Commands & Dialogs

| File | System Label(s) | Description |
|------|-----------------|-------------|
| web/components/gsd/command-surface.tsx | Web UI, Commands | Command palette and slash command dispatcher |
| web/components/gsd/remaining-command-panels.tsx | Web UI, Commands | History, undo, export, cleanup panels |
| web/components/gsd/diagnostics-panels.tsx | Web UI, Doctor/Diagnostics | Doctor, forensics, skill health panels |
| web/components/gsd/settings-panels.tsx | Web UI, Config | Settings and preferences panels |
| web/components/gsd/guided-dialog.tsx | Web UI | Generic guided dialog component |
| web/components/gsd/update-banner.tsx | Web UI | Update notification banner |
| web/components/gsd/scope-badge.tsx | Web UI | Scope badge indicator |
| web/components/gsd/loading-skeletons.tsx | Web UI | Loading skeleton placeholders |
| web/components/gsd/code-editor.tsx | Web UI | Code editor display component |
| web/components/gsd/file-content-viewer.tsx | Web UI | File content viewer and previewer |
| web/components/gsd/focused-panel.tsx | Web UI | Focused panel layout component |

### Onboarding

| File | System Label(s) | Description |
|------|-----------------|-------------|
| web/components/gsd/onboarding-gate.tsx | Web UI, Onboarding | Gate and orchestration for onboarding flow |
| web/components/gsd/onboarding/step-welcome.tsx | Web UI, Onboarding | Welcome step |
| web/components/gsd/onboarding/step-mode.tsx | Web UI, Onboarding | User mode selection step |
| web/components/gsd/onboarding/step-provider.tsx | Web UI, Onboarding | LLM provider selection step |
| web/components/gsd/onboarding/step-authenticate.tsx | Web UI, Onboarding, Auth/OAuth | Authentication step |
| web/components/gsd/onboarding/step-dev-root.tsx | Web UI, Onboarding | Dev root directory selection step |
| web/components/gsd/onboarding/step-project.tsx | Web UI, Onboarding | Project selection step |
| web/components/gsd/onboarding/step-remote.tsx | Web UI, Onboarding | Remote configuration step |
| web/components/gsd/onboarding/step-optional.tsx | Web UI, Onboarding | Optional settings step |
| web/components/gsd/onboarding/step-ready.tsx | Web UI, Onboarding | Ready confirmation step |
| web/components/gsd/onboarding/wizard-stepper.tsx | Web UI, Onboarding | Stepper progress indicator |

### API Routes

| File | System Label(s) | Description |
|------|-----------------|-------------|
| web/app/api/boot/route.ts | API Routes, State Machine | Initial boot payload with project/workspace state |
| web/app/api/session/manage/route.ts | API Routes, Session Management | Session rename and management |
| web/app/api/session/browser/route.ts | API Routes, Session Management | Session browser listing |
| web/app/api/session/command/route.ts | API Routes, Session Management | Session command execution |
| web/app/api/session/events/route.ts | API Routes, Session Management | Session event streaming (SSE) |
| web/app/api/terminal/stream/route.ts | API Routes | PTY output streaming via SSE |
| web/app/api/terminal/input/route.ts | API Routes | Terminal input submission |
| web/app/api/terminal/resize/route.ts | API Routes | Terminal resize |
| web/app/api/terminal/sessions/route.ts | API Routes | Terminal session management |
| web/app/api/terminal/upload/route.ts | API Routes | File upload for terminal |
| web/app/api/bridge-terminal/stream/route.ts | API Routes, Web Mode | Bridge terminal output streaming |
| web/app/api/bridge-terminal/input/route.ts | API Routes, Web Mode | Bridge terminal input |
| web/app/api/bridge-terminal/resize/route.ts | API Routes, Web Mode | Bridge terminal resize |
| web/app/api/projects/route.ts | API Routes | Project discovery and listing |
| web/app/api/live-state/route.ts | API Routes, State Machine | Live workspace state updates |
| web/app/api/steer/route.ts | API Routes, Commands | Steering endpoint for agent direction |
| web/app/api/history/route.ts | API Routes, State Machine | History and metrics |
| web/app/api/undo/route.ts | API Routes, Commands | Undo operation |
| web/app/api/cleanup/route.ts | API Routes, Commands | Cleanup operation |
| web/app/api/export-data/route.ts | API Routes, Commands | Data export |
| web/app/api/knowledge/route.ts | API Routes, GSD Workflow | Knowledge base |
| web/app/api/hooks/route.ts | API Routes, GSD Workflow | Git hooks management |
| web/app/api/inspect/route.ts | API Routes, Doctor/Diagnostics | Inspection and analysis |
| web/app/api/doctor/route.ts | API Routes, Doctor/Diagnostics | Doctor diagnostic tool |
| web/app/api/forensics/route.ts | API Routes, Doctor/Diagnostics | Forensics analysis |
| web/app/api/skill-health/route.ts | API Routes, Doctor/Diagnostics | Skill health check |
| web/app/api/visualizer/route.ts | API Routes, Doctor/Diagnostics | Workflow visualization |
| web/app/api/preferences/route.ts | API Routes, Config | User preferences |
| web/app/api/settings-data/route.ts | API Routes, Config | Settings data |
| web/app/api/dev-mode/route.ts | API Routes, Config | Development mode toggle |
| web/app/api/captures/route.ts | API Routes, GSD Workflow | Knowledge captures |
| web/app/api/browse-directories/route.ts | API Routes | Directory browsing |
| web/app/api/files/route.ts | API Routes, Tool System | File system access |
| web/app/api/git/route.ts | API Routes, Tool System | Git operations |
| web/app/api/onboarding/route.ts | API Routes, Onboarding | Onboarding data |
| web/app/api/recovery/route.ts | API Routes, Doctor/Diagnostics | Recovery operations |
| web/app/api/remote-questions/route.ts | API Routes, Remote Questions | Remote question handling |
| web/app/api/shutdown/route.ts | API Routes | Graceful shutdown |
| web/app/api/update/route.ts | API Routes, CLI | Update check |

### Library & State

| File | System Label(s) | Description |
|------|-----------------|-------------|
| web/lib/auth.ts | Auth/OAuth | Client-side auth token management from URL fragment |
| web/lib/gsd-workspace-store.tsx | State Machine | Global workspace state store with external store |
| web/lib/project-store-manager.tsx | State Machine | Multi-project store manager with SSE lifecycle |
| web/lib/shutdown-gate.ts | State Machine | Graceful shutdown coordination |
| web/lib/browser-slash-command-dispatch.ts | Commands | Slash command dispatch |
| web/lib/workflow-actions.ts | GSD Workflow | Primary workflow action derivation logic |
| web/lib/workflow-action-execution.ts | GSD Workflow | Workflow action execution handler |
| web/lib/command-surface-contract.ts | Commands | Command surface request/response contract types |
| web/lib/pty-manager.ts | Web UI | Server-side PTY spawning and session management |
| web/lib/pty-chat-parser.ts | Web UI | PTY output parsing for chat display |
| web/lib/remaining-command-types.ts | Web UI | Browser-safe types for command surfaces |
| web/lib/knowledge-captures-types.ts | GSD Workflow | Knowledge entry and captures types |
| web/lib/diagnostics-types.ts | Doctor/Diagnostics | Diagnostics panel types |
| web/lib/settings-types.ts | Config | Settings and preferences types |
| web/lib/visualizer-types.ts | Doctor/Diagnostics | Workflow visualizer types |
| web/lib/session-browser-contract.ts | Session Management | Session browser contract types |
| web/lib/git-summary-contract.ts | Tool System | Git summary contract types |
| web/lib/utils.ts | Web UI | Common utility functions |
| web/lib/project-url.ts | Web UI | Project URL parsing and construction |
| web/lib/workspace-status.ts | Web UI, State Machine | Workspace status derivation |
| web/lib/image-utils.ts | Image Processing | Image handling and processing utilities |
| web/lib/use-editor-font-size.ts | Web UI | Editor font size preference hook |
| web/lib/use-terminal-font-size.ts | Web UI | Terminal font size preference hook |
| web/lib/use-user-mode.ts | Web UI | User mode hook |
| web/hooks/use-mobile.ts | Web UI | Mobile viewport detection hook |
| web/hooks/use-toast.ts | Web UI | Toast notification hook |
| web/components/theme-provider.tsx | Web UI | Theme provider for dark/light modes |
| web/components/ui/* (50+ files) | Web UI | Shadcn/ui base component library |

---

## vscode-extension/ — VS Code Extension

| File | System Label(s) | Description |
|------|-----------------|-------------|
| vscode-extension/src/extension.ts | VS Code Extension | Extension activation, client management, command registration |
| vscode-extension/src/gsd-client.ts | VS Code Extension, MCP Server/Client | RPC client for GSD agent communication |
| vscode-extension/src/chat-participant.ts | VS Code Extension | Chat participant for @gsd command |
| vscode-extension/src/sidebar.ts | VS Code Extension | Sidebar webview provider with status display |

---

## studio/ — Electron Desktop App

| File | System Label(s) | Description |
|------|-----------------|-------------|
| studio/electron.vite.config.ts | Studio App, Build System | Electron Vite build configuration |
| studio/src/main/index.ts | Studio App | Electron main process window creation |
| studio/src/preload/index.ts | Studio App | Context isolation preload for IPC bridge |
| studio/src/preload/index.d.ts | Studio App | Preload bridge type definitions |
| studio/src/renderer/src/main.tsx | Studio App | React renderer entry point |
| studio/src/renderer/src/App.tsx | Studio App | Main app component |
| studio/src/renderer/src/lib/theme/tokens.ts | Studio App | Design tokens (colors, fonts, sizes) |

---

## native/ — Rust Engine

| File | System Label(s) | Description |
|------|-----------------|-------------|
| native/crates/engine/src/lib.rs | Native/Rust Tools | N-API entry point exposing all Rust modules |
| native/crates/engine/src/grep.rs | File Search, Native/Rust Tools | Ripgrep-backed regex search with context/globbing |
| native/crates/engine/src/glob.rs | File Search, Native/Rust Tools | Glob-pattern FS discovery with gitignore + scan cache |
| native/crates/engine/src/fd.rs | File Search, Native/Rust Tools | Fuzzy file discovery for autocomplete/@-mentions |
| native/crates/engine/src/highlight.rs | Syntax Highlighting, Native/Rust Tools | Syntect-backed ANSI syntax highlighting |
| native/crates/engine/src/ast.rs | AST, Native/Rust Tools | Linker shim for AST N-API registrations |
| native/crates/engine/src/diff.rs | Text Processing, Native/Rust Tools | Fuzzy matching, Unicode normalization, unified diffs |
| native/crates/engine/src/image.rs | Image Processing, Native/Rust Tools | Image decode/encode and resize |
| native/crates/engine/src/html.rs | Text Processing, Native/Rust Tools | HTML to Markdown conversion |
| native/crates/engine/src/text.rs | Text Processing, Native/Rust Tools | ANSI-aware text measurement and slicing |
| native/crates/engine/src/truncate.rs | Text Processing, Native/Rust Tools | Line-boundary-aware output truncation |
| native/crates/engine/src/ps.rs | Native/Rust Tools | Cross-platform process tree management |
| native/crates/engine/src/clipboard.rs | Native/Rust Tools | Clipboard read/write for text and images |
| native/crates/engine/src/json_parse.rs | Text Processing, Native/Rust Tools | Streaming JSON parser with partial recovery |
| native/crates/engine/src/gsd_parser.rs | GSD Workflow, Native/Rust Tools | .gsd/ directory file parser (markdown, frontmatter) |
| native/crates/engine/src/ttsr.rs | TTSR, Native/Rust Tools | TTSR regex engine with compiled RegexSet |
| native/crates/engine/src/stream_process.rs | Text Processing, Native/Rust Tools | Bash stream processor (UTF-8, ANSI strip, binary) |
| native/crates/engine/src/xxhash.rs | Native/Rust Tools | xxHash32 for hashline edit tool |
| native/crates/engine/src/git.rs | Native/Rust Tools | Native git operations via libgit2 |
| native/crates/engine/src/fs_cache.rs | File Search, Native/Rust Tools | TTL-based FS scan cache with explicit invalidation |
| native/crates/engine/src/glob_util.rs | File Search, Native/Rust Tools | Shared glob-pattern helpers |
| native/crates/engine/src/task.rs | Native/Rust Tools | Blocking work on libuv thread pool with cancellation |
| native/crates/engine/build.rs | Build System | Cargo build script for napi-build compilation |
| native/crates/grep/src/lib.rs | File Search, Native/Rust Tools | Ripgrep search library (in-memory and on-disk) |
| native/crates/ast/src/lib.rs | AST, Native/Rust Tools | AST-aware structural search and rewrite engine |
| native/crates/ast/src/ast.rs | AST, Native/Rust Tools | ast-grep integration for structural code search |
| native/crates/ast/src/language/mod.rs | AST, Native/Rust Tools | Vendored language defs and tree-sitter bindings |
| native/crates/ast/src/language/parsers.rs | AST, Native/Rust Tools | Pre-compiled tree-sitter parsers (50+ languages) |

## packages/native/src/ — Node.js Rust Bindings

| File | System Label(s) | Description |
|------|-----------------|-------------|
| packages/native/src/native.ts | Native/Rust Tools, Node.js Bindings | Native addon loader with platform fallback |
| packages/native/src/grep/index.ts | File Search, Node.js Bindings | Ripgrep wrapper for regex search |
| packages/native/src/fd/index.ts | File Search, Node.js Bindings | Fuzzy file discovery wrapper |
| packages/native/src/highlight/index.ts | Syntax Highlighting, Node.js Bindings | Syntax highlighting wrapper |
| packages/native/src/image/index.ts | Image Processing, Node.js Bindings | Image processing wrapper |
| packages/native/src/html/index.ts | Text Processing, Node.js Bindings | HTML to Markdown wrapper |
| packages/native/src/diff/index.ts | Text Processing, Node.js Bindings | Text diffing wrapper |
| packages/native/src/ps/index.ts | Native/Rust Tools, Node.js Bindings | Process tree management wrapper |
| packages/native/src/truncate/index.ts | Text Processing, Node.js Bindings | Output truncation wrapper |
| packages/native/src/json-parse/index.ts | Text Processing, Node.js Bindings | JSON parsing wrapper |
| packages/native/src/stream-process/index.ts | Text Processing, Node.js Bindings | Stream processing wrapper |
| packages/native/src/ttsr/index.ts | TTSR, Node.js Bindings | TTSR regex engine wrapper |

---

## tests/ — Test Suite

| File / Directory | System Label(s) | Description |
|------------------|-----------------|-------------|
| tests/smoke/run.ts | Integration Tests | Test runner for smoke tests |
| tests/smoke/test-help.ts | Integration Tests | Smoke test for help command |
| tests/smoke/test-init.ts | Integration Tests | Smoke test for initialization |
| tests/smoke/test-version.ts | Integration Tests | Smoke test for version command |
| tests/fixtures/run.ts | Integration Tests | Fixture-based test harness with recording replay |
| tests/fixtures/provider.ts | Integration Tests | Fixture provider and replayer for LLM turns |
| tests/fixtures/record.ts | Integration Tests | Recording fixture capture |
| tests/fixtures/recordings/*.json | Integration Tests | Pre-recorded LLM agent interaction fixtures |
| tests/live/run.ts | Integration Tests | Live API roundtrip test runner |
| tests/live/test-anthropic-roundtrip.ts | Integration Tests, AI Providers | Live Anthropic API integration test |
| tests/live/test-openai-roundtrip.ts | Integration Tests, AI Providers | Live OpenAI API integration test |
| tests/live-regression/run.ts | Integration Tests | Live regression test runner |
| tests/repro-worktree-bug/*.mjs | Integration Tests, Worktree | Worktree bug reproduction scripts |

---

## scripts/ — Build & Utility

| File | System Label(s) | Description |
|------|-----------------|-------------|
| scripts/dev.js | Build System | Dev supervisor — tsc and resource watcher |
| scripts/dev-cli.js | Build System | CLI development mode runner |
| scripts/watch-resources.js | Build System | Resource file watcher for hot reload |
| scripts/bump-version.mjs | Build System | Version bumper for package.json and platform packages |
| scripts/sync-pkg-version.cjs | Build System | Sync pkg/package.json with workspace version |
| scripts/copy-resources.cjs | Build System | Resource file copier for distribution |
| scripts/copy-export-html.cjs | Build System | HTML export asset copier |
| scripts/copy-themes.cjs | Build System | Theme file copier |
| scripts/link-workspace-packages.cjs | Build System | Workspace package symlink manager |
| scripts/ensure-workspace-builds.cjs | Build System | Postinstall build checker |
| scripts/build-web-if-stale.cjs | Build System | Conditional web build trigger |
| scripts/stage-web-standalone.cjs | Build System | Web standalone staging |
| scripts/generate-changelog.mjs | Build System | Changelog generator from commits |
| scripts/update-changelog.mjs | Build System | Changelog updater |
| scripts/version-stamp.mjs | Build System | Version timestamp generator |
| scripts/validate-pack.sh | Build System | Package validation script |
| scripts/validate-pack.js | Build System | Package validation (Node.js) |
| scripts/install-pi-global.js | Build System | Global installation helper |
| scripts/uninstall-pi-global.js | Build System | Global uninstallation helper |
| scripts/install-hooks.sh | Build System, GSD Workflow | Git hook installer |
| scripts/secret-scan.sh | Build System, Auth/OAuth | Secret scanning for credentials |
| scripts/docs-prompt-injection-scan.sh | Build System | Prompt injection detection in docs |
| scripts/check-skill-references.mjs | Build System, Skills | Skill reference validator |
| scripts/preview-dashboard.ts | Web Mode | Dashboard preview server |
| scripts/ci_monitor.cjs | Build System | CI monitoring dashboard |
| scripts/recover-gsd-1364.sh | Build System, Migration | Recovery script for issue #1364 |
| scripts/recover-gsd-1364.ps1 | Build System, Migration | Recovery script for issue #1364 (PowerShell) |
| scripts/recover-gsd-1668.sh | Build System, Migration | Recovery script for issue #1668 |
| scripts/recover-gsd-1668.ps1 | Build System, Migration | Recovery script for issue #1668 (PowerShell) |

---

## System → File Reverse Index

Quick lookup: which files are part of each system?

| System | Key Files (abbreviated) |
|--------|------------------------|
| **Agent Core** | pi-agent-core/src/*, pi-coding-agent/src/core/agent-session.ts, agent-loop.ts, agent.ts, event-bus.ts, sdk.ts |
| **AI Providers** | pi-ai/src/providers/*, pi-ai/src/stream.ts, pi-ai/src/models*.ts |
| **API Routes** | web/app/api/**/*.ts |
| **AST** | native/crates/ast/*, packages/native/src/ast/ |
| **Async Jobs** | src/resources/extensions/async-jobs/* |
| **Auth / OAuth** | pi-ai/src/utils/oauth/*, src/web/web-auth-storage.ts, core/auth-storage.ts, src/pi-migration.ts, aws-auth/index.ts, web/lib/auth.ts |
| **Auto Engine** | src/resources/extensions/gsd/auto*.ts, gsd/auto-loop.ts, gsd/auto-supervisor.ts, gsd/unit-runtime.ts |
| **Bg Shell** | src/resources/extensions/bg-shell/* |
| **Browser Tools** | src/resources/extensions/browser-tools/* |
| **Build System** | scripts/*, native/crates/engine/build.rs |
| **CLI** | src/cli.ts, src/cli-web-branch.ts, src/help-text.ts, src/update*.ts, pi-coding-agent/src/cli.ts, src/worktree-cli.ts |
| **CMux** | src/resources/extensions/cmux/index.ts |
| **Commands** | gsd/commands*.ts, gsd/exit-command.ts, gsd/undo.ts, gsd/kill.ts, pi-coding-agent/src/core/slash-commands.ts |
| **Compaction** | pi-coding-agent/src/core/compaction*.ts, core/compaction/* |
| **Config** | src/app-paths.ts, src/models-resolver.ts, src/remote-questions-config.ts, src/wizard.ts, core/defaults.ts, core/constants.ts, config.ts |
| **Context7** | src/resources/extensions/context7/index.ts |
| **Doctor / Diagnostics** | gsd/doctor*.ts, gsd/collision-diagnostics.ts, core/diagnostics.ts, web/lib/diagnostics-types.ts, web/app/api/doctor/*, forensics/* |
| **Event System** | pi-coding-agent/src/core/event-bus.ts, gsd/auto-observability.ts |
| **Extension Registry** | src/extension-discovery.ts, src/extension-registry.ts, src/bundled-extension-paths.ts |
| **Extensions** | pi-coding-agent/src/core/extensions/*, src/resource-loader.ts |
| **File Search** | native/crates/engine/src/grep.rs, glob.rs, fd.rs, fs_cache.rs, packages/native/src/grep/*, fd/*, core/tools/grep.ts, find.ts |
| **GSD Workflow** | src/resources/extensions/gsd/* (non-auto), gsd/reports.ts, gsd/notifications.ts, gsd/prompts/*, gsd/workflow-templates/* |
| **Google Search** | src/resources/extensions/google-search/index.ts |
| **Headless Mode** | src/headless*.ts |
| **Image Processing** | native/crates/engine/src/image.rs, packages/native/src/image/*, utils/image-*.ts, web/lib/image-utils.ts |
| **Integration Tests** | tests/**/* |
| **Loader / Bootstrap** | src/loader.ts, src/resource-loader.ts, src/tool-bootstrap.ts, src/bundled-resource-path.ts, gsd/bootstrap/* |
| **LSP** | pi-coding-agent/src/core/lsp/* |
| **Mac Tools** | src/resources/extensions/mac-tools/* |
| **MCP Server/Client** | src/mcp-server.ts, src/resources/extensions/mcp-client/index.ts, vscode-extension/src/gsd-client.ts, modes/rpc/* |
| **Memory Extension** | pi-coding-agent/src/resources/extensions/memory/* |
| **Migration** | gsd/migrate/*, src/pi-migration.ts, pi-coding-agent/src/migrations.ts, scripts/recover-*.sh |
| **Modes** | pi-coding-agent/src/modes/* |
| **Model System** | pi-coding-agent/src/core/model-*.ts, pi-ai/src/models*.ts, pi-ai/src/api-registry.ts, gsd/model-router.ts |
| **Native / Rust Tools** | native/crates/engine/src/* |
| **Node.js Bindings** | packages/native/src/* |
| **Onboarding** | src/onboarding.ts, src/wizard.ts, web/components/gsd/onboarding/*, web/app/api/onboarding/* |
| **Permissions** | core/extensions/project-trust.ts, core/auth-storage.ts |
| **Remote Questions** | src/resources/extensions/remote-questions/* |
| **Search the Web** | src/resources/extensions/search-the-web/* |
| **Session Management** | pi-coding-agent/src/core/session-manager.ts, core/settings-manager.ts, web/app/api/session/* |
| **Skills** | src/resources/skills/*, gsd/skill-telemetry.ts, gsd/preferences-skills.ts, core/skills.ts |
| **Slash Commands** | src/resources/extensions/slash-commands/* |
| **State Machine** | gsd/state.ts, gsd/history.ts, gsd/json-persistence.ts, gsd/memory-store.ts, gsd/reactive-graph.ts, core/agent-session.ts, web/lib/gsd-workspace-store.tsx |
| **Studio App** | studio/* |
| **Subagent** | src/resources/extensions/subagent/*, src/resources/agents/* |
| **Syntax Highlighting** | native/crates/engine/src/highlight.rs, packages/native/src/highlight/* |
| **Text Processing** | native/crates/engine/src/diff.rs, html.rs, text.rs, truncate.rs, json_parse.rs, stream_process.rs |
| **Tool System** | pi-coding-agent/src/core/tools/*, core/bash-executor.ts, core/exec.ts |
| **TTSR** | src/resources/extensions/ttsr/*, native/crates/engine/src/ttsr.rs, packages/native/src/ttsr/* |
| **TUI Components** | packages/pi-tui/src/*, pi-coding-agent/src/modes/interactive/components/*, pi-coding-agent/src/modes/interactive/controllers/* |
| **Universal Config** | src/resources/extensions/universal-config/* |
| **Voice** | src/resources/extensions/voice/* |
| **VS Code Extension** | vscode-extension/src/* |
| **Web Mode** | src/web/*.ts, src/web-mode.ts |
| **Web UI** | web/app/*.tsx, web/components/*, web/hooks/*, web/lib/* |
| **Worktree** | src/worktree-cli.ts, src/worktree-name-gen.ts, gsd/worktree*.ts, tests/repro-worktree-bug/* |
