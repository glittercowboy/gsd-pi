//! Native git operations via libgit2.
//!
//! Provides high-performance git operations for GSD, eliminating the need
//! to spawn `git` child processes via execSync. Both read and write
//! operations are implemented natively.
//!
//! All functions have TypeScript fallbacks in `native-git-bridge.ts` for
//! environments where the native module is unavailable.

use git2::{
    build::CheckoutBuilder, BranchType, Delta, DiffOptions, IndexAddOption, MergeOptions,
    ObjectType, Repository, ResetType, Sort, StatusOptions,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::Path;

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Open a git repository at the given path.
fn open_repo(repo_path: &str) -> Result<Repository> {
    Repository::open(repo_path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to open git repository at {repo_path}: {e}"),
        )
    })
}

/// Convert a git2 error to a napi error with context.
fn git_err(context: &str, e: git2::Error) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {e}"))
}

/// Validate that a file path stays within the repository boundary.
/// Prevents path traversal attacks via patterns like `../../etc/passwd`.
fn validate_path_within_repo(repo_path: &str, file_path: &str) -> Result<std::path::PathBuf> {
    let repo_dir = std::fs::canonicalize(repo_path).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Failed to canonicalize repo path '{repo_path}': {e}"))
    })?;
    let full_path = repo_dir.join(file_path);
    let canonical = if full_path.exists() {
        std::fs::canonicalize(&full_path).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Failed to canonicalize path '{file_path}': {e}"))
        })?
    } else if let Some(parent) = full_path.parent() {
        if parent.exists() {
            let cp = std::fs::canonicalize(parent).map_err(|e| {
                Error::new(Status::GenericFailure, format!("Failed to canonicalize parent of '{file_path}': {e}"))
            })?;
            cp.join(full_path.file_name().unwrap_or_default())
        } else {
            full_path.clone()
        }
    } else {
        full_path.clone()
    };
    if !canonical.starts_with(&repo_dir) {
        return Err(Error::new(Status::GenericFailure, format!("Path '{file_path}' escapes repository boundary")));
    }
    Ok(canonical)
}

/// Resolve a ref string to an Oid. Supports branch names, tags, HEAD, etc.
fn resolve_ref(repo: &Repository, refspec: &str) -> Result<git2::Oid> {
    repo.revparse_single(refspec)
        .map(|obj| obj.id())
        .map_err(|e| git_err(&format!("Failed to resolve ref '{refspec}'"), e))
}

/// Get the tree for a given ref.
fn ref_tree<'a>(repo: &'a Repository, refspec: &str) -> Result<git2::Tree<'a>> {
    let obj = repo
        .revparse_single(refspec)
        .map_err(|e| git_err(&format!("Failed to resolve ref '{refspec}'"), e))?;
    obj.peel_to_tree()
        .map_err(|e| git_err(&format!("Failed to peel '{refspec}' to tree"), e))
}

/// Find the merge base between two refs (for three-dot diff semantics).
fn merge_base_tree<'a>(
    repo: &'a Repository,
    from_ref: &str,
    to_ref: &str,
) -> Result<git2::Tree<'a>> {
    let from_oid = resolve_ref(repo, from_ref)?;
    let to_oid = resolve_ref(repo, to_ref)?;
    let base_oid = repo
        .merge_base(from_oid, to_oid)
        .map_err(|e| git_err("Failed to find merge base", e))?;
    let base_commit = repo
        .find_commit(base_oid)
        .map_err(|e| git_err("Failed to find merge base commit", e))?;
    base_commit
        .tree()
        .map_err(|e| git_err("Failed to get merge base tree", e))
}

// ─── NAPI Return Types ─────────────────────────────────────────────────────

#[napi(object)]
pub struct GitDiffStat {
    #[napi(js_name = "filesChanged")]
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub summary: String,
}

#[napi(object)]
pub struct GitNameStatus {
    pub status: String,
    pub path: String,
}

#[napi(object)]
pub struct GitNumstat {
    pub added: u32,
    pub removed: u32,
    pub path: String,
}

#[napi(object)]
pub struct GitLogEntry {
    pub sha: String,
    pub message: String,
}

#[napi(object)]
pub struct GitWorktreeEntry {
    pub path: String,
    pub branch: String,
    #[napi(js_name = "isBare")]
    pub is_bare: bool,
}

#[napi(object)]
pub struct GitBatchInfo {
    pub branch: String,
    #[napi(js_name = "hasChanges")]
    pub has_changes: bool,
    pub status: String,
    #[napi(js_name = "stagedCount")]
    pub staged_count: u32,
    #[napi(js_name = "unstagedCount")]
    pub unstaged_count: u32,
}

#[napi(object)]
pub struct GitMergeResult {
    pub success: bool,
    pub conflicts: Vec<String>,
}

// ─── Existing Read Functions (unchanged) ────────────────────────────────────

/// Get the current branch name (HEAD symbolic ref).
/// Returns None if HEAD is detached.
#[napi]
pub fn git_current_branch(repo_path: String) -> Result<Option<String>> {
    let repo = open_repo(&repo_path)?;
    let head = repo
        .head()
        .map_err(|e| git_err("Failed to read HEAD", e))?;

    if head.is_branch() {
        Ok(head.shorthand().map(String::from))
    } else {
        Ok(None)
    }
}

/// Detect the main/integration branch for a repository.
///
/// Resolution order:
/// 1. refs/remotes/origin/HEAD -> extract branch name
/// 2. refs/heads/main exists -> "main"
/// 3. refs/heads/master exists -> "master"
/// 4. Fall back to current branch
#[napi]
pub fn git_main_branch(repo_path: String) -> Result<String> {
    let repo = open_repo(&repo_path)?;

    // Check origin/HEAD symbolic ref
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Ok(resolved) = reference.resolve() {
            if let Some(name) = resolved.name() {
                if let Some(branch) = name.strip_prefix("refs/remotes/origin/") {
                    return Ok(branch.to_string());
                }
            }
        }
    }

    if repo.find_reference("refs/heads/main").is_ok() {
        return Ok("main".to_string());
    }

    if repo.find_reference("refs/heads/master").is_ok() {
        return Ok("master".to_string());
    }

    let head = repo
        .head()
        .map_err(|e| git_err("Failed to read HEAD", e))?;
    Ok(head.shorthand().unwrap_or("HEAD").to_string())
}

