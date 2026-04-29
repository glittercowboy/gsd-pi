import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { gsdRoot } from "../paths.js";
import { logWarning } from "../workflow-logger.js";

export interface PausedMetadataCleanupDeps {
  existsSyncFn?: (path: string) => boolean;
  unlinkSyncFn?: (path: string) => void;
  gsdRootFn?: (basePath: string) => string;
  logWarningFn?: typeof logWarning;
}

/**
 * Delete paused-session metadata only after the resume lock has been acquired.
 *
 * When lock acquisition fails, metadata must remain on disk so resume can be retried.
 */
export function cleanupPausedMetadataAfterResumeLock(
  lockAcquired: boolean,
  basePath: string,
  originalBasePath: string | null,
  pausedMetadataCleanupPath: string | null,
  deps: PausedMetadataCleanupDeps = {},
): void {
  if (!lockAcquired) return;

  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const unlinkSyncFn = deps.unlinkSyncFn ?? unlinkSync;
  const gsdRootFn = deps.gsdRootFn ?? gsdRoot;
  const logWarningFn = deps.logWarningFn ?? logWarning;

  const pausedPath = pausedMetadataCleanupPath
    ?? join(gsdRootFn(originalBasePath || basePath), "runtime", "paused-session.json");

  if (!existsSyncFn(pausedPath)) return;

  try {
    unlinkSyncFn(pausedPath);
  } catch (err) {
    logWarningFn(
      "session",
      `pause file cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      { file: "auto.ts" },
    );
  }
}
