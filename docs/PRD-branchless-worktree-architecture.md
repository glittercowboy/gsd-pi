# PRD: Branchless Worktree Architecture

**Author:** Lex Christopherson
**Date:** 2026-03-15
**ADR:** [ADR-001-branchless-worktree-architecture.md](./ADR-001-branchless-worktree-architecture.md)
**Priority:** Critical — blocks reliable auto-mode operation

---

## Problem Statement

GSD's auto-mode is unreliable. Users experience:

1. **Infinite loop detection failures** — the agent writes planning artifacts on slice branches that become invisible after branch switching, causing `verifyExpectedArtifact()` to fail repeatedly. Auto-mode burns budget retrying the same unit 3-6 times before hard-stopping. This is the #1 user complaint.

2. **State corruption across branches** — `.gsd/` planning artifacts (roadmaps, plans, decisions) are gitignored but branch-specific. Multiple branches sharing a single `.gsd/` directory clobber each other's state. Users see wrong milestones marked complete, wrong roadmaps loaded, and auto-mode starting from the wrong phase.

3. **Excessive complexity** — 770+ lines of merge, conflict resolution, branch switching, and self-healing code exist solely to manage slice branches inside worktrees. This code has required 15+ bug fixes across versions and remains the primary source of auto-mode failures.

These problems are architectural. They cannot be fixed by patching individual symptoms.

## Vision

Auto-mode uses git worktrees for isolation and sequential commits for history. No branch switching. No merge conflicts within a worktree. Planning artifacts are tracked in git and travel with the branch. The git layer is so simple it can't break.

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| Zero loop detection failures from branch visibility | No `verifyExpectedArtifact()` failures caused by branch mismatch in 50 consecutive auto-mode runs |
| Zero `.gsd/` state corruption | Manual worktrees created via `git worktree add` have correct `.gsd/` state without any GSD-specific initialization |
| Code deletion | Net removal of ≥500 lines of merge/conflict/branch-switching code |
| Test simplification | Removal or simplification of ≥6 merge-specific test files |
| Backwards compatibility | Existing projects with `gsd/M001/S01` slice branches continue to work (read-only; new work uses new model) |
| No new git primitives | The implementation uses only: worktrees, commits, squash-merge. No new branch types, merge strategies, or conflict resolution. |

## Non-Goals

- Parallel slice execution within a single worktree (if needed later, use separate worktrees)
- Changing how milestones relate to `main` (squash-merge stays)
- Modifying the dispatch unit types or state machine (except removing `fix-merge`)
- Changing the worktree-manager.ts manual worktree API (`/worktree` command)

## Current Architecture

### Branch Model (M003, v2.13.0)

```
main
  └─ milestone/M001 (worktree at .gsd/worktrees/M001/)
       ├─ gsd/M001/S01 (slice branch — code + .gsd/ artifacts)
       │   └── merge --no-ff → milestone/M001
       ├─ gsd/M001/S02
       │   └── merge --no-ff → milestone/M001
       └── squash merge → main
```

### Data Flow

```
Agent writes file → on slice branch → handleAgentEnd → auto-commit on slice branch
→ switch to milestone branch → verifyExpectedArtifact → FILE NOT FOUND (it's on slice branch)
→ loop counter++ → retry → same result → HARD STOP
```

### Code Involved

| File | Lines | Purpose |
|------|-------|---------|
| `auto-worktree.ts` | 512 | Worktree lifecycle + slice→milestone merge |
| `git-service.ts` | 915 | Branch creation, switching, merge with conflict resolution |
| `git-self-heal.ts` | 198 | Merge failure recovery |
| `auto.ts` | ~150 lines | Merge dispatch guards, fix-merge routing, branch-mode vs worktree-mode branching |
| `worktree.ts` | ~40 lines | Slice branch delegates |
| 11 test files | ~2000 lines | Merge/branch/worktree test coverage |

### `.gsd/` Tracking (Current — Contradictory)

- `.gitignore` line 52: `.gsd/` — ignores everything
- `smartStage()` lines 338-349: force-adds `GSD_DURABLE_PATHS` — tracks milestones/, DECISIONS.md, PROJECT.md, REQUIREMENTS.md, QUEUE.md
- Result: `.gsd/milestones/` is partially tracked on some branches, fully ignored on others. The code fights the config.

## Proposed Architecture

### Branch Model

```
main
  └─ milestone/M001 (worktree at .gsd/worktrees/M001/)
       │
       commit: feat(M001): context + roadmap
       commit: feat(M001/S01): research
       commit: feat(M001/S01): plan
       commit: feat(M001/S01/T01): implement auth service
       commit: feat(M001/S01/T02): implement auth tests
       commit: feat(M001/S01): summary + UAT
       commit: docs(M001): reassess roadmap after S01
       commit: feat(M001/S02): research
       commit: feat(M001/S02): plan
       commit: ...
       commit: feat(M001): milestone complete
       │
       └── squash merge → main
```

