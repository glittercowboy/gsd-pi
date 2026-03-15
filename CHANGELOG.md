# Changelog

All notable changes to GSD are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.14.4] - 2026-03-15

### Fixed
- **Session cwd update** — `newSession()` now updates the LLM's perceived working directory to reflect `process.chdir()` into auto-worktrees. Previously the system prompt was frozen at the original project root, causing the LLM to `cd` back and write files to the wrong location. This was the root cause of complete-slice and plan-slice loops in worktree-based projects.

## [2.14.3] - 2026-03-15

### Fixed
- **Copy planning artifacts into new auto-worktrees** — `createAutoWorktree` now copies `.gsd/milestones/`, `DECISIONS.md`, `REQUIREMENTS.md`, `PROJECT.md` from the source repo into the worktree. Prevents plan-slice loops in projects with pre-v2.14.0 `.gitignore`.

## [2.14.2] - 2026-03-15

### Fixed
- **Dispatch reentrancy deadlock** — `_dispatching` flag was never reset after first dispatch, permanently blocking all subsequent unit dispatches. Wrapped in try/finally.
- **`.gitignore` self-heal** — existing projects with blanket `.gsd/` ignore now auto-remove it on next auto-mode start, replacing with explicit runtime-only patterns so planning artifacts are tracked in git.
- **Discuss depth verification** — render summary as chat text (markdown renders), use ask_user_questions for short confirmation only.

## [2.14.1] - 2026-03-15

### Fixed
- **Quiet auto-mode warnings** — internal recovery machinery (dispatch gap watchdog, model fallback chain) downgraded to verbose-only. Users only see warnings when action is needed.
- **Dispatch recovery hardening** — artifact fallback when completion key missing, TUI freeze prevention, reentrancy guard, atomic writes, stale runtime record cleanup

## [2.14.0] - 2026-03-15

### Added
- **Discussion manifest** — mechanical process verification for multi-milestone context discussions
- **Session-internal `/gsd config`** — configure GSD settings within a running session
- **Model selection UI** — select list instead of free-text input for model preferences
- **Startup performance** — faster GSD launch via optimized initialization

### Changed
- **Branchless worktree architecture** — eliminated slice branches entirely. All work commits sequentially on `milestone/<MID>` within auto-mode worktrees. No branch creation, switching, or merging within a worktree. ~2600 lines of merge/conflict/branch-switching code removed.
- **`.gitignore` overhaul** — planning artifacts (`.gsd/milestones/`) are tracked in git naturally. Only runtime files are gitignored. No more force-add hacks.
- **Multi-milestone enforcement** — `depends_on` frontmatter enforced in multi-milestone CONTEXT.md

### Fixed
- **Auto-mode loop detection failures** — artifacts on wrong branch or invisible after branch switch no longer possible (root cause eliminated by branchless architecture)
- **Nested worktree creation** — auto-mode no longer creates worktrees inside existing manual worktrees, preventing wrong-repo state reads and "All milestones complete" false positives
- **Dispatch recovery hardening** — artifact fallback when completion key missing, TUI freeze prevention on cascading skips, reentrancy guard, atomic writes, stale runtime record cleanup, git index.lock cleanup
- **Hook orchestration** — finalize runtime records, add supervision, fix retry
- **Empty slice plan stays in planning** — no longer incorrectly transitions to summarizing
- **Prefs wizard** — launch directly from `/gsd prefs`, fix parse/serialize cycle for empty arrays
- **Discussion routing** — `/gsd discuss` routes to draft when phase is needs-discussion

### Removed
- `ensureSliceBranch()`, `switchToMain()`, `mergeSliceToMain()`, `mergeSliceToMilestone()`
- `shouldUseWorktreeIsolation()`, `getMergeToMainMode()`, `buildFixMergePrompt()`
- `withMergeHeal()`, `recoverCheckout()`, `fix-merge` unit type
- `git.isolation` and `git.merge_to_main` preferences (deprecated with warnings)

## [2.13.1] - 2026-03-15

### Fixed
- Windows: multi-line commit messages in `mergeSliceToMilestone` broke shell parsing — switched to `execFileSync` with argument arrays
- Windows: single-quoted git arguments and bash-only redirects in test files
- Windows: worktree path normalization for `shouldUseWorktreeIsolation` and stale branch detection

