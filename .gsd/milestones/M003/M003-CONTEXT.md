# M003: Worktree-Isolated Git Architecture

**Gathered:** 2026-03-14
**Status:** Ready for planning

## Project Description

Overhaul GSD's git system to use worktree-per-milestone isolation as the default model. Each milestone gets its own git worktree with an isolated `.gsd/` directory, eliminating the entire category of `.gsd/` merge conflicts that have caused ~15 separate bug fixes to date. Slices merge into the milestone branch via `--no-ff` (preserving full commit history as a diary of the agent's work). Milestones squash-merge to main on completion (keeping main clean). The system is automagical for vibe coders — zero git errors, zero git knowledge required — and configurable for senior engineers via preferences.

## Why This Milestone

The current branch-per-slice model shares `.gsd/` state across branches, causing merge conflicts that halt auto-mode. The CHANGELOG shows a pattern: each fix leads to a new edge case. The root cause is structural — sharing mutable state across branches. Worktree isolation eliminates the problem architecturally rather than patching symptoms.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Run `/gsd auto` on a new project and have it execute start-to-finish without any git errors, merge conflicts, or mysterious halts
- See clean `git log` on main with one commit per completed milestone
- Configure `git.merge_to_main: "slice"` in preferences to get slice-level integration if they want it
- Run `/gsd doctor` to detect and fix git-related issues
- Use manual `/worktree` alongside auto-mode without conflicts

### Entry point / environment

- Entry point: `/gsd auto` CLI command, `/gsd doctor` CLI command
- Environment: local dev — any git repository
- Live dependencies involved: git CLI, optional libgit2 native module

## Completion Class

- Contract complete means: auto-worktree create/teardown lifecycle works, slice merges use `--no-ff`, milestone squashes to main, preferences switch between modes, self-heal recovers from common failures, all tests pass
- Integration complete means: the full auto-mode lifecycle (startAuto → dispatch units → complete slices → complete milestone → merge to main) works end-to-end in a real git repo with real file changes
- Operational complete means: existing projects on branch-per-slice model continue working unchanged, manual `/worktree` coexists without conflicts

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- Auto-mode on a fresh project creates a worktree, executes through multiple slices, and merges the milestone to main — with zero git errors
- An existing project with branch-per-slice history continues working identically (no regression)
- A deliberately introduced merge conflict is self-healed without user intervention
- `git log main` shows exactly one squash commit per completed milestone
- `git log milestone/M003` shows full commit history with `--no-ff` merge boundaries per slice

## Risks and Unknowns

- **`process.chdir` in auto-mode** — auto-mode currently passes `basePath` to all functions but doesn't `chdir`. Worktree mode needs `chdir` into the worktree so that all tool calls (bash, read, write, edit) resolve against the worktree. The worktree-command.ts already does this, but auto-mode doesn't. Risk: some codepath uses `basePath` while another uses `process.cwd()`, causing split-brain.
- **Worktree `.gsd/` inheritance** — when a worktree is created, it gets a copy of the project files from the milestone branch base. But `.gsd/` planning files from the main tree may or may not be wanted in the worktree. Need to decide: copy planning state or start fresh.
- **State machine re-entry** — if auto-mode is paused and resumed, the worktree must be re-entered (if it still exists). The pause/resume logic in `startAuto` needs to handle this.
- **Existing orphan recovery** — the current `mergeOrphanedSliceBranches` logic needs to work within the worktree context, not just on main.

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R029 — Auto-worktree creation on milestone start
- R030 — Auto-worktree teardown + squash-merge on milestone complete
- R031 — `--no-ff` slice merges within milestone worktree
- R032 — Rich milestone-level squash commit message
- R033 — `git.isolation` preference
- R034 — `git.merge_to_main` preference
- R035 — Self-healing git repair on failure
- R036 — `.gsd/` conflict resolution elimination
- R037 — Zero git errors for vibe coders
- R038 — Backwards compatibility with branch-per-slice model
- R039 — Manual `/worktree` coexistence with auto-worktrees
- R040 — Doctor git health checks
- R041 — Test coverage for worktree-isolated flow

## Scope

### In Scope

- Auto-worktree lifecycle wired into `startAuto()` and `complete-milestone`
- `--no-ff` merge for slices within worktree, squash for milestone to main
- `git.isolation` and `git.merge_to_main` preferences with validation
- Self-healing git repair (abort, reset, retry) for common failure modes
- Doctor git health checks (orphaned worktrees, stale branches, corrupt state)
- Simplification of `.gsd/` conflict resolution code (worktree mode only)
- Test suite for both worktree and branch isolation modes
- Backwards compatibility with existing branch-per-slice projects

### Out of Scope / Non-Goals

- Parallel milestone execution (deferred to future milestone)
- Native libgit2 write operations (deferred)
- Rebase merge strategy (anti-feature — conflicts with commit diary philosophy)
- Remote git operations beyond existing auto-push

## Technical Constraints

- Must work with git CLI (libgit2 native module is optional, read-only)
- `process.chdir` is the mechanism for worktree switching (proven in worktree-command.ts)
- All file tools (read, write, edit, bash) resolve against `process.cwd()` — this is the reason `chdir` works
- Source files are in `src/resources/extensions/gsd/`, tests in `src/resources/extensions/gsd/tests/`
- Tests run via `npm run test:unit` and `npm run test:integration`

## Integration Points

- `auto.ts` — primary integration point for worktree lifecycle in `startAuto()`, `dispatchNextUnit()`, `handleAgentEnd()`
- `git-service.ts` — `GitServiceImpl` class owns all git mutation operations
- `worktree.ts` — thin facade over `GitServiceImpl`, exports `ensureSliceBranch`, `mergeSliceToMain`, etc.
- `worktree-manager.ts` — existing worktree create/list/remove/merge operations
- `worktree-command.ts` — manual `/worktree` command with `process.chdir` handling
- `preferences.ts` — preference validation and loading
- `doctor.ts` — health check and auto-fix system
- `native-git-bridge.ts` — libgit2 read operations
- `dispatch-guard.ts` — prior-slice completion checking

## Open Questions

- **Worktree naming convention for auto-worktrees** — should auto-worktrees use the milestone ID as the name (`.gsd/worktrees/M003/`) or a prefixed name (`.gsd/worktrees/auto-M003/`)? Current thinking: bare milestone ID is cleaner and the branch convention (`milestone/M003` vs `worktree/<name>`) disambiguates from manual worktrees.
- **`.gsd/` file handling on worktree creation** — should the worktree inherit the main tree's `.gsd/` planning files, or should they be cleared for a fresh start? Current thinking: inherit — the worktree needs the milestone's CONTEXT.md and ROADMAP.md to continue planning.
