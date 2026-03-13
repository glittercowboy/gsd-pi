//! Shared filesystem scan cache for discovery tools (glob).
//!
//! Provides a TTL-based cache of scanned directory entries, with:
//! - Global policy (no per-call TTL tuning)
//! - Explicit invalidation for agent file mutations
//! - Empty-result fast recheck to avoid stale negatives
//!
//! # Policy Configuration (environment overrides)
//! - `FS_SCAN_CACHE_TTL_MS`       – default `1000`
//! - `FS_SCAN_EMPTY_RECHECK_MS`   – default `200`
//! - `FS_SCAN_CACHE_MAX_ENTRIES`   – default `16`

use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, Instant},
};

use dashmap::DashMap;
use ignore::WalkBuilder;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

// ═══════════════════════════════════════════════════════════════════════════
// Public types (re-exported by glob)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, PartialEq, Eq)]
#[napi]
pub enum FileType {
    /// Regular file.
    File = 1,
    /// Directory.
    Dir = 2,
    /// Symbolic link.
    Symlink = 3,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
#[napi(object)]
pub struct GlobMatch {
    /// Relative path from the search root, using forward slashes.
    pub path: String,
    /// Resolved filesystem type for the match.
    #[napi(js_name = "fileType")]
    pub file_type: FileType,
    /// Modification time in milliseconds since Unix epoch (from
    /// `symlink_metadata`).
    pub mtime: Option<f64>,
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache policy
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CACHE_TTL_MS: u64 = 1_000;
const DEFAULT_EMPTY_RECHECK_MS: u64 = 200;
const DEFAULT_MAX_CACHE_ENTRIES: usize = 16;

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Configured cache TTL in milliseconds.
pub fn cache_ttl_ms() -> u64 {
    env_u64("FS_SCAN_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS)
}

/// Configured empty-result recheck threshold in milliseconds.
pub fn empty_recheck_ms() -> u64 {
    env_u64("FS_SCAN_EMPTY_RECHECK_MS", DEFAULT_EMPTY_RECHECK_MS)
}

fn max_cache_entries() -> usize {
    env_usize("FS_SCAN_CACHE_MAX_ENTRIES", DEFAULT_MAX_CACHE_ENTRIES)
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache internals
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
    root: PathBuf,
    include_hidden: bool,
    use_gitignore: bool,
}

#[derive(Clone)]
struct CacheEntry {
    created_at: Instant,
    entries: Vec<GlobMatch>,
}

static FS_CACHE: LazyLock<DashMap<CacheKey, CacheEntry>> = LazyLock::new(DashMap::new);

/// Result of a cache-aware scan, including the age of the cached data.
pub struct ScanResult {
    /// Scanned filesystem entries.
    pub entries: Vec<GlobMatch>,
    /// How old the cached data is in milliseconds (0 = freshly scanned).
    pub cache_age_ms: u64,
}

fn evict_oldest() {
    let max = max_cache_entries();
    if FS_CACHE.len() > max {
        if let Some(oldest_key) = FS_CACHE
            .iter()
            .min_by_key(|entry| entry.value().created_at)
            .map(|entry| entry.key().clone())
        {
            FS_CACHE.remove(&oldest_key);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Path utilities
// ═══════════════════════════════════════════════════════════════════════════

/// Resolve a search path string to a canonical `PathBuf` (must be a directory).
pub fn resolve_search_path(path: &str) -> Result<PathBuf> {
    let candidate = PathBuf::from(path);
    let root = if candidate.is_absolute() {
        candidate
    } else {
        let cwd = std::env::current_dir()
            .map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
        cwd.join(candidate)
    };
    let metadata = std::fs::metadata(&root)
        .map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
    if !metadata.is_dir() {
        return Err(Error::from_reason(
            "Search path must be a directory".to_string(),
        ));
    }
    Ok(std::fs::canonicalize(&root).unwrap_or(root))
}

/// Normalize a filesystem path to a forward-slash relative string.
pub fn normalize_relative_path<'a>(root: &Path, path: &'a Path) -> Cow<'a, str> {
    let relative = path.strip_prefix(root).unwrap_or(path);
    if cfg!(windows) {
        let relative = relative.to_string_lossy();
        if relative.contains('\\') {
            Cow::Owned(relative.replace('\\', "/"))
        } else {
            relative
        }
    } else {
        relative.to_string_lossy()
    }
}

pub fn contains_component(path: &Path, target: &str) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|value| value == target)
    })
}

pub fn should_skip_path(path: &Path, mentions_node_modules: bool) -> bool {
    if contains_component(path, ".git") {
        return true;
    }
    if !mentions_node_modules && contains_component(path, "node_modules") {
        return true;
    }
    false
}

pub fn classify_file_type(path: &Path) -> Option<(FileType, Option<f64>)> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let file_type = metadata.file_type();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64);
    if file_type.is_symlink() {
        Some((FileType::Symlink, mtime_ms))
    } else if file_type.is_dir() {
        Some((FileType::Dir, mtime_ms))
    } else {
        Some((FileType::File, mtime_ms))
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Walker + collection
// ═══════════════════════════════════════════════════════════════════════════

/// Builds a deterministic filesystem walker configured for visibility and
/// ignore rules.
pub fn build_walker(root: &Path, include_hidden: bool, use_gitignore: bool) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(!include_hidden)
        .follow_links(false)
        .sort_by_file_path(|a, b| a.cmp(b));

    if use_gitignore {
        builder
            .git_ignore(true)
            .git_exclude(true)
            .git_global(true)
            .ignore(true)
            .parents(true);
    } else {
        builder
            .git_ignore(false)
            .git_exclude(false)
            .git_global(false)
            .ignore(false)
            .parents(false);
    }

    builder
}

