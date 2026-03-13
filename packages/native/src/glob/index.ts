/**
 * Native glob module using N-API.
 *
 * Gitignore-respecting filesystem discovery backed by Rust's `ignore` and
 * `globset` crates, with an optional TTL-based scan cache for repeated queries.
 */

import { native } from "../native.js";
import type {
  GlobMatch,
  GlobOptions,
  GlobResult,
} from "./types.js";

export type { FileType, GlobMatch, GlobOptions, GlobResult } from "./types.js";

/**
 * Find filesystem entries matching a glob pattern.
 *
 * Respects .gitignore by default. Skips `.git` and `node_modules` unless
 * the pattern explicitly mentions them.
 *
 * @param options - Glob search options (pattern, path, filters, etc.)
 * @param onMatch - Optional streaming callback invoked for each match.
 * @returns Promise resolving to matched entries.
 */
export function glob(
  options: GlobOptions,
  onMatch?: (match: GlobMatch) => void,
): Promise<GlobResult> {
  return native.glob(options, onMatch) as Promise<GlobResult>;
}

/**
 * Invalidate the filesystem scan cache.
 *
 * Call after file mutations (write, edit, rename, delete) to ensure
 * subsequent glob queries see fresh data.
 *
 * @param path - Specific path to invalidate, or omit to clear all.
 */
export function invalidateFsScanCache(path?: string): void {
  native.invalidateFsScanCache(path);
}
