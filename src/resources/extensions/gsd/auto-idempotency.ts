/**
 * Idempotency checks for auto-mode unit dispatch.
 *
 * Handles completed-key membership, artifact cross-validation,
 * consecutive skip counting, phantom skip loop detection, key eviction,
 * and fallback persistence.
 *
 * Extracted from dispatchNextUnit() in auto.ts. Pure decision logic
 * with set mutations — does NOT call dispatchNextUnit or stopAuto.
 */

import { invalidateAllCaches } from "./cache.js";
import {
  verifyExpectedArtifact,
  persistCompletedKey,
  removePersistedKey,
} from "./auto-recovery.js";
import { resolveMilestoneFile } from "./paths.js";
import { MAX_CONSECUTIVE_SKIPS, MAX_LIFETIME_DISPATCHES } from "./auto/session.js";
import type { AutoSession } from "./auto/session.js";

export interface IdempotencyContext {
  s: AutoSession;
  unitType: string;
  unitId: string;
  basePath: string;
  /** Notification callback */
  notify: (message: string, level: "info" | "warning" | "error") => void;
}

export type IdempotencyResult =
  | { action: "skip"; reason: string }
  | { action: "rerun"; reason: string }
  | { action: "proceed" }
  | { action: "stop"; reason: string };

/**
 * Check whether a unit should be skipped (already completed), rerun
 * (stale completion record), or dispatched normally.
 *
 * Mutates s.completedKeySet, s.unitConsecutiveSkips, s.unitLifetimeDispatches,
 * and s.recentlyEvictedKeys as needed.
 */
export function checkIdempotency(ictx: IdempotencyContext): IdempotencyResult {
  const { s, unitType, unitId, basePath, notify } = ictx;
  const idempotencyKey = `${unitType}/${unitId}`;

  // ── Primary path: key exists in completed set ──
  if (s.completedKeySet.has(idempotencyKey)) {
    const artifactExists = verifyExpectedArtifact(unitType, unitId, basePath);
    if (artifactExists) {
      // Guard against infinite skip loops
      const skipCount = (s.unitConsecutiveSkips.get(idempotencyKey) ?? 0) + 1;
      s.unitConsecutiveSkips.set(idempotencyKey, skipCount);
      if (skipCount > MAX_CONSECUTIVE_SKIPS) {
        // Cross-check: verify the unit's milestone is still active (#790)
        const skippedMid = unitId.split("/")[0];
        const skippedMilestoneComplete = skippedMid
          ? !!resolveMilestoneFile(basePath, skippedMid, "SUMMARY")
          : false;
        if (skippedMilestoneComplete) {
          s.unitConsecutiveSkips.delete(idempotencyKey);
          invalidateAllCaches();
          notify(
            `Phantom skip loop cleared: ${unitType} ${unitId} belongs to completed milestone ${skippedMid}. Re-dispatching from fresh state.`,
            "info",
          );
          return { action: "skip", reason: "phantom-loop-cleared" };
        }
        s.unitConsecutiveSkips.delete(idempotencyKey);
        s.completedKeySet.delete(idempotencyKey);
        s.recentlyEvictedKeys.add(idempotencyKey);
        removePersistedKey(basePath, idempotencyKey);
        invalidateAllCaches();
        notify(
          `Skip loop detected: ${unitType} ${unitId} skipped ${skipCount} times without advancing. Evicting completion record and forcing reconciliation.`,
          "warning",
        );
        return { action: "skip", reason: "evicted" };
      }
      // Count toward lifetime cap
      const lifeSkip = (s.unitLifetimeDispatches.get(idempotencyKey) ?? 0) + 1;
      s.unitLifetimeDispatches.set(idempotencyKey, lifeSkip);
      if (lifeSkip > MAX_LIFETIME_DISPATCHES) {
        return { action: "stop", reason: `Hard loop: ${unitType} ${unitId} (skip cycle)` };
      }
      notify(
        `Skipping ${unitType} ${unitId} — already completed in a prior session. Advancing.`,
        "info",
      );
      return { action: "skip", reason: "completed" };
    } else {
      // Stale completion record — artifact missing. Remove and re-run.
      s.completedKeySet.delete(idempotencyKey);
      removePersistedKey(basePath, idempotencyKey);
      notify(
        `Re-running ${unitType} ${unitId} — marked complete but expected artifact missing.`,
        "warning",
      );
      return { action: "rerun", reason: "stale-key" };
    }
  }

  // ── Fallback: key missing but artifact exists ──
  if (verifyExpectedArtifact(unitType, unitId, basePath) && !s.recentlyEvictedKeys.has(idempotencyKey)) {
    persistCompletedKey(basePath, idempotencyKey);
    s.completedKeySet.add(idempotencyKey);
    invalidateAllCaches();
    // Same consecutive-skip guard as the primary path
    const skipCount2 = (s.unitConsecutiveSkips.get(idempotencyKey) ?? 0) + 1;
    s.unitConsecutiveSkips.set(idempotencyKey, skipCount2);
    if (skipCount2 > MAX_CONSECUTIVE_SKIPS) {
      const skippedMid2 = unitId.split("/")[0];
      const skippedMilestoneComplete2 = skippedMid2
        ? !!resolveMilestoneFile(basePath, skippedMid2, "SUMMARY")
        : false;
      if (skippedMilestoneComplete2) {
        s.unitConsecutiveSkips.delete(idempotencyKey);
        invalidateAllCaches();
        notify(
          `Phantom skip loop cleared: ${unitType} ${unitId} belongs to completed milestone ${skippedMid2}. Re-dispatching from fresh state.`,
          "info",
        );
        return { action: "skip", reason: "phantom-loop-cleared" };
      }
      s.unitConsecutiveSkips.delete(idempotencyKey);
      s.completedKeySet.delete(idempotencyKey);
      removePersistedKey(basePath, idempotencyKey);
      invalidateAllCaches();
      notify(
        `Skip loop detected: ${unitType} ${unitId} skipped ${skipCount2} times without advancing. Evicting completion record and forcing reconciliation.`,
        "warning",
      );
      return { action: "skip", reason: "evicted" };
    }
    // Count toward lifetime cap
    const lifeSkip2 = (s.unitLifetimeDispatches.get(idempotencyKey) ?? 0) + 1;
    s.unitLifetimeDispatches.set(idempotencyKey, lifeSkip2);
    if (lifeSkip2 > MAX_LIFETIME_DISPATCHES) {
      return { action: "stop", reason: `Hard loop: ${unitType} ${unitId} (skip cycle)` };
    }
    notify(
      `Skipping ${unitType} ${unitId} — artifact exists but completion key was missing. Repaired and advancing.`,
      "info",
    );
    return { action: "skip", reason: "fallback-persisted" };
  }

  return { action: "proceed" };
}
