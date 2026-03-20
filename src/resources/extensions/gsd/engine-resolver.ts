/**
 * Engine resolver — determines which WorkflowEngine + ExecutionPolicy pair
 * to use for a given session.
 *
 * For S02, only the "dev" engine exists. Custom engine routing is S03+.
 */

import type { WorkflowEngine } from "./workflow-engine.js";
import type { ExecutionPolicy } from "./execution-policy.js";
import { DevWorkflowEngine } from "./dev-workflow-engine.js";
import { DevExecutionPolicy } from "./dev-execution-policy.js";
import { CustomWorkflowEngine } from "./custom-workflow-engine.js";
import { CustomExecutionPolicy } from "./custom-execution-policy.js";

/**
 * A resolved engine/policy pair returned by resolveEngine.
 */
export interface ResolvedEngine {
  engine: WorkflowEngine;
  policy: ExecutionPolicy;
}

/**
 * Resolve the engine and policy for the given session.
 *
 * @param session — must include `activeEngineId` (null defaults to "dev")
 * @returns The engine/policy pair for the session
 * @throws Error if the engine ID is unrecognized
 */
export function resolveEngine(session: {
  activeEngineId: string | null;
}): ResolvedEngine {
  const id = session.activeEngineId ?? "dev";

  if (id === "dev") {
    return {
      engine: new DevWorkflowEngine(),
      policy: new DevExecutionPolicy(),
    };
  }

  if (id.startsWith("custom:")) {
    const runDir = id.slice("custom:".length);
    return {
      engine: new CustomWorkflowEngine(runDir),
      policy: new CustomExecutionPolicy(runDir),
    };
  }

  throw new Error(`Unknown engine: ${id}`);
}
