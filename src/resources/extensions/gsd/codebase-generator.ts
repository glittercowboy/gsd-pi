/**
 * GSD Codebase Map Generator
 *
 * Produces .gsd/CODEBASE.md — a structural table of contents for the project.
 * Gives fresh agent contexts instant orientation without filesystem exploration.
 *
 * Generation: walk `git ls-files`, group by directory, output with descriptions.
 * Maintenance: agent updates descriptions as it works; incremental update preserves them.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";

import { execSync } from "node:child_process";
import { gsdRoot } from "./paths.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CodebaseMapOptions {
  excludePatterns?: string[];
  maxFiles?: number;
  collapseThreshold?: number;
}

export interface CodebaseMapMetadata {
  generatedAt: string;
  fingerprint: string;
  fileCount: number;
  truncated: boolean;
}

export interface EnsureCodebaseMapOptions {
  ttlMs?: number;
  maxAgeMs?: number;
  force?: boolean;
}

export interface EnsureCodebaseMapResult {
  status: "generated" | "updated" | "fresh" | "empty";
  fileCount: number;
  truncated: boolean;
  generatedAt: string | null;
  fingerprint: string | null;
  reason?: string;
}

interface FileEntry {
  path: string;
  description: string;
}

interface DirectoryGroup {
  path: string;
  files: FileEntry[];
  collapsed: boolean;
}

interface ResolvedCodebaseMapOptions {
  excludes: string[];
  maxFiles: number;
  collapseThreshold: number;
  optionSignature: string;
}

interface EnumeratedFiles {
  files: string[];
  truncated: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_EXCLUDES = [
  // ── AI / tooling meta ──
  ".agents/",
  ".gsd/",
  ".planning/",
  ".plans/",
  ".claude/",
  ".cursor/",
  ".bg-shell/",

  // ── Editor / IDE ──
  ".vscode/",
  ".idea/",

  // ── VCS ──
  ".git/",

  // ── Dependencies & build artifacts ──
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "vendor/",
  "target/",

  // ── Misc ──
  ".cache/",
  "tmp/",
];

const DEFAULT_MAX_FILES = 500;
const DEFAULT_COLLAPSE_THRESHOLD = 20;
const DEFAULT_REFRESH_TTL_MS = 30_000;
const DEFAULT_MAX_AGE_MS = 15 * 60_000;
const CODEBASE_METADATA_PREFIX = "<!-- gsd:codebase-meta ";

const freshnessCache = new Map<string, { checkedAt: number; result: EnsureCodebaseMapResult }>();

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse an existing CODEBASE.md to extract file → description mappings.
 * Also scans <!-- gsd:collapsed-descriptions --> comment blocks to preserve
 * descriptions for files in collapsed directories across incremental updates.
 */
export function parseCodebaseMap(content: string): Map<string, string> {
  const descriptions = new Map<string, string>();
  let inCollapsedBlock = false;

  for (const line of content.split("\n")) {
    // Track collapsed-description comment blocks
    if (line.trimStart().startsWith("<!-- gsd:collapsed-descriptions")) {
      inCollapsedBlock = true;
      continue;
    }
    if (inCollapsedBlock && line.trimStart().startsWith("-->")) {
      inCollapsedBlock = false;
      continue;
    }

    // Match: - `path/to/file.ts` — Description here
    const match = line.match(/^- `(.+?)` — (.+)$/);
    if (match) {
      descriptions.set(match[1], match[2]);
      continue;
    }

    // Match: - `path/to/file.ts` (no description) — only outside collapsed blocks
    if (!inCollapsedBlock) {
      const bareMatch = line.match(/^- `(.+?)`\s*$/);
      if (bareMatch) {
        descriptions.set(bareMatch[1], "");
      }
    }
  }
  return descriptions;
}

export function parseCodebaseMapMetadata(content: string): CodebaseMapMetadata | null {
  const metaLine = content
    .split("\n")
    .find((line) => line.trimStart().startsWith(CODEBASE_METADATA_PREFIX));
  if (!metaLine) return null;

  const trimmed = metaLine.trim();
  const jsonStart = CODEBASE_METADATA_PREFIX.length;
  const jsonEnd = trimmed.lastIndexOf(" -->");
  if (jsonEnd <= jsonStart) return null;

  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd));
    if (
      typeof parsed?.generatedAt === "string"
      && typeof parsed?.fingerprint === "string"
      && typeof parsed?.fileCount === "number"
      && typeof parsed?.truncated === "boolean"
    ) {
      return parsed as CodebaseMapMetadata;
    }
  } catch {
    // Ignore malformed metadata and treat the map as stale.
  }
  return null;
}