/// Check if a local branch exists (refs/heads/<name>).
#[napi]
pub fn git_branch_exists(repo_path: String, branch: String) -> Result<bool> {
    let repo = open_repo(&repo_path)?;
    let refname = format!("refs/heads/{branch}");
    let exists = repo.find_reference(&refname).is_ok();
    Ok(exists)
}

/// Check if the repository index has unmerged entries (merge conflicts).
#[napi]
pub fn git_has_merge_conflicts(repo_path: String) -> Result<bool> {
    let repo = open_repo(&repo_path)?;
    let index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;
    Ok(index.has_conflicts())
}

/// Get working tree status in porcelain format.
/// Returns a string where each line is "XY path" (git status --porcelain).
#[napi]
pub fn git_working_tree_status(repo_path: String) -> Result<String> {
    let repo = open_repo(&repo_path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| git_err("Failed to get status", e))?;

    let mut lines = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let status = entry.status();
        let path = entry.path().unwrap_or("?");

        let index_char = if status.is_index_new() {
            'A'
        } else if status.is_index_modified() {
            'M'
        } else if status.is_index_deleted() {
            'D'
        } else if status.is_index_renamed() {
            'R'
        } else if status.is_index_typechange() {
            'T'
        } else {
            ' '
        };

        let wt_char = if status.is_wt_new() {
            '?'
        } else if status.is_wt_modified() {
            'M'
        } else if status.is_wt_deleted() {
            'D'
        } else if status.is_wt_renamed() {
            'R'
        } else if status.is_wt_typechange() {
            'T'
        } else {
            ' '
        };

        lines.push(format!("{index_char}{wt_char} {path}"));
    }

    Ok(lines.join("\n"))
}

/// Quick check: are there any staged or unstaged changes in the working tree?
#[napi]
pub fn git_has_changes(repo_path: String) -> Result<bool> {
    let repo = open_repo(&repo_path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| git_err("Failed to get status", e))?;

    Ok(!statuses.is_empty())
}

/// Count commits between two refs (equivalent to `git rev-list --count from..to`).
#[napi]
pub fn git_commit_count_between(
    repo_path: String,
    from_ref: String,
    to_ref: String,
) -> Result<u32> {
    let repo = open_repo(&repo_path)?;

    let from_oid = resolve_ref(&repo, &from_ref)?;
    let to_oid = resolve_ref(&repo, &to_ref)?;

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| git_err("Failed to create revwalk", e))?;

    revwalk
        .push(to_oid)
        .map_err(|e| git_err("Failed to push to_ref", e))?;
    revwalk
        .hide(from_oid)
        .map_err(|e| git_err("Failed to hide from_ref", e))?;

    Ok(revwalk.count() as u32)
}

// ─── New Read Functions ─────────────────────────────────────────────────────

/// Check if a path is inside a git repository.
/// Replaces: `git rev-parse --git-dir`
#[napi]
pub fn git_is_repo(path: String) -> bool {
    Repository::open(&path).is_ok()
}

/// Check if there are any staged changes (index differs from HEAD).
/// Replaces: `git diff --cached --stat` check
#[napi]
pub fn git_has_staged_changes(repo_path: String) -> Result<bool> {
    let repo = open_repo(&repo_path)?;

    // Get HEAD tree (may not exist for initial commit)
    let head_tree = match repo.head() {
        Ok(head) => {
            let commit = head
                .peel_to_commit()
                .map_err(|e| git_err("Failed to peel HEAD to commit", e))?;
            Some(
                commit
                    .tree()
                    .map_err(|e| git_err("Failed to get HEAD tree", e))?,
            )
        }
        Err(_) => None, // No commits yet — everything in index is "staged"
    };

    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, None)
        .map_err(|e| git_err("Failed to diff tree to index", e))?;

    Ok(diff.deltas().len() > 0)
}

/// Get diff statistics between two refs, or between HEAD and working tree.
/// When `from_ref` is "HEAD" and `to_ref` is "WORKDIR", diffs working tree vs HEAD.
/// When `from_ref` is "HEAD" and `to_ref` is "INDEX", diffs index vs HEAD (staged).
/// Replaces: `git diff --stat HEAD`, `git diff --stat --cached HEAD`
#[napi]
pub fn git_diff_stat(
    repo_path: String,
    from_ref: String,
    to_ref: String,
) -> Result<GitDiffStat> {
    let repo = open_repo(&repo_path)?;

    let diff = match (from_ref.as_str(), to_ref.as_str()) {
        ("HEAD", "WORKDIR") => {
            let head_tree = match repo.head() {
                Ok(head) => Some(
                    head.peel_to_tree()
                        .map_err(|e| git_err("Failed to peel HEAD to tree", e))?,
                ),
                Err(_) => None,
            };
            repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), None)
                .map_err(|e| git_err("Failed to diff", e))?
        }
        ("HEAD", "INDEX") => {
            let head_tree = match repo.head() {
                Ok(head) => Some(
                    head.peel_to_tree()
                        .map_err(|e| git_err("Failed to peel HEAD to tree", e))?,
                ),
                Err(_) => None,
            };
            repo.diff_tree_to_index(head_tree.as_ref(), None, None)
                .map_err(|e| git_err("Failed to diff", e))?
        }
        _ => {
            let from_tree = ref_tree(&repo, &from_ref)?;
            let to_tree = ref_tree(&repo, &to_ref)?;
            repo.diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
                .map_err(|e| git_err("Failed to diff", e))?
        }
    };

    let stats = diff
        .stats()
        .map_err(|e| git_err("Failed to get diff stats", e))?;

    let summary = stats
        .to_buf(git2::DiffStatsFormat::FULL, 80)
        .map_err(|e| git_err("Failed to format diff stats", e))?
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok(GitDiffStat {
        files_changed: stats.files_changed() as u32,
        insertions: stats.insertions() as u32,
        deletions: stats.deletions() as u32,
        summary,
    })
}

