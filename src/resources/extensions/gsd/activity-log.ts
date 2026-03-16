/**
 * GSD Activity Log — Save raw chat sessions to .gsd/activity/
 *
 * Before each context wipe in auto-mode, dumps the full session
 * as JSONL. No formatting, no truncation, no information loss.
 * These are debug artifacts — only read when summaries aren't enough.
 *
 * Diagnostic extraction is handled by session-forensics.ts.
 */

import { writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, openSync, closeSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const SEQ_PREFIX_RE = /^(\d+)-/;
import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { gsdRoot } from "./paths.js";

interface ActivityLogState {
  nextSeq: number;
  lastSnapshotKeyByUnit: Map<string, string>;
}

const activityLogState = new Map<string, ActivityLogState>();

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

function snapshotKey(unitType: string, unitId: string, content: string): string {
  const digest = createHash("sha1").update(content).digest("hex");
  return `${unitType}\0${unitId}\0${digest}`;
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
  throw new Error(`Failed to find available activity log sequence in ${activityDir}`);
}

export function saveActivityLog(
  ctx: ExtensionContext,
  basePath: string,
  unitType: string,
  unitId: string,
): void {
  try {
    const entries = ctx.sessionManager.getEntries();
    if (!entries || entries.length === 0) return;

    const activityDir = join(gsdRoot(basePath), "activity");
    mkdirSync(activityDir, { recursive: true });

    const safeUnitId = unitId.replace(/\//g, "-");
    const content = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
    const state = getActivityState(activityDir);
    const unitKey = `${unitType}\0${safeUnitId}`;
    const key = snapshotKey(unitType, safeUnitId, content);
    if (state.lastSnapshotKeyByUnit.get(unitKey) === key) return;

    const filePath = nextActivityFilePath(activityDir, state, unitType, safeUnitId);
    writeFileSync(filePath, content, "utf-8");
    state.nextSeq += 1;
    state.lastSnapshotKeyByUnit.set(unitKey, key);
  } catch (e) {
    // Don't let logging failures break auto-mode
    void e;
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
      try {
        const mtime = statSync(entry.filePath).mtimeMs;
        if (Math.floor(mtime) <= cutoff) unlinkSync(entry.filePath);
      } catch { /* file vanished or stat failed — skip */ }
    }
  } catch { /* empty dir or readdirSync failure — skip */ }
}
