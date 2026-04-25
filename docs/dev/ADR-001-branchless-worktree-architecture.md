# ADR-001: Branchless Worktree Architecture

**Status:** Proposed
**Date:** 2026-03-15
**Deciders:** Lex Christopherson
**Advisors:** Claude Opus 4.6, Gemini 2.5 Pro, GPT-5.4 (Codex)

## Context

GSD uses git for isolation during autonomous coding sessions. The current architecture (shipped in M003, v2.13.0) creates a **worktree per milestone** with **slice branches inside each worktree**. Each slice (`S01`, `S02`, ...) gets its own branch (`gsd/M001/S01`) within the worktree, which merges back to the milestone branch (`milestone/M001`) via `--no-ff` when the slice completes. The milestone branch squash-merges to `main` when the milestone completes.

This architecture replaced a previous "branch-per-slice" model that had severe `.gsd/` merge conflicts. M003 solved the merge conflicts but retained slice branches inside worktrees, inheriting complexity that has produced persistent, user-facing failures.

### Problems

**1. Planning artifact invisibility (loop detection failures)**

When `research-slice` or `plan-slice` dispatches, the agent writes artifacts (e.g., `S02-RESEARCH.md`) on a slice branch. After the agent completes, `handleAgentEnd` switches back to the milestone branch for the next dispatch. The artifact is on the slice branch, not the milestone branch. `verifyExpectedArtifact()` checks the milestone branch, can't find the file, increments the loop counter, retries, same result. After 3 retries → hard stop. After 6 lifetime dispatches → permanent stop. This burns budget and blocks progress.

Documented in the auto-stop architecture doc as "The Branch-Switching Problem."

**2. `.gsd/` state clobbering across branches**

`.gsd/` is gitignored (line 52 of `.gitignore`: `.gsd/`). Planning artifacts (roadmaps, plans, summaries, decisions, requirements) live in `.gsd/milestones/` but are invisible to git. When multiple branches or worktrees operate from the same repo, they share a single `.gsd/` directory on disk. Branch A's M001 roadmap overwrites Branch B's M001 roadmap. GSD reads corrupted state, shows wrong milestone as complete, or enters infinite dispatch loops.

The codebase has a contradictory workaround: `smartStage()` (git-service.ts:304-352) force-adds `GSD_DURABLE_PATHS` (milestones/, DECISIONS.md, PROJECT.md, REQUIREMENTS.md, QUEUE.md) despite the `.gitignore`. This means `.gsd/milestones/` IS partially tracked on some branches but the gitignore claims otherwise. The code fights the configuration.

**3. Merge/conflict code complexity**

The current slice branch model requires:
- `mergeSliceToMilestone()` — 98 lines, `--no-ff` merge with `withMergeHeal` wrapper
- `mergeSliceToMain()` — 189 lines, squash-merge with conflict detection/categorization/auto-resolution
- `git-self-heal.ts` — 198 lines, 3 recovery functions for merge failures
- `fix-merge` dispatch unit — dedicated LLM session to resolve conflicts the auto-resolver can't handle
- `smartStage()` — 49 lines of runtime exclusion during staging
- Conflict categorization — 80 lines classifying `.gsd/` vs runtime vs code conflicts

Total: **~582 lines** of merge/branch/conflict code across 3 files, plus the `fix-merge` prompt template and dispatch logic. This code exists solely because of slice branches.

**4. Dual isolation modes**

Branch-mode (`git-service.ts:mergeSliceToMain`) and worktree-mode (`auto-worktree.ts:mergeSliceToMilestone`) have parallel implementations with different merge strategies, different conflict handling, and different branch naming. Both paths must be maintained and tested. 11 test files exercise merge/branch/worktree logic.

**5. Bug history**