/// Get name-status diff between two refs with optional pathspec filter.
/// `use_merge_base`: if true, uses three-dot semantics (diff from merge base).
/// Replaces: `git diff --name-status main...branch -- .gsd/`
#[napi]
pub fn git_diff_name_status(
    repo_path: String,
    from_ref: String,
    to_ref: String,
    pathspec: Option<String>,
    use_merge_base: Option<bool>,
) -> Result<Vec<GitNameStatus>> {
    let repo = open_repo(&repo_path)?;

    let mut diff_opts = DiffOptions::new();
    if let Some(ref ps) = pathspec {
        diff_opts.pathspec(ps);
    }

    let from_tree = if use_merge_base.unwrap_or(false) {
        merge_base_tree(&repo, &from_ref, &to_ref)?
    } else {
        ref_tree(&repo, &from_ref)?
    };
    let to_tree = ref_tree(&repo, &to_ref)?;

    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut diff_opts))
        .map_err(|e| git_err("Failed to diff trees", e))?;

    let mut results = Vec::with_capacity(diff.deltas().len());
    for delta in diff.deltas() {
        let status_char = match delta.status() {
            Delta::Added => "A",
            Delta::Deleted => "D",
            Delta::Modified => "M",
            Delta::Renamed => "R",
            Delta::Copied => "C",
            Delta::Typechange => "T",
            _ => continue,
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        results.push(GitNameStatus {
            status: status_char.to_string(),
            path,
        });
    }

    Ok(results)
}

/// Get numstat diff between two refs.
/// Replaces: `git diff --numstat main branch`
#[napi]
pub fn git_diff_numstat(
    repo_path: String,
    from_ref: String,
    to_ref: String,
) -> Result<Vec<GitNumstat>> {
    let repo = open_repo(&repo_path)?;

    let from_tree = ref_tree(&repo, &from_ref)?;
    let to_tree = ref_tree(&repo, &to_ref)?;

    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
        .map_err(|e| git_err("Failed to diff trees", e))?;

    // Collect paths per delta index, then count lines in a second pass
    let mut results = Vec::new();
    for delta in diff.deltas() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        results.push(GitNumstat {
            added: 0,
            removed: 0,
            path,
        });
    }

    // Count added/removed lines per file using the patch API
    for (i, _) in diff.deltas().enumerate() {
        if let Ok(patch) = git2::Patch::from_diff(&diff, i) {
            if let Some(patch) = patch {
                let (_, additions, deletions) = patch.line_stats()
                    .unwrap_or((0, 0, 0));
                if let Some(entry) = results.get_mut(i) {
                    entry.added = additions as u32;
                    entry.removed = deletions as u32;
                }
            }
        }
    }

    Ok(results)
}

/// Get unified diff content between two refs with optional pathspec/exclude.
/// `use_merge_base`: if true, uses three-dot semantics.
/// `exclude`: optional pathspec to exclude (e.g., ".gsd/").
/// Replaces: `git diff main...branch -- .gsd/` and `-- . :(exclude).gsd/`
#[napi]
pub fn git_diff_content(
    repo_path: String,
    from_ref: String,
    to_ref: String,
    pathspec: Option<String>,
    exclude: Option<String>,
    use_merge_base: Option<bool>,
) -> Result<String> {
    let repo = open_repo(&repo_path)?;

    let mut diff_opts = DiffOptions::new();
    if let Some(ref ps) = pathspec {
        diff_opts.pathspec(ps);
    }

    let from_tree = if use_merge_base.unwrap_or(false) {
        merge_base_tree(&repo, &from_ref, &to_ref)?
    } else {
        ref_tree(&repo, &from_ref)?
    };
    let to_tree = ref_tree(&repo, &to_ref)?;

    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut diff_opts))
        .map_err(|e| git_err("Failed to diff trees", e))?;

    let exclude_prefix = exclude.as_deref();

    let mut output = String::new();
    diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        // Apply exclude filter
        if let Some(excl) = exclude_prefix {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            if path.starts_with(excl) {
                return true;
            }
        }

        let prefix = match line.origin() {
            '+' | '-' | ' ' => {
                output.push(line.origin());
                ""
            }
            'F' | 'H' | 'B' => "",
            _ => "",
        };
        output.push_str(prefix);
        if let Ok(content) = std::str::from_utf8(line.content()) {
            output.push_str(content);
        }
        true
    })
    .map_err(|e| git_err("Failed to print diff", e))?;

    Ok(output)
}

/// Get commit log between two refs (from..to).
/// Replaces: `git log --oneline main..branch`
#[napi]
pub fn git_log_oneline(
    repo_path: String,
    from_ref: String,
    to_ref: String,
) -> Result<Vec<GitLogEntry>> {
    let repo = open_repo(&repo_path)?;

    let from_oid = resolve_ref(&repo, &from_ref)?;
    let to_oid = resolve_ref(&repo, &to_ref)?;

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| git_err("Failed to create revwalk", e))?;
    revwalk.set_sorting(Sort::TIME).ok();
    revwalk
        .push(to_oid)
        .map_err(|e| git_err("Failed to push to_ref", e))?;
    revwalk
        .hide(from_oid)
        .map_err(|e| git_err("Failed to hide from_ref", e))?;

    let mut entries = Vec::new();
    for oid in revwalk.flatten() {
        if let Ok(commit) = repo.find_commit(oid) {
            let sha = format!("{:.7}", oid);
            let message = commit.summary().unwrap_or("").to_string();
            entries.push(GitLogEntry { sha, message });
        }
    }

    Ok(entries)
}

