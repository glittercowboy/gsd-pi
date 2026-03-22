/**
 * engine-resolver.ts — Route sessions to engine/policy pairs.
 *
 * Routes `null` and `"dev"` engine IDs to the DevWorkflowEngine/DevExecutionPolicy
 * pair. Any other non-null engine ID is treated as a custom workflow engine that
 * reads its state from an `activeRunDir`. Respects `GSD_ENGINE_BYPASS=1` kill
 * switch to skip the engine layer entirely.
 */

import type { WorkflowEngine } from "./workflow-engine.js";
import type { ExecutionPolicy } from "./execution-policy.js";
import { DevWorkflowEngine } from "./dev-workflow-engine.js";
import { DevExecutionPolicy } from "./dev-execution-policy.js";
import { CustomWorkflowEngine } from "./custom-workflow-engine.js";
import { CustomExecutionPolicy } from "./custom-execution-policy.js";

/** A resolved engine + policy pair ready for the auto-loop. */
export interface ResolvedEngine {
  engine: WorkflowEngine;
  policy: ExecutionPolicy;
}

/**
 * Resolve an engine/policy pair for the given session.
 *
 * - `null` or `"dev"` → DevWorkflowEngine + DevExecutionPolicy
 * - any other non-null ID → CustomWorkflowEngine(activeRunDir) + CustomExecutionPolicy()
 *   (requires activeRunDir to be a non-empty string)
 *
 * Note: `GSD_ENGINE_BYPASS=1` is checked in autoLoop before calling this function.
 */
export function resolveEngine(
  session: { activeEngineId: string | null; activeRunDir?: string | null },
): ResolvedEngine {
  const { activeEngineId, activeRunDir } = session;

  if (activeEngineId === null || activeEngineId === "dev") {
    return {
      engine: new DevWorkflowEngine(),
      policy: new DevExecutionPolicy(),
    };
  }

  // Any non-null, non-"dev" engine ID is a custom workflow engine.
  // activeRunDir is required — the engine reads GRAPH.yaml from it.
  if (!activeRunDir || typeof activeRunDir !== "string") {
    throw new Error(
      `Custom engine "${activeEngineId}" requires activeRunDir to be a non-empty string, ` +
      `got: ${JSON.stringify(activeRunDir)}`,
    );
  }

  return {
    engine: new CustomWorkflowEngine(activeRunDir),
    policy: new CustomExecutionPolicy(activeRunDir),
  };
}
