/**
 * Milestone ID primitives — pure utilities for generating, parsing, sorting,
 * and discovering milestone identifiers.
 *
 * Consumed by 15+ modules across the GSD extension. Zero side-effects.
 */

import { randomInt } from "node:crypto";
import { readdirSync, existsSync } from "node:fs";
import { milestonesDir } from "./paths.js";
import { loadQueueOrder, sortByQueueOrder } from "./queue-order.js";
import { getErrorMessage } from "./error-utils.js";

// ─── Regex ──────────────────────────────────────────────────────────────────

/** Matches both classic `M001` and unique `M001-abc123` formats (anchored). */
export const MILESTONE_ID_RE = /^M\d{3}(?:-[a-z0-9]{6})?$/;

// ─── Parsing & Extraction ───────────────────────────────────────────────────

/** Extract the trailing sequential number from a milestone ID. Returns 0 for non-matches. */
export function extractMilestoneSeq(id: string): number {
  const m = id.match(/^M(\d{3})(?:-[a-z0-9]{6})?$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Structured parse of a milestone ID into optional suffix and sequence number. */
export function parseMilestoneId(id: string): { suffix?: string; num: number } {
  const m = id.match(/^M(\d{3})(?:-([a-z0-9]{6}))?$/);
  if (!m) return { num: 0 };
  return {
    ...(m[2] ? { suffix: m[2] } : {}),
    num: parseInt(m[1], 10),
  };
}

// ─── Sorting ────────────────────────────────────────────────────────────────

/** Comparator for sorting milestone IDs by sequential number. */
export function milestoneIdSort(a: string, b: string): number {
  return extractMilestoneSeq(a) - extractMilestoneSeq(b);
}

// ─── Generation ─────────────────────────────────────────────────────────────

/** Generate a 6-char lowercase `[a-z0-9]` suffix using crypto.randomInt(). */
export function generateMilestoneSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars[randomInt(36)];
  }
  return result;
}

/** Return the highest numeric suffix among milestone IDs (0 when the list is empty or has no numeric IDs). */
export function maxMilestoneNum(milestoneIds: string[]): number {
  return milestoneIds.reduce((max, id) => {
    const num = extractMilestoneSeq(id);
    return num > max ? num : max;
  }, 0);
}

/** Derive the next milestone ID from existing IDs using max-based approach to avoid collisions after deletions. */
export function nextMilestoneId(milestoneIds: string[], uniqueEnabled?: boolean): string {
  const seq = String(maxMilestoneNum(milestoneIds) + 1).padStart(3, "0");
  if (uniqueEnabled) {
    return `M${seq}-${generateMilestoneSuffix()}`;
  }
  return `M${seq}`;
}

// ─── Reservation ─────────────────────────────────────────────────────────────

/**
 * Module-level set of milestone IDs that have been previewed/promised to the
 * user but not yet materialised on disk. Both guided-flow (preview) and
 * gsd_generate_milestone_id (tool) share this set so the ID shown in the UI
 * matches the one the tool returns.
 */
const reservedMilestoneIds = new Set<string>();

/** Reserve an ID so that subsequent calls to `claimReservedId` / `nextMilestoneId` account for it. */
export function reserveMilestoneId(id: string): void {
  reservedMilestoneIds.add(id);
}

/**
 * If any IDs have been reserved, shift one out and return it.
 * Returns `undefined` when the reservation set is empty.
 */
export function claimReservedId(): string | undefined {
  const first = reservedMilestoneIds.values().next().value;
  if (first !== undefined) {
    reservedMilestoneIds.delete(first);
    return first;
  }
  return undefined;
}

/** Return a snapshot of all currently reserved IDs (for merging into the "existing" list). */
export function getReservedMilestoneIds(): ReadonlySet<string> {
  return reservedMilestoneIds;
}

/** Clear all reservations (useful for tests). */
export function clearReservedMilestoneIds(): void {
  reservedMilestoneIds.clear();
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** Scan the milestones directory and return IDs sorted by queue order (or numeric fallback). */
export function findMilestoneIds(basePath: string): string[] {
  const dir = milestonesDir(basePath);
  try {
    const ids = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const match = d.name.match(/^(M\d+(?:-[a-z0-9]{6})?)/);
        return match ? match[1] : null;
      })
      .filter((id): id is string => id !== null);

    // Apply custom queue order if available, else fall back to numeric sort
    const customOrder = loadQueueOrder(basePath);
    return sortByQueueOrder(ids, customOrder);
  } catch (err) {
    // Log why milestone scanning failed — silent [] here causes infinite loops (#456)
    if (existsSync(dir)) {
      console.error(`[gsd] findMilestoneIds: .gsd/milestones/ exists but readdirSync failed — ${getErrorMessage(err)}`);
    }
    return [];
  }
}