/// List git worktrees in porcelain format.
/// Replaces: `git worktree list --porcelain`
#[napi]
pub fn git_worktree_list(repo_path: String) -> Result<Vec<GitWorktreeEntry>> {
    let repo = open_repo(&repo_path)?;

    let mut entries = Vec::new();

    // Add the main worktree
    if let Some(workdir) = repo.workdir() {
        let branch = match repo.head() {
            Ok(head) => head.shorthand().unwrap_or("HEAD").to_string(),
            Err(_) => "HEAD".to_string(),
        };
        entries.push(GitWorktreeEntry {
            path: workdir.to_string_lossy().to_string(),
            branch,
            is_bare: false,
        });
    } else if repo.is_bare() {
        entries.push(GitWorktreeEntry {
            path: repo.path().to_string_lossy().to_string(),
            branch: String::new(),
            is_bare: true,
        });
    }

    // List linked worktrees
    if let Ok(worktrees) = repo.worktrees() {
        for wt_name in worktrees.iter().flatten() {
            if let Ok(wt) = repo.find_worktree(wt_name) {
                let wt_path = wt.path().to_string_lossy().to_string();
                // Open the worktree's repo to read its HEAD
                let branch = match Repository::open(&wt_path) {
                    Ok(wt_repo) => match wt_repo.head() {
                        Ok(head) => {
                            if let Some(name) = head.name() {
                                name.strip_prefix("refs/heads/")
                                    .unwrap_or(head.shorthand().unwrap_or("HEAD"))
                                    .to_string()
                            } else {
                                "HEAD".to_string()
                            }
                        }
                        Err(_) => "HEAD".to_string(),
                    },
                    Err(_) => String::new(),
                };
                entries.push(GitWorktreeEntry {
                    path: wt_path,
                    branch,
                    is_bare: false,
                });
            }
        }
    }

    Ok(entries)
}

/// List branches matching an optional glob pattern.
/// Replaces: `git branch --list milestone/*`, `git branch --list gsd/*`
#[napi]
pub fn git_branch_list(repo_path: String, pattern: Option<String>) -> Result<Vec<String>> {
    let repo = open_repo(&repo_path)?;
    let branches = repo
        .branches(Some(BranchType::Local))
        .map_err(|e| git_err("Failed to list branches", e))?;

    let mut names = Vec::new();
    for branch_result in branches {
        let (branch, _) = branch_result.map_err(|e| git_err("Failed to iterate branches", e))?;
        if let Some(name) = branch.name().ok().flatten() {
            if let Some(ref pat) = pattern {
                // Simple glob matching: support "prefix/*" and "prefix/*/*"
                if matches_branch_pattern(name, pat) {
                    names.push(name.to_string());
                }
            } else {
                names.push(name.to_string());
            }
        }
    }

    Ok(names)
}

/// Simple branch pattern matching for patterns like "milestone/*", "gsd/*/*"
fn matches_branch_pattern(name: &str, pattern: &str) -> bool {
    // Handle simple prefix/* patterns
    if let Some(prefix) = pattern.strip_suffix("/*") {
        // For "gsd/*/*", this becomes "gsd/*" after first strip
        if prefix.contains('*') {
            // Recursive: "gsd/*/*" → name must start with "gsd/" and have at least 2 segments after
            if let Some(inner_prefix) = prefix.strip_suffix("/*") {
                return name.starts_with(&format!("{inner_prefix}/"))
                    && name[inner_prefix.len() + 1..].contains('/');
            }
        }
        return name.starts_with(&format!("{prefix}/"));
    }
    // Exact match
    name == pattern
}

/// List branches that have been merged into the given target branch.
/// Replaces: `git branch --merged main --list gsd/*`
#[napi]
pub fn git_branch_list_merged(
    repo_path: String,
    target: String,
    pattern: Option<String>,
) -> Result<Vec<String>> {
    let repo = open_repo(&repo_path)?;
    let target_oid = resolve_ref(&repo, &target)?;

    let branches = repo
        .branches(Some(BranchType::Local))
        .map_err(|e| git_err("Failed to list branches", e))?;

    let mut merged = Vec::new();
    for branch_result in branches {
        let (branch, _) = branch_result.map_err(|e| git_err("Failed to iterate branches", e))?;
        if let Some(name) = branch.name().ok().flatten() {
            // Apply pattern filter
            if let Some(ref pat) = pattern {
                if !matches_branch_pattern(name, pat) {
                    continue;
                }
            }

            // Check if merged: a branch is merged into target if the merge base
            // of the branch tip and target equals the branch tip.
            if let Ok(branch_ref) = branch.get().peel(ObjectType::Commit) {
                let branch_oid = branch_ref.id();
                if let Ok(base) = repo.merge_base(target_oid, branch_oid) {
                    if base == branch_oid {
                        merged.push(name.to_string());
                    }
                }
            }
        }
    }

    Ok(merged)
}

/// List files tracked in the index matching a pathspec.
/// Replaces: `git ls-files "<path>"`
#[napi]
pub fn git_ls_files(repo_path: String, pathspec: String) -> Result<Vec<String>> {
    let repo = open_repo(&repo_path)?;
    let index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;

    let mut files = Vec::new();
    for entry in index.iter() {
        let path = String::from_utf8_lossy(&entry.path).to_string();
        if path.starts_with(&pathspec) || (pathspec.ends_with('/') && path.starts_with(pathspec.trim_end_matches('/'))) {
            files.push(path);
        }
    }

    Ok(files)
}

/// List references matching a prefix.
/// Replaces: `git for-each-ref refs/gsd/snapshots/ --format=%(refname)`
#[napi]
pub fn git_for_each_ref(repo_path: String, prefix: String) -> Result<Vec<String>> {
    let repo = open_repo(&repo_path)?;
    let glob = if prefix.ends_with('/') {
        format!("{prefix}*")
    } else {
        format!("{prefix}/*")
    };

    let refs = repo
        .references_glob(&glob)
        .map_err(|e| git_err("Failed to list references", e))?;

    let mut names = Vec::new();
    for r in refs.flatten() {
        if let Some(name) = r.name() {
            names.push(name.to_string());
        }
    }

    Ok(names)
}

