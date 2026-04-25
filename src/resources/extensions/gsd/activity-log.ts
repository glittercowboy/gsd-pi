/**
 * GSD Activity Log — Save raw chat sessions to .gsd/activity/
 *
 * Before each context wipe in auto-mode, dumps the full session
 * as JSONL. No formatting, no truncation, no information loss.
 * These are debug artifacts — only read when summaries aren't enough.
 *
 * Diagnostic extraction is handled by session-forensics.ts.
 */

import { writeFileSync, writeSync, mkdirSync, readdirSync, unlinkSync, statSync, openSync, closeSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { GSDError, GSD_IO_ERROR } from "./errors.js";

const SEQ_PREFIX_RE = /^(\d+)-/;
import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { gsdRoot } from "./paths.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./uok/audit.js";
import { isUnifiedAuditEnabled } from "./uok/audit-toggle.js";

interface ActivityLogState {
  nextSeq: number;
  lastSnapshotKeyByUnit: Map<string, string>;
}

const activityLogState = new Map<string, ActivityLogState>();

/**
 * Clear accumulated activity log state (#611).
 * Call when auto-mode stops to prevent unbounded memory growth
 * from lastSnapshotKeyByUnit maps accumulating across units.
 */
export function clearActivityLogState(): void {
  activityLogState.clear();
}

function scanNextSequence(activityDir: string): number {
  let maxSeq = 0;
  try {
    for (const f of readdirSync(activityDir)) {
      const match = f.match(SEQ_PREFIX_RE);
      if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
    }
  } catch (e) {
    void e; /* directory not readable — start at 1 */
    return 1;
  }
  return maxSeq + 1;
}

function getActivityState(activityDir: string): ActivityLogState {
  let state = activityLogState.get(activityDir);
  if (!state) {
    state = { nextSeq: scanNextSequence(activityDir), lastSnapshotKeyByUnit: new Map() };
    activityLogState.set(activityDir, state);
  }
  return state;
}

/**
 * Build a lightweight dedup key from session entries without serializing
 * the entire content to a string (#611). Uses entry count + hash of
 * the last few entries as a fingerprint instead of hashing megabytes.
 */
function snapshotKey(unitType: string, unitId: string, entries: unknown[]): string {
  const hash = createHash("sha1");
  hash.update(`${unitType}\0${unitId}\0${entries.length}\0`);
  // Hash only the last 3 entries as a fingerprint — if the session grew,
  // the count change alone detects it; if content changed, the tail hash catches it.
  const tail = entries.slice(-3);
  for (const entry of tail) {
    hash.update(JSON.stringify(entry));
  }
  return hash.digest("hex");
}

function nextActivityFilePath(
  activityDir: string,
  state: ActivityLogState,
  unitType: string,
  safeUnitId: string,
): string {
  // Use O_CREAT | O_EXCL for atomic "create if absent" — no directory scan needed.
  for (let attempts = 0; attempts < 1000; attempts++) {
    const seq = String(state.nextSeq).padStart(3, "0");
    const filePath = join(activityDir, `${seq}-${unitType}-${safeUnitId}.jsonl`);
    try {
      const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      closeSync(fd);
      return filePath;
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        state.nextSeq++;
        continue;
      }
      throw err;
    }
  }
  // Fallback: should never reach here in practice
  throw new GSDError(GSD_IO_ERROR, `Failed to find available activity log sequence in ${activityDir}`);
}

export function saveActivityLog(
  ctx: ExtensionContext,
  basePath: string,
  unitType: string,
  unitId: string,
): string | null {
  try {
    const entries = ctx.sessionManager.getEntries();
    if (!entries || entries.length === 0) return null;

    const activityDir = join(gsdRoot(basePath), "activity");
    mkdirSync(activityDir, { recursive: true });

    const safeUnitId = unitId.replace(/\//g, "-");
    const state = getActivityState(activityDir);
    const unitKey = `${unitType}\0${safeUnitId}`;
    // Use lightweight fingerprint instead of serializing all entries (#611)
    const key = snapshotKey(unitType, safeUnitId, entries);
    if (state.lastSnapshotKeyByUnit.get(unitKey) === key) return null;

    const filePath = nextActivityFilePath(activityDir, state, unitType, safeUnitId);
    // Stream entries to disk line-by-line instead of building one massive string (#611).
    // For large sessions, the single-string approach allocated hundreds of MB.
    const fd = openSync(filePath, "w");
    try {
      for (const entry of entries) {
        writeSync(fd, JSON.stringify(entry) + "\n");
      }
    } finally {
      closeSync(fd);
    }
    state.nextSeq += 1;
    state.lastSnapshotKeyByUnit.set(unitKey, key);

    if (isUnifiedAuditEnabled()) {
      emitUokAuditEvent(
        basePath,
        buildAuditEnvelope({
          traceId: `activity:${unitType}:${unitId}`,
          turnId: unitId,
          category: "execution",
          type: "activity-log-saved",
          payload: {
            unitType,
            unitId,
            filePath,
            entryCount: entries.length,
          },
        }),
      );
    }

    return filePath;
  } catch (e) {
    // Don't let logging failures break auto-mode
    void e;
    return null;
  }
}

export function pruneActivityLogs(activityDir: string, retentionDays: number): void {
  try {
    const files = readdirSync(activityDir);
    const entries: { seq: number; filePath: string }[] = [];
    for (const f of files) {
      const match = f.match(SEQ_PREFIX_RE);
      if (match) entries.push({ seq: parseInt(match[1], 10), filePath: join(activityDir, f) });
    }
    if (entries.length === 0) return;
    const maxSeq = Math.max(...entries.map(e => e.seq));
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const entry of entries) {
      if (entry.seq === maxSeq) continue;  // always preserve highest-seq
      if (retentionDays === 0) { try { unlinkSync(entry.filePath); } catch { /* skip */ } continue; }
      try {
        const mtime = statSync(entry.filePath).mtimeMs;
        if (Math.floor(mtime) <= cutoff) unlinkSync(entry.filePath);
      } catch { /* file vanished or stat failed — skip */ }
    }
  } catch { /* empty dir or readdirSync failure — skip */ }
}
