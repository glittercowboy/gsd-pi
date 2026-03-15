//! Native git operations via libgit2.
//!
//! Provides fast READ-ONLY git queries for the GSD dispatch hotpath,
//! eliminating the need to spawn 25-40 `git` child processes per dispatch.
//!
//! WRITE operations (commit, merge, checkout, push) remain as execSync
//! calls in TypeScript — only status queries are native.

use git2::{Repository, StatusOptions};
use napi::bindgen_prelude::*;
use napi_derive::napi;

fn is_gsd_slice_branch(branch: &str) -> bool {
    let mut parts = branch.split('/');
    if parts.next() != Some("gsd") {
        return false;
    }

    let second = match parts.next() {
        Some(value) => value,
        None => return false,
    };

    let (milestone, slice) = if second.starts_with('M') {
        (second, parts.next())
    } else {
        let milestone = match parts.next() {
            Some(value) => value,
            None => return false,
        };
        (milestone, parts.next())
    };

    milestone.starts_with('M') && slice.map(|value| value.starts_with('S')).unwrap_or(false)
}

/// Open a git repository at the given path.
fn open_repo(repo_path: &str) -> Result<Repository> {
    Repository::open(repo_path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to open git repository at {repo_path}: {e}"),
        )
    })
}

/// Get the current branch name (HEAD symbolic ref).
/// Returns None if HEAD is detached.
#[napi]
pub fn git_current_branch(repo_path: String) -> Result<Option<String>> {
    let repo = open_repo(&repo_path)?;
    let head = repo.head().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read HEAD: {e}"),
        )
    })?;

    if head.is_branch() {
        Ok(head.shorthand().map(String::from))
    } else {
        Ok(None)
    }
}

/// Detect the main/integration branch for a repository.
///
/// Resolution order:
/// 1. refs/remotes/origin/HEAD → extract branch name
/// 2. refs/heads/main exists → "main"
/// 3. refs/heads/master exists → "master"
/// 4. Fall back to current branch
///
/// Note: milestone integration branch and worktree detection are handled
/// in TypeScript — this function covers the repo-level default detection
/// that previously spawned 4 `git show-ref` / `git symbolic-ref` calls.
#[napi]
pub fn git_main_branch(repo_path: String) -> Result<String> {
    let repo = open_repo(&repo_path)?;

    // Check origin/HEAD symbolic ref
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Ok(resolved) = reference.resolve() {
            if let Some(name) = resolved.name() {
                if let Some(branch) = name.strip_prefix("refs/remotes/origin/") {
                    if !is_gsd_slice_branch(branch) {
                        return Ok(branch.to_string());
                    }
                }
            }
        }
    }

    // Check refs/heads/main
    if repo.find_reference("refs/heads/main").is_ok() {
        return Ok("main".to_string());
    }

    // Check refs/heads/master
    if repo.find_reference("refs/heads/master").is_ok() {
        return Ok("master".to_string());
    }

    // Fall back to current branch
    let head = repo.head().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read HEAD: {e}"),
        )
    })?;

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
    let index = repo.index().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read index: {e}"),
        )
    })?;

    Ok(index.has_conflicts())
}

/// Get working tree status in porcelain format.
/// Returns a string where each line is "XY path" (git status --porcelain).
#[napi]
pub fn git_working_tree_status(repo_path: String) -> Result<String> {
    let repo = open_repo(&repo_path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to get status: {e}"),
        )
    })?;

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

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to get status: {e}"),
        )
    })?;

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

    let from_oid = repo
        .revparse_single(&from_ref)
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to resolve ref '{from_ref}': {e}"),
            )
        })?
        .id();

    let to_oid = repo
        .revparse_single(&to_ref)
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to resolve ref '{to_ref}': {e}"),
            )
        })?
        .id();

    let mut revwalk = repo.revwalk().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create revwalk: {e}"),
        )
    })?;

    revwalk.push(to_oid).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to push to_ref: {e}"),
        )
    })?;

    revwalk.hide(from_oid).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to hide from_ref: {e}"),
        )
    })?;

    let count = revwalk.count() as u32;
    Ok(count)
}