/// Get list of files with unmerged (conflict) entries in the index.
/// Replaces: `git diff --name-only --diff-filter=U`
#[napi]
pub fn git_conflict_files(repo_path: String) -> Result<Vec<String>> {
    let repo = open_repo(&repo_path)?;
    let index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;

    if !index.has_conflicts() {
        return Ok(Vec::new());
    }

    let conflicts = index
        .conflicts()
        .map_err(|e| git_err("Failed to read conflicts", e))?;

    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for conflict in conflicts.flatten() {
        // A conflict has ancestor, our, theirs entries — get the path from whichever exists
        let path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .map(|entry| String::from_utf8_lossy(&entry.path).to_string());

        if let Some(p) = path {
            if seen.insert(p.clone()) {
                files.push(p);
            }
        }
    }

    Ok(files)
}

/// Get batch info: branch + status + change counts in ONE call.
/// Replaces: sequential calls to getCurrentBranch + hasChanges + status.
#[napi]
pub fn git_batch_info(repo_path: String) -> Result<GitBatchInfo> {
    let repo = open_repo(&repo_path)?;

    // Branch
    let branch = match repo.head() {
        Ok(head) => {
            if head.is_branch() {
                head.shorthand().unwrap_or("HEAD").to_string()
            } else {
                "HEAD".to_string()
            }
        }
        Err(_) => String::new(),
    };

    // Status
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| git_err("Failed to get status", e))?;

    let has_changes = !statuses.is_empty();
    let mut staged_count: u32 = 0;
    let mut unstaged_count: u32 = 0;
    let mut lines = Vec::with_capacity(statuses.len());

    for entry in statuses.iter() {
        let status = entry.status();
        let path = entry.path().unwrap_or("?");

        let index_char = if status.is_index_new() {
            staged_count += 1;
            'A'
        } else if status.is_index_modified() {
            staged_count += 1;
            'M'
        } else if status.is_index_deleted() {
            staged_count += 1;
            'D'
        } else if status.is_index_renamed() {
            staged_count += 1;
            'R'
        } else if status.is_index_typechange() {
            staged_count += 1;
            'T'
        } else {
            ' '
        };

        let wt_char = if status.is_wt_new() {
            unstaged_count += 1;
            '?'
        } else if status.is_wt_modified() {
            unstaged_count += 1;
            'M'
        } else if status.is_wt_deleted() {
            unstaged_count += 1;
            'D'
        } else if status.is_wt_renamed() {
            unstaged_count += 1;
            'R'
        } else if status.is_wt_typechange() {
            unstaged_count += 1;
            'T'
        } else {
            ' '
        };

        lines.push(format!("{index_char}{wt_char} {path}"));
    }

    Ok(GitBatchInfo {
        branch,
        has_changes,
        status: lines.join("\n"),
        staged_count,
        unstaged_count,
    })
}

// ─── Write Functions ────────────────────────────────────────────────────────

/// Initialize a new git repository.
/// Replaces: `git init -b <branch>`
#[napi]
pub fn git_init(path: String, initial_branch: Option<String>) -> Result<()> {
    let repo = Repository::init(&path).map_err(|e| git_err("Failed to init repository", e))?;

    // Set initial branch name if specified
    if let Some(branch_name) = initial_branch {
        // For a new repo, HEAD points to refs/heads/master by default.
        // We need to update the symbolic ref to point to the desired branch.
        repo.set_head(&format!("refs/heads/{branch_name}"))
            .map_err(|e| git_err("Failed to set initial branch", e))?;
    }

    Ok(())
}

/// Stage all files (equivalent to `git add -A`).
/// Replaces: `git add -A`
#[napi]
pub fn git_add_all(repo_path: String) -> Result<()> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;

    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| git_err("Failed to add all files", e))?;

    // Also handle deletions: update the index to reflect removed files
    index
        .update_all(["*"].iter(), None)
        .map_err(|e| git_err("Failed to update index for deletions", e))?;

    index
        .write()
        .map_err(|e| git_err("Failed to write index", e))?;

    Ok(())
}

/// Stage specific files.
/// Replaces: `git add -- <file1> <file2> ...`
#[napi]
pub fn git_add_paths(repo_path: String, paths: Vec<String>) -> Result<()> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;

    index
        .add_all(paths.iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| git_err("Failed to add paths", e))?;

    index
        .write()
        .map_err(|e| git_err("Failed to write index", e))?;

    Ok(())
}

/// Unstage files (reset index entries to HEAD for specific paths).
/// Replaces: `git reset HEAD -- <path>`
#[napi]
pub fn git_reset_paths(repo_path: String, paths: Vec<String>) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    // Get HEAD commit's tree
    let head_obj = match repo.head() {
        Ok(head) => Some(
            head.peel(ObjectType::Commit)
                .map_err(|e| git_err("Failed to peel HEAD", e))?,
        ),
        Err(_) => None,
    };

    let pathspecs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();

    repo.reset_default(head_obj.as_ref(), pathspecs.iter())
        .map_err(|e| git_err("Failed to reset paths", e))?;

    Ok(())
}

