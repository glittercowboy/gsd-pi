# Issue #524: Move Git Operations to Rust via git2 Crate

## Current State

- **git2** crate (v0.20) already a dependency with vendored libgit2
- **7 read-only** functions already native in `git.rs` + `native-git-bridge.ts`:
  - `git_current_branch`, `git_main_branch`, `git_branch_exists`
  - `git_has_merge_conflicts`, `git_working_tree_status`, `git_has_changes`
  - `git_commit_count_between`
- **~73 execSync/execFileSync git calls** remain across 14 TypeScript files
- All native functions follow the same pattern: native-first with execSync fallback

## Scope

This plan covers **Phase 1**: migrate all remaining read operations and high-value
write operations to native git2. Push operations stay as execSync (credential
handling too complex for git2). The "Additional Rust Opportunities" (state
derivation, JSONL parser) are out of scope for this PR.

---

## Phase 1: New Native Read Functions (git.rs)

### 1.1 — `git_is_repo(path: String) -> bool`
Replaces: `git rev-parse --git-dir` (3 calls in auto.ts, guided-flow.ts, doctor.ts)
Implementation: `Repository::open(path).is_ok()`

### 1.2 — `git_has_staged_changes(repo_path: String) -> bool`
Replaces: `git diff --cached --stat` (2 calls in git-service.ts)
Implementation: Diff index vs HEAD tree, check if delta count > 0

### 1.3 — `git_diff_stat(repo_path, from_ref?, to_ref?) -> GitDiffStat`
Replaces: `git diff --stat HEAD`, `git diff --stat --cached HEAD` (session-forensics.ts)
Returns: `{ files_changed: u32, insertions: u32, deletions: u32, summary: String }`
Implementation: Diff between two trees/index/workdir, count deltas

### 1.4 — `git_diff_name_status(repo_path, from_ref, to_ref, pathspec?) -> Vec<GitNameStatus>`
Replaces: `git diff --name-status main...branch -- .gsd/` (worktree-manager.ts, 3 calls)
Returns: `Vec<{ status: String, path: String }>`
Implementation: Tree-to-tree diff with pathspec filter

### 1.5 — `git_diff_numstat(repo_path, from_ref, to_ref) -> Vec<GitNumstat>`
Replaces: `git diff --numstat main branch` (worktree-manager.ts, 1 call)
Returns: `Vec<{ added: u32, removed: u32, path: String }>`

### 1.6 — `git_diff_content(repo_path, from_ref, to_ref, pathspec?, exclude?) -> String`
Replaces: `git diff main...branch -- .gsd/` and `-- . :(exclude).gsd/` (worktree-manager.ts, 2 calls)
Returns: Unified diff string

### 1.7 — `git_log_oneline(repo_path, from_ref, to_ref) -> Vec<GitLogEntry>`
Replaces: `git log --oneline main..branch` (worktree-manager.ts, 1 call)
Returns: `Vec<{ sha: String, message: String }>`

### 1.8 — `git_worktree_list(repo_path) -> Vec<GitWorktreeEntry>`
Replaces: `git worktree list --porcelain` (worktree-manager.ts, 2 calls)
Returns: `Vec<{ path: String, branch: String, is_bare: bool }>`
Implementation: `Repository::worktrees()` + individual worktree info

### 1.9 — `git_branch_list(repo_path, pattern?) -> Vec<String>`
Replaces: `git branch --list milestone/*`, `git branch --list gsd/*` (doctor.ts, commands.ts, 3 calls)
Returns: Branch names matching pattern

### 1.10 — `git_branch_list_merged(repo_path, target, pattern?) -> Vec<String>`
Replaces: `git branch --merged main --list gsd/*` (commands.ts, 1 call)
Returns: Branch names merged into target

### 1.11 — `git_ls_files(repo_path, pathspec) -> Vec<String>`
Replaces: `git ls-files "<exclusion>"` (doctor.ts, 1 call)
Implementation: Read index, filter by pathspec

### 1.12 — `git_for_each_ref(repo_path, prefix) -> Vec<String>`
Replaces: `git for-each-ref refs/gsd/snapshots/ --format=%(refname)` (commands.ts, 1 call)
Implementation: `repo.references_glob(prefix/*)`

### 1.13 — `git_conflict_files(repo_path) -> Vec<String>`
Replaces: `git diff --name-only --diff-filter=U` (auto-worktree.ts, 1 call)
Implementation: Read index conflicts

### 1.14 — `git_batch_info(repo_path) -> GitBatchInfo`
NEW batch function: status + branch + diff summary in ONE call
Returns: `{ branch: String, has_changes: bool, status: String, staged_count: u32, unstaged_count: u32 }`

---

## Phase 2: New Native Write Functions (git.rs)

