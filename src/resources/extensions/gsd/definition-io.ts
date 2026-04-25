/**
 * definition-io.ts — Read frozen DEFINITION.yaml from a run directory.
 *
 * Extracted from custom-workflow-engine.ts to break the circular dependency
 * between context-injector.ts and custom-workflow-engine.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { WorkflowDefinition } from "./definition-loader.js";

/** Read and parse the frozen DEFINITION.yaml from a run directory. */
export function readFrozenDefinition(runDir: string): WorkflowDefinition {
  const defPath = join(runDir, "DEFINITION.yaml");
  const raw = readFileSync(defPath, "utf-8");
  return parse(raw, { schema: "core" }) as WorkflowDefinition;
}