/// Create a commit from the current index.
/// Returns the commit SHA.
/// Replaces: `git commit -m <message>`, `git commit --no-verify -F -`
#[napi]
pub fn git_commit(
    repo_path: String,
    message: String,
    allow_empty: Option<bool>,
) -> Result<String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;

    // If message is empty, read from MERGE_MSG or SQUASH_MSG (--no-edit equivalent)
    let message = if message.is_empty() {
        let merge_msg_path = repo.path().join("MERGE_MSG");
        let squash_msg_path = repo.path().join("SQUASH_MSG");
        if merge_msg_path.exists() {
            std::fs::read_to_string(&merge_msg_path)
                .unwrap_or_else(|_| "Merge commit".to_string())
        } else if squash_msg_path.exists() {
            std::fs::read_to_string(&squash_msg_path)
                .unwrap_or_else(|_| "Squash commit".to_string())
        } else {
            "Merge commit".to_string()
        }
    } else {
        message
    };

    // Write the index as a tree
    let tree_oid = index
        .write_tree()
        .map_err(|e| git_err("Failed to write tree", e))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| git_err("Failed to find tree", e))?;

    // Get parent commit(s)
    let parent = match repo.head() {
        Ok(head) => Some(
            head.peel_to_commit()
                .map_err(|e| git_err("Failed to peel HEAD to commit", e))?,
        ),
        Err(_) => None, // Initial commit
    };

    // Check if there are changes (unless allow_empty)
    if !allow_empty.unwrap_or(false) {
        if let Some(ref p) = parent {
            let parent_tree = p
                .tree()
                .map_err(|e| git_err("Failed to get parent tree", e))?;
            let diff = repo
                .diff_tree_to_tree(Some(&parent_tree), Some(&tree), None)
                .map_err(|e| git_err("Failed to diff for empty check", e))?;
            if diff.deltas().len() == 0 {
                return Err(Error::new(
                    Status::GenericFailure,
                    "nothing to commit, working tree clean",
                ));
            }
        }
    }

    // Create the signature from git config
    let sig = repo
        .signature()
        .map_err(|e| git_err("Failed to get signature", e))?;

    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| git_err("Failed to create commit", e))?;

    // Clean up merge/squash message files after commit
    for msg_file in &["SQUASH_MSG", "MERGE_MSG"] {
        let msg_path = repo.path().join(msg_file);
        if msg_path.exists() {
            std::fs::remove_file(&msg_path)
                .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to clean up {msg_file}: {e}")))?;
        }
    }

    Ok(format!("{oid}"))
}

/// Checkout a branch (switch HEAD and update working tree).
/// Replaces: `git checkout <branch>`
#[napi]
pub fn git_checkout_branch(repo_path: String, branch: String) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    let refname = format!("refs/heads/{branch}");
    let obj = repo
        .revparse_single(&refname)
        .map_err(|e| git_err(&format!("Branch '{branch}' not found"), e))?;

    repo.checkout_tree(
        &obj,
        Some(CheckoutBuilder::new().safe().recreate_missing(true)),
    )
    .map_err(|e| git_err(&format!("Failed to checkout '{branch}'"), e))?;

    repo.set_head(&refname)
        .map_err(|e| git_err(&format!("Failed to set HEAD to '{branch}'"), e))?;

    Ok(())
}

/// Resolve index conflicts by accepting "theirs" version for specific paths.
/// Replaces: `git checkout --theirs -- <file>`
#[napi]
pub fn git_checkout_theirs(repo_path: String, paths: Vec<String>) -> Result<()> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;

    for path in &paths {
        // Find the "theirs" (stage 3) entry in the index
        if let Some(entry) = index.get_path(Path::new(path), 3) {
            // Copy the entry data we need before mutating the index
            let blob_id = entry.id;
            let entry_mode = entry.mode;
            let entry_path = entry.path.clone();

            // Remove all conflict stages
            index.remove_path(Path::new(path)).ok();

            // Create a new stage-0 entry with the "theirs" content
            let resolved = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: entry_mode,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: blob_id,
                flags: 0, // stage 0
                flags_extended: 0,
                path: entry_path,
            };
            index
                .add(&resolved)
                .map_err(|e| git_err(&format!("Failed to add resolved '{path}'"), e))?;

            // Also checkout the file to working directory (with path traversal validation)
            let blob = repo
                .find_blob(blob_id)
                .map_err(|e| git_err(&format!("Failed to find blob for '{path}'"), e))?;
            let full_path = validate_path_within_repo(&repo_path, path)?;
            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to create directory for '{path}': {e}")))?;
            }
            std::fs::write(&full_path, blob.content())
                .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to write '{path}': {e}")))?;
        }
    }

    index
        .write()
        .map_err(|e| git_err("Failed to write index", e))?;

    Ok(())
}

/// Squash-merge a branch into the current branch.
/// Stages changes in the index but does NOT create a commit.
/// Replaces: `git merge --squash <branch>`
#[napi]
pub fn git_merge_squash(repo_path: String, branch: String) -> Result<GitMergeResult> {
    let repo = open_repo(&repo_path)?;

    let refname = format!("refs/heads/{branch}");
    let their_commit = repo
        .find_reference(&refname)
        .map_err(|e| git_err(&format!("Branch '{branch}' not found"), e))?
        .peel_to_commit()
        .map_err(|e| git_err(&format!("Failed to peel '{branch}' to commit"), e))?;

    let annotated = repo
        .find_annotated_commit(their_commit.id())
        .map_err(|e| git_err("Failed to create annotated commit", e))?;

    // Perform the merge analysis
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| git_err("Failed to analyze merge", e))?;

    if analysis.is_up_to_date() {
        return Ok(GitMergeResult {
            success: true,
            conflicts: vec![],
        });
    }

    // Perform the merge into the index
    let mut merge_opts = MergeOptions::new();
    let mut checkout_opts = CheckoutBuilder::new();
    checkout_opts.safe().allow_conflicts(true);

    repo.merge(&[&annotated], Some(&mut merge_opts), Some(&mut checkout_opts))
        .map_err(|e| git_err("Failed to merge", e))?;

    // Check for conflicts
    let index = repo
        .index()
        .map_err(|e| git_err("Failed to read index after merge", e))?;

    let mut conflicts = Vec::new();
    if index.has_conflicts() {
        if let Ok(conflict_iter) = index.conflicts() {
            for conflict in conflict_iter.flatten() {
                let path = conflict
                    .our
                    .as_ref()
                    .or(conflict.their.as_ref())
                    .or(conflict.ancestor.as_ref())
                    .map(|entry| String::from_utf8_lossy(&entry.path).to_string());

                if let Some(p) = path {
                    conflicts.push(p);
                }
            }
        }
    }

    // For squash merge: clean up merge state (we don't want MERGE_HEAD)
    // This mimics `git merge --squash` which doesn't record the merge
    repo.cleanup_state()
        .map_err(|e| git_err("Failed to cleanup merge state", e))?;

    Ok(GitMergeResult {
        success: conflicts.is_empty(),
        conflicts,
    })
}