// ─── File Enumeration ────────────────────────────────────────────────────────

function shouldExclude(filePath: string, excludes: string[]): boolean {
  for (const pattern of excludes) {
    if (pattern.endsWith("/")) {
      if (filePath.startsWith(pattern) || filePath.includes(`/${pattern}`)) return true;
    } else if (filePath === pattern || filePath.endsWith(`/${pattern}`)) {
      return true;
    }
  }
  // Skip binary/lock files
  const ext = extname(filePath).toLowerCase();
  if ([".lock", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".svg"].includes(ext)) {
    return true;
  }
  return false;
}

function lsFiles(basePath: string): string[] {
  try {
    const result = execSync("git ls-files", { cwd: basePath, encoding: "utf-8", timeout: 10000 });
    return result.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Enumerate tracked files, applying exclusions and the maxFiles cap.
 * Returns both the file list and whether truncation occurred.
 */
function enumerateFiles(basePath: string, excludes: string[], maxFiles: number): { files: string[]; truncated: boolean } {
  const allFiles = lsFiles(basePath);
  const filtered = allFiles.filter((f) => !shouldExclude(f, excludes));
  const truncated = filtered.length > maxFiles;
  return { files: truncated ? filtered.slice(0, maxFiles) : filtered, truncated };
}

function resolveGeneratorOptions(options?: CodebaseMapOptions): ResolvedCodebaseMapOptions {
  const excludes = [...DEFAULT_EXCLUDES, ...(options?.excludePatterns ?? [])];
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const collapseThreshold = options?.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD;
  return {
    excludes,
    maxFiles,
    collapseThreshold,
    optionSignature: JSON.stringify({
      excludes,
      maxFiles,
      collapseThreshold,
    }),
  };
}

function computeCodebaseFingerprint(
  files: string[],
  resolved: ResolvedCodebaseMapOptions,
  truncated: boolean,
): string {
  return createHash("sha1")
    .update(JSON.stringify({
      files,
      truncated,
      optionSignature: resolved.optionSignature,
    }))
    .digest("hex");
}

// ─── Grouping ────────────────────────────────────────────────────────────────

function groupByDirectory(
  files: string[],
  descriptions: Map<string, string>,
  collapseThreshold: number,
): DirectoryGroup[] {
  const dirMap = new Map<string, FileEntry[]>();

  for (const file of files) {
    const dir = dirname(file);
    const dirKey = dir === "." ? "" : dir;
    if (!dirMap.has(dirKey)) {
      dirMap.set(dirKey, []);
    }
    dirMap.get(dirKey)!.push({
      path: file,
      description: descriptions.get(file) ?? "",
    });
  }

  const groups: DirectoryGroup[] = [];
  const sortedDirs = [...dirMap.keys()].sort();

  for (const dir of sortedDirs) {
    const dirFiles = dirMap.get(dir)!;
    dirFiles.sort((a, b) => a.path.localeCompare(b.path));

    groups.push({
      path: dir,
      files: dirFiles,
      collapsed: dirFiles.length > collapseThreshold,
    });
  }

  return groups;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderCodebaseMap(
  groups: DirectoryGroup[],
  totalFiles: number,
  truncated: boolean,
  metadata: CodebaseMapMetadata,
): string {
  const lines: string[] = [];
  const described = groups.reduce((sum, g) => sum + g.files.filter((f) => f.description).length, 0);

  lines.push("# Codebase Map");
  lines.push("");
  lines.push(`Generated: ${metadata.generatedAt} | Files: ${totalFiles} | Described: ${described}/${totalFiles}`);
  lines.push(`${CODEBASE_METADATA_PREFIX}${JSON.stringify(metadata)} -->`);
  if (truncated) {
    lines.push(`Note: Truncated to first ${totalFiles} files. Run with higher --max-files to include all.`);
  }
  lines.push("");

  for (const group of groups) {
    const heading = group.path || "(root)";
    lines.push(`### ${heading}/`);

    if (group.collapsed) {
      // Summarize collapsed directories
      const extensions = new Map<string, number>();
      for (const f of group.files) {
        const ext = extname(f.path) || "(no ext)";
        extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      }
      const extSummary = [...extensions.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([ext, count]) => `${count} ${ext}`)
        .join(", ");
      lines.push(`- *(${group.files.length} files: ${extSummary})*`);

      // Preserve any existing descriptions in a hidden comment block so
      // incremental updates can recover them via parseCodebaseMap.
      const descLines = group.files
        .filter((f) => f.description)
        .map((f) => `- \`${f.path}\` — ${f.description}`);
      if (descLines.length > 0) {
        lines.push("<!-- gsd:collapsed-descriptions");
        lines.push(...descLines);
        lines.push("-->");
      }
    } else {
      for (const file of group.files) {
        if (file.description) {
          lines.push(`- \`${file.path}\` — ${file.description}`);
        } else {
          lines.push(`- \`${file.path}\``);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildCodebaseMap(
  basePath: string,
  resolved: ResolvedCodebaseMapOptions,
  existingDescriptions?: Map<string, string>,
  enumerated?: EnumeratedFiles,
): {
  content: string;
  fileCount: number;
  truncated: boolean;
  files: string[];
  fingerprint: string;
  generatedAt: string;
} {
  const listed = enumerated ?? enumerateFiles(basePath, resolved.excludes, resolved.maxFiles);
  const descriptions = existingDescriptions ?? new Map<string, string>();
  const groups = groupByDirectory(listed.files, descriptions, resolved.collapseThreshold);
  const generatedAt = new Date().toISOString().split(".")[0] + "Z";
  const metadata: CodebaseMapMetadata = {
    generatedAt,
    fingerprint: computeCodebaseFingerprint(listed.files, resolved, listed.truncated),
    fileCount: listed.files.length,
    truncated: listed.truncated,
  };
  const content = renderCodebaseMap(groups, listed.files.length, listed.truncated, metadata);

  return {
    content,
    fileCount: listed.files.length,
    truncated: listed.truncated,
    files: listed.files,
    fingerprint: metadata.fingerprint,
    generatedAt,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a fresh CODEBASE.md from scratch.
 * Preserves existing descriptions if `existingDescriptions` is provided.
 */
export function generateCodebaseMap(
  basePath: string,
  options?: CodebaseMapOptions,
  existingDescriptions?: Map<string, string>,
): { content: string; fileCount: number; truncated: boolean; files: string[]; fingerprint: string; generatedAt: string } {
  const resolved = resolveGeneratorOptions(options);
  return buildCodebaseMap(basePath, resolved, existingDescriptions);
}

/**
 * Incremental update: re-scan files, preserve existing descriptions,
 * add new files, remove deleted files.
 */
export function updateCodebaseMap(
  basePath: string,
  options?: CodebaseMapOptions,
): {
  content: string;
  added: number;
  removed: number;
  unchanged: number;
  fileCount: number;
  truncated: boolean;
  fingerprint: string;
  generatedAt: string;
} {
  const codebasePath = join(gsdRoot(basePath), "CODEBASE.md");
  const resolved = resolveGeneratorOptions(options);

  // Load existing descriptions
  let existingDescriptions = new Map<string, string>();
  if (existsSync(codebasePath)) {
    const existing = readFileSync(codebasePath, "utf-8");
    existingDescriptions = parseCodebaseMap(existing);
  }

  const existingFiles = new Set(existingDescriptions.keys());

  // Generate new map preserving descriptions — reuse the returned file list
  // to avoid a second enumeration (prevents race between content and stats).
  const result = buildCodebaseMap(basePath, resolved, existingDescriptions);
  const currentSet = new Set(result.files);

  // Count changes
  let added = 0;
  let removed = 0;

  for (const f of result.files) {
    if (!existingFiles.has(f)) added++;
  }
  for (const f of existingFiles) {
    if (!currentSet.has(f)) removed++;
  }

  return {
    content: result.content,
    added,
    removed,
    unchanged: result.files.length - added,
    fileCount: result.fileCount,
    truncated: result.truncated,
    fingerprint: result.fingerprint,
    generatedAt: result.generatedAt,
  };
}

function clearFreshnessCache(basePath: string): void {
  for (const key of freshnessCache.keys()) {
    if (key === basePath || key.startsWith(`${basePath}::`)) {
      freshnessCache.delete(key);
    }
  }
}

export function ensureCodebaseMapFresh(
  basePath: string,
  options?: CodebaseMapOptions,
  ensureOptions?: EnsureCodebaseMapOptions,
): EnsureCodebaseMapResult {
  const resolved = resolveGeneratorOptions(options);
  const cacheKey = `${basePath}::${resolved.optionSignature}`;
  const ttlMs = ensureOptions?.ttlMs ?? DEFAULT_REFRESH_TTL_MS;
  const maxAgeMs = ensureOptions?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const force = ensureOptions?.force === true;
  const now = Date.now();

  if (!force && ttlMs > 0) {
    const cached = freshnessCache.get(cacheKey);
    if (cached && now - cached.checkedAt < ttlMs) {
      return cached.result;
    }
  }

  const existing = readCodebaseMap(basePath);
  const listed = enumerateFiles(basePath, resolved.excludes, resolved.maxFiles);
  const fingerprint = computeCodebaseFingerprint(listed.files, resolved, listed.truncated);

  const cacheAndReturn = (result: EnsureCodebaseMapResult): EnsureCodebaseMapResult => {
    freshnessCache.set(cacheKey, { checkedAt: now, result });
    return result;
  };

  if (!existing) {
    const generated = buildCodebaseMap(basePath, resolved, undefined, listed);
    if (generated.fileCount > 0) {
      writeCodebaseMap(basePath, generated.content);
      return cacheAndReturn({
        status: "generated",
        fileCount: generated.fileCount,
        truncated: generated.truncated,
        generatedAt: generated.generatedAt,
        fingerprint: generated.fingerprint,
        reason: "missing",
      });
    }
    return cacheAndReturn({
      status: "empty",
      fileCount: 0,
      truncated: false,
      generatedAt: null,
      fingerprint,
      reason: "no-tracked-files",
    });
  }

  const metadata = parseCodebaseMapMetadata(existing);
  const existingDescriptions = parseCodebaseMap(existing);
  const ageMs = metadata ? now - Date.parse(metadata.generatedAt) : Number.POSITIVE_INFINITY;
  const staleReason =
    !metadata ? "missing-metadata"
    : metadata.fingerprint !== fingerprint ? "files-changed"
    : metadata.fileCount !== listed.files.length ? "file-count-changed"
    : metadata.truncated !== listed.truncated ? "truncation-changed"
    : maxAgeMs > 0 && Number.isFinite(ageMs) && ageMs > maxAgeMs ? "expired"
    : undefined;

  if (!staleReason) {
    return cacheAndReturn({
      status: "fresh",
      fileCount: metadata?.fileCount ?? listed.files.length,
      truncated: metadata?.truncated ?? listed.truncated,
      generatedAt: metadata?.generatedAt ?? null,
      fingerprint: metadata?.fingerprint ?? fingerprint,
    });
  }

  const updated = buildCodebaseMap(basePath, resolved, existingDescriptions, listed);
  if (updated.fileCount > 0) {
    writeCodebaseMap(basePath, updated.content);
    return cacheAndReturn({
      status: "updated",
      fileCount: updated.fileCount,
      truncated: updated.truncated,
      generatedAt: updated.generatedAt,
      fingerprint: updated.fingerprint,
      reason: staleReason,
    });
  }

  return cacheAndReturn({
    status: "empty",
    fileCount: 0,
    truncated: false,
    generatedAt: null,
    fingerprint,
    reason: staleReason,
  });
}

/**
 * Write CODEBASE.md to .gsd/ directory.
 */
export function writeCodebaseMap(basePath: string, content: string): string {
  const root = gsdRoot(basePath);
  mkdirSync(root, { recursive: true });
  const outPath = join(root, "CODEBASE.md");
  writeFileSync(outPath, content, "utf-8");
  clearFreshnessCache(basePath);
  return outPath;
}

/**
 * Read existing CODEBASE.md, or return null if it doesn't exist.
 */
export function readCodebaseMap(basePath: string): string | null {
  const codebasePath = join(gsdRoot(basePath), "CODEBASE.md");
  if (!existsSync(codebasePath)) return null;
  try {
    return readFileSync(codebasePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get stats about the codebase map.
 */
export function getCodebaseMapStats(basePath: string): {
  exists: boolean;
  fileCount: number;
  describedCount: number;
  undescribedCount: number;
  generatedAt: string | null;
} {
  const content = readCodebaseMap(basePath);
  if (!content) {
    return { exists: false, fileCount: 0, describedCount: 0, undescribedCount: 0, generatedAt: null };
  }

  // Parse total file count from the header line (accurate even for collapsed dirs)
  const fileCountMatch = content.match(/Files:\s*(\d+)/);
  const totalFiles = fileCountMatch ? parseInt(fileCountMatch[1], 10) : 0;

  // Use parseCodebaseMap to count described files (includes collapsed-description blocks)
  const descriptions = parseCodebaseMap(content);
  const described = [...descriptions.values()].filter((d) => d.length > 0).length;
  const dateMatch = content.match(/Generated: (\S+)/);

  return {
    exists: true,
    fileCount: totalFiles,
    describedCount: described,
    undescribedCount: totalFiles - described,
    generatedAt: dateMatch?.[1] ?? null,
  };
}
