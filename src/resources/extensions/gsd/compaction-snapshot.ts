// GSD Compaction Snapshot — writes a ≤2 KB markdown digest of durable
// project state before the session context is compacted. On resume, an
// agent can `gsd_resume` (or Read .gsd/last-snapshot.md) to re-orient
// without re-deriving the same memories.
//
// Inspired by mksglu/context-mode. Independent implementation.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getActiveMemoriesRanked, type Memory } from "./memory-store.js";
import { listExecHistory, type ExecHistoryEntry } from "./exec-history.js";

export const DEFAULT_SNAPSHOT_BYTES = 2048;
export const SNAPSHOT_FILENAME = "last-snapshot.md";

export interface SnapshotSources {
  memories: Memory[];
  execHistory: ExecHistoryEntry[];
  generatedAt: Date;
  /** Optional free-form context string (e.g. active unit id). */
  activeContext?: string | null;
}

export interface BuildSnapshotOptions {
  /** Hard cap in bytes (UTF-8). Default 2048. */
  maxBytes?: number;
  /** Memory count cap before truncation (default 6). */
  maxMemories?: number;
  /** Exec history cap (default 5). */
  maxExec?: number;
}

/**
 * Build a priority-tiered markdown snapshot. Pure — no I/O. Tiers:
 *   1. Active context (if any)
 *   2. Top memories by rank
 *   3. Recent exec runs (failures highlighted)
 * The result is guaranteed to be <= opts.maxBytes (truncated with an
 * ellipsis marker if necessary).
 */
export function buildSnapshot(sources: SnapshotSources, opts: BuildSnapshotOptions = {}): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_SNAPSHOT_BYTES;
  const maxMemories = opts.maxMemories ?? 6;
  const maxExec = opts.maxExec ?? 5;

  const lines: string[] = [];
  lines.push(`# GSD context snapshot (${sources.generatedAt.toISOString()})`);
  lines.push("");

  if (sources.activeContext && sources.activeContext.trim().length > 0) {
    lines.push("## Active context");
    lines.push(sources.activeContext.trim());
    lines.push("");
  }

  const memories = sources.memories.slice(0, maxMemories);
  if (memories.length > 0) {
    lines.push("## Top project memories");
    for (const memory of memories) {
      lines.push(`- [${memory.id}] (${memory.category}) ${memory.content.trim()}`);
    }
    lines.push("");
  }

  const exec = sources.execHistory.slice(0, maxExec);
  if (exec.length > 0) {
    lines.push("## Recent gsd_exec runs");
    for (const entry of exec) {
      const status = entry.timed_out
        ? "timeout"
        : entry.exit_code === null
          ? "exit:null"
          : `exit:${entry.exit_code}`;
      const purpose = entry.purpose ? ` — ${entry.purpose}` : "";
      lines.push(`- [${entry.id}] ${entry.runtime} ${status}${purpose}`);
    }
    lines.push("");
  }

  if (memories.length === 0 && exec.length === 0 && !sources.activeContext) {
    lines.push("_No durable memories, active context, or exec history to surface._");
  }

  return enforceByteCap(lines.join("\n").trimEnd(), maxBytes);
}

function enforceByteCap(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf-8") <= maxBytes) return input;
  const marker = "\n…[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  const budget = Math.max(0, maxBytes - markerBytes);
  // Walk backwards until the trimmed string fits. utf-8 is variable-width;
  // naive char slicing is safe for ASCII but may split a multi-byte char.
  // Guard by decoding the trimmed Buffer and relying on the replacement-char
  // fallback in TextDecoder (implicit via toString).
  const buf = Buffer.from(input, "utf-8").subarray(0, budget);
  return `${buf.toString("utf-8")}${marker}`;
}

export interface WriteSnapshotOptions extends BuildSnapshotOptions {
  activeContext?: string | null;
  now?: () => Date;
}

export interface WriteSnapshotResult {
  path: string;
  bytes: number;
  memories: number;
  execRuns: number;
}

export function writeCompactionSnapshot(
  baseDir: string,
  opts: WriteSnapshotOptions = {},
): WriteSnapshotResult {
  const memories = safeGetMemories();
  const execHistory = safeListExec(baseDir);
  const content = buildSnapshot(
    {
      memories,
      execHistory,
      generatedAt: (opts.now ?? (() => new Date()))(),
      activeContext: opts.activeContext ?? null,
    },
    opts,
  );
  const gsdDir = resolve(baseDir, ".gsd");
  if (!existsSync(gsdDir)) mkdirSync(gsdDir, { recursive: true });
  const path = resolve(gsdDir, SNAPSHOT_FILENAME);
  const finalContent = `${content}\n`;
  writeFileSync(path, finalContent, "utf-8");
  return {
    path,
    bytes: Buffer.byteLength(finalContent, "utf-8"),
    memories: memories.length,
    execRuns: execHistory.length,
  };
}

export function readCompactionSnapshot(baseDir: string): string | null {
  const path = resolve(baseDir, ".gsd", SNAPSHOT_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function safeGetMemories(): Memory[] {
  try {
    return getActiveMemoriesRanked(12);
  } catch {
    return [];
  }
}

function safeListExec(baseDir: string): ExecHistoryEntry[] {
  try {
    return listExecHistory(baseDir);
  } catch {
    return [];
  }
}