/// Abort an in-progress merge.
/// Replaces: `git merge --abort`
#[napi]
pub fn git_merge_abort(repo_path: String) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    // Reset to HEAD
    let head = repo
        .head()
        .map_err(|e| git_err("Failed to read HEAD", e))?;
    let obj = head
        .peel(ObjectType::Commit)
        .map_err(|e| git_err("Failed to peel HEAD", e))?;

    repo.reset(&obj, ResetType::Hard, None)
        .map_err(|e| git_err("Failed to reset", e))?;

    // Clean up merge state files
    repo.cleanup_state()
        .map_err(|e| git_err("Failed to cleanup merge state", e))?;

    Ok(())
}

/// Abort an in-progress rebase.
/// Replaces: `git rebase --abort`
#[napi]
pub fn git_rebase_abort(repo_path: String) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    // Check for rebase state and abort
    let git_dir = repo.path();
    let rebase_merge = git_dir.join("rebase-merge");
    let rebase_apply = git_dir.join("rebase-apply");

    if rebase_merge.exists() || rebase_apply.exists() {
        // Read ORIG_HEAD to know where to reset
        let orig_head_path = git_dir.join("ORIG_HEAD");
        if let Ok(orig_ref) = std::fs::read_to_string(&orig_head_path) {
            let oid_str = orig_ref.trim();
            if let Ok(oid) = git2::Oid::from_str(oid_str) {
                if let Ok(commit) = repo.find_commit(oid) {
                    let obj = commit.as_object();
                    repo.reset(obj, ResetType::Hard, None)
                        .map_err(|e| git_err("Failed to reset to ORIG_HEAD", e))?;
                }
            }
        }

        // Clean up rebase state directories
        if rebase_merge.exists() {
            std::fs::remove_dir_all(&rebase_merge)
                .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to remove rebase-merge state: {e}")))?;
        }
        if rebase_apply.exists() {
            std::fs::remove_dir_all(&rebase_apply)
                .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to remove rebase-apply state: {e}")))?;
        }
    }

    repo.cleanup_state()
        .map_err(|e| git_err("Failed to cleanup repo state", e))?;
    Ok(())
}

/// Hard reset to HEAD.
/// Replaces: `git reset --hard HEAD`
#[napi]
pub fn git_reset_hard(repo_path: String) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    let head = repo
        .head()
        .map_err(|e| git_err("Failed to read HEAD", e))?;
    let obj = head
        .peel(ObjectType::Commit)
        .map_err(|e| git_err("Failed to peel HEAD", e))?;

    repo.reset(&obj, ResetType::Hard, None)
        .map_err(|e| git_err("Failed to reset", e))?;

    Ok(())
}

/// Delete a branch.
/// Replaces: `git branch -D <branch>` (force=true) or `git branch -d <branch>` (force=false)
#[napi]
pub fn git_branch_delete(repo_path: String, branch: String, force: Option<bool>) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    let mut git_branch = repo
        .find_branch(&branch, BranchType::Local)
        .map_err(|e| git_err(&format!("Branch '{branch}' not found"), e))?;

    if force.unwrap_or(false) {
        // Force delete (like -D): delete the ref directly
        let refname = format!("refs/heads/{branch}");
        if let Ok(mut reference) = repo.find_reference(&refname) {
            reference
                .delete()
                .map_err(|e| git_err(&format!("Failed to delete branch '{branch}'"), e))?;
        }
    } else {
        // Safe delete (like -d): only if fully merged
        git_branch
            .delete()
            .map_err(|e| git_err(&format!("Failed to delete branch '{branch}'"), e))?;
    }

    Ok(())
}

/// Force-reset a branch to point at a target ref.
/// Replaces: `git branch -f <branch> <target>`
#[napi]
pub fn git_branch_force_reset(
    repo_path: String,
    branch: String,
    target: String,
) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    let target_commit = repo
        .revparse_single(&target)
        .map_err(|e| git_err(&format!("Failed to resolve '{target}'"), e))?
        .peel_to_commit()
        .map_err(|e| git_err(&format!("Failed to peel '{target}' to commit"), e))?;

    repo.branch(&branch, &target_commit, true)
        .map_err(|e| git_err(&format!("Failed to reset branch '{branch}'"), e))?;

    Ok(())
}

/// Remove files from the index (cache) without touching the working tree.
/// Returns the list of files that were actually removed.
/// Replaces: `git rm --cached -r --ignore-unmatch <path>`
#[napi]
pub fn git_rm_cached(
    repo_path: String,
    paths: Vec<String>,
    recursive: Option<bool>,
) -> Result<Vec<String>> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;

    let is_recursive = recursive.unwrap_or(true);
    let mut removed = Vec::new();

    for path in &paths {
        if is_recursive && (path.ends_with('/') || Path::new(&repo_path).join(path).is_dir()) {
            // Remove all entries under this directory
            let prefix = if path.ends_with('/') {
                path.clone()
            } else {
                format!("{path}/")
            };
            let entries_to_remove: Vec<String> = index
                .iter()
                .filter_map(|entry| {
                    let entry_path = String::from_utf8_lossy(&entry.path).to_string();
                    if entry_path.starts_with(&prefix) || entry_path == path.trim_end_matches('/') {
                        Some(entry_path)
                    } else {
                        None
                    }
                })
                .collect();

            for entry_path in &entries_to_remove {
                if index.remove_path(Path::new(entry_path)).is_ok() {
                    removed.push(format!("rm '{entry_path}'"));
                }
            }
        } else {
            if index.remove_path(Path::new(path)).is_ok() {
                removed.push(format!("rm '{path}'"));
            }
        }
    }

    if !removed.is_empty() {
        index
            .write()
            .map_err(|e| git_err("Failed to write index", e))?;
    }

    Ok(removed)
}

/// Force-remove files from both index and working tree.
/// Replaces: `git rm --force -- <file>`
#[napi]
pub fn git_rm_force(repo_path: String, paths: Vec<String>) -> Result<()> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo
        .index()
        .map_err(|e| git_err("Failed to read index", e))?;

    for path in &paths {
        index.remove_path(Path::new(path))
            .map_err(|e| git_err(&format!("Failed to remove '{path}' from index"), e))?;
        // Also delete from working tree (with path traversal validation)
        let full_path = validate_path_within_repo(&repo_path, path)?;
        if full_path.exists() {
            std::fs::remove_file(&full_path)
                .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to delete '{path}': {e}")))?;
        }
    }

    index
        .write()
        .map_err(|e| git_err("Failed to write index", e))?;

    Ok(())
}

