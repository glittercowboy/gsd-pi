/**
 * Unit closeout helper — consolidates the repeated pattern of
 * snapshotting metrics + saving activity log + extracting memories
 * that appears 6+ times in auto.ts.
 */

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { snapshotUnitMetrics } from "./metrics.js";
import { saveActivityLog } from "./activity-log.js";
import { logWarning } from "./workflow-logger.js";

export interface CloseoutOptions {
  promptCharCount?: number;
  baselineCharCount?: number;
  tier?: string;
  modelDowngraded?: boolean;
  continueHereFired?: boolean;
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
      const { buildMemoryLLMCall, extractMemoriesFromUnit } = await import('./memory-extractor.js');
      const llmCallFn = buildMemoryLLMCall(ctx);
      if (llmCallFn) {
        extractMemoriesFromUnit(activityFile, unitType, unitId, llmCallFn).catch((err) => {
          logWarning("engine", `memory extraction failed for ${unitType}/${unitId}: ${(err as Error).message}`);
        });
      }
    } catch (err) { /* non-fatal */
      logWarning("engine", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return activityFile ?? undefined;
}