One branch. Sequential commits. No merges within the worktree.

### Data Flow

```
Agent writes file → on milestone branch → handleAgentEnd → auto-commit on milestone branch
→ verifyExpectedArtifact → FILE FOUND (same branch) → persist completion → next dispatch
```

### `.gsd/` Tracking (Proposed — Coherent)

**Tracked (travels with branch):**
```
.gsd/milestones/**/*.md    (except CONTINUE markers)
.gsd/milestones/**/*.json  (META.json integration records)
.gsd/PROJECT.md
.gsd/DECISIONS.md
.gsd/REQUIREMENTS.md
.gsd/QUEUE.md
```

**Gitignored (ephemeral):**
```
.gsd/auto.lock
.gsd/completed-units.json
.gsd/STATE.md
.gsd/metrics.json
.gsd/gsd.db
.gsd/activity/
.gsd/runtime/
.gsd/worktrees/
.gsd/DISCUSSION-MANIFEST.json
.gsd/milestones/**/*-CONTINUE.md
.gsd/milestones/**/continue.md
```

### Why This Works

| Problem | How It's Solved |
|---------|----------------|
| Artifact invisibility after branch switch | No branch switching. Artifacts commit on the one branch. |
| `.gsd/` state clobbering | Artifacts tracked in git. Each branch carries its own `.gsd/`. `git worktree add` and `git checkout` give correct state. |
| Merge conflict complexity | No merges within a worktree. Only merge is milestone→main (squash). |
| Manual worktree initialization | Tracked artifacts are checked out with the branch. No GSD-specific bootstrap needed. |
| Dual isolation mode maintenance | Single mode: worktree. Branch-mode (`git.isolation: "branch"`) deprecated. |

## Implementation Plan

### Phase 1: `.gitignore` + Tracking Fix

**Goal:** Planning artifacts are tracked in git. `.gitignore` reflects reality.

1. Update `.gitignore`:
   - Remove blanket `.gsd/` ignore
   - Add explicit runtime-only ignores (see proposed list above)

2. Force-add existing planning artifacts on current branch:
   ```
   git add --force .gsd/milestones/ .gsd/PROJECT.md .gsd/DECISIONS.md .gsd/REQUIREMENTS.md .gsd/QUEUE.md
   ```

3. Ensure runtime files are NOT tracked:
   ```
   git rm --cached -r .gsd/runtime/ .gsd/activity/ .gsd/STATE.md .gsd/metrics.json .gsd/completed-units.json .gsd/auto.lock
   ```

4. Update README suggested `.gitignore` section

5. Remove `smartStage()` force-add of `GSD_DURABLE_PATHS` — no longer needed since `.gitignore` doesn't block them

**Verification:** `git status` shows planning artifacts tracked, runtime files untracked. `git worktree add` on a new worktree has correct `.gsd/milestones/` state.

### Phase 2: Remove Slice Branch Creation + Switching

**Goal:** No code creates, switches to, or references slice branches for new work.

1. Remove `ensureSliceBranch()` from `git-service.ts` (lines 485-544)
2. Remove `switchToMain()` from `git-service.ts` (lines 549-563)
3. Remove `getSliceBranchName()` from `worktree.ts` (lines 94-98)
4. Remove `isOnSliceBranch()` and `getActiveSliceBranch()` from `worktree.ts`
5. Update `auto.ts` dispatch paths — remove branch creation before `execute-task`
6. Update `handleAgentEnd` — remove branch-switching logic post-dispatch

**Verification:** Auto-mode runs a full slice (research → plan → execute → complete) without creating any branches. All commits land on `milestone/<MID>`.

### Phase 3: Remove Slice Merge Code

**Goal:** All slice→milestone and slice→main merge code is deleted.

1. Remove `mergeSliceToMilestone()` from `auto-worktree.ts` (lines 253-350)
2. Remove `mergeSliceToMain()` from `git-service.ts` (lines 705-893)
3. Remove merge dispatch guards from `auto.ts` (lines 1635-1679)
4. Remove `fix-merge` dispatch unit type from `auto.ts`
5. Remove `buildPromptForFixMerge()` from `auto.ts`
6. Remove `withMergeHeal()` from `git-self-heal.ts` (lines 99-136)
7. Remove `abortAndReset()` from `git-self-heal.ts` (lines 37-84) — or simplify to crash-recovery-only
8. Remove `shouldUseWorktreeIsolation()` preference resolution — worktree is the only mode
9. Remove `getMergeToMainMode()` — milestone merge is the only mode
10. Deprecate `git.isolation: "branch"` and `git.merge_to_main: "slice"` preferences