/// Add a new git worktree.
/// Replaces: `git worktree add [-b <new_branch>] <path> <branch_or_start>`
#[napi]
pub fn git_worktree_add(
    repo_path: String,
    wt_path: String,
    branch: String,
    create_branch: Option<bool>,
    start_point: Option<String>,
) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    if create_branch.unwrap_or(false) {
        // Create a new branch from start_point, then add worktree
        let start = start_point.as_deref().unwrap_or("HEAD");
        let start_commit = repo
            .revparse_single(start)
            .map_err(|e| git_err(&format!("Failed to resolve '{start}'"), e))?
            .peel_to_commit()
            .map_err(|e| git_err(&format!("Failed to peel '{start}' to commit"), e))?;

        repo.branch(&branch, &start_commit, false)
            .map_err(|e| git_err(&format!("Failed to create branch '{branch}'"), e))?;
    }

    // Use git worktree add via the worktree API
    let refname = format!("refs/heads/{branch}");
    let reference = repo
        .find_reference(&refname)
        .map_err(|e| git_err(&format!("Branch '{branch}' not found"), e))?;

    repo.worktree(
        &branch, // worktree name
        Path::new(&wt_path),
        Some(
            git2::WorktreeAddOptions::new()
                .reference(Some(&reference)),
        ),
    )
    .map_err(|e| git_err(&format!("Failed to add worktree at '{wt_path}'"), e))?;

    Ok(())
}

/// Remove a git worktree.
/// Replaces: `git worktree remove [--force] <path>`
#[napi]
pub fn git_worktree_remove(repo_path: String, wt_path: String, force: Option<bool>) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    // Find the worktree by path
    if let Ok(worktrees) = repo.worktrees() {
        for wt_name in worktrees.iter().flatten() {
            if let Ok(wt) = repo.find_worktree(wt_name) {
                let path_str = wt.path().to_string_lossy().to_string();
                let normalized_wt = path_str.trim_end_matches('/');
                let normalized_target = wt_path.trim_end_matches('/');
                if normalized_wt == normalized_target {
                    if force.unwrap_or(false) {
                        // Force: validate (which marks it as prunable) then remove dir
                        wt.validate().ok(); // May fail if already invalid — that's fine
                        if wt.path().exists() {
                            std::fs::remove_dir_all(wt.path()).ok();
                        }
                        // Prune the entry
                        wt.prune(Some(
                            git2::WorktreePruneOptions::new()
                                .valid(true)
                                .locked(true)
                                .working_tree(true),
                        ))
                        .ok();
                    } else if wt.validate().is_ok() {
                        // Only prune if the worktree is valid
                        if wt.path().exists() {
                            std::fs::remove_dir_all(wt.path()).ok();
                        }
                        wt.prune(Some(git2::WorktreePruneOptions::new().valid(true)))
                            .ok();
                    }
                    return Ok(());
                }
            }
        }
    }

    // If worktree not found in git's list, try to clean up the directory anyway
    let wt = Path::new(&wt_path);
    if wt.exists() && force.unwrap_or(false) {
        std::fs::remove_dir_all(wt).ok();
    }

    Ok(())
}

/// Prune stale worktree entries.
/// Replaces: `git worktree prune`
#[napi]
pub fn git_worktree_prune(repo_path: String) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    if let Ok(worktrees) = repo.worktrees() {
        for wt_name in worktrees.iter().flatten() {
            if let Ok(wt) = repo.find_worktree(wt_name) {
                if wt.validate().is_err() {
                    // Worktree is invalid (directory missing, etc.) — prune it
                    wt.prune(Some(
                        git2::WorktreePruneOptions::new()
                            .valid(false)
                            .working_tree(true),
                    ))
                    .ok();
                }
            }
        }
    }

    Ok(())
}

/// Revert a commit without auto-committing.
/// Replaces: `git revert --no-commit <sha>`
#[napi]
pub fn git_revert_commit(repo_path: String, sha: String) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    let oid = git2::Oid::from_str(&sha)
        .map_err(|e| git_err(&format!("Invalid SHA '{sha}'"), e))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|e| git_err(&format!("Commit '{sha}' not found"), e))?;

    repo.revert(&commit, None)
        .map_err(|e| git_err(&format!("Failed to revert commit '{sha}'"), e))?;

    // Clean up revert state since we don't want to auto-commit
    // (git revert --no-commit semantics)
    repo.cleanup_state().ok();

    Ok(())
}

/// Abort an in-progress revert.
/// Replaces: `git revert --abort`
#[napi]
pub fn git_revert_abort(repo_path: String) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    // Reset to HEAD
    if let Ok(head) = repo.head() {
        if let Ok(obj) = head.peel(ObjectType::Commit) {
            repo.reset(&obj, ResetType::Hard, None).ok();
        }
    }

    repo.cleanup_state().ok();
    Ok(())
}

/// Create or delete a ref.
/// When `target` is provided, creates/updates the ref to point at target.
/// When `target` is None, deletes the ref.
/// Replaces: `git update-ref <ref> HEAD` and `git update-ref -d <ref>`
#[napi]
pub fn git_update_ref(repo_path: String, refname: String, target: Option<String>) -> Result<()> {
    let repo = open_repo(&repo_path)?;

    match target {
        Some(target_ref) => {
            let oid = resolve_ref(&repo, &target_ref)?;
            repo.reference(&refname, oid, true, "update-ref")
                .map_err(|e| git_err(&format!("Failed to update ref '{refname}'"), e))?;
        }
        None => {
            if let Ok(mut reference) = repo.find_reference(&refname) {
                reference
                    .delete()
                    .map_err(|e| git_err(&format!("Failed to delete ref '{refname}'"), e))?;
            }
        }
    }

    Ok(())
}
