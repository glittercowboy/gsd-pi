# Changelog

All notable changes to GSD are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.40.0] - 2026-03-20

### Added
- **pi**: add Skill tool resolution (#1661)
- health check phase 2 — real-time doctor issue visibility across widget, visualizer, and HTML reports (#1644)
- upgrade forensics prompt to full-access GSD debugger (#1660)

### Fixed
- prune stale env-utils.js from extensions root, preventing startup load error (#1655)
- **splash**: replace box corners with full-width bars for visual unity with auto-mode widget (#1654)
- add runtime paths to forensics prompt to prevent path hallucination (#1657)
- guard TUI render during session transitions to prevent freeze (#1658)
- default UAT type to artifact-driven to prevent unnecessary auto-mode pauses (#1651)
- cancel trailing async jobs on session switch to prevent wasted LLM turns (#1643)

### Changed
- decompose autoLoop into pipeline phases (#1615) (#1659)

## [2.39.0] - 2026-03-20

### Added
- **gsd**: activate matching skills in dispatched prompts (#1630)
- **gsd**: add .gsd/RUNTIME.md template for declared runtime context (#1626)
- **gsd**: create draft PR on milestone completion when git.auto_pr enabled (#1627)
- **gsd**: add browser-executable and runtime-executable UAT types (#1620)
- apply model preferences in guided flow for milestone planning (#1614)
- **gsd**: GitHub sync extension — auto-sync to Issues, PRs, Milestones (#1603)
- add GSD_PROJECT_ID env var to override project hash (#1600)
- add GSD_HOME env var to override global ~/.gsd directory (#1566)
- **gsd**: add 13 enhancements to /gsd doctor (#1583)
- feat(ui): minimal GSD welcome screen on startup (#1584)

### Fixed
- recover + prevent #1364 .gsd/ data-loss (v2.30.0–v2.38.0) (#1635)
- treat summary as terminal artifact even when roadmap slices are unchecked (#1632)
- **gsd**: close residual #1364 data-loss vectors on v2.36.0+ (#1637)
- auto-resolve npm subpath exports in extension loader (#1624)
- create node_modules symlink for dynamic import resolution in extensions (#1623)
- filter cross-milestone errors from health tracker escalation (#1621)
- move unit closeout to run immediately after completion (#1612)
- use pathspec exclusions in smartStage to prevent hanging on large repos (#1613)
- add auto-fix for premature slice completion deadlock in doctor (#1611)
- resolve ${VAR} env references in MCP client .mcp.json configs (#1609)
- return "dispatched" after doctor heal to prevent session race (#1580) (#1610)
- update Anthropic OAuth endpoints to platform.claude.com (#1608)
- lazy-open GSD database on first tool call in manual sessions (#1606)
- **gsd**: detect anthropic-vertex in provider doctor (#1598)
- **gsd**: tighten prompt automation contracts (#1556)
- **gsd**: harden auto-mode agent loop — session teardown, unit correlation, sidecar perf (#1592)
- break remaining shared/mod.js barrel imports in report generation chain (#1588)
- apply pi manifest opt-out to extension-discovery.ts (#1545)
- detect worktree paths resolved through .gsd symlinks (#1585)

### Changed
- **gsd**: unify sidecar mini-loop into main dispatch path (#1617)
- **auto-loop**: initial cleanup — hoist constant, cache prefs per iteration (#1616)
- **gsd**: add 30K char hard cap on prompt preamble (#1619)
- **gsd**: replace stuck counter with sliding-window detection (#1618)
- **auto-loop**: 5 code smell fixes (#1602)
- **gsd**: replace session-scoped promise bridge with per-unit one-shot (#1595)
- **gsd**: remove prompt compression subsystem (~4,100 lines) (#1597)
- **gsd**: crashproof stopAuto with independent try/catch per cleanup step (#1596)

## [2.38.0] - 2026-03-20

### Added
- **gsd**: ADR-004 — derived-graph reactive task execution (#1546)
- add anthropic-vertex provider for Claude on Vertex AI (#1533)

### Fixed
- **ci**: reduce GitHub Actions minutes ~60-70% (~10k → ~3-4k/month) (#1552)
- **gsd**: reactive batch verification + dependency-based carry-forward (#1549)
- **gsd**: enforce backtick file paths in task plan IO sections (#1548)

## [2.37.1] - 2026-03-20

### Fixed
- interactive guard menu for remote auto-mode sessions (#1507) (#1524)
- use pull_request_target so AI triage has secret access on PRs
- cmux library directory incorrectly loaded as extension (#1537)
- separate pi-tui-dependent layout utils to fix report generation (#1527)
- clarify session lock loss diagnostics (#1535)
- **#1526**: auto-mode worktree commits land on main instead of milestone branch (#1534)

## [2.37.0] - 2026-03-20

### Added
- **dashboard**: two-column layout with redesigned widget (#1530)
- integrate cmux with gsd runtime (#1532)

### Fixed
- add session-level search budget to prevent unbounded native web search (#1309) (#1529)

## [2.36.0] - 2026-03-20

### Added
- deprecate agent-instructions.md in favor of AGENTS.md / CLAUDE.md (#1492) (#1514)
- AI-powered issue and PR triage via Claude Haiku (#1510)

### Fixed
- preserve user messages during abort with origin-aware queue clearing (#1439) (#1521)
- remove broken SwiftUI skill and add CI reference check (#1476) (#1520)
- wire escalateTier into auto-loop retry path (#1505) (#1519)
- prevent bare /gsd from stealing session lock from running auto-mode (#1507) (#1517)
- wire dead token-profile defaults and add /gsd rate command (#1505) (#1516)
- prevent false-positive session lock loss during sleep/event loop stalls (#1512) (#1513)
- **gsd**: filter non-milestone directories from findMilestoneIds (#1494) (#1508)
- **gsd**: accept 'passed' as terminal validation verdict (#1429) (#1509)
- add missing imports breaking CI build (#1511)
- prevent ensureGitignore from adding .gsd when tracked in git (#1364) (#1367)
- check project root .env when secrets gate runs in worktree (#1387) (#1470)
- realign cwd before dispatch + clean stale merge state on failure (#1389) (#1400)
- create milestones/ directory in worktree when missing (#1374)
- inject network_idle warning into hook prompts (#1345) (#1401)
- verify symlink after migration + fix test failures (#1377) (#1404)
- validate CWD instead of project root when running from a GSD worktree (#1317) (#1504)
- **gsd**: detect initialized health widget projects (#1432)
- smarter .gsd root discovery — git-root anchor + walk-up replaces symlink hack (#1386)
- correct GSD-WORKFLOW.md fallback path and sync to agentDir (#1375)
- always include reasoning.encrypted_content for OpenAI reasoning models
- **gsd**: avoid EISDIR crash in file loader
- **gsd**: open existing database on inspect

## [2.35.0] - 2026-03-19

### Added
- **gsd**: add /gsd changelog command with LLM-summarized release notes (#1465)

### Fixed
- restore lsp single-server selector export
- **mcp**: preserve args for mcp_call tool invocations (#1354)
- accumulate session cost independently of message array (#1423)
- resolve CI failures — scope provider check, fix Windows path, correct severity
- close 5 doctor coverage gaps — providers, lock dir, integration branch, orphaned worktrees
- add PID self-check to guided-flow crash lock detection (#1398)
- **prefs**: close merge, validation, serialization, and docs gaps

### Changed
- deduplicate error emission and message patterns in agent-core (#1444)
- simplify settings manager with generic setter helpers (#1461)
- consolidate theme files and remove manual schema (#1478)
- extract overlay layout and compositing from TUI into separate module (#1482)
- extract slash command handlers from interactive-mode (#1485)
- remove dead code (unused exports) (#1486)
- extract retry handler and compaction orchestrator from agent-session
- deduplicate rendering patterns in markdown and keys
- consolidate shared code between OpenAI providers
- deduplicate RPC mode shared patterns
- extract shared tree rendering utilities
- consolidate OAuth callback server and helper utilities
- extract shared file lock utilities
- consolidate resource loader with generic update/dedupe methods
- consolidate model switching logic in agent-session
- extract shared helpers in compaction module
- deduplicate toPosixPath, ZERO_USAGE, and shortenPath utilities
- consolidate 9 emit methods in extension runner into shared invokeHandlers
- consolidate extension type guards and inline handler type aliases
- consolidate duplicate patterns in LSP module

## [2.34.0] - 2026-03-19

### Added
- auto-generate OpenRouter model registry from API + add missing models (#1407) (#1426)

### Fixed
- release stranded bootstrap locks and handle re-entrant reacquire (#1352)
- add JS fallbacks for wrapTextWithAnsi and visibleWidth when native addon unavailable (#1418) (#1428)
- emit agent_end after abort during tool execution (#1414) (#1417)
- auto-discard bootstrap crash locks and clean auto.lock on exit (#1397)
- harden quick-task branch lifecycle — disk recovery + integration branch guard (#1342)
- skip verification retry on spawn infra errors (ETIMEDOUT, ENOENT) (#1340)
- keep external GSD state stable in worktrees (#1334)
- stop excluding all .gsd/ from commits — only exclude runtime files (#1326) (#1328)
- handle ECOMPROMISED in uncaughtException guard and align retry onCompromised (#1322) (#1332)

## [2.33.1] - 2026-03-19

### Fixed
- clean up stale numbered lock files and harden signal/exit handling (#1315) (#1323)
- worktree sync and home-directory safety check (#1311, #1317) (#1322)

### Changed
- remove orphaned mcporter extension manifest (#1318)

## [2.33.0] - 2026-03-19

### Added
- add live regression test harness for post-build pipeline validation (#1316)

### Fixed
- align retry lock path with primary lock settings to prevent ECOMPROMISED (#1307)
- skip symlinks in makeTreeWritable to prevent EPERM on NixOS/nix-darwin (#1303)
- handle Windows EPERM on .gsd migration rename with copy+delete fallback (#1296)
- add actionable recovery guidance to crash info messages (#1295)
- resolve main repo root in worktrees for stable identity hash (#1294)
- merge quick-task branch back to original after completion (#1293)

### Changed
- extract tryMergeMilestone to eliminate 4 duplicate merge paths in auto.ts (#1314)
- dispatch loop hardening — defensive guards, regression tests, lock alignment (#1310)
- extract parseUnitId() to centralize unit ID parsing (#1282)
- extract getErrorMessage() helper to eliminate 65 inline duplicates (#1280)
- consolidate DB-fallback inline functions in auto-prompts (#1276)

## [2.32.0] - 2026-03-19

### Added
- always-on health widget and visualizer health tab expansion (#1286)
- environment health checks, progress score, and status integration (#1263)

### Fixed
- skip crash recovery when auto.lock was written by current process (#1289)
- load worktree-cli extension modules via jiti instead of static ESM imports (#1285)
- **gsd**: prevent concurrent dispatch during skip chains (#1272) (#1283)
- skip non-artifact UAT dispatch in auto-mode (#1277)

### Changed
- deduplicate knownUnitTypes and STATE_REBUILD_MIN_INTERVAL_MS constants (#1281)
- extract prompt builder helpers for inlined context and source file lists (#1279)
- extract createGitService() factory, remove debug logs (#1278)
- extract dispatchUnit helper, inline dead buildDocsCommitInstruction (#1275)
- unify unit-type switch statements into lookup map (#1273)

## [2.31.2] - 2026-03-18

### Fixed
- **gsd**: stop replaying completed run-uat units (#1270)

## [2.31.1] - 2026-03-18

### Fixed
- prevent false-positive 'Session lock lost' during auto-mode (#1257)

## [2.31.0] - 2026-03-18

### Added
- add aws-auth extension for automatic Bedrock credential refresh (#1253)
- add -w/--worktree CLI flag for isolated worktree sessions (#1247)

### Fixed
- remove stale git-commit assertion in worktree test after commit_docs removal
- remove commit_docs test that broke CI after type removal (#1258)
- replace blanket git clean .gsd/ with targeted runtime file removal (#1252)
- invalidate caches inside discuss loop to detect newly written slice context (#1249)
- robust prose slice header parsing — handle H1-H4, bold, dots, no-separator variants (#1248)
- clean up stranded .gsd.lock/ directory to prevent false lock conflicts (#1251)

### Changed
- remove dead commit_docs preference (incompatible with external .gsd/ state) (#1258)

## [2.30.0] - 2026-03-18

### Added
- add extension manifest + registry for user-managed enable/disable (#1238)
- add model health indicator to auto-mode progress widget (#1232)
- simplify auto pipeline — merge research into planning, mechanical completion (ADR-003) (#1235)
- add create-gsd-extension skill (#1229)
- add built-in skill authoring system (ADR-003) (#1228)
- **prefs**: two-step provider→model picker in preferences wizard (#1218)
- workflow templates — right-sized workflows for every task type (#1185)

### Fixed
- align react-best-practices skill name with directory name (#1234)
- gate slice progression on UAT verdict, not just file existence (#1241)
- invalidate caches before roadmap check in /gsd discuss (#1240)
- use shell: true for LSP spawn on Windows to resolve .cmd executables (#1233)
- increase headless new-milestone timeout and limit investigation scope (#1230)
- clean untracked .gsd/ files before squash-merge to prevent failure (#1239)
- graceful fallback when native addon is unavailable on unsupported platforms (#1225)
- replace ambiguous double-question in discussion reflection step (#1226)
- kill non-persistent bg processes between auto-mode units (#1217)
- Two-column dashboard layout with task checklist (#1195)

### Changed
- move .gsd/ to external state directory with symlink (ADR-002) (#1242)
- replace MCPorter with native MCP client (#1210)
- extend json-persistence utility and migrate top JSON I/O callsites (#1216)
- deduplicate dispatchDoctorHeal — keep single copy in commands-handlers.ts (#1211)
- remove facade re-exports from auto.ts — import directly from source modules (#1214)
- extract shared HTTP client for remote-questions adapters (#1212)

## [2.29.0] - 2026-03-18

### Added
- add searchExcludeDirs setting for @ file autocomplete blacklist (#1202)
- **ci**: automate prod-release with version bump, changelog, and tag push (#1194)
- auto-open HTML reports in default browser on manual export (#1164)
- upgrade to Node.js 24 LTS across CI, Docker, and package config (#1165)
- add /gsd logs command to browse activity, debug, and metrics logs (#1162)
- **browser-tools**: configurable screenshot resolution, format, and quality (#1152)
- add pre-commit secret scanner and CI secret detection (#1148)
- **mcporter**: add .gsd/mcp.json per-project MCP config support (#1141)
- **metrics**: add API request counter for copilot/subscription users (#1140)
- per-milestone depth verification + queue-flow write-gate (#1116)
- add OSC 8 clickable hyperlinks for file paths in export notifications (#1114)
- park/discard actions for in-progress milestones (#1107)
- **ci**: implement three-stage promotion pipeline (Dev → Test → Prod) (#1098)
- cache-ordered prompt assembly and dashboard cache hit rate (#1094)
- add comprehensive API key manager (/gsd keys) (#1089)
- **ci**: add multi-stage Dockerfile for CI builder and runtime images
- **gsd**: add directory safeguards for system/home paths (#1053)
- enhance HTML report with derived metrics, visualizations, and interactivity (#1078)
- auto-extract lessons to KNOWLEDGE.md on slice/milestone completion (#711) (#1081)
- auto-create PR on milestone completion (#687) (#1084)
- wire semantic chunking, add preferences, metrics, and docs
- add token optimization suite for prompt caching, compression, and smart context selection
- **autocomplete**: add /thinking completions, GSD subcommand descriptions, and test coverage (#1019)
- add respectGitignoreInPicker setting for @ file picker (#979) (#1016)
- **prefs**: add search_provider to preferences.md (#1001)
- add `--events` flag for JSONL stream filtering (#1000)
- add 10 bundled skills for UI, quality, and code optimization (#999)
- **ux**: group model list by provider in /gsd prefs wizard (#993)
- add `--answers` flag for headless answer injection (#982)
- add project onboarding detection and init wizard

### Fixed
- **ci**: add npm publish to prod-release and prevent mid-deploy cancellation (#1208)
- **ci**: use env var for Discord webhook secret in if-condition
- complete shared barrel exports and add import-claude to help text (#1198)
- broaden unit-runtime path sanitization to strip all unsafe characters
- detect stale bundled resources via content fingerprint (#1193)
- include promptGuidelines in customPrompt path of buildSystemPrompt (#1187)
- prevent branch-mode merge fallback from firing in worktree isolation (#1183)
- treat auto-discovered verification failures as advisory, not blocking (#1188)
- **ci**: remove @latest npm promotion from pipeline
- **ci**: skip GitHub release creation when tag already exists
- handle Windows non-ASCII paths in cpSync with copyFileSync fallback (#1181)
- non-blocking verification gate for auto-discovered commands (#1177)
- add defensive guards against undefined .filter() in auto-mode dispatch/recovery (#1180)
- sync living docs (DECISIONS/REQUIREMENTS/PROJECT/KNOWLEDGE) between worktree and project root (#1173)
- route needs-discussion phase to interactive flow instead of stopping (#1175)
- run resource-skew check before early TTY gate
- move TTY check before heavy initialization to prevent process hang
- **ci**: skip init smoke test in non-TTY CI environments (#1172)
- **ci**: skip publish when version already exists on npm (#1166)
- **ci**: use local binary for pipeline smoke test (#1163)
- prevent concurrent GSD sessions from overlapping on same project (#1154)
- exclude completion-transition errors from health escalation at task level (#1157)
- **ci**: skip git-diff guard in prepublishOnly during CI (#1160)
- /gsd quick respects git isolation: none preference (#1156)
- text-based fallbacks for RPC mode where TUI widgets produce empty turns (#1112)
- **headless-query**: use jiti to load extension .ts modules (#1143)
- pause auto-mode when env variables needed instead of blocking (#1147)
- **ci**: fix dev-publish version stamp and platform sync (#1145)
- **google-search**: add 30s timeout to Gemini API call (#1139)
- **verification-gate**: sanitize preference commands with isLikelyCommand (#1138)
- **auto-dashboard**: show trigger task label for hook units (#1136)
- **auto-worktree**: detect worktree structurally when originalBase is null (#1135)
- **model-resolver**: prefer provider's recommended variant over saved base model (#1131)
- **auto-worktree**: auto-commit project root dirty state before milestone merge (#1130)
- **guided-flow**: support re-discuss flow for already-discussed slices (#1129)
- dispatch guard skips parked milestones — they no longer block later milestone dispatch (#1126)
- worktree reassess-roadmap loop — existsSync fallback in checkNeedsReassessment (#1117)
- **lsp**: use where.exe on Windows to resolve command paths (#1134)
- **gsd-db**: auto-initialize database when tools are called (#1133)
- inline preferences path to fix remote questions setup (#1110) (#1111)
- **ci**: add safe.directory for containerized pipeline job (#1108)
- remove .gsd/ from tracking, ignore entire directory
- update tests for god-file decomposition
- strip model variant suffix for API key auth (#1097) (#1099)
- match both milestoneId and sliceId when filtering duplicate blocker cards
- add dispatch stall guards to prevent auto-mode pause after slice completion (#1073) (#1076)
- prevent summarizing phase stall by retrying dropped agent_end events (#1072) (#1074)
- use atomic writes for completed-units.json and invalidate caches in db-writer (#1069)
- reject prose Verify: fields from being executed as shell commands (#1066) (#1068)
- restore session model on error instead of reading stale global prefs (#1065) (#1067)
- prevent run-uat re-dispatch loop when roadmap checkbox update fails (#1063) (#1064)
- inline compareSemver in gsd extension to fix broken relative import (#1058)
- disable reasoning for MiniMax-M2.5 in alibaba-coding-plan provider (#1003) (#1055)
- improve LSP diagnostics when no servers detected (#1082) (#1086)
- prevent summarizing phase stall by retrying dropped agent_end events (#1072)
- switch alibaba-coding-plan to OpenAI-compat endpoint with proper compat flags (#1003)
- add barrel files for remote-questions, ttsr, and shared extensions (#1048)
- consolidate frontmatter parsing into shared module (#1040)
- always ensure tasks/ directory exists for slice units (#900) (#1050)
- centralize GSD timeout and cache constants (#1038)
- improve RemotePromptRecord.ref type safety (#1041)
- document silent catch handlers in browser-tools (#1037)
- use literal union types in RuntimeErrorJSON for type safety (#1034)
- extract sanitizeError to shared module and apply to ask-user-questions (#1033)
- deduplicate formatDateShort into shared/format-utils (#1032)
- add error handlers to visualizer overlay promise chains (#1027)
- **security**: use execFileSync in resolve-config-value to prevent shell operator bypass (#1025)
- **security**: use execFile for browser URL opening to prevent shell injection (#1022)
- prevent duplicate milestone IDs when generating multiple before persisting (#961) (#1018)
- consolidate duplicate formatting functions (#1011)
- **gsd**: delete orphaned complexity.ts (#1005)
- **search**: consolidate duplicate Brave API helpers (#1010)
- merge worktree to main when all milestones complete (#962) (#1007)
- **gsd**: deduplicate resolveGitHeadPath function (#1015)
- add missing package.json subpath exports and oauth stubs (#1014)
- **gsd**: consolidate string-array normalizer functions into shared utility (#1009)
- **browser-tools**: document intentional silent catches, add debug logging for others (#1013)
- consolidate duplicate VerificationCheck/Result type definitions (#1008)
- **gsd**: add GIT_NO_PROMPT_ENV to gitFileExec and deduplicate constant (#1006)
- **remote-questions**: add null coalesce for optional threadUrl (#1004)
- auto-resume on transient server errors, not just rate limits (#886) (#957)
- replace ambiguous compound question in reflection step (#963) (#1002)
- **gsd**: remove STATE.md update instructions from all prompts (#983)
- **gsd**: clear all caches after discuss dispatch so picker sees new CONTEXT files (#981)
- **auto**: dispatch retry after verification gate failure (#998)
- enforce GSDError usage and activate unused error codes (#997)
- unify extension discovery logic (#995)
- deduplicate tierLabel/tierOrdinal exports (#988)
- deduplicate getMainBranch implementations (#994)
- add error handling for unhandled promise rejections (#992)
- deduplicate formatTokenCount into shared format-utils (#987)
- add debug logging to silent catch blocks in auto.ts (#986)
- deduplicate formatDuration into shared format-utils (#989)
- add exports fields to pi-tui and pi-agent-core packages (#991)
- remove dead github-client.ts (never imported) (#990)
- deduplicate parseJSONL and unify MAX_JSONL_BYTES constant (#985)
- remove broken ./hooks export path from pi-coding-agent (#984)
- inline bundled extension path parsing in subagent

### Changed
- extract numeric validation helpers in prefs wizard (#1205)
- deduplicate projectRoot() and dispatchDoctorHeal() between commands.ts and commands-handlers.ts (#1203)
- extract shared JSON persistence utility, migrate metrics + routing-history + unit-runtime (#1206)
- remove unused preferences-hooks.ts re-export facade (#1207)
- remove commands.ts re-exports, import directly from submodules (#1204)
- extract frontmatter body extraction into shared helper (#1201)
- deduplicate projectRoot() — single source in commands.ts (#1197)
- extract PER_REQUEST_TIMEOUT_MS to shared types (#1196)
- update state — S01 planned, ready for execution
- **M001-1ya5a3/S01**: auto-commit after state-rebuild
- **M001-1ya5a3/S01**: auto-commit after research-slice
- decompose doctor.ts into types, format, and checks modules (#1096)
- extract milestone-ids and guided-flow-queue from guided-flow.ts (#1095)
- decompose preferences.ts, populate skills and models modules (#1091)
- decompose auto.ts into 6 focused modules (#1088)
- decompose commands.ts into 5 focused modules
- remove redundant test file, identify consolidation targets (#1070)
- batch 2 — consolidate preferences, convert 8 more files to node:test (#1061)
- consolidate tests by area, standardize on node:test (#1059)
- skip initResources when version matches, consolidate startup I/O (#1052)
- centralize magic numbers into constants.ts (#1044)
- **resource-loader**: extract syncResourceDir to eliminate triplicated sync logic (#1036)
- **bg-shell**: split 1604-line god file into tool, command, and lifecycle modules (#1049)
- **headless**: split 772-line god file into events, UI, and context modules (#1047)
- **gsd**: extract safeCopy/safeMkdir helpers to replace repetitive try/catch FS patterns (#1043)
- **gsd**: extract atomicWriteSync utility to replace 6 duplicate write-tmp-rename patterns (#1046)
- **gsd**: unify duplicate padRight/truncate into shared format-utils (#1045)
- **loader**: consolidate 5 duplicate package.json version reads into cached helper (#1042)
- **headless**: remove duplicate jsonLine, use serializeJsonLine from pi-coding-agent (#1039)
- fix unicode regex discrepancy and standardize function naming (#1031)
- fix chalk version mismatch and document pinned dependency rationale (#1030)
- add concurrency limits to unbounded Promise.all operations (#1029)
- optimize SSE streaming buffer to avoid quadratic string growth (#1024)
- reduce makeTreeWritable calls from 6 to 2 on startup (#1023)
- add domain-grouped re-exports for preferences module (#996)

## [2.28.0] - 2026-03-17

### Added
- `gsd headless query` command for instant, read-only state inspection — returns phase, cost, progress, and next-unit as parseable JSON without spawning an LLM session
- `/gsd update` slash command for in-session self-update
- `/gsd export --html --all` for retrospective milestone reports

### Fixed
- Failure recovery & resume safeguards: atomic file writes, OAuth fetch timeouts (30s), RPC subprocess exit detection, extension command context guards, bash temp file cleanup, settings write queue flush, LSP init retry with backoff, crash detection on session resume, blob garbage collection
- Consolidated duplicate `mcp-server.ts` into single implementation
- Consolidated duplicate `bundled-extension-paths.ts` into single module
- Removed duplicate `marketplace-discovery.test.ts` test file
- Established npm as canonical package manager
- Exported RPC utilities from pi-coding-agent public API
- Prompt system requires grammatical narration for clearer agent output

### Changed
- Updated documentation for v2.26 and v2.27.0 features
- Documented all `preferences.md` fields in reference and template
- Removed stale `.pi/agents/` files superseded by built-in agent definitions

## [2.27.0] - 2026-03-17

### Added
- HTML report generator with progression index across milestones
- Crash recovery for parallel orchestrator — persisted state with PID liveness detection
- Headless orchestration skill with supervised mode
- Verification enforcement gate for milestone completion
- `git.manage_gitignore` preference to opt out of automatic `.gitignore` changes

### Changed
- Encapsulated auto.ts state into AutoSession class (cleaner session lifecycle)
- Extracted 7 focused modules from auto.ts (auto-worktree-sync, resource staleness, stale escape)
- TUI dashboard cleanup, dedup, and feature improvements
- Reordered visualizer tabs and HTML report sections into logical groupings

### Fixed
- Single ENTER now correctly submits slash command argument autocomplete
- Web search loop broken with consecutive duplicate guard
- Transient network errors retried before model fallback
- Parallel worker PID tracking, spawn-status race, and exit persistence
- `/gsd discuss` now recommends next undiscussed slice
- Roadmap parser allows suffix text after `## Slices` heading
- User's model choice no longer overwritten when API key is temporarily unavailable
- Reassess-roadmap skip loop broken by preventing re-persistence of evicted keys
- LSP command resolution and ENOENT crash on Windows/MSYS
- Dispatch plan-slice when task plan files are missing
- Reduced CPU usage on long auto-mode sessions
- Orphan-prone child processes reaped across session churn
- Symlinked skill directories resolved in `always_use_skills` and preferences
- Replan-slice infinite loop and non-standard `finish_reason` crash
- Skip slice plan commit when `commit_docs` is false
- Context-pressure monitor wired to send wrap-up signal at 70%
- Missing STATE.md in fresh worktree no longer deadlocks pre-dispatch health gate
- Stale runtime unit files for completed milestones cleaned on startup
- Broken install detection with Windows symlink fallback
- Auto-restart headless mode on crash with exponential backoff
- Generic type preserved on `resolveModelId` through resolution

## [2.26.0] - 2026-03-17

### Added
- Model selector grouped by provider with model type, provider, and API docs fields
- `require_slice_discussion` option to pause auto-mode before each slice for human review
- Discussion status indicators in `/gsd discuss` slice picker
- Worker NDJSON monitoring and budget enforcement for parallel orchestration
- `gsd_generate_milestone_id` tool for multi-milestone unique ID generation
- Alt+V clipboard image paste shortcut on macOS
- Hashline edit mode integration into active workflow
- Fallback parser for prose-style roadmaps without `## Slices` section

### Fixed
- Windows path normalization in LLM-visible text to prevent bash failures
- Async bash job completion no longer triggers spurious LLM turns
- Native web_search limited to max 5 uses per response
- Completed milestone with summary no longer re-entered as active on resume
- Replan-slice artifact verification breaks infinite replanning-slice loop
- Auto-heal STATE.md missing in preDispatchHealthGate
- Worktree artifact copy includes STATE.md, KNOWLEDGE.md, OVERRIDES.md
- Transient network errors marked as retriable in Anthropic provider
- `needs-remediation` treated as terminal validation verdict to prevent hard loop
- Post-hook doctor uses fixLevel 'all' to fix roadmap checkboxes
- `task_done_missing_summary` fixable in doctor to prevent validate-milestone skip loop
- BMP clipboard images on WSL2 handled via wl-paste PNG conversion
- Extended idle timeout for headless new-milestone
- EPIPE handling in LSP sendNotification with proper process exit wait
- Debug logging for silent early-return paths in dispatchNextUnit
- Untracked .gsd/ state files removed before milestone merge checkout
- Crash prevention when cancelling OAuth provider login dialog
- Resource staleness check compares gsdVersion instead of syncedAt
- Unique temp paths in saveFile() to prevent parallel write collisions
- Validation/summary file generation for completed milestones during migration
- Cache invalidation before initial state derivation in startAuto
- Headless mode no longer exits early on progress notifications containing 'complete'

### Removed
- Symlink-based development workflow (reverted PR #744)

### Changed
- Explicit Gemini OAuth ToS warning added to README — recommends API keys over OAuth
- Documentation updated for v2.24 release features
- Bug report template updated with model type, provider, and API docs fields

## [2.25.0] - 2026-03-16

### Added
- Native web search results rendering in TUI with `PREFER_BRAVE_SEARCH` environment variable toggle
- Meaningful commit messages generated from task summaries instead of generic messages
- Incremental memory system for auto-mode sessions
- Visualizer enriched with stats and discussion status
- 14 new E2E smoke tests for CLI verification

### Fixed
- Phantom skip loop caused by stale crash recovery context
- Skip-loop now interruptible and counts toward lifetime cap
- Cache invalidation consistency — orphaned `invalidateStateCache()` calls replaced, DB artifact cache included in `invalidateAllCaches()`
- Plan checkbox reconciliation on worktree re-attach after crash

### Changed
- Removed unnecessary `as any` casts, dead exports, and duplicate code
- Updated documentation for v2.22 and v2.23 release features

## [2.24.0] - 2026-03-16

### Added
- **Parallel milestone orchestration** — run multiple workers across phases simultaneously
- Dashboard view for parallel workers with 80% budget alert
- Headless `new-milestone` command for programmatic milestone creation
- Interactive update prompt on startup when a new version is available
- Symlink-based development workflow for `src/resources/`
- Descriptions added to `/gsd` autocomplete commands
- `validate-milestone` phase and dispatch

### Fixed
- Sync `completed-units.json` across worktree boundaries
- Worktree artifact verification uses correct base path
- Auto-resume auto-mode after rate limit cooldown
- Raise `maxDelayMs` default from 60s to 300s for better rate-limit handling
- Downgrade `missing_tasks_dir` to warning for completed slices
- Prevent stale state loop on auto-mode restart with existing worktree
- Always sync bundled resources and clean stale files
- Add stop reason to every auto-mode stop
- Skip redundant checkout in worktree merge when main already current
- Prevent runaway execute-task when task plan missing after failed research
- Fix read-only file permissions after cpSync from Nix store
- Fix parallel sendMessage calls missing required fields
- Strip clack UI from postinstall, keep silent Playwright download

### Changed
- Lazy-load LLM provider SDKs to reduce startup time

## [2.23.0] - 2026-03-16

### Added
- **VS Code extension** — full extension with chat participant, RPC integration, marketplace publishing under FluxLabs publisher
- **`gsd headless`** — redesigned headless mode for full workflow orchestration: auto-responds to prompts, detects completion, supports `--json` output and `--timeout` flags
- **`gsd sessions`** — interactive session picker for browsing and resuming saved sessions (#721)
- **10 new browser tools** — `browser_save_pdf`, `browser_save_state`, `browser_restore_state`, `browser_mock_route`, `browser_block_urls`, `browser_clear_routes`, `browser_emulate_device`, `browser_extract`, `browser_visual_diff`, `browser_zoom_region`, `browser_generate_test`, `browser_check_injection`, `browser_action_cache` (#698)
- **Structured discussion rounds** — `ask_user_questions` in guided-discuss-milestone for better requirement gathering (#688)
- **`validate-milestone` prompt** — milestone validation prompt and template
- **`models.json` resolution** — custom model definitions with fallback to `~/.pi/agent/models.json`

### Changed
- **Background shell performance** — optimized hot path with parallel git queries and lazy workspace validation

### Fixed
- Forensics uses `GSD_VERSION` env var instead of fragile package.json path traversal; now worktree-aware to prevent stale root misdiagnosis
- Background commands rewritten to prevent pipe-open hang; stalled-tool detection added with prompt guidance
- Auto mode breaks infinite skip loop on repeatedly-skipped completed units
- Roadmap parser expands range syntax in depends (e.g. `S01-S04` → `S01,S02,S03,S04`)
- Empty scaffold plan files rejected during plan-slice artifact verification (#699)
- Anti-pattern rule prevents `bash &` usage that causes agent hangs (#733)
- Shift-Tab navigates to previous tab in workflow visualizer (#717)
- Capture resolutions executed after triage instead of only classified (#714)
- Screenshot constraining uses independent width/height caps (#725)
- `auto.lock` written at startup; remote sessions detected in dashboard (#723)
- Cross-platform test compatibility with `process.ppid`
- CSP nonce, dead branch cleanup, restart cooldown fixes
- CI fix: `pi.getActiveTools()` replaces `ctx.getActiveTools()`

## [2.22.0] - 2026-03-16

### Added
- **`/gsd forensics`** — post-mortem investigation of auto-mode failures with structured root-cause analysis
- **Claude marketplace import** — import Claude marketplace plugins as namespaced GSD components
- **MCP server mode** — run GSD as an MCP server with `--mode mcp`
- **`/review` skill** — code review with diff-aware context
- **`/test` skill** — test generation and execution
- **`/lint` skill** — linting integration
- **GitHub API client** — diff-aware context injection and tiktoken-based token counting
- **File watcher** — chokidar-based file watching for live updates
- **`git.isolation: "none"`** — disable worktree isolation for projects that don't need it
- **E2E smoke tests** — end-to-end test suite for extension integration
- **Subcommand help** — inline help text for all GSD subcommands

### Fixed
- `verificationBudget` passed correctly to execute-task prompt template
- Background shell worktree cwd detection normalized to prevent stale paths
- Skill loading made an active directive in auto-mode units
- Auto-worktree validated as real git worktree before use
- MCP server discovery from project-root `.mcp.json`
- Command injection surface eliminated in diff-context; file-watcher path resolution hardened
- Thinking level clamped to `low` for gpt-5.x models
- `completedAt` coerced to String in visualizer changelog sort
- Warp terminal added to unsupported Ctrl+Alt shortcut list
- Fractional slice IDs (e.g. S03.5) supported in roadmap parser
- `executorContextConstraints` provided to plan-slice template
- Worktree state synced to project root after each unit
- Initial state derived from worktree when one exists
- Hardware cursor auto-enabled in Warp terminal
- CSI 3J scrollback clear removed from TUI full redraws
- Worktree edge cases — `resolveGitDir`, `captureIntegrationBranch` guard, doctor path

## [2.21.0] - 2026-03-16

### Added
- **Browser tools TypeScript conversion** — `browser-tools/core.js` converted to TypeScript with c8 test coverage
- **SSRF protection on `fetch_page`** — blocks private IPs, metadata endpoints, and non-HTTP protocols
- **Stale async job cancellation** — heuristic prevents outdated results in auto-mode

### Changed
- **Pause/resume recovery** — reuses crash recovery infrastructure for more reliable context restoration
- **Build scripts extracted** — inline package.json scripts moved to standalone files for cross-platform support
- **Help text deduplicated** — consolidated across CLI entry points
- **Dependency alignment** — `@types/mime-types` moved to devDependencies, chalk versions consolidated

### Fixed
- Task counter display no longer shows "task 5/4" after loop recovery
- Browser-tools TypeScript type errors in CI
- 4 small issues (#663): Windows GitHub Copilot login, Tavily display, MCPorter auto-install, notification preferences
- Cross-platform `validate-pack` script compatibility

## [2.20.0] - 2026-03-16

### Added
- **Telegram remote questions** — receive and respond to GSD questions via Telegram bot alongside existing Slack and Discord channels (#645)
- **`/gsd quick`** — execute a quick task with GSD guarantees (atomic commits, state tracking) without the full planning overhead (#437)
- **`/gsd mode`** — workflow mode system with solo and team presets that configure defaults for milestone IDs, git commit behavior, and documentation settings (#651)
- **`/gsd help`** — categorized command reference with descriptions for all GSD subcommands (#630)
- **`/gsd doctor`** — 7 runtime health checks with auto-fix for common state corruption issues (#646)
- **Agent instructions injection** — `agent-instructions.md` loaded into every agent session for persistent per-project behavioral guidance (#437)
- **Skill lifecycle management** — telemetry tracking, health dashboard, and heal-skill command for managing custom skills (#599)
- **SQLite context store** — surgical prompt injection from structured knowledge base for precise context engineering (#619)
- **Context-window budget engine** — proportional prompt sizing that allocates context budget across system prompt sections based on relevance (#660)
- **LSP activated by default** — Language Server Protocol now auto-activates with call hierarchy, formatting, signature help, and synchronized edits (#639)
- **Extension smoke tests** — CI catches import failures, circular deps, and module resolution issues across all bundled extensions
- **`gsd --debug` mode** — structured JSONL diagnostic logging for troubleshooting dispatch and state issues (#468)
- **Worktree post-create hook** — run custom setup scripts when GSD creates a new worktree (#597)

### Fixed
- **CPU spinning from regex backtracking** — replaced `[\s\S]*?` regex in preferences parser with indexOf-based scanning (#468)
- **Model config bleed between concurrent GSD instances** — isolated model configuration per session (#650)
- **Onboarding wizard repeats** — skip onboarding for extension-based providers that don't require auth.json credentials (#589)
- **Session tool rebuild on cwd change** — tools now rebuild correctly when working directory changes mid-session (#633)
- **Auto mode state derivation after discussion fallthrough** — re-derives state to prevent stale dispatches (#609)
- **Milestone branch preservation on auto stop** — prevents work loss when stopping auto mode (#601)
- **Infinite loop when milestone detection silently fails** — `findMilestoneIds` now logs errors and warns instead of looping (#456)
- **Google Search OAuth fallback** — uses Google Cloud Code Assist API when `GEMINI_API_KEY` is not set (#466)

### Changed
- **Preferences wizard** — replaced serial flow with categorized menu for faster configuration (#623)
- **Slack remote questions** — brought to feature parity with Discord integration (#628)
- **YAML support in hooks** — hooks now support YAML configuration alongside JSON (#637)

## [2.19.0] - 2026-03-16

### Added
- **Workflow visualizer** — `/gsd visualize` opens a full-screen TUI overlay with four tabs: Progress (milestone/slice/task tree), Dependencies (ASCII dep graph), Metrics (cost/token bar charts), and Timeline (chronological execution history). Supports Tab/1-4 switching, per-tab scrolling, auto-refresh every 2s, and optional auto-trigger after milestone completion via `auto_visualize` preference (#626)
- **Mid-execution capture & triage** — `/gsd capture` lets you fire-and-forget thoughts during auto-mode. The system triages accumulated captures at natural seams between tasks, classifies impact into five types (quick-task, inject, defer, replan, note), and proposes action with user confirmation. Dashboard shows pending capture count badge. Capture context injected into replan and reassess prompts (#512)
- **Dynamic model routing** — complexity-based model routing classifies units into light/standard/heavy tiers and routes to cheaper models when appropriate, reducing token consumption 20-50% on capped plans. Includes budget-pressure-aware routing, cross-provider cost comparison, escalation on failure, adaptive learning from routing history (rolling 50-entry window with user feedback support), and task plan introspection (code block counting, complexity keyword detection) (#579)
- **Feature-branch lifecycle integration test** — proves milestone worktrees branch from and merge back to feature branches, never touching main (#624)
- **Discord integration parity with Slack** — plus new remote-questions documentation (#620)

### Fixed
- **Absolute paths in auto-mode prompts** — write-target variables now passed as absolute paths, eliminating LLM path confusion in worktree contexts that caused artifacts written to wrong location and loop detection (#627)
- **Worktree lifecycle on mid-session milestone transitions** (#616, #618)
- **Eager template cache warming** — prevents version-skew crash in long auto-mode sessions (#621)

## [2.18.0] - 2026-03-16

### Added
- **Milestone queue reorder** — `/gsd queue` supports reordering milestone execution priority with dependency-aware validation, persistent ordering via `.gsd/QUEUE-ORDER.json` (#460)
- **`.gsd/KNOWLEDGE.md`** — persistent project-specific context file loaded into agent prompts. New `/gsd knowledge` command with `rule`, `pattern`, and `lesson` subcommands for adding entries (#585)
- **Dynamic model discovery** — runtime model enumeration from provider APIs (Ollama, OpenAI, Google, OpenRouter) with per-provider TTL caching and discovery adapters. New `ProviderManagerComponent` TUI for managing providers with auth status and model counts (#581)
- **Expanded preferences wizard** — all configurable fields now exposed in the setup wizard, model ID validation, and `updatePreferencesModels()` for safe read-modify-write of model config (#580)
- **Comprehensive documentation** — 12 new docs covering getting started, auto-mode, commands, configuration, token optimization, cost management, git strategy, team workflows, skills, migration, troubleshooting, and architecture (#605)
- **`resolveProjectRoot()`** — all GSD commands resolve the effective project root from worktree paths instead of using raw `process.cwd()`, preventing path confusion across worktree boundaries (#602)
- **1,813 lines of new tests** — 13 new test files covering discovery cache, model discovery, model registry, models-json-writer, auto-worktree, derive-state-deps, in-flight tool tracking, knowledge, memory leak guards, preferences wizard fields, queue order, queue reorder E2E, and stale worktree cwd

### Fixed
- **Heap OOM during long-running auto-mode sessions** — four sources of unbounded memory growth: activity log serialized all entries for SHA1 dedup (now streaming writes with lightweight fingerprint), uncleaned `activityLogState` Map between sessions, unbounded `completedUnits` array (now capped at 200), and `dirEntryCache`/`dirListCache` growing without bounds (now evicted at 200 entries) (#611)
- **Stale worktree cwd after milestone completion** — three-layer fix: `escapeStaleWorktree()` at auto-mode entry, unconditional cwd restore in `stopAuto()`, and cwd restore on partial merge failure (#608)
- **Worktree created from integration branch instead of main** — `createAutoWorktree` reads integration branch from META.json, merge targets integration branch not hardcoded main (#606)
- **Milestone merge skipped in branch isolation mode** — branch-mode fallback detects `milestone/*` branch and performs squash-merge (#603)
- **`parseContextDependsOn()` destroys unique milestone ID case** — was lowercasing IDs, breaking dependency resolution (#604)
- **Tool-aware idle detection** — prevents false interruption of long-running tasks in auto-mode (#596)
- **Remote questions onboarding crash** — extracted `saveRemoteQuestionsConfig` into compiled src/ helper to avoid cross-boundary .ts import (#592)
- **`showNextAction` crash** — falls back to `select()` when `custom()` returns undefined (#447, #615)

### Changed
- Comprehensive update to preferences reference and configuration guide (#614)
- Auto-mode artifact writes scoped to active milestone worktree, preventing cross-milestone pollution (#590)

## [2.17.0] - 2026-03-15

### Added
- **Token optimization profiles** — `budget`, `balanced`, and `quality` presets that coordinate model selection, phase skipping, and context compression to reduce token usage by 40-60% on budget mode
- **Complexity-based task routing** — automatically classifies tasks as simple/standard/heavy and routes to appropriate models, with persistent learning from routing history
- **`git.commit_docs` preference** — set to `false` to keep `.gsd/` planning artifacts local-only, useful for teams where only some members use GSD

### Changed
- Updated Ollama cloud provider model catalog

### Fixed
- Native binary hangs in GSD auto-mode paths (#453)
- Auto-mode can be stopped from a different terminal (#586)
- Parse cache collision causing false loop detection on `complete-slice` (#583)
- Exhaustive switch handling and cleanup in Google provider (#587)

## [2.16.0] - 2026-03-15

### Added
- `/gsd steer` command — hard-steer plan documents during execution without stopping the pipeline
- Native git operations via libgit2 — ~70 fewer process spawns per dispatch cycle
- Native performance optimizations for `deriveState`, JSONL parsing, and path resolution
- Default model upgraded to Opus 4.6 with 1M context variant
- PR template and bug report issue template

### Fixed
- Auto-mode continues after guided milestone planning instead of stalling at "Milestone planned"
- Git commands no longer fail when repo path contains spaces
- Arrow key cursor updates and Shift+Enter newline insertion in TUI
- Tool API keys loaded from `auth.json` at session startup
- TypeScript errors resolved across extension, test, and async-jobs files

### Changed
- Hot-path lookup caching and error resilience optimizations
- Extension type-checking added to CI pipeline

## [2.15.1] - 2026-03-15

### Fixed
- Auto-mode worktree path resolution — prompt templates now include working directory, preventing artifacts from being written to the wrong location and causing infinite re-dispatches
- Auto-mode resource sync detection — gracefully stops when resources change mid-session instead of crashing
- Auto-mode missing import for `resolveSkillDiscoveryMode` causing crash on startup
- Auto-mode recovery hardened — checkbox verification falls through correctly, corrupt roadmaps fail verification instead of silently passing, atomic writes for completed-units.json, and task completion verified via artifacts not just file existence
- Auto-mode progress widget now refreshes from disk every 5 seconds during unit execution instead of appearing frozen
- Undo command now invalidates all caches (not just state cache), preventing stale results after undoing completed tasks

### Changed
- CI pipeline supports prerelease publishing with `--tag next` for testing before stable release

### Added
- Unit tests for auto-dashboard, auto-recovery, and crash-recovery modules (46 new tests)

## [2.15.0] - 2026-03-15

### Added
- **8 new commands**: budget enforcement, notifications, and quality-of-life improvements (#441)
- **Preferences schema validation**: detects unknown/typo'd preference keys and surfaces warnings instead of silently ignoring them (#542)
- **Pipeline-aware prompts**: each agent phase (research, plan, execute, complete) now knows its role in the pipeline, eliminating redundant code exploration between phases (#543)
- **Research depth calibration**: three-tier system (deep/targeted/light) so agents match effort to actual complexity (#543)

### Changed
- Auto-mode decomposed into focused modules for maintainability (#534)
- Dispatch logic extracted from if-else chain to dispatch table (#539)
- v1 migration code gated behind dynamic import — only loaded when needed (#541)
- Background shell module decomposed into focused modules
- Unified cache invalidation into single `invalidateAllCaches()` function (#545)

### Fixed
- Executor agents now receive explicit working directory, preventing writes to main repo instead of worktree (#543)
- Merge loop and .gsd/ conflict auto-resolution in worktree model, `git.isolation` preference restored (#536)
- Arrow keys no longer insert escape sequences as text during LLM streaming (#493)
- YAML preferences parser hardened for OpenRouter model IDs with special characters (#488)
- `@` file autocomplete debounced to prevent TUI freeze on large codebases (#448)
- Auto-mode stops cleanly when dispatch gap watchdog fails (#537)
- Synchronous I/O removed from hot paths (#540)
- Silent catch blocks now capture error references for crash diagnostics (#546)
- `ctx.log` error in GSD provider recovery path fixed
- TUI resource leaks patched in loader, cancellable-loader, input, and editor components (#482)
- Hardcoded ANSI escapes replaced with chalk for consistent terminal handling (#482)

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

[Unreleased]: https://github.com/gsd-build/gsd-2/compare/v2.40.0...HEAD
[2.40.0]: https://github.com/gsd-build/gsd-2/compare/v2.39.0...v2.40.0
[2.39.0]: https://github.com/gsd-build/gsd-2/compare/v2.38.0...v2.39.0
[2.38.0]: https://github.com/gsd-build/gsd-2/compare/v2.37.1...v2.38.0
[2.37.1]: https://github.com/gsd-build/gsd-2/compare/v2.37.0...v2.37.1
[2.37.0]: https://github.com/gsd-build/gsd-2/compare/v2.36.0...v2.37.0
[2.36.0]: https://github.com/gsd-build/gsd-2/compare/v2.35.0...v2.36.0
[2.35.0]: https://github.com/gsd-build/gsd-2/compare/v2.34.0...v2.35.0
[2.34.0]: https://github.com/gsd-build/gsd-2/compare/v2.33.1...v2.34.0
[2.33.1]: https://github.com/gsd-build/gsd-2/compare/v2.33.0...v2.33.1
[2.33.0]: https://github.com/gsd-build/gsd-2/compare/v2.32.0...v2.33.0
[2.32.0]: https://github.com/gsd-build/gsd-2/compare/v2.31.2...v2.32.0
[2.31.2]: https://github.com/gsd-build/gsd-2/compare/v2.31.1...v2.31.2
[2.31.1]: https://github.com/gsd-build/gsd-2/compare/v2.31.0...v2.31.1
[2.31.0]: https://github.com/gsd-build/gsd-2/compare/v2.30.0...v2.31.0
[2.30.0]: https://github.com/gsd-build/gsd-2/compare/v2.29.0...v2.30.0
[2.29.0]: https://github.com/gsd-build/gsd-2/compare/v2.28.0...v2.29.0
[2.28.0]: https://github.com/gsd-build/gsd-2/compare/v2.27.0...v2.28.0
[2.27.0]: https://github.com/gsd-build/gsd-2/compare/v2.26.0...v2.27.0
[2.26.0]: https://github.com/gsd-build/gsd-2/compare/v2.25.0...v2.26.0
[2.25.0]: https://github.com/gsd-build/gsd-2/releases/tag/v2.25.0
[2.24.0]: https://github.com/gsd-build/gsd-2/compare/v2.23.0...v2.24.0
[2.23.0]: https://github.com/gsd-build/gsd-2/compare/v2.22.0...v2.23.0
[2.21.0]: https://github.com/gsd-build/gsd-2/compare/v2.20.0...v2.21.0
[2.19.0]: https://github.com/gsd-build/gsd-2/compare/v2.18.0...v2.19.0
[2.18.0]: https://github.com/gsd-build/gsd-2/compare/v2.17.0...v2.18.0
[2.17.0]: https://github.com/gsd-build/gsd-2/compare/v2.16.0...v2.17.0
[2.16.0]: https://github.com/gsd-build/gsd-2/compare/v2.15.1...v2.16.0
[2.15.1]: https://github.com/gsd-build/gsd-2/releases/tag/v2.15.1
[2.15.0]: https://github.com/gsd-build/gsd-2/compare/v2.14.4...v2.15.0
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
[2.20.0]: https://github.com/gsd-build/gsd-2/releases/tag/v2.20.0
[2.22.0]: https://github.com/gsd-build/gsd-2/releases/tag/v2.22.0
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
