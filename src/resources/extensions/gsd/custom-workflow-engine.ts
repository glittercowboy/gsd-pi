/**
 * custom-workflow-engine.ts — WorkflowEngine implementation for custom workflows.
 *
 * Drives the auto-loop using GRAPH.yaml step state from a run directory.
 * Each iteration: deriveState reads the graph, resolveDispatch picks the
 * next eligible step, reconcile marks it complete and persists.
 *
 * Observability:
 * - All state reads/writes go through graph.ts YAML I/O — inspectable on disk.
 * - `resolveDispatch` returns unitType "custom-step" with unitId "<name>/<stepId>".
 * - `getDisplayMetadata` provides step N/M progress for dashboard rendering.
 * - Phase transitions are derivable from GRAPH.yaml step statuses.
 */

import type { WorkflowEngine } from "./workflow-engine.js";
import type {
  EngineState,
  EngineDispatchAction,
  CompletedStep,
  ReconcileResult,
  DisplayMetadata,
} from "./engine-types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readGraph,
  writeGraph,
  getNextPendingStep,
  markStepActive,
  markStepComplete,
  expandIteration,
  type WorkflowGraph,
} from "./graph.js";
import { injectContext } from "./context-injector.js";
import type { StepDefinition } from "./definition-loader.js";
import { readFrozenDefinition } from "./definition-io.js";
import { parseUnitId } from "./unit-id.js";
import { withFileLock } from "./file-lock.js";

// Re-export for downstream consumers
export { readFrozenDefinition } from "./definition-io.js";

export class CustomWorkflowEngine implements WorkflowEngine {
  readonly engineId = "custom";
  private readonly runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  /**
   * Derive engine state from GRAPH.yaml on disk.
   *
   * Phase is "complete" when all steps are complete or expanded,
   * "running" otherwise (any pending or active steps remain).
   */
  async deriveState(_basePath: string): Promise<EngineState> {
    const graph = readGraph(this.runDir);
    const allDone = graph.steps.every(
      (s) => s.status === "complete" || s.status === "expanded",
    );
    const phase = allDone ? "complete" : "running";

    return {
      phase,
      currentMilestoneId: null,
      activeSliceId: null,
      activeTaskId: null,
      isComplete: allDone,
      raw: graph,
    };
  }