### 2.1 — `git_init(path, branch?) -> void`
Replaces: `git init -b <branch>` (auto.ts, guided-flow.ts, 2 calls)
Implementation: `Repository::init()` + set initial branch

### 2.2 — `git_add_all(repo_path) -> void`
Replaces: `git add -A` (auto-worktree.ts, git-service.ts, 4 calls)
Implementation: Add all to index via `repo.index().add_all()`

### 2.3 — `git_add_paths(repo_path, paths: Vec<String>) -> void`
Replaces: `git add -- <file>` (auto-worktree.ts, git-service.ts, 3 calls)
Implementation: Add specific paths to index

### 2.4 — `git_reset_paths(repo_path, paths: Vec<String>) -> void`
Replaces: `git reset HEAD -- <path>` (git-service.ts, in loop)
Implementation: Reset index entries to HEAD for specific paths

### 2.5 — `git_commit(repo_path, message, options?) -> String`
Replaces: `git commit -m <msg>`, `git commit --no-verify -F -` (11+ calls across files)
Returns: Commit SHA
Implementation: Write index as tree → create commit → update HEAD
Options: `{ allow_empty: bool }`

### 2.6 — `git_checkout_branch(repo_path, branch) -> void`
Replaces: `git checkout <branch>` (auto-worktree.ts, 1 call)
Implementation: Set HEAD + checkout tree

### 2.7 — `git_checkout_theirs(repo_path, paths: Vec<String>) -> void`
Replaces: `git checkout --theirs -- <file>` (auto-worktree.ts, in loop)
Implementation: Resolve index conflict with "theirs" strategy

### 2.8 — `git_merge_squash(repo_path, branch) -> GitMergeResult`
Replaces: `git merge --squash <branch>` (auto-worktree.ts, worktree-manager.ts, 3 calls)
Returns: `{ success: bool, conflicts: Vec<String> }`
Implementation: Find merge base → merge trees → apply to index

### 2.9 — `git_merge_abort(repo_path) -> void`
Replaces: `git merge --abort` (git-self-heal.ts, worktree-command.ts, 2 calls)
Implementation: Reset to ORIG_HEAD, clean merge state

### 2.10 — `git_rebase_abort(repo_path) -> void`
Replaces: `git rebase --abort` (git-self-heal.ts, 1 call)

### 2.11 — `git_reset_hard(repo_path) -> void`
Replaces: `git reset --hard HEAD` (git-self-heal.ts, 1 call)
Implementation: `repo.reset(HEAD, Hard)`

### 2.12 — `git_branch_delete(repo_path, branch, force: bool) -> void`
Replaces: `git branch -D/-d <branch>` (5 calls across files)
Implementation: `repo.find_branch().delete()`

### 2.13 — `git_branch_force_reset(repo_path, branch, target) -> void`
Replaces: `git branch -f <branch> <target>` (worktree-manager.ts, 1 call)

### 2.14 — `git_rm_cached(repo_path, paths: Vec<String>, recursive: bool) -> Vec<String>`
Replaces: `git rm --cached -r --ignore-unmatch` (git-service.ts, doctor.ts, gitignore.ts, 6 calls)
Returns: List of removed paths

### 2.15 — `git_rm_force(repo_path, paths: Vec<String>) -> void`
Replaces: `git rm --force -- <file>` (auto-worktree.ts, 1 call)

### 2.16 — `git_worktree_add(repo_path, path, branch, create_from?) -> void`
Replaces: `git worktree add` commands (worktree-manager.ts, 2 calls)
Implementation: `repo.worktree()` API

### 2.17 — `git_worktree_remove(repo_path, path, force: bool) -> void`
Replaces: `git worktree remove --force` (worktree-manager.ts, doctor.ts, 3 calls)

### 2.18 — `git_worktree_prune(repo_path) -> void`
Replaces: `git worktree prune` (worktree-manager.ts, 3 calls)

### 2.19 — `git_revert_commit(repo_path, sha, no_commit: bool) -> void`
Replaces: `git revert --no-commit <sha>` (undo.ts, 1 call)

### 2.20 — `git_revert_abort(repo_path) -> void`
Replaces: `git revert --abort` (undo.ts, 1 call)

### 2.21 — `git_update_ref(repo_path, refname, target?) -> void`
Replaces: `git update-ref <ref> HEAD` and `git update-ref -d <ref>` (git-service.ts, commands.ts, 2 calls)
When target is null/empty, deletes the ref.

---

## Phase 3: TypeScript Bridge Updates (native-git-bridge.ts)

Add bridge functions for ALL new native functions, each with:
1. Native-first implementation
2. execSync fallback for when native module unavailable
3. Proper error handling
4. Type definitions

---

## Phase 4: Consumer Migration

Update each TypeScript file to use native bridge functions:

