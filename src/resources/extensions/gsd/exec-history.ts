// GSD Exec History — read-side helpers for the exec sandbox.
//
// Pure I/O: scans `.gsd/exec/*.meta.json` under a base directory and
// returns lightweight records. Used by the gsd_exec_search tool and
// any future compaction-snapshot enrichment.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ExecHistoryEntry {
  id: string;
  runtime: "bash" | "node" | "python" | string;
  purpose: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdout_path: string;
  stderr_path: string;
  meta_path: string;
}

export interface ExecSearchOptions {
  /** Case-insensitive needle matched against purpose. Empty string matches all. */
  query?: string;
  /** Restrict to this runtime. */
  runtime?: ExecHistoryEntry["runtime"];
  /** Include only entries with exit_code !== 0 || timed_out. */
  failing_only?: boolean;
  /** Return at most N entries, most recent first. Default 20, cap 200. */
  limit?: number;
}

export interface ExecSearchHit {
  entry: ExecHistoryEntry;
  /** Tail of stdout (first 300 chars) — cheap to read, useful for disambiguation. */
  digest_preview?: string;
}

function listMetaFiles(baseDir: string): string[] {
  const dir = resolve(baseDir, ".gsd", "exec");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".meta.json"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function safeReadMeta(path: string): ExecHistoryEntry | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ExecHistoryEntry>;
    if (typeof parsed.id !== "string" || typeof parsed.runtime !== "string") return null;
    return {
      id: parsed.id,
      runtime: parsed.runtime,
      purpose: typeof parsed.purpose === "string" ? parsed.purpose : null,
      started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
      finished_at: typeof parsed.finished_at === "string" ? parsed.finished_at : "",
      duration_ms: typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0,
      exit_code: typeof parsed.exit_code === "number" ? parsed.exit_code : null,
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      timed_out: parsed.timed_out === true,
      stdout_bytes: typeof parsed.stdout_bytes === "number" ? parsed.stdout_bytes : 0,
      stderr_bytes: typeof parsed.stderr_bytes === "number" ? parsed.stderr_bytes : 0,
      stdout_truncated: parsed.stdout_truncated === true,
      stderr_truncated: parsed.stderr_truncated === true,
      stdout_path: path.replace(/\.meta\.json$/, ".stdout"),
      stderr_path: path.replace(/\.meta\.json$/, ".stderr"),
      meta_path: path,
    };
  } catch {
    return null;
  }
}

export function listExecHistory(baseDir: string): ExecHistoryEntry[] {
  const metas = listMetaFiles(baseDir)
    .map((path) => {
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        /* ignore */
      }
      const entry = safeReadMeta(path);
      return entry ? { entry, mtime } : null;
    })
    .filter((value): value is { entry: ExecHistoryEntry; mtime: number } => value !== null);
  metas.sort((a, b) => b.mtime - a.mtime);
  return metas.map((m) => m.entry);
}

function matchesFilters(entry: ExecHistoryEntry, opts: ExecSearchOptions): boolean {
  if (opts.runtime && entry.runtime !== opts.runtime) return false;
  if (opts.failing_only) {
    const failed = entry.timed_out || (entry.exit_code !== 0 && entry.exit_code !== null);
    if (!failed) return false;
  }
  const query = (opts.query ?? "").trim().toLowerCase();
  if (!query) return true;
  const haystack = `${entry.id} ${entry.purpose ?? ""}`.toLowerCase();
  return haystack.includes(query);
}

function readDigestPreview(entry: ExecHistoryEntry, maxChars: number): string | undefined {
  if (!entry.stdout_path || maxChars <= 0) return undefined;
  try {
    const size = statSync(entry.stdout_path).size;
    if (size === 0) return undefined;
    const readBytes = Math.min(size, maxChars * 4); // 4 bytes/char upper bound for UTF-8
    const buf = Buffer.allocUnsafe(readBytes);
    const fd = openSync(entry.stdout_path, "r");
    try {
      const bytesRead = readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes));
      const text = buf.subarray(0, bytesRead).toString("utf-8");
      const trimmed = text.trimEnd();
      return trimmed.length <= maxChars ? trimmed : trimmed.slice(trimmed.length - maxChars);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export function searchExecHistory(
  baseDir: string,
  opts: ExecSearchOptions = {},
): ExecSearchHit[] {
  const limit = clampLimit(opts.limit, 20, 200);
  const entries = listExecHistory(baseDir);
  const filtered = entries.filter((entry) => matchesFilters(entry, opts));
  return filtered.slice(0, limit).map((entry) => ({
    entry,
    digest_preview: readDigestPreview(entry, 300),
  }));
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 1) return 1;
  if (value > max) return max;
  return Math.floor(value);
}