  /**
   * Resolve the next dispatch action from graph state.
   *
   * Uses getNextPendingStep to find the first step whose dependencies
   * are all satisfied. If the step has an `iterate` config in the frozen
   * DEFINITION.yaml, expands it into instance steps before dispatching.
   *
   * Returns a dispatch with unitType "custom-step" and unitId in
   * "<workflowName>/<stepId>" format.
   *
   * Observability:
   * - Iterate expansion is logged to stderr with item count and parent step ID.
   * - Missing source artifacts throw with the full resolved path for diagnosis.
   * - Zero-match expansions return a stop action with level "info".
   * - Expanded GRAPH.yaml is written to disk before dispatch — inspectable on disk.
   */
  async resolveDispatch(
    state: EngineState,
    _context: { basePath: string },
  ): Promise<EngineDispatchAction> {
    const graphPath = join(this.runDir, "GRAPH.yaml");

    return await withFileLock(graphPath, () => {
      let graph = readGraph(this.runDir);
      const active = graph.steps.find((step) => step.status === "active");
      if (active) {
        return {
          action: "dispatch" as const,
          step: {
            unitType: "custom-step",
            unitId: `${graph.metadata.name}/${active.id}`,
            prompt: injectContext(this.runDir, active.id, active.prompt),
          },
        };
      }

      let next = getNextPendingStep(graph);

      if (!next) {
        return {
          action: "stop",
          reason: "All steps complete",
          level: "info",
        };
      }

      // Check frozen DEFINITION.yaml for iterate config on this step
      const def = readFrozenDefinition(this.runDir);
      const stepDef = def.steps.find((s: StepDefinition) => s.id === next!.id);

      if (stepDef?.iterate) {
        const iterate = stepDef.iterate;

        // Read source artifact
        const sourcePath = join(this.runDir, iterate.source);
        let sourceContent: string;
        try {
          sourceContent = readFileSync(sourcePath, "utf-8");
        } catch {
          throw new Error(
            `Iterate source artifact not found: ${sourcePath} (step "${next.id}", source: "${iterate.source}")`,
          );
        }

        // Extract items via regex with global+multiline flags.
        // Guard against ReDoS: if matching takes too long on large inputs, bail.
        const regex = new RegExp(iterate.pattern, "gm");
        const items: string[] = [];
        const matchStart = Date.now();
        let match: RegExpExecArray | null;
        while ((match = regex.exec(sourceContent)) !== null) {
          if (match[1] !== undefined) items.push(match[1]);
          if (Date.now() - matchStart > 5_000) {
            throw new Error(
              `Iterate pattern "${iterate.pattern}" exceeded 5s timeout on step "${next.id}" — possible ReDoS`,
            );
          }
        }

        // Expand the graph
        const expandedGraph = expandIteration(graph, next.id, items, next.prompt);
        writeGraph(this.runDir, expandedGraph);
        graph = expandedGraph;

        // Re-query for first instance step
        next = getNextPendingStep(expandedGraph);

        if (!next) {
          return {
            action: "stop",
            reason: "Iterate expansion produced no instances",
            level: "info",
          };
        }
      }

      const activeGraph = markStepActive(graph, next.id);
      writeGraph(this.runDir, activeGraph);

      const activeStep = activeGraph.steps.find((s) => s.id === next.id);
      if (!activeStep) {
        throw new Error(`Active step not found after GRAPH.yaml update: ${next.id}`);
      }

      // Enrich prompt with context from prior step artifacts
      const enrichedPrompt = injectContext(this.runDir, activeStep.id, activeStep.prompt);

      return {
        action: "dispatch" as const,
        step: {
          unitType: "custom-step",
          unitId: `${activeGraph.metadata.name}/${activeStep.id}`,
          prompt: enrichedPrompt,
        },
      };
    });
  }

  /**
   * Reconcile state after a step completes.
   *
   * Extracts the stepId from the completedStep's unitId (last segment after `/`),
   * marks it complete in the graph, and writes the updated GRAPH.yaml to disk.
   *
   * Returns "milestone-complete" when all steps are now done, "continue" otherwise.
   */
  async reconcile(
    state: EngineState,
    completedStep: CompletedStep,
  ): Promise<ReconcileResult> {
    const graphPath = join(this.runDir, "GRAPH.yaml");

    return await withFileLock(graphPath, () => {
      // Re-read the graph from disk so we do not overwrite concurrent
      // workflow edits with a stale in-memory snapshot from deriveState().
      const graph = readGraph(this.runDir);

      // Extract stepId from "<workflowName>/<stepId>"
      const { milestone, slice, task } = parseUnitId(completedStep.unitId);
      const stepId = task ?? slice ?? milestone;

      const updatedGraph = markStepComplete(graph, stepId);
      writeGraph(this.runDir, updatedGraph);

      const allDone = updatedGraph.steps.every(
        (s) => s.status === "complete" || s.status === "expanded",
      );

      return {
        outcome: allDone ? "milestone-complete" : "continue",
      };
    });
  }

  /**
   * Return UI-facing metadata for progress display.
   *
   * Shows "Step N/M" progress where N = completed count and M = total.
   */
  getDisplayMetadata(state: EngineState): DisplayMetadata {
    const graph = state.raw as WorkflowGraph;
    const total = graph.steps.length;
    const completed = graph.steps.filter((s) => s.status === "complete").length;

    return {
      engineLabel: "WORKFLOW",
      currentPhase: state.phase,
      progressSummary: `Step ${completed}/${total}`,
      stepCount: { completed, total },
    };
  }
}