- v2.11.1: URGENT fix for parse cache staleness causing repeated unit dispatch (directly caused by branch switching invalidation timing)
- v2.13.1: Windows hotfix for multi-line commit messages in `mergeSliceToMilestone`
- 15+ separate bug fixes for `.gsd/` merge conflicts in the pre-M003 era
- Persistent user complaints about loop detection failures and state corruption

## Decision

**Eliminate slice branches entirely.** All work within a milestone worktree commits sequentially on a single branch (`milestone/<MID>`). No branch creation, no branch switching, no slice merges, no conflict resolution within a worktree.

Track `.gsd/` planning artifacts in git. Gitignore only runtime/ephemeral state.

### The Architecture

```
main ──────────────────────────────────────────── main
  │                                                 ↑
  └─ worktree (milestone/M001)                      │
       │                                            │
       commit: feat(M001): context + roadmap        │
       commit: feat(M001/S01): research             │
       commit: feat(M001/S01): plan                 │
       commit: feat(M001/S01/T01): impl             │
       commit: feat(M001/S01/T02): impl             │
       commit: feat(M001/S01): summary + UAT        │
       commit: feat(M001/S02): research             │
       commit: ...                                  │
       commit: feat(M001): milestone complete       │
       │                                            │
       └──────────── squash merge ──────────────────┘
```

### Git Primitives Used

| Primitive | Purpose |
|-----------|---------|
| **Worktrees** | One per active milestone. Filesystem isolation. |
| **Commits** | Granular sequential history of every action. |
| **Squash merge** | Clean single commit on `main` per milestone. |
| **Branches** | Only `main` and `milestone/<MID>`. Nothing else. |

### Git Primitives NOT Used

| Primitive | Why Not |
|-----------|---------|
| Slice branches | Slices are sequential. Branches add complexity with no rollback benefit. |
| `--no-ff` merges | No branches to merge within a worktree. |
| Branch switching | Never happens. All work on one branch. |
| Conflict resolution | No merges within a worktree means no conflicts within a worktree. |

### `.gsd/` Tracking Model

**Tracked in git (travels with the branch):**
```
.gsd/milestones/         — roadmaps, plans, summaries, research, contexts, task plans/summaries
.gsd/PROJECT.md          — project overview
.gsd/DECISIONS.md        — architectural decision register
.gsd/REQUIREMENTS.md     — requirements register
.gsd/QUEUE.md            — work queue
```

**Gitignored (ephemeral, runtime, infrastructure):**
```
.gsd/runtime/            — dispatch records, timeout tracking
.gsd/activity/           — JSONL session dumps
.gsd/worktrees/          — git worktree working directories
.gsd/auto.lock           — crash detection sentinel
.gsd/metrics.json        — token/cost accumulator
.gsd/completed-units.json — dispatch idempotency tracker
.gsd/STATE.md            — derived state cache (rebuilt by deriveState())
.gsd/gsd.db              — SQLite cache (rebuilt from tracked markdown by importers)
.gsd/DISCUSSION-MANIFEST.json — discussion phase tracking
.gsd/milestones/**/*-CONTINUE.md — interrupted-work markers
.gsd/milestones/**/continue.md   — legacy continue markers
```

### `.gitignore` Update

Replace the current blanket `.gsd/` ignore with explicit runtime-only ignores:

