//! Filesystem discovery with glob patterns, ignore semantics, and shared scan
//! caching.
//!
//! # Overview
//! Resolves a search root, obtains scanned entries via [`fs_cache`], applies
//! glob matching plus optional file-type filtering, and optionally streams each
//! accepted match through a callback.
//!
//! The walker always skips `.git`, and skips `node_modules` unless explicitly
//! requested.
//!
//! # Example
//! ```ignore
//! // JS: await native.glob({ pattern: "*.rs", path: "." })
//! ```

use std::path::Path;

use globset::GlobSet;
use napi::{
    bindgen_prelude::*,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

pub use crate::fs_cache::{FileType, GlobMatch};
use crate::{fs_cache, glob_util, task};

/// Input options for `glob`, including traversal, filtering, and cancellation.
#[napi(object)]
pub struct GlobOptions {
    /// Glob pattern to match (e.g., "*.ts").
    pub pattern: String,
    /// Directory to search.
    pub path: String,
    /// Filter by file type: "file", "dir", or "symlink". Symlinks are
    /// matched for file/dir filters based on their target type.
    #[napi(js_name = "fileType")]
    pub file_type: Option<FileType>,
    /// Match simple patterns recursively by default (`*.ts` -> recursive).
    pub recursive: Option<bool>,
    /// Include hidden files (default: false).
    pub hidden: Option<bool>,
    /// Maximum number of results to return.
    #[napi(js_name = "maxResults")]
    pub max_results: Option<u32>,
    /// Respect .gitignore files (default: true).
    pub gitignore: Option<bool>,
    /// Enable shared filesystem scan cache (default: false).
    pub cache: Option<bool>,
    /// Sort results by mtime (most recent first) before applying limit.
    #[napi(js_name = "sortByMtime")]
    pub sort_by_mtime: Option<bool>,
    /// Include `node_modules` entries when the pattern does not explicitly
    /// mention them.
    #[napi(js_name = "includeNodeModules")]
    pub include_node_modules: Option<bool>,
    /// Timeout in milliseconds for the operation.
    #[napi(js_name = "timeoutMs")]
    pub timeout_ms: Option<u32>,
}

/// Result payload returned by a glob operation.
#[napi(object)]
pub struct GlobResult {
    /// Matched filesystem entries.
    pub matches: Vec<GlobMatch>,
    /// Number of returned matches (`matches.len()`), clamped to `u32::MAX`.
    pub total_matches: u32,
}

/// Internal runtime config for a single glob execution.
struct GlobConfig {
    root: std::path::PathBuf,
    pattern: String,
    recursive: bool,
    include_hidden: bool,
    file_type_filter: Option<FileType>,
    max_results: usize,
    use_gitignore: bool,
    mentions_node_modules: bool,
    sort_by_mtime: bool,
    use_cache: bool,
}

fn resolve_symlink_target_type(root: &Path, relative_path: &str) -> Option<FileType> {
    let target_path = root.join(relative_path);
    let metadata = std::fs::metadata(target_path).ok()?;
    if metadata.is_dir() {
        Some(FileType::Dir)
    } else if metadata.is_file() {
        Some(FileType::File)
    } else {
        None
    }
}

fn apply_file_type_filter(entry: &GlobMatch, config: &GlobConfig) -> Option<FileType> {
    let Some(filter) = config.file_type_filter else {
        return Some(entry.file_type);
    };
    if entry.file_type == filter {
        return Some(entry.file_type);
    }
    if entry.file_type != FileType::Symlink {
        return None;
    }
    match filter {
        FileType::File | FileType::Dir => {
            let resolved = resolve_symlink_target_type(&config.root, &entry.path)?;
            if resolved == filter {
                Some(resolved)
            } else {
                None
            }
        }
        FileType::Symlink => None,
    }
}

/// Filter and collect matching entries from a pre-scanned list.
fn filter_entries(
    entries: &[GlobMatch],
    glob_set: &GlobSet,
    config: &GlobConfig,
    on_match: Option<&ThreadsafeFunction<GlobMatch>>,
    ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
    let mut matches = Vec::new();
    if config.max_results == 0 {
        return Ok(matches);
    }

    for entry in entries {
        ct.heartbeat()?;
        if fs_cache::should_skip_path(Path::new(&entry.path), config.mentions_node_modules) {
            continue;
        }
        if !glob_set.is_match(&entry.path) {
            continue;
        }
        let Some(effective_file_type) = apply_file_type_filter(entry, config) else {
            continue;
        };
        let mut matched_entry = entry.clone();
        matched_entry.file_type = effective_file_type;
        if let Some(callback) = on_match {
            callback.call(
                Ok(matched_entry.clone()),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }

        matches.push(matched_entry);
        if !config.sort_by_mtime && matches.len() >= config.max_results {
            break;
        }
    }
    Ok(matches)
}

/// Executes matching/filtering over scanned entries and optionally streams each
/// hit.
fn run_glob(
    config: GlobConfig,
    on_match: Option<&ThreadsafeFunction<GlobMatch>>,
    ct: task::CancelToken,
) -> Result<GlobResult> {
    let glob_set = glob_util::compile_glob(&config.pattern, config.recursive)?;
    if config.max_results == 0 {
        return Ok(GlobResult {
            matches: Vec::new(),
            total_matches: 0,
        });
    }

    let mut matches = if config.use_cache {
        let scan =
            fs_cache::get_or_scan(&config.root, config.include_hidden, config.use_gitignore, &ct)?;
        let mut matches = filter_entries(&scan.entries, &glob_set, &config, on_match, &ct)?;
        // Empty-result recheck: if we got zero matches from a cached scan that's old
        // enough, force a rescan and try once more before returning empty.
        if matches.is_empty() && scan.cache_age_ms >= fs_cache::empty_recheck_ms() {
            let fresh = fs_cache::force_rescan(
                &config.root,
                config.include_hidden,
                config.use_gitignore,
                true,
                &ct,
            )?;
            matches = filter_entries(&fresh, &glob_set, &config, on_match, &ct)?;
        }
        matches
    } else {
        let fresh = fs_cache::force_rescan(
            &config.root,
            config.include_hidden,
            config.use_gitignore,
            false,
            &ct,
        )?;
        filter_entries(&fresh, &glob_set, &config, on_match, &ct)?
    };

    if config.sort_by_mtime {
        matches.sort_by(|a, b| {
            let a_mtime = a.mtime.unwrap_or(0.0);
            let b_mtime = b.mtime.unwrap_or(0.0);
            b_mtime
                .partial_cmp(&a_mtime)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        matches.truncate(config.max_results);
    }
    let total_matches = matches.len().min(u32::MAX as usize) as u32;
    Ok(GlobResult {
        matches,
        total_matches,
    })
}

/// Find filesystem entries matching a glob pattern.
///
/// Resolves the search root, scans entries, applies glob and optional file-type
/// filters, and optionally streams each accepted match through `on_match`.
///
/// If `sortByMtime` is enabled, all matching entries are collected, sorted by
/// descending mtime, then truncated to `maxResults`.
#[napi(js_name = "glob")]
pub fn glob(
    options: GlobOptions,
    #[napi(ts_arg_type = "((match: GlobMatch) => void) | undefined | null")] on_match: Option<
        ThreadsafeFunction<GlobMatch>,
    >,
) -> task::Async<GlobResult> {
    let GlobOptions {
        pattern,
        path,
        file_type,
        recursive,
        hidden,
        max_results,
        gitignore,
        sort_by_mtime,
        cache,
        include_node_modules,
        timeout_ms,
    } = options;

    let pattern = pattern.trim();
    let pattern = if pattern.is_empty() { "*" } else { pattern };
    let pattern = pattern.to_string();

    let ct = task::CancelToken::new(timeout_ms);

    task::blocking("glob", ct, move |ct| {
        let result = run_glob(
            GlobConfig {
                root: fs_cache::resolve_search_path(&path)?,
                include_hidden: hidden.unwrap_or(false),
                file_type_filter: file_type,
                recursive: recursive.unwrap_or(true),
                max_results: max_results.map_or(usize::MAX, |value| value as usize),
                use_gitignore: gitignore.unwrap_or(true),
                mentions_node_modules: include_node_modules
                    .unwrap_or_else(|| pattern.contains("node_modules")),
                sort_by_mtime: sort_by_mtime.unwrap_or(false),
                use_cache: cache.unwrap_or(false),
                pattern,
            },
            on_match.as_ref(),
            ct,
        );
        // Explicitly drop the ThreadsafeFunction to release the N-API reference
        // immediately rather than relying on implicit drop ordering.
        drop(on_match);
        result
    })
}
