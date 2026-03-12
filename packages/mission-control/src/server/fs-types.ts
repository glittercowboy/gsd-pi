/**
 * Types for file system browsing and project detection.
 * Used by fs-api.ts and recent-projects.ts.
 */

export interface FileSystemEntry {
  /** File or directory name */
  name: string;
  /** Absolute path with forward slashes */
  path: string;
  /** Whether this entry is a directory */
  isDirectory: boolean;
  /** Whether this directory contains .gsd/ (is a GSD project) */
  isGsdProject: boolean;
}

export interface RecentProject {
  /** Absolute path with forward slashes */
  path: string;
  /** Display name (last segment of path) */
  name: string;
  /** Unix timestamp of last open */
  lastOpened: number;
  /** Whether the project has .gsd/ */
  isGsdProject: boolean;
}