**Verification:** `git grep mergeSliceToMilestone` returns zero results. `git grep mergeSliceToMain` returns zero results. `git grep fix-merge` returns zero results (outside of changelog/docs).

### Phase 4: Simplify `mergeMilestoneToMain()`

**Goal:** Milestone→main merge is clean and minimal.

The function becomes:
1. Auto-commit any dirty state in worktree
2. `process.chdir(originalBasePath)` — back to main repo
3. `git checkout main`
4. `git merge --squash milestone/<MID>`
5. Build commit message with milestone summary + slice manifest
6. `git commit`
7. Optional: `git push`
8. `removeWorktree()` + `git branch -D milestone/<MID>`

No conflict categorization. No runtime file stripping (runtime files are gitignored, not in the merge). No `.gsd/` special handling.

If squash-merge conflicts (parallel milestone edge case): stop auto-mode with clear error, user resolves manually or GSD dispatches a one-time resolution session.

**Verification:** Complete a full milestone in auto-mode. `main` receives one squash commit with all code and planning artifacts.

### Phase 5: Test Cleanup

**Goal:** Test suite reflects the simplified architecture.

1. Delete or rewrite:
   - `auto-worktree-merge.test.ts` — tests slice→milestone merge (deleted)
   - `auto-worktree-milestone-merge.test.ts` — rewrite for simplified milestone→main
   - `worktree-e2e.test.ts` — rewrite for branchless flow
   - `worktree-integration.test.ts` — rewrite for branchless flow
   - Merge-related test cases in `git-service.test.ts`

2. Add new tests:
   - Branchless worktree lifecycle: create → commit → commit → squash-merge → cleanup
   - `.gsd/` tracking: planning artifacts tracked, runtime files ignored
   - Manual worktree: `git worktree add` has correct `.gsd/` state
   - Crash recovery: dirty state on milestone branch, restart, auto-commit, continue

3. Remove merge-specific doctor checks or simplify:
   - `corrupt_merge_state` — keep (still relevant for milestone→main)
   - `orphaned_auto_worktree` — keep
   - `stale_milestone_branch` — keep
   - `tracked_runtime_files` — keep

**Verification:** `npm run test` passes. No test references `mergeSliceToMilestone`, `mergeSliceToMain`, or `ensureSliceBranch`.

### Phase 6: Migration + Backwards Compatibility

**Goal:** Existing projects with slice branches continue to work.

1. State derivation (`deriveState()`) continues to read `gsd/M001/S01` branch naming for legacy detection
2. On first run after upgrade:
   - Detect existing slice branches
   - Notify user: "GSD no longer creates slice branches. Existing branches are preserved but new work commits directly to the milestone branch."
   - No forced migration — legacy branches are read-only context
3. Doctor check: `legacy_slice_branches` — informational, not auto-fix
4. Update `shouldUseWorktreeIsolation()` preference handling:
   - `git.isolation: "worktree"` → default behavior (only option)
   - `git.isolation: "branch"` → warning, treated as worktree
   - Remove preference UI for isolation mode

**Verification:** Open a project with existing `gsd/M001/S01` branches. GSD reads state correctly, new work commits on milestone branch without slice branches.

## Stress Test Results

Validated by three independent models:

### Gemini 2.5 Pro — 6 Attack Vectors

| Attack | Severity | Mitigation |
|--------|----------|------------|
| Parallel milestone code conflict at squash-merge | Medium | `git rebase main` before squash. Rare in single-user. |
| SQLite desync after `git reset --hard` | Low | DB rebuilt from tracked markdown on startup (M001/S02 importers). |
| Ghost lock after SIGKILL | Low | Existing heartbeat lock detection handles this. |
| Squash merge loses bisect granularity | Low | Commit messages tag slices. Branch preservable if needed. |
| Disk space with multiple worktrees | Low | Single active milestone at a time. Immediate cleanup. |
| Plan-action atomicity gap (crash between write and commit) | Low | `handleAgentEnd` auto-commits. Sequential model simplifies recovery. |

### GPT-5.4 (Codex) — Codebase-Informed Analysis