### 4.1 — git-service.ts
- `smartStage()` → use `nativeAddAll()` + `nativeResetPaths()`
- `commit()` → use `nativeCommit()`
- `autoCommit()` → use `nativeHasStagedChanges()`
- `createSnapshot()` → use `nativeUpdateRef()`
- Runtime file cleanup → use `nativeRmCached()`
- `runPreMergeCheck()` → use `nativeReadFile()` or keep fs.readFileSync (not git)

### 4.2 — worktree-manager.ts
- `getMainBranch()` → use `nativeDetectMainBranch()` (already exists!)
- `createWorktree()` → use `nativeWorktreeAdd()`, `nativeBranchForceReset()`
- `listWorktrees()` → use `nativeWorktreeList()`
- `removeWorktree()` → use `nativeWorktreeRemove()`, `nativeWorktreePrune()`, `nativeBranchDelete()`
- `diffWorktreeGSD()` → use `nativeDiffNameStatus()`
- `diffWorktreeAll()` → use `nativeDiffNameStatus()`
- `diffWorktreeNumstat()` → use `nativeDiffNumstat()`
- `getWorktreeGSDDiff()` → use `nativeDiffContent()`
- `getWorktreeCodeDiff()` → use `nativeDiffContent()`
- `getWorktreeLog()` → use `nativeLogOneline()`
- `mergeWorktreeToMain()` → use `nativeMergeSquash()` + `nativeCommit()`

### 4.3 — auto-worktree.ts
- `getCurrentBranch()` → use `nativeGetCurrentBranch()` (already exists!)
- `autoCommitDirtyState()` → use `nativeWorkingTreeStatus()` + `nativeAddAll()` + `nativeCommit()`
- `mergeMilestoneToMain()` → use native merge, checkout, commit, branch delete

### 4.4 — auto.ts
- `git rev-parse --git-dir` → use `nativeIsRepo()`
- `git init -b` → use `nativeInit()`
- `git add -A .gsd .gitignore && git commit` → use `nativeAddPaths()` + `nativeCommit()`

### 4.5 — auto-supervisor.ts
- `detectWorkingTreeActivity()` → use `nativeHasChanges()` (already exists!)

### 4.6 — git-self-heal.ts
- `abortAndReset()` → use `nativeMergeAbort()` + `nativeRebaseAbort()` + `nativeResetHard()`

### 4.7 — guided-flow.ts
- Same pattern as auto.ts for init + bootstrap

### 4.8 — doctor.ts
- `git rev-parse --git-dir` → use `nativeIsRepo()`
- `git worktree remove --force` → use `nativeWorktreeRemove()`
- `git branch --list milestone/*` → use `nativeBranchList()`
- `git branch -D` → use `nativeBranchDelete()`
- `git ls-files` → use `nativeLsFiles()`
- `git rm --cached` → use `nativeRmCached()`
- `git branch --format...` → use `nativeBranchList()`

### 4.9 — gitignore.ts
- `untrackRuntimeFiles()` → use `nativeRmCached()`

### 4.10 — commands.ts
- `handleCleanupBranches()` → use `nativeBranchList()`, `nativeBranchListMerged()`, `nativeBranchDelete()`
- `handleCleanupSnapshots()` → use `nativeForEachRef()`, `nativeUpdateRef()`

### 4.11 — undo.ts
- `git revert --no-commit` → use `nativeRevertCommit()`
- `git revert --abort` → use `nativeRevertAbort()`

### 4.12 — session-forensics.ts
- `getGitChanges()` → use `nativeWorkingTreeStatus()` + `nativeDiffStat()`

### 4.13 — worktree-command.ts
- `git merge --abort` → use `nativeMergeAbort()`

---

## Kept as execSync (out of scope)

- `git push <remote> <branch>` — Credential handling too complex for git2
- `cat package.json` — Not a git command (already just fs.readFileSync)
- `npm test` / custom commands — Not git operations

---

## Implementation Order

1. **Rust functions** (git.rs) — all read functions first, then write functions
2. **TypeScript bridge** (native-git-bridge.ts) — add all new bridge functions
3. **Consumer migration** — update each .ts file to use bridge functions
4. **Remove dead code** — delete local `runGit()` helpers from files that no longer need them
5. **Testing** — build native module, run CI, verify all operations work

---

## Risk Mitigation

- Every native function has an execSync fallback in the bridge
- Write operations are tested by existing integration tests
- git2's vendored libgit2 matches git CLI behavior for standard operations
- The `loadNative()` pattern means if ANY native function crashes, ALL functions fall back to CLI

## Expected Impact

- **~70 execSync calls eliminated** when native module is available
- **Zero process spawns** for git operations in the common path
- **Batch operations** (git_batch_info) reduce 3-4 calls to 1
- **Type-safe errors** instead of parsing stderr strings
- **Consistent cross-platform** behavior via libgit2
