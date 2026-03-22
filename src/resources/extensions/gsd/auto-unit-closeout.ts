/**
 * Unit closeout helper — consolidates the repeated pattern of
 * snapshotting metrics + saving activity log + extracting memories
 * that appears 6+ times in auto.ts.
 */

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { snapshotUnitMetrics } from "./metrics.js";
import { saveActivityLog } from "./activity-log.js";
import { debugLog } from "./debug-logger.js";

export interface CloseoutOptions {
  promptCharCount?: number;
  baselineCharCount?: number;
  tier?: string;
  modelDowngraded?: boolean;
  continueHereFired?: boolean;
}

// ─── Memory Extraction FIFO Queue ───────────────────────────────────────────
// Keeps at most 3 pending extractions so concurrent calls are queued rather
// than silently dropped by the mutex guard in memory-extractor.ts (#M8).

interface MemoryExtractionJob {
  activityFile: string;
  unitType: string;
  unitId: string;
  llmCallFn: import('./memory-extractor.js').LLMCallFn;
}

const _memoryQueue: MemoryExtractionJob[] = [];
const MAX_MEMORY_QUEUE = 3;
let _memoryQueueRunning = false;

async function _drainMemoryQueue(): Promise<void> {
  if (_memoryQueueRunning) return;
  _memoryQueueRunning = true;
  try {
    while (_memoryQueue.length > 0) {
      const job = _memoryQueue.shift()!;
      try {
        const { extractMemoriesFromUnit } = await import('./memory-extractor.js');
        await extractMemoriesFromUnit(job.activityFile, job.unitType, job.unitId, job.llmCallFn);
      } catch (err) {
        debugLog("closeoutUnit", {
          phase: "memory-extraction",
          unitType: job.unitType,
          unitId: job.unitId,
          error: String(err),
        });
      }
    }
  } finally {
    _memoryQueueRunning = false;
  }
}

/**
 * Snapshot metrics, save activity log, and fire-and-forget memory extraction
 * for a completed unit. Returns the activity log file path (if any).
 */
export async function closeoutUnit(
  ctx: ExtensionContext,
  basePath: string,
  unitType: string,
  unitId: string,
  startedAt: number,
  opts?: CloseoutOptions,
): Promise<string | undefined> {
  const modelId = ctx.model?.id ?? "unknown";
  snapshotUnitMetrics(ctx, unitType, unitId, startedAt, modelId, opts);
  const activityFile = saveActivityLog(ctx, basePath, unitType, unitId);

  if (activityFile) {
    try {
      const { buildMemoryLLMCall } = await import('./memory-extractor.js');
      const llmCallFn = buildMemoryLLMCall(ctx);
      if (llmCallFn) {
        if (_memoryQueue.length < MAX_MEMORY_QUEUE) {
          _memoryQueue.push({ activityFile, unitType, unitId, llmCallFn });
          // Drain asynchronously — never awaited, never throws to caller
          _drainMemoryQueue().catch((err) => {
            debugLog("closeoutUnit", {
              phase: "memory-queue-drain",
              unitType,
              unitId,
              error: String(err),
            });
          });
        } else {
          debugLog("closeoutUnit", {
            phase: "memory-extraction",
            unitType,
            unitId,
            warning: "memory extraction queue full — job dropped",
          });
        }
      }
    } catch (err) {
      debugLog("closeoutUnit", {
        phase: "memory-extraction-setup",
        unitType,
        unitId,
        error: String(err),
      });
    }
  }

  return activityFile ?? undefined;
}
