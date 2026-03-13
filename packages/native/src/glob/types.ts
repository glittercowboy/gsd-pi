/** File type classification for filesystem entries. */
export const enum FileType {
  /** Regular file. */
  File = 1,
  /** Directory. */
  Dir = 2,
  /** Symbolic link. */
  Symlink = 3,
}

/** A single filesystem entry matched by a glob operation. */
export interface GlobMatch {
  /** Relative path from the search root, using forward slashes. */
  path: string;
  /** Resolved filesystem type for the match. */
  fileType: FileType;
  /** Modification time in milliseconds since Unix epoch. */
  mtime: number | null;
}

/** Options for the glob operation. */
export interface GlobOptions {
  /** Glob pattern to match (e.g., "*.ts"). */
  pattern: string;
  /** Directory to search. */
  path: string;
  /** Filter by file type: File (1), Dir (2), or Symlink (3). */
  fileType?: FileType;
  /** Match simple patterns recursively by default (default: true). */
  recursive?: boolean;
  /** Include hidden files (default: false). */
  hidden?: boolean;
  /** Maximum number of results to return. */
  maxResults?: number;
  /** Respect .gitignore files (default: true). */
  gitignore?: boolean;
  /** Enable shared filesystem scan cache (default: false). */
  cache?: boolean;
  /** Sort results by mtime (most recent first) before applying limit. */
  sortByMtime?: boolean;
  /** Include node_modules entries (default: false, unless pattern mentions it). */
  includeNodeModules?: boolean;
  /** Timeout in milliseconds for the operation. */
  timeoutMs?: number;
}

/** Result payload returned by a glob operation. */
export interface GlobResult {
  /** Matched filesystem entries. */
  matches: GlobMatch[];
  /** Number of returned matches. */
  totalMatches: number;
}