- Confirmed `smartStage()` force-add already implements tracked-artifact intent
- Confirmed `resolveMainWorktreeRoot` (PR #487) contradicts this architecture
- Confirmed `.gsd/milestones/` partially tracked on `main` despite `.gitignore`
- Verdict: **Model is sound. Removes only accidental complexity.**

### GPT-5.4 (Codex) — Dissenting Opinion

Codex agreed on tracked artifacts and worktree-per-milestone, but pushed back on removing slice branches, calling it "a redesign, not a simplification." Specific concerns:

| Concern | Rebuttal |
|---------|----------|
| Crash recovery for orphaned slice branches disappears | The failure mode (orphaned branch needing merge) is caused by slice branches. Removing branches removes the failure. Sequential commits on one branch need no orphan recovery. |
| Concurrent edits to shared root docs (DECISIONS.md) from two terminals | Standard content conflict at squash-merge time. Not caused by or solved by slice branches. |
| Continuous integration via slice→milestone merges | In sequential single-user work, there's nothing to integrate against within the worktree. Pre-flight rebase before squash-merge is more direct. |
| Need a replacement slice-boundary primitive | Accepted: conventional commit tags (`feat(M001/S01):`) + optional git tags (`gsd/M001/S01-complete`) serve as boundaries. |

Codex's analysis confirms the tracked-artifact approach but recommends treating branchless as a deliberate redesign with explicit replacement primitives, not a casual deletion.

### Edge Case: Two Milestones Touching Same Source Files

Scenario: M001 and M002 both modify `src/auth.ts`. M001 squash-merges first.

Resolution: Before M002 squash-merges, rebase onto updated `main`:
```
cd .gsd/worktrees/M002
git fetch origin main
git rebase main
# Resolve any conflicts (code-only, never .gsd/)
# Then squash-merge
```

This is standard git workflow. GSD can automate the rebase step as a pre-merge check.

### Edge Case: Agent Crash Mid-Commit

Scenario: Power loss during `git commit` on the milestone branch.

Resolution: Git's internal journaling protects the object store. On restart:
- If commit completed: state is consistent
- If commit didn't complete: working directory has uncommitted changes, `handleAgentEnd` auto-commits on next dispatch
- No branch to be "stuck between" — single branch means no split-brain state

### Edge Case: User Edits Main While Worktree Active

Scenario: User makes manual commits on `main` while M001 worktree is active.

Resolution: Worktree is on `milestone/M001` branch, independent of `main`. Manual `main` commits don't affect the worktree. At squash-merge time, `git merge --squash` handles the divergence normally. If there's a conflict, it's resolved once.

## Metrics

### Before (Current)

| Metric | Value |
|--------|-------|
| Merge/conflict/branch code | 770+ lines across 4 files |
| Merge-related test files | 11 files |
| Branch types | 4 (main, milestone/*, gsd/*/*, worktree/*) |
| Merge strategies | 3 (--no-ff, --squash, conflict resolution) |
| Dispatch unit types with merge logic | 2 (complete-slice, fix-merge) |
| Isolation modes | 2 (branch, worktree) |
| Doctor git checks | 4 |

### After (Proposed)

| Metric | Value |
|--------|-------|
| Merge/conflict/branch code | ~50 lines (simplified `mergeMilestoneToMain` only) |
| Merge-related test files | 3-4 files (rewritten) |
| Branch types | 2 (main, milestone/*) |
| Merge strategies | 1 (--squash) |
| Dispatch unit types with merge logic | 0 |
| Isolation modes | 1 (worktree) |
| Doctor git checks | 3-4 (simplified) |

### Net Impact

- **~720 lines deleted** (net, after simplified replacements)
- **~7 test files deleted or consolidated**
- **2 branch types eliminated**
- **2 merge strategies eliminated**
- **1 dispatch unit type eliminated** (fix-merge)
- **1 isolation mode eliminated** (branch)
- **0 merge conflicts possible within a worktree**

## Dependencies

- **M001 (Memory Database):** The SQLite database (`gsd.db`) must remain gitignored. The M001/S02 importer layer rebuilds it from tracked markdown. This PRD's `.gitignore` update explicitly ignores `gsd.db`.

- **PR #487:** Must be closed. The `resolveMainWorktreeRoot` approach (sharing `.gsd/` across worktrees) contradicts tracked-artifact architecture.

## Open Questions

1. **Squash vs `--no-ff` for milestone→main merge?** Squash gives clean history on `main` but loses bisect granularity. `--no-ff` preserves granular commits but clutters `main`. Current proposal: squash (matching existing behavior), with option to preserve milestone branch for debugging.

2. **Should `worktrees/` move outside `.gsd/`?** Having worktrees inside `.gsd/` creates a nesting-doll pattern (worktree contains `.gsd/` which is inside `.gsd/worktrees/`). Relocating to `.gsd-worktrees/` or `~/.gsd/worktrees/<repo-hash>/` is cleaner but changes the filesystem layout. Recommendation: defer, address separately if it causes issues.

3. **Pre-flight rebase automation?** Before milestone→main squash-merge, should GSD automatically `git rebase main`? Gemini recommends yes. Risk: rebase can fail with conflicts, adding a code path. Recommendation: implement as a doctor check ("milestone branch is behind main by N commits") with manual resolution, automate later if needed.