## [2.13.0] - 2026-03-15

### Added
- **Worktree isolation for auto-mode** — auto-mode creates isolated git worktrees per milestone, with `--no-ff` slice merges preserving commit history and squash merge to main on milestone completion
- **Self-healing git repair** — automatic recovery from detached HEAD, stale locks, and orphaned worktrees
- **Worktree-aware doctor** — git health diagnostics and worktree integrity checks
- **Isolation preferences** — choose between worktree and branch isolation modes

### Fixed
- **Dispatch loop: parse cache stale data** — `dispatchNextUnit()` cleared path cache but not parse cache, allowing stale roadmap checkbox state to persist through doctor→dispatch transitions (#462)
- **Dispatch loop: completion not persisted after agent session** — `handleAgentEnd()` now verifies artifacts and persists the completion key before re-entering the dispatch loop, preventing re-dispatch when `deriveState()` sees pre-merge branch state (#462)
- **Dispatch loop: recovery counter reset without persistence** — loop-recovery and self-repair paths now persist completion keys and include a hard lifetime dispatch cap of 6 (#462, #463)
- **Dispatch loop: non-execute-task units had no artifact verification** — `complete-slice`, `plan-slice`, and other unit types now verify artifacts on disk before bail-out (#465)
- `@` file autocomplete debounced to prevent TUI freeze on large codebases (#452)
- Guard against newer synced resources from future versions (#445)
- Prevent `web_search` tool injection for non-Anthropic providers serving Claude models (#446)

## [2.12.0] - 2026-03-15

### Added
- **Parallel tool calling** — tools from a single assistant message execute concurrently by default, with sequential mode as opt-in (`toolExecution: "sequential"`) and `beforeToolCall`/`afterToolCall` hooks for interception
- **Ollama Cloud** as model and web tool provider
- **Extensible hook system** for auto-mode state machine — post-unit hooks fire after unit completion
- **Event queue settlement** for parallel tool execution — extension `tool_call`/`tool_result` handlers always see settled agent state

### Changed
- Inline static templates into prompt builders, eliminating ~44 READ tool calls per milestone

### Fixed
- Auto-mode dispatch loop when `cachedReaddir` returns stale data after unit writes files
- Parse and path caches cleared alongside state cache after unit completion
- `bg_shell` hangs indefinitely when `ready_port` server fails to start — now transitions to error state with stderr context
- Em dash and slash characters in milestone/slice titles corrupting GSD state management
- Guided-flow self-heals stale runtime records from crashed auto-mode sessions on wizard start
- CI smoke test ANSI code stripping

## [2.11.1] - 2026-03-15

### Fixed
- **URGENT: auto-mode loops on research-slice and plan-slice** — `handleAgentEnd` called `invalidateStateCache()` but not `clearPathCache()` or `clearParseCache()`. The in-process directory listing cache in `paths.ts` retained the pre-subagent empty directory snapshot, so `resolveSliceFile()` returned `null` for artifacts the subagent had just written. This caused `dispatchNextUnit` to re-dispatch the same unit (`research-slice` or `plan-slice`) instead of advancing, incrementing the dispatch counter until the `MAX_UNIT_DISPATCHES=3` limit triggered a hard stop with "Loop detected" (#421)

## [2.11.0] - 2026-03-14

### Added
- Cross-provider fallback when rate or quota limits are hit (#125)
- Custom OpenAI-compatible endpoint option in onboarding wizard (#335)
- Model provider selection in preferences (#350)
- Auto-mode fallback model rotation on network errors (#386)
- Native libgit2-backed git read operations for dispatch hotpath (#388)

### Changed
- Replace hardcoded extension list with dynamic discovery in loader
- Deduplicate transitive dependency summaries in prompt builders
- Reduce dispatch gap timeout from 30s to 5s
- Memoize `deriveState()` per dispatch cycle
- Wire native batch parser into `deriveState()` hotpath (#389)
- Add session-scoped directory listing cache and content-hash-keyed parse cache for path resolution
- Optimize discovery and interactive hot paths

### Fixed
- Resolve OpenRouter model IDs in auto-mode and show active model per phase
- Suppress git-svn noise causing confusing errors on affected systems (#404)
- Include export-html templates in pkg/ shim (#370, #395)
- Increase timeout for z.ai provider to handle slow API spikes (#379, #396)
- Prevent login dialog from leaving dangling promises that freeze the UI (#280, #390)
- Improve Cloud Code Assist 404 error with actionable model guidance (#384)
- Prevent auto-mode hang when dispatch chain breaks after slice tasks complete (#381, #382)
- Fix packaging verification and path portability (#378)
- Read resources from dist/ to prevent branch-drift in npm-link setups (#314)
- Always use native Anthropic web search when available (#374)
- CI smoke test — wait for registry propagation, show errors (#383)
- Bypass pre-commit hooks on GSD infrastructure commits to prevent lint-staged empty commit errors (#385)

## [2.10.12] - 2026-03-14

### Added
- Multi-milestone readiness flow with per-milestone discussion gate (#377)

### Fixed
- Fix `npx gsd-pi@latest` failing with `ERR_MODULE_NOT_FOUND: Cannot find package '@gsd/pi-coding-agent'`. The loader now creates workspace package symlinks at runtime before importing, so it works even when `npx` skips postinstall scripts (#380)

## [2.10.11] - 2026-03-14

### Fixed
- Hoist workspace package dependencies (undici, anthropic SDK, openai, chalk, etc.) into root `dependencies` so they install for end users. v2.10.10 removed `bundleDependencies` but didn't promote the transitive deps (#376)
- Add `undici` as root dependency to resolve startup crash (#372)
- Check `GROQ_API_KEY` before entering voice mode to prevent crash (#367)

## [2.10.10] - 2026-03-14

### Added
- Alibaba Cloud coding-plan provider support (#295)
- Linux voice mode: Groq Whisper API backend for fast, accurate speech-to-text (#366)
- Opus 4.6 1M as default model, model selector UX improvements, Discord onboarding (#290)

### Fixed
- Fix broken `npm install` / `npx gsd-pi@latest` caused by unpublished `@gsd/*` workspace packages leaking into npm dependencies. Workspace cross-references removed from published package metadata; packages resolve via bundled `node_modules/` at runtime (#369)
- Add pre-publish tarball install validation (`validate-pack`) to CI and publish pipeline, preventing broken packages from reaching npm
- Handle empty index after runtime file stripping in squash-merge (#364)
- Add retry logic for transient network/auth failures instead of crashing (#365)
- Auto-mode: stale lock detection, SIGTERM handler, live-session guard (#362)

## [2.10.9] - 2026-03-14

### Added
- Team collaboration: multiple users can work on the same repo without milestone name clashes by checking in `.gsd/` planning artifacts (#338)

### Changed
- Execute-task loop detection uses adaptive reconciliation instead of hard-stopping, reducing false positives (#342)
- Memory storage switched from better-sqlite3 to sql.js (WASM) for Node 25+ compatibility (#356)

### Fixed
- Node 22.22+ compatibility: `.ts` import extensions normalized to `.js` for module resolution (#354)
- Infinite loop when complete-slice merges to main are interrupted (#345)
- Credential backoff no longer triggers on transport errors; quota exhaustion handled gracefully (#353)
- OAuth-backed providers (Gemini) no longer crash on quota exhaustion (#347)
- Secrets skip in auto mode no longer crashes (#352)
- Untracked runtime files discarded before branch switch to prevent checkout conflicts (#346)
- TUI crash/corruption on code blocks with lines exceeding terminal width (#343)
- Infinite skip loop in `gsd auto` broken by adding roadmap completion check
- Model ID variant suffix stripped correctly for OAuth Anthropic API calls
- `.gsd/` planning artifacts force-added and `handleAgentEnd` reentrancy guarded (#341)

## [2.10.8] - 2026-03-14

### Fixed
- Publish verification checks `dist/loader.js` is non-empty (`-s`) and uses `--ignore-scripts` on `npm pack --dry-run` to match actual publish behaviour (#298)

## [2.10.7] - 2026-03-14

### Added
- GitHub Workflows skill with CI workflow template and `ci_monitor` tool (#294)
- Auto-resolve merge conflicts via LLM-powered fix-merge session
- Auto-update integration branch when user starts auto-mode from a different branch (#300)

### Changed
- Secrets manifest is re-checked before every dispatch, not just at auto mode start
- Replaced TS parameter properties with explicit fields for Node strip-types compatibility
- Hardened CI publish pipeline to prevent broken releases (#304)

### Fixed
- Unresolvable artifact paths now correctly treated as stale completion state, preventing OOM crashes (#313)
- Eliminated branch checkout during slice merge that caused STATE.md conflicts (#307)
- Removed infinite delivery retry loop for background job completions (#301)
- Display ⌥ instead of Alt for keybindings on macOS (#299)

### Removed
- Deprecated legacy dead code from OAuth module

## [2.10.6] - 2026-03-13

### Added
- Native Rust output truncation module for efficient large-output handling (#268)
- Native Rust xxHash32 hasher for hashline IDs — faster line hashing (#272)
- Native Rust bash stream processor for single-pass chunk processing (#271)
- Memory extraction pipeline (#261)
- `claude-opus-4-6` model with 1M context window (#288)

### Fixed
- Oversized TUI lines now truncated instead of crashing (#287)
- Anthropic rate limit backoff now respects server-requested retry delay
- CI publish guard: skip main package publish if already on npm
- Strip hashline prefixes from TUI read output (#265)

## [2.10.5] - 2026-03-13

### Added
- Async background jobs extension for non-blocking task execution (#260)
- Multi-credential round-robin with rate-limit fallback across API keys
- Bash interceptor to block commands that duplicate dedicated tools (Read, Write, Edit, Grep, Glob)
- `gsd update` subcommand for self-update (#273)
- Task isolation for subagent filesystem safety (#254)
- Native Rust streaming JSON parser (#266)
- Web search provider selection added to onboarding wizard (#278)

### Changed
- Simplified onboarding into two-step auth flow — plain language instead of OAuth jargon (#274)

### Fixed
- `optionalDependencies` in published `gsd-pi@2.10.4` were still pinned to `2.10.2`, causing users to install the broken engine binaries that 2.10.4 was meant to fix (#276)
- Auto-resolve `.gsd/` planning artifact conflicts during slice merge (#264)
- Use version ranges for native engine optional dependencies (#286)
- Guard publish against uncommitted version sync changes
- Show 'keep current' option in config when already authenticated (#283)
- Restore bashInterceptor settings dropped by async-jobs merge
- Collapse tool output by default

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

[Unreleased]: https://github.com/gsd-build/gsd-2/compare/v2.14.4...HEAD
[2.14.4]: https://github.com/gsd-build/gsd-2/compare/v2.14.3...v2.14.4
[2.14.3]: https://github.com/gsd-build/gsd-2/compare/v2.14.2...v2.14.3
[2.14.2]: https://github.com/gsd-build/gsd-2/compare/v2.14.1...v2.14.2
[2.14.1]: https://github.com/gsd-build/gsd-2/compare/v2.14.0...v2.14.1
[2.14.0]: https://github.com/gsd-build/gsd-2/compare/v2.13.1...v2.14.0
[2.13.1]: https://github.com/gsd-build/gsd-2/compare/v2.13.0...v2.13.1
[2.13.0]: https://github.com/gsd-build/gsd-2/compare/v2.12.0...v2.13.0
[2.12.0]: https://github.com/gsd-build/gsd-2/compare/v2.11.1...v2.12.0
[2.11.1]: https://github.com/gsd-build/gsd-2/compare/v2.11.0...v2.11.1
[2.11.0]: https://github.com/gsd-build/gsd-2/compare/v2.10.12...v2.11.0
[2.10.12]: https://github.com/gsd-build/gsd-2/compare/v2.10.11...v2.10.12
[2.10.11]: https://github.com/gsd-build/gsd-2/compare/v2.10.10...v2.10.11
[2.10.10]: https://github.com/gsd-build/gsd-2/compare/v2.10.9...v2.10.10
[2.10.9]: https://github.com/gsd-build/gsd-2/compare/v2.10.8...v2.10.9
[2.10.8]: https://github.com/gsd-build/gsd-2/compare/v2.10.7...v2.10.8
[2.10.7]: https://github.com/gsd-build/gsd-2/compare/v2.10.6...v2.10.7
[2.10.6]: https://github.com/gsd-build/gsd-2/compare/v2.10.5...v2.10.6
[2.10.5]: https://github.com/gsd-build/gsd-2/compare/v2.10.4...v2.10.5
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
