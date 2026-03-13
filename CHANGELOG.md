# Changelog

All notable changes to GSD are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.10.5] - 2026-03-13

### Fixed
- `optionalDependencies` in published `gsd-pi@2.10.4` were still pinned to `2.10.2`, causing users to install the broken engine binaries that 2.10.4 was meant to fix (#276)

## [2.10.4] - 2026-03-13

### Fixed
- Native binary distribution — `.node` binaries were missing from the npm tarball, causing startup crashes on all platforms since v2.10.0
- Native loader resolution chain: tries `@gsd-build/engine-{platform}` npm package first, then local dev build, with clear error messages listing supported platforms

### Added
- Per-platform optional dependency packages (`@gsd-build/engine-*`) for macOS (ARM64/x64), Linux (x64/ARM64), and Windows (x64)
- Cross-platform native binary CI build and publish workflow
- Version synchronization script for lock-step platform package releases

## [2.10.2] - 2026-03-13

### Added
- Native Rust TTSR regex engine — pre-compiles all stream rule conditions into a single `RegexSet` for one-pass DFA matching instead of O(rules × conditions) JS regex iteration
- Native Rust diff engine — fuzzy text matching (`fuzzyFindText`, `normalizeForFuzzyMatch`) and unified diff generation (`generateDiff`) via the `similar` crate, replacing the `diff` npm package
- Native Rust GSD file parser — frontmatter parsing, section extraction, batch `.gsd/` directory parsing, and structured roadmap parsing with transparent JS fallback

## [2.10.1] - 2026-03-13

### Fixed
- `@gsd/native` package ships pre-compiled JavaScript instead of raw TypeScript, fixing startup crashes on Node.js 20, 22, and 24 (#248)

## [2.10.0] - 2026-03-13

### Added
- Native Rust engine with high-performance N-API modules replacing JS/WASM dependencies:
  - **grep** — ripgrep-backed content and filesystem search
  - **glob** — gitignore-aware file discovery with scan caching
  - **ps** — cross-platform process tree management
  - **clipboard** — native clipboard access via arboard (text + image)
  - **highlight** — syntect-based syntax highlighting (replaces `cli-highlight`)
  - **ast** — structural code search and rewrite via ast-grep (38+ languages)
  - **html** — HTML-to-Markdown conversion
  - **text** — ANSI-aware text measurement, wrapping, truncation, and slicing
  - **fd** — fuzzy file path discovery for autocomplete
  - **image** — decode, encode, and resize images (PNG, JPEG, GIF, WebP)
- Background shell `env` action to query shell session environment state
- Background shell `run` action for blocking command execution on persistent sessions
- Background shell `session` process type for persistent interactive sessions
- Hashline edits — line-hash-anchored file editing
- Universal config discovery extension

### Changed
- Find tool uses native Rust glob instead of `fd` CLI binary
- Syntax highlighting uses native syntect instead of `cli-highlight` npm package
- Autocomplete uses native fd module instead of `fd` CLI subprocess
- Text utilities (visible width, wrapping, truncation, slicing) use native Rust instead of JS
- Clipboard operations use native arboard instead of platform-specific CLI tools
- Image processing uses native Rust `image` crate instead of Photon WASM

### Fixed
- Prevent move operation from silently overwriting existing files
- Separate access/unlink error handling in delete path
- Untrack runtime files from slice branch before squash-merge
- Copy LSP defaults.json to dist during build
- Native module test assertions

## [2.9.0] - 2026-03-13

### Added
- LSP tool — full Language Server Protocol integration with diagnostics, go-to-definition, references, hover, document/workspace symbols, rename, code actions, type definition, and implementation support
- `/thinking` slash command for toggling thinking level during sessions
- Interactive wizard mode for `/gsd prefs` with guided configuration
- Startup update check with 24-hour cache — notifies when a new version is available

### Fixed
- TypeScript type errors across gsd, browser-tools, search-the-web, and misc extension files
- Milestone ID generation uses max-based approach instead of length+1 (prevents ID collisions)
- Non-thinking models handled correctly in `/thinking` command
- Auto-mode pauses on provider errors to prevent reassess-roadmap loop
- TAB hint displayed for notes input in discuss-mode survey
- Slice branches merge to integration branch instead of main
- Prefs wizard audit findings addressed
- Deduplicated maxNum logic with test coverage
- Command injection eliminated in LSP config `which()` function
- Unhandled JSON.parse in LSP message reader wrapped with error handling

## [2.8.3] - 2026-03-13

### Fixed
- `ask_user_questions` handles undefined `custom()` result in RPC mode
- Provider-aware model resolution for per-phase preferences (respects `provider` field instead of parsing model name prefixes)
- Execute-task artifact verification aligned with `deriveState` — adds self-repair for missing artifacts
- Research phase infinite loop broken; state synced on stop
- Auto-resolve merge conflicts on `.gsd/` runtime files
- Auto-switch model after `/login` and `/logout` to prevent API key errors
- Anthropic provider detection uses `provider` field instead of model name prefix matching

## [2.8.2] - 2026-03-13

### Fixed
- Path operations use `node:path` stdlib instead of hardcoded forward slashes, fixing cross-platform compatibility
- Prompts use relative paths to prevent Windows drive letter mangling
- Runtime files already in the git index are untracked to prevent merge conflicts
- HTTP_PROXY and HTTPS_PROXY environment variables respected for all outbound requests
- Windows NUL redirects sanitized to /dev/null in Git Bash environments

### Changed
- `.claude/` and `.gsd/` directories untracked from repo, `*.tgz` gitignored

## [2.8.1] - 2026-03-13

### Added
- Discussion depth verification and context write-gate for richer milestone discussions
- TTSR + blob/artifact storage (ported from oh-my-pi)
- Skip/discard escape hatches in no-roadmap wizard
- Configurable `merge_strategy` preference for slice completion

### Fixed
- `fsevents` bumped to ~2.3.3 for Node 25 compatibility; added as optional dep for Linux installs
- Observability warnings injected into agent prompt for enforcement
- Auto-detect headless environment for Playwright browser launch
- UAT artifact verified before marking complete-slice done
- Prior slices must complete on main before next slice dispatches
- smartStage fallback bypasses runtime exclusions when `.gsd/` is gitignored
- `/exit` uses graceful shutdown instead of hard kill

## [2.8.0] - 2026-03-13

### Added
- Browser tools: `browser_analyze_form` and `browser_fill_form` — form field inventory and intelligent filling by label/name/placeholder
- Browser tools: `browser_find_best` — scored element candidates for semantic intents
- Browser tools: `browser_act` — execute common browser micro-tasks in one call
- Browser tools: 108 unit and integration tests covering all new components

### Changed
- Browser tools: decomposed 5000-line monolithic `index.ts` into focused modules (state, capture, settle, lifecycle, refs, utils) with 11 categorized tool files
- Browser tools: consolidated state capture reduces evaluate round-trips per action
- Browser tools: zero-mutation settle short-circuit for faster page interaction
- Browser tools: conditional body text capture — low-signal tools skip it for smaller token payloads
- Browser tools: screenshot resizing uses `sharp` instead of canvas evaluate calls
- Browser tools: screenshots opt-in on navigate (no longer sent by default)

## [2.7.1] - 2026-03-13

### Added
- Model fallback support for auto-mode phases — if the configured model fails, GSD tries alternate models before stopping
- `/kill` command for immediate process termination

### Fixed
- `npm install -g gsd-pi` now works — workspace packages bundled in npm tarball via `bundleDependencies`
- External PI ecosystem packages (pi-rtk, pi-context, etc.) can now resolve `@mariozechner/*` imports through jiti aliases
- Missing `export-html` vendor files (marked.min.js, highlight.min.js) restored
- Skipped API keys now persist so the setup wizard doesn't repeat on every launch
- Provider config and extension loading reused correctly

### Changed
- `/exit` uses graceful shutdown (saves session state); `/kill` replaces the old immediate-exit behavior

## [2.7.0] - 2026-03-12

### Changed
- Vendor Pi SDK source (tui, ai, agent-core, coding-agent) into workspace monorepo under `packages/`, replacing the compiled npm dependency and patch-package workflow. Pi internals are now directly modifiable as TypeScript source.
- Existing patches (setModel persist option, Windows VT input caching) applied as source edits.
- Build pipeline runs workspace packages in dependency order before GSD compilation.
- Removed `patch-package` from devDependencies and postinstall.

## [2.6.0] - 2026-03-12

### Added
- Proactive secret management — planning phase forecasts required API keys into a manifest; auto-mode collects pending secrets before dispatching the first slice
- `--continue` / `-c` CLI flag to resume the most recent session

### Fixed
- Doctor post-hook no longer preempts `complete-slice` dispatch
- `main_branch` preference restored; `runPreMergeCheck` implemented for merge safety
- Recovery/retry prompt injection capped to prevent V8 OOM on large sessions
- `.gsd/` excluded from pre-switch auto-commits to prevent squash merge conflicts

## [2.5.1] - 2026-03-12

### Added
- `secure_env_collect` now auto-detects existing keys, destination files, and provides guidance field for better onboarding UX

### Changed
- Right-sized pipeline for simple work — single-slice milestones skip redundant research/plan sessions, reducing 9-10 sessions to 5-6
- Heavyweight plan sections (Proof Level, Integration Closure, Observability) are now conditional, omitted for simple slices

### Fixed
- Squash-merge now aborts cleanly on conflict and stops auto-mode instead of looping with corrupted state
- Resolved baked-in merge conflict markers in loader.ts, logo.ts, and postinstall.js

## [2.5.0] - 2026-03-12

### Added
- Native Anthropic web search — Claude models get server-side web search automatically, no Brave API key required
- GitService fully wired into codebase — programmatic git operations replace shell-based git commands in prompts
- Merge guards prevent slice completion when uncommitted changes or conflicts exist
- Snapshot support for saving and restoring `.gsd/` state
- Auto-push after slice squash-merge to main
- Rich commit messages with structured metadata

### Fixed
- State machine deadlock when units fail to produce expected artifacts — retry and cross-validation now gate completion
- Duplicate Brave search tools when toggling providers repeatedly
- Windows test glob patterns (single quotes → unquoted for shell expansion)
- Conversation replay error caused by thinking blocks in stored history
- Brave search tools removed from API payload when no `BRAVE_API_KEY` is set
- Restore notifications suppressed on session resume to reduce UX noise

## [2.4.0] - 2026-03-12

### Added
- Automatic migration of provider credentials from existing Pi installations — skip re-authentication when switching to GSD
- Pi extensions from `~/.pi/agent/extensions/` discoverable in interactive mode
- GitService core implementation for programmatic git operations

### Changed
- System prompt compressed by 48% (360 → 187 lines) for better context efficiency
- Refined agent character and communication style prompts
- Added craft standards, self-debugging awareness, and work narration to agent prompts

### Fixed
- RPC mode crash when `ctx.ui.theme` is undefined (#121)

## [2.3.11] - 2026-03-12

### Added
- Branded clack-based onboarding wizard on first launch — LLM provider selection (OAuth + API key), optional tool API keys, and setup summary (#118)
- `gsd config` subcommand to re-run the setup wizard anytime
- Shared `src/logo.ts` module as single source of truth for ASCII banner

### Fixed
- Parallel subagent results no longer truncated at 200 characters

### Changed
- `wizard.ts` trimmed to env hydration only — onboarding logic moved to `onboarding.ts`
- First-launch banner removed from `loader.ts` (onboarding wizard handles branding)

## [2.3.10] - 2026-03-12

### Added
- Branded postinstall experience with animated spinners, progress indicators, and clean summary (#115)

### Fixed
- Ctrl+Alt shortcuts (dashboard, bg manager, voice) now show slash-command fallback in terminals that lack Kitty keyboard protocol support — macOS Terminal.app, JetBrains IDEs (#100, #104)

## [2.3.9] - 2026-03-12

### Added
- Tavily as alternative web search provider alongside Brave Search (#102)
- Auto-mode progress widget now shows all stats; footer hidden during auto-mode (#75)

### Fixed
- Auto-mode infinite loop and closeout instability — idempotent unit dispatch, retry caps, and atomic closeout (#96, #109)
- Migration no longer requires ROADMAP.md — milestones inferred from phases/ directory when missing (#93, #90)
- Worktree branch safety — proper namespacing and slice branch base selection (#92)
- Windows: use `execFile` to avoid single-quote shell issues (#103)
- Broken `read @GSD-WORKFLOW.md` references replaced with `/gsd` command (#88)
- Google Search extension updated to use `gemini-2.5-flash` (#83)
- Duplicate `getCurrentBranch` import in auto.ts (#87)
- `formatCost` crash on non-number cost values (#74)
- Avoid `sudo` prompts in postinstall script (#73)
- `.gsd/` folder removed from git tracking; consolidated `.gitignore` (#78)
- Multiple community-reported bugs across CLI, auto-mode, and extensions

## [2.3.8] - 2026-03-11

### Fixed
- Worktree file operations (Write, Read, Edit) now resolve paths against the active working directory instead of the launch directory (#72)
- Auto-mode merge guard handles all slice completion paths, preventing infinite dispatch loops when `complete-slice` is bypassed (#71)

## [2.3.7] - 2026-03-11

### Added
- Remote user questions via Slack/Discord for headless auto-mode sessions

### Fixed
- Auto-mode model switches no longer persist as the user's global default (#30)
- Auto-mode resume now rebuilds disk state and runs doctor before dispatching, preventing inline execution after pause (#16)
- Silent dispatch failure when command context is null now surfaces an error notification
- Race condition between timeout handlers and prompt dispatch in auto-mode
- Remote questions: validate IDs before test-send, sanitize error messages to prevent token leakage
- Remote questions: cap user_note at 500 chars to prevent LLM context injection
- Remote questions: validate channel ID format to prevent SSRF
- Remote questions: add 15s per-request fetch timeout to adapters
- Remote questions: distinguish Discord 404 from auth errors in reactions
- Prompt store sorting uses `updatedAt` instead of filename
- TypeScript parameter properties desugared for `--experimental-strip-types` compatibility

### Changed
- Remote question result details use discriminated union type

## [2.3.6] - 2026-03-11

### Fixed
- Postinstall no longer triggers hidden `sudo` prompt on Linux — Playwright's `--with-deps` flag is no longer run automatically, preventing `npm install -g` from appearing to hang (#67)
- Auto-commit dirty files before branch switch to prevent lost work during slice transitions

### Changed
- Updated README to reflect current commands, extensions, and step mode workflow

## [2.3.5] - 2026-03-11

### Fixed
- Voice extension: transcription no longer lost when pausing and resuming recording

## [2.3.4] - 2026-03-11

### Added
- CHANGELOG.md with curated history from v0.1.6 onwards
- Project-local `/publish-version` command for npm releases
- GitHub Sponsors funding configuration
- npm publish and install smoke test

## [0.3.3] - 2026-03-11

### Added
- `/gsd next` step mode — walk through units one at a time with a wizard between each
- `/gsd` bare command defaults to step mode
- `/exit` command to kill the GSD process immediately
- `/clear` as alias for `/new` (new session)
- MCPorter extension for lazy on-demand MCP server integration
- `/voice` extension for real-time speech-to-text
- Pi global install scripts
- Post-hook bookkeeping: auto-run doctor + rebuild STATE.md after each unit

### Changed
- Improved worktree merge, create, remove, and reload resilience
- Discuss prompt rewritten with reflection step and depth enforcement

### Fixed
- Idle watchdog false-firing on active agents — tasks >10min no longer get incorrectly skipped (#52)
- Browser screenshots constrained to 1568px max dimension (#56)
- Pi extensions loaded from `~/.pi/agent/extensions/` (#51)

### Removed
- `/gsd-run` command (replaced by `/gsd` and `/gsd next`)

## [0.3.1] - 2026-03-11

### Fixed
- Windows VT input restored after child processes exit (#41)
- Print/JSON mode in cli.js so subagents don't hang
- Discuss prompt loop prevention
- Managed tools bootstrap and gh auth
- Session list scoped to current working directory
- Bash/bg_shell hang and kill issues on Windows (#40)
- `/gsd-run` hardcoded `~/.pi/` path (#38)
- Windows backspace in masked input + custom browser path support (#36, #34)

### Changed
- Renamed "Get Stuff Done" to "Get Shit Done"

## [0.3.0] - 2026-03-11

### Added
- `/worktree` (`/wt`) — git worktree lifecycle management (#31)
- `/gsd migrate` — `.planning` to `.gsd` migration tool (#28)

### Fixed
- Skipped API keys now persist so wizard doesn't repeat on every launch (#27)
- Scoped models restored from settings on new session startup (#22)
- Startup fallback no longer overwrites user's default model with Sonnet (#29)

## [0.2.9] - 2026-03-11

### Fixed
- Idle recovery skips stuck units instead of silently stalling (#19)
- `pkg/package.json` version synced with pi-coding-agent to prevent false update banner
- Milestones with summary but no roadmap treated as complete (#13)

## [0.2.8] - 2026-03-11

### Added
- Mac-tools extension (macOS native automation)

## [0.2.6] - 2026-03-11

### Fixed
- Default model validated against full registry on every startup

## [0.2.5] - 2026-03-11

### Fixed
- Circular self-dependency removed, default model set to anthropic/claude-sonnet-4-6 with thinking off

## [0.2.4] - 2026-03-11

### Added
- Branded setup wizard UI with visual hierarchy, descriptions, and status feedback
- Branded banner on first launch
- Postinstall banner with version and next-step hint

### Fixed
- All `.pi/` paths updated to `.gsd/`
- Default model matching by `id.includes('sonnet')` for dated API IDs
- Circular gsd-pi self-dependency removed
- Pi SDK version check suppressed
- Selected options stay lit when notes field is focused

## [0.1.6] - 2026-03-11

### Added
- GitHub extension tool suite with confirmation gate
- Bundled skills: frontend-design, swiftui, debug-like-expert
- Skills trigger table in system prompt
- Resource loader syncs bundled skills to `~/.gsd/agent/skills/`

### Fixed
- `~/.gsd/agent/` paths in prompt templates instead of `~/.pi/agent/` (#10)
- Guard against re-injecting discuss prompt when session already in flight

### Changed
- License updated to MIT

[Unreleased]: https://github.com/gsd-build/gsd-2/compare/v2.10.4...HEAD
[2.10.4]: https://github.com/gsd-build/gsd-2/compare/v2.10.2...v2.10.4
[2.10.2]: https://github.com/gsd-build/gsd-2/compare/v2.10.1...v2.10.2
[2.10.1]: https://github.com/gsd-build/gsd-2/compare/v2.10.0...v2.10.1
[2.10.0]: https://github.com/gsd-build/gsd-2/compare/v2.9.0...v2.10.0
[2.9.0]: https://github.com/gsd-build/gsd-2/compare/v2.8.3...v2.9.0
[2.8.3]: https://github.com/gsd-build/gsd-2/compare/v2.8.2...v2.8.3
[2.8.2]: https://github.com/gsd-build/gsd-2/compare/v2.8.1...v2.8.2
[2.8.1]: https://github.com/gsd-build/gsd-2/compare/v2.8.0...v2.8.1
[2.8.0]: https://github.com/gsd-build/gsd-2/compare/v2.7.1...v2.8.0
[2.7.1]: https://github.com/gsd-build/gsd-2/compare/v2.7.0...v2.7.1
[2.7.0]: https://github.com/gsd-build/gsd-2/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/gsd-build/gsd-2/compare/v2.5.1...v2.6.0
[2.5.1]: https://github.com/gsd-build/gsd-2/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/gsd-build/gsd-2/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/gsd-build/gsd-2/compare/v2.3.11...v2.4.0
[2.3.11]: https://github.com/gsd-build/gsd-2/compare/v2.3.10...v2.3.11
[2.3.10]: https://github.com/gsd-build/gsd-2/compare/v2.3.9...v2.3.10
[2.3.9]: https://github.com/gsd-build/gsd-2/compare/v2.3.8...v2.3.9
[2.3.8]: https://github.com/gsd-build/gsd-2/compare/v2.3.7...v2.3.8
[2.3.7]: https://github.com/gsd-build/gsd-2/compare/v2.3.6...v2.3.7
[2.3.6]: https://github.com/gsd-build/gsd-2/compare/v2.3.5...v2.3.6
[2.3.5]: https://github.com/gsd-build/gsd-2/compare/v2.3.4...v2.3.5
[2.3.4]: https://github.com/gsd-build/gsd-2/compare/v0.3.3...v2.3.4
[0.3.3]: https://github.com/gsd-build/gsd-2/compare/v0.3.1...v0.3.3
[0.3.1]: https://github.com/gsd-build/gsd-2/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/gsd-build/gsd-2/compare/v0.2.9...v0.3.0
[0.2.9]: https://github.com/gsd-build/gsd-2/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/gsd-build/gsd-2/compare/v0.2.6...v0.2.8
[0.2.6]: https://github.com/gsd-build/gsd-2/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/gsd-build/gsd-2/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/gsd-build/gsd-2/compare/v0.1.6...v0.2.4
[0.1.6]: https://github.com/gsd-build/gsd-2/releases/tag/v0.1.6