/// Scans filesystem entries and records normalized relative paths with file
/// metadata.
fn collect_entries(
    root: &Path,
    include_hidden: bool,
    use_gitignore: bool,
    ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
    let builder = build_walker(root, include_hidden, use_gitignore);
    let mut entries = Vec::new();

    for entry in builder.build() {
        ct.heartbeat()?;

        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if should_skip_path(path, true) {
            continue;
        }

        let relative = normalize_relative_path(root, path);
        if relative.is_empty() {
            continue;
        }

        let Some((file_type, mtime)) = classify_file_type(path) else {
            continue;
        };

        entries.push(GlobMatch {
            path: relative.into_owned(),
            file_type,
            mtime,
        });
    }

    Ok(entries)
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache API
// ═══════════════════════════════════════════════════════════════════════════

/// Returns scanned entries using the global TTL cache policy.
///
/// The returned [`ScanResult::cache_age_ms`] lets callers implement
/// empty-result fast recheck: if a query produces zero matches and the cache is
/// older than [`empty_recheck_ms()`], call [`force_rescan`] before returning
/// empty.
pub fn get_or_scan(
    root: &Path,
    include_hidden: bool,
    use_gitignore: bool,
    ct: &task::CancelToken,
) -> Result<ScanResult> {
    let ttl = cache_ttl_ms();
    if ttl == 0 {
        let entries = collect_entries(root, include_hidden, use_gitignore, ct)?;
        return Ok(ScanResult {
            entries,
            cache_age_ms: 0,
        });
    }

    let key = CacheKey {
        root: root.to_path_buf(),
        include_hidden,
        use_gitignore,
    };

    let now = Instant::now();
    if let Some(entry) = FS_CACHE.get(&key) {
        let age = now.duration_since(entry.created_at);
        if age < Duration::from_millis(ttl) {
            return Ok(ScanResult {
                entries: entry.entries.clone(),
                cache_age_ms: age.as_millis() as u64,
            });
        }
        drop(entry);
        FS_CACHE.remove(&key);
    }

    let entries = collect_entries(root, include_hidden, use_gitignore, ct)?;
    FS_CACHE.insert(
        key,
        CacheEntry {
            created_at: now,
            entries: entries.clone(),
        },
    );
    evict_oldest();
    Ok(ScanResult {
        entries,
        cache_age_ms: 0,
    })
}

/// Force a fresh scan, replacing any existing cache entry.
///
/// When `store` is false, the fresh scan result is returned without
/// repopulating the cache.
pub fn force_rescan(
    root: &Path,
    include_hidden: bool,
    use_gitignore: bool,
    store: bool,
    ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
    let key = CacheKey {
        root: root.to_path_buf(),
        include_hidden,
        use_gitignore,
    };
    FS_CACHE.remove(&key);

    let entries = collect_entries(root, include_hidden, use_gitignore, ct)?;
    if store {
        let now = Instant::now();
        FS_CACHE.insert(
            key,
            CacheEntry {
                created_at: now,
                entries: entries.clone(),
            },
        );
        evict_oldest();
    }
    Ok(entries)
}

// ═══════════════════════════════════════════════════════════════════════════
// Invalidation
// ═══════════════════════════════════════════════════════════════════════════

/// Invalidate cache entries whose root contains `target`.
pub fn invalidate_path(target: &Path) {
    let keys_to_remove: Vec<CacheKey> = FS_CACHE
        .iter()
        .filter(|entry| target.starts_with(&entry.key().root))
        .map(|entry| entry.key().clone())
        .collect();
    for key in keys_to_remove {
        FS_CACHE.remove(&key);
    }
}

/// Clear the entire scan cache.
pub fn invalidate_all() {
    FS_CACHE.clear();
}

/// Invalidate the filesystem scan cache.
///
/// When called with a path, removes entries for roots containing that path.
/// When called without a path, clears the entire cache.
///
/// Intended to be called after agent file mutations (write, edit, rename,
/// delete).
#[napi(js_name = "invalidateFsScanCache")]
pub fn invalidate_fs_scan_cache(path: Option<String>) {
    match path {
        Some(p) => {
            let candidate = PathBuf::from(&p);
            let absolute = if candidate.is_absolute() {
                candidate
            } else if let Ok(cwd) = std::env::current_dir() {
                cwd.join(candidate)
            } else {
                PathBuf::from(&p)
            };
            let target = std::fs::canonicalize(&absolute)
                .or_else(|_| {
                    absolute
                        .parent()
                        .and_then(|parent| std::fs::canonicalize(parent).ok())
                        .and_then(|parent| absolute.file_name().map(|name| parent.join(name)))
                        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
                })
                .unwrap_or(absolute);
            invalidate_path(&target);
        }
        None => invalidate_all(),
    }
}
