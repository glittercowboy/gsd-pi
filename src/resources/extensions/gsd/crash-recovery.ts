/**
 * GSD Crash Recovery
 *
 * Detects interrupted auto-mode sessions via a lock file.
 * Written on auto-start, updated on each unit dispatch, deleted on clean stop.
 * If the lock file exists on next startup, the previous session crashed.
 *
 * The lock records the pi session file path so crash recovery can read the
 * surviving JSONL (pi appends entries incrementally via appendFileSync,
 * so the file on disk reflects every tool call up to the crash point).
 */

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";

/**
 * Read the last N lines of a JSONL session file and extract a brief summary
 * of recent tool calls and assistant messages before a crash.
 * Returns a formatted "Last activity before crash:" string, or null if the
 * file is unreadable or contains no relevant entries.
 */
export function readSessionFileSummary(sessionFile: string, maxLines = 20): string | null {
  try {
    if (!existsSync(sessionFile)) return null;
    const raw = readFileSync(sessionFile, "utf-8");
    const allLines = raw.split("\n").filter(Boolean);
    const lastLines = allLines.slice(-maxLines);

    const entries: string[] = [];
    for (const line of lastLines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const type = entry["type"] as string | undefined;
        // Tool call entries
        if (type === "tool_use" || type === "tool_call") {
          const name = (entry["name"] as string) ?? (entry["tool"] as string) ?? "unknown";
          const inputRaw = entry["input"] ?? entry["arguments"] ?? "";
          const inputStr = typeof inputRaw === "string"
            ? inputRaw
            : JSON.stringify(inputRaw);
          const truncated = inputStr.length > 200 ? inputStr.slice(0, 200) + "…" : inputStr;
          entries.push(`  tool: ${name}(${truncated})`);
        }
        // Tool result entries
        if (type === "tool_result") {
          const contentRaw = entry["content"] ?? entry["output"] ?? "";
          const contentStr = typeof contentRaw === "string"
            ? contentRaw
            : JSON.stringify(contentRaw);
          const truncated = contentStr.length > 200 ? contentStr.slice(0, 200) + "…" : contentStr;
          entries.push(`  result: ${truncated}`);
        }
        // Assistant message entries
        if (type === "assistant" || type === "message") {
          const contentRaw = entry["content"] ?? "";
          const contentStr = typeof contentRaw === "string"
            ? contentRaw
            : JSON.stringify(contentRaw);
          if (contentStr.trim()) {
            const truncated = contentStr.length > 200 ? contentStr.slice(0, 200) + "…" : contentStr;
            entries.push(`  assistant: ${truncated}`);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Keep only the last 3–5 tool/result pairs
    const toolEntries = entries.filter(e => e.startsWith("  tool:") || e.startsWith("  result:"));
    const recentTools = toolEntries.slice(-5);

    if (recentTools.length === 0) return null;

    return ["Last activity before crash:", ...recentTools].join("\n");
  } catch {
    // File unreadable — skip gracefully
    return null;
  }
}

const LOCK_FILE = "auto.lock";

export interface LockData {
  pid: number;
  startedAt: string;
  unitType: string;
  unitId: string;
  unitStartedAt: string;
  completedUnits: number;
  /** Path to the pi session JSONL file that was active when this unit started. */
  sessionFile?: string;
}

function lockPath(basePath: string): string {
  return join(gsdRoot(basePath), LOCK_FILE);
}

/** Write or update the lock file with current auto-mode state. */
export function writeLock(
  basePath: string,
  unitType: string,
  unitId: string,
  completedUnits: number,
  sessionFile?: string,
): void {
  try {
    const data: LockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType,
      unitId,
      unitStartedAt: new Date().toISOString(),
      completedUnits,
      sessionFile,
    };
    const lp = lockPath(basePath);
    atomicWriteSync(lp, JSON.stringify(data, null, 2));
  } catch (e) { /* non-fatal: lock write failure */ void e; }
}

/** Remove the lock file on clean stop. */
export function clearLock(basePath: string): void {
  try {
    const p = lockPath(basePath);
    if (existsSync(p)) unlinkSync(p);
  } catch (e) { /* non-fatal: lock clear failure */ void e; }
}

/** Check if a crash lock exists and return its data. */
export function readCrashLock(basePath: string): LockData | null {
  try {
    const p = lockPath(basePath);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as LockData;
  } catch (e) {
    /* non-fatal: corrupt or unreadable lock file */ void e;
    return null;
  }
}

/**
 * Check whether the process that wrote the lock is still running.
 * Uses `process.kill(pid, 0)` which sends no signal but checks liveness.
 * Returns false if the PID matches our own (recycled PID from a prior run).
 */
export function isLockProcessAlive(lock: LockData): boolean {
  const pid = lock.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission — treat as alive.
    // ESRCH means the process does not exist — treat as dead (stale lock).
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/** Format crash info for display or injection into a prompt. */
export function formatCrashInfo(lock: LockData): string {
  const lines = [
    `Previous auto-mode session was interrupted.`,
    `  Was executing: ${lock.unitType} (${lock.unitId})`,
    `  Started at: ${lock.unitStartedAt}`,
    `  Units completed before crash: ${lock.completedUnits}`,
    `  PID: ${lock.pid}`,
  ];

  // Add recovery guidance based on what was happening when it crashed
  if (lock.unitType === "starting" && lock.unitId === "bootstrap" && lock.completedUnits === 0) {
    lines.push(`No work was lost. Run /gsd auto to restart.`);
  } else if (lock.unitType.includes("research") || lock.unitType.includes("plan")) {
    lines.push(`The ${lock.unitType} unit may be incomplete. Run /gsd auto to re-run it.`);
  } else if (lock.unitType.includes("execute")) {
    lines.push(`Task execution was interrupted. Run /gsd auto to resume — completed work is preserved.`);
  } else if (lock.unitType.includes("complete")) {
    lines.push(`Slice/milestone completion was interrupted. Run /gsd auto to finish.`);
  }

  // If the lock recorded a session file, read the last activity summary from JSONL
  if (lock.sessionFile) {
    const summary = readSessionFileSummary(lock.sessionFile);
    if (summary) {
      lines.push(summary);
    }
  }

  return lines.join("\n");
}
