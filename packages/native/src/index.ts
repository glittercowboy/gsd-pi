/**
 * @gsd/native — High-performance Rust modules exposed via N-API.
 *
 * Modules:
 * - grep: ripgrep-backed regex search (content + filesystem)
 * - ps: cross-platform process tree management
 * - glob: gitignore-respecting filesystem discovery with scan caching
 */

export { searchContent, grep } from "./grep/index.js";
export type {
  ContextLine,
  GrepMatch,
  GrepOptions,
  GrepResult,
  SearchMatch,
  SearchOptions,
  SearchResult,
} from "./grep/index.js";

export {
  killTree,
  listDescendants,
  processGroupId,
  killProcessGroup,
} from "./ps/index.js";

export { glob, invalidateFsScanCache } from "./glob/index.js";
export type {
  FileType,
  GlobMatch,
  GlobOptions,
  GlobResult,
} from "./glob/index.js";