```gitignore
# ── GSD: Runtime / Ephemeral ─────────────────────────────────
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

Planning artifacts (milestones/, PROJECT.md, DECISIONS.md, REQUIREMENTS.md, QUEUE.md) are NOT in `.gitignore` and are tracked normally.

## Consequences

### Code Deletion

| File | Lines Deleted | What's Removed |
|------|--------------|----------------|
| `auto-worktree.ts` | ~246 | `mergeSliceToMilestone()`, `shouldUseWorktreeIsolation()`, `getMergeToMainMode()`, slice merge guards |
| `git-service.ts` | ~250 | `mergeSliceToMain()`, conflict resolution, runtime stripping post-merge, `ensureSliceBranch()`, `switchToMain()` |
| `git-self-heal.ts` | ~86 | `abortAndReset()`, `withMergeHeal()` (merge-specific recovery) |
| `auto.ts` | ~150 | Merge dispatch guards, `fix-merge` dispatch path, branch-mode routing |
| `worktree.ts` | ~40 | `getSliceBranchName()`, `ensureSliceBranch()`, `mergeSliceToMain()` delegates |
| **Test files** | ~11 files | `auto-worktree-merge.test.ts`, `auto-worktree-milestone-merge.test.ts`, merge-related test cases |
| **Total** | **~770+ lines** | |

### What `mergeMilestoneToMain()` Becomes

The function simplifies dramatically:
1. Auto-commit any dirty state in worktree
2. `chdir` back to main repo root
3. `git checkout main`
4. `git merge --squash milestone/<MID>`
5. `git commit` with milestone summary
6. Remove worktree + delete branch

No conflict categorization. No runtime file stripping. No `.gsd/` special handling. Planning artifacts merge cleanly because they're in `.gsd/milestones/M001/` which doesn't exist on `main` until this merge.

### What `smartStage()` Becomes

The force-add of `GSD_DURABLE_PATHS` is no longer needed — planning artifacts are not gitignored, so `git add -A` picks them up naturally. The function reduces to:

1. `git add -A`
2. `git reset HEAD -- <runtime paths>` (unstage runtime files)

The `_runtimeFilesCleanedUp` one-time migration logic can also be removed.

### What Happens to `handleAgentEnd()`

After any unit completes:
1. Invalidate caches
2. `autoCommitCurrentBranch()` — commits on the one and only branch
3. `verifyExpectedArtifact()` — file is always on the current branch (no branch switching)
4. Persist completion key

The "Path A fix" (lines 937-953) becomes the only path. No branch mismatch possible.

### What Happens to `fix-merge`

The `fix-merge` dispatch unit type is eliminated. Within a worktree, there are no merges that can conflict. The only merge is milestone→main (squash), and if that conflicts (rare, parallel milestone edge case), it's handled as a one-time resolution at milestone completion — not a dispatch loop.

### Backwards Compatibility

The `shouldUseWorktreeIsolation()` three-tier preference resolution is replaced by a single behavior: worktree isolation is always used. The `git.isolation: "branch"` preference is deprecated.

Projects with existing `gsd/M001/S01` slice branches can still be read by state derivation, but new work never creates slice branches.

### Risks

**1. Parallel milestone code conflicts at squash-merge time**

If two milestones modify the same source file, the second squash-merge to `main` will conflict. Mitigation: `git fetch origin main && git rebase main` before squash-merge. This is standard practice and rare in single-user workflows.

**2. Loss of per-slice git history after squash**

Squash merge collapses all commits into one on `main`. Mitigations:
- Commit messages tag slices (`feat(M001/S01/T01):`) — filterable with `git log --grep`
- The milestone branch can be preserved (not deleted) if history is needed
- Alternative: `merge --no-ff` instead of `--squash` to keep history on `main`

**3. SQLite DB desync after `git reset`**

If tracked markdown rolls back via `git reset --hard`, the gitignored `gsd.db` doesn't. Mitigation: the importer layer (M001/S02) rebuilds the DB from markdown on startup. The DB is a cache, markdown is truth.

**4. Disk space with multiple worktrees**

Each worktree duplicates the working directory (including `node_modules`). Mitigation: single active milestone at a time (single-user workflow), immediate cleanup after completion.

## Alternatives Considered

### A. Keep slice branches, fix visibility with immediate mini-merges

After `research-slice` or `plan-slice`, immediately merge the slice branch back to the milestone branch. This fixes the loop detection bug but retains all merge complexity.

**Rejected:** Adds another merge path instead of removing the root cause. Still requires conflict resolution, self-healing, branch switching.

### B. Keep `.gsd/` gitignored, bootstrap from git history for manual worktrees

When GSD detects an empty `.gsd/` in a worktree, reconstruct state from the branch's git history using `git show <commit>:.gsd/...`.

**Rejected:** Recovery logic, not architecture. Doesn't fix the fundamental problem of branch-agnostic state. Fails when git history has been rewritten.

### C. Branch-scoped `.gsd/` directories (`.gsd/branches/<branch-name>/milestones/...`)

Each branch writes to a namespaced subdirectory within `.gsd/`.

**Rejected:** Adds complexity instead of removing it. Requires renaming/moving on branch creation, doesn't work with standard git tools (`git checkout` doesn't rename directories).

## Validation

This architecture was stress-tested by three independent models:

**Gemini 2.5 Pro** identified 6 attack vectors. None broke the core model. Recommendations: pre-flight rebase before squash-merge (adopted), heartbeat locks (already exists), DB rebuild on startup (adopted via M001/S02 importers).

**GPT-5.4 (Codex)** read the full codebase and confirmed the model is sound. Identified that `smartStage()` already force-adds durable paths (validating the tracked-artifact approach) and that `resolveMainWorktreeRoot` in PR #487 is architecturally wrong (adopted — PR to be closed).

**Codebase analysis** confirmed `.gsd/milestones/` is already partially tracked on `main` despite the `.gitignore`, that `GSD_DURABLE_PATHS` exists as a code-level acknowledgment that planning artifacts should be tracked, and that the README already documents the correct runtime-only gitignore pattern.

### Codex (GPT-5.4) Dissent — "No Slice Branches Is a Redesign"

Codex read the full codebase and raised 4 concerns. Each is addressed:

**Concern 1: "Crash after slice done but before integration — today the runtime detects orphaned slice branches and merges them."**

Rebuttal: In the branchless model, there is no integration step to crash between. Slice work is committed directly on the milestone branch. On restart, `deriveState()` reads the branch state as-is. The orphaned-branch recovery path exists solely because of slice branches — removing branches removes the failure mode it recovers from.

**Concern 2: "Concurrent edits to shared root docs (PROJECT.md, DECISIONS.md) from two terminals."**

Rebuttal: Valid edge case. If `/gsd queue` edits `DECISIONS.md` on `main` while auto-mode edits it in a worktree, there's a content conflict at squash-merge time. This is a standard git content conflict — no different from two developers editing the same file. Handled by normal merge resolution. Not caused by or solved by slice branches.

**Concern 3: "Slice→milestone merges provide continuous integration. Removing them pushes conflict discovery to the end."**

Rebuttal: In a single-user sequential workflow, there is nothing to integrate against within a worktree. Each slice builds on the previous one. The only conflict source is `main` diverging (e.g., another milestone merging first), which slice→milestone merges don't catch anyway — they merge within the worktree, not against `main`. Pre-flight rebase before squash-merge catches this more directly.

**Concern 4: "Replace slice branches with another explicit slice-boundary primitive. Don't just delete them."**

Response: Accepted in spirit. Commits with conventional tags (`feat(M001/S01):`, `feat(M001/S01/T01):`) serve as the slice boundary primitive. `git log --grep="M001/S01"` isolates a slice's history. `git revert` targets specific commits. Git tags (`gsd/M001/S01-complete`) can mark slice completion if needed. The boundary primitive is commit metadata, not branches.

## Action Items

1. Close PR #487 (`resolveMainWorktreeRoot`) — contradicts this architecture
2. Implement as a GSD milestone with phases:
   - Update `.gitignore` and force-add existing planning artifacts
   - Remove slice branch creation/switching/merging code
   - Simplify `mergeMilestoneToMain()` and `smartStage()`
   - Remove `fix-merge` dispatch unit
   - Remove branch-mode isolation (`git.isolation: "branch"`)
   - Update/delete 11 test files
   - Update README suggested gitignore
   - Migration path for existing projects with slice branches
