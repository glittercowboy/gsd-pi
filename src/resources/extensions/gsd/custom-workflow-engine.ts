/**
 * CustomWorkflowEngine — drives custom workflows defined by GRAPH.yaml.
 *
 * Implements WorkflowEngine by reading step state from a GRAPH.yaml file
 * in the run directory, dispatching pending steps in dependency order,
 * and marking steps complete via reconcile.
 *
 * Created in S03. Uses graph.ts for all GRAPH.yaml operations.
 */

import type { WorkflowEngine } from "./workflow-engine.js";
import type {
  EngineState,
  EngineDispatchAction,
  CompletedStep,
  ReconcileResult,
  DisplayMetadata,
} from "./engine-types.js";
import {
  readGraph,
  writeGraph,
  getNextPendingStep,
  markStepComplete,
  expandIteration,
} from "./graph.js";
import type { WorkflowGraph } from "./graph.js";
import type { WorkflowDefinition, VerifyPolicy, IterateConfig } from "./definition-loader.js";
import { injectContext } from "./context-injector.js";
import { parse } from "yaml";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── GSDState-compatible stub ────────────────────────────────────────────

/**
 * Build a GSDState-compatible stub for EngineState.raw.
 *
 * The auto-loop's dispatchNextUnit() reads fields from EngineState.raw
 * (cast to GSDState) between deriveState() and resolveDispatch().
 * This stub provides neutral values that prevent crashes:
 * - activeMilestone must be non-null (otherwise the loop stops early)
 * - phase must not be "complete" or "blocked" (those trigger early returns)
 * - arrays must be present but empty
 */
function buildGSDStateStub(graph: WorkflowGraph, definitionName?: string) {
  const completed = graph.steps.filter((s) => s.status === "complete").length;
  const total = graph.steps.length;

  return {
    activeMilestone: { id: "custom-workflow", title: "Custom Workflow" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [] as string[],
    blockers: [] as string[],
    nextAction: "",
    registry: [] as unknown[],
    // Attach graph data so resolveDispatch can access it without re-reading disk
    _graph: graph,
    // Attach definition metadata for getDisplayMetadata
    _definition: definitionName ? { name: definitionName } : undefined,
    progress: {
      milestones: { done: 0, total: 1 },
      tasks: { done: completed, total },
    },
  };
}

// ─── CustomWorkflowEngine ────────────────────────────────────────────────

export class CustomWorkflowEngine implements WorkflowEngine {
  readonly engineId = "custom" as const;
  private readonly runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  async deriveState(_basePath: string): Promise<EngineState> {
    const graph = readGraph(this.runDir);
    const completed = graph.steps.filter((s) => s.status === "complete").length;
    const nonExpanded = graph.steps.filter((s) => s.status !== "expanded");
    const total = nonExpanded.length;
    const allComplete = total > 0 && completed === total;
    const nextStep = getNextPendingStep(graph);

    // Try to read definition name from DEFINITION.yaml (present for S04+ runs)
    let definitionName: string | undefined;
    const defPath = join(this.runDir, "DEFINITION.yaml");
    if (existsSync(defPath)) {
      try {
        const raw = readFileSync(defPath, "utf-8");
        const parsed = parse(raw) as { name?: string };
        if (typeof parsed?.name === "string") {
          definitionName = parsed.name;
        }
      } catch {
        // Fall through — use undefined (getDisplayMetadata will use fallback)
      }
    }

    return {
      phase: allComplete ? "complete" : "executing",
      currentMilestoneId: "custom-workflow",
      activeSliceId: nextStep?.id ?? null,
      activeTaskId: nextStep?.id ?? null,
      isComplete: allComplete,
      raw: buildGSDStateStub(graph, definitionName),
    };
  }

  async resolveDispatch(
    state: EngineState,
    _context: { basePath: string },
  ): Promise<EngineDispatchAction> {
    // Re-read from disk for fresh state (reconcile may have written changes)
    const graph = readGraph(this.runDir);
    const nextStep = getNextPendingStep(graph);

    if (!nextStep) {
      return {
        action: "stop",
        reason: "All steps complete",
        level: "info",
      };
    }

    // Inject context from prior step artifacts (S05 — context continuity)
    let prompt = nextStep.prompt;
    const defPath = join(this.runDir, "DEFINITION.yaml");
    if (existsSync(defPath)) {
      try {
        const raw = readFileSync(defPath, "utf-8");
        const parsed = parse(raw) as Record<string, unknown>;
        // Build a minimal WorkflowDefinition from the frozen YAML
        const yamlSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
        const definition: WorkflowDefinition = {
          version: (parsed.version as number) ?? 1,
          name: (parsed.name as string) ?? "",
          steps: yamlSteps.map((s: Record<string, unknown>) => ({
            id: s.id as string,
            name: s.name as string,
            prompt: s.prompt as string,
            requires: Array.isArray(s.requires)
              ? (s.requires as string[])
              : Array.isArray(s.depends_on)
                ? (s.depends_on as string[])
                : [],
            produces: Array.isArray(s.produces) ? (s.produces as string[]) : [],
            contextFrom: Array.isArray(s.context_from) ? (s.context_from as string[]) : undefined,
            verify: s.verify as VerifyPolicy | undefined,
            iterate: (s.iterate != null && typeof s.iterate === "object")
              ? s.iterate as IterateConfig
              : undefined,
          })),
        };

        // ── Iterate expansion (S06) ──────────────────────────────
        const stepDef = definition.steps.find((s) => s.id === nextStep.id);
        if (stepDef?.iterate && nextStep.status === "pending") {
          const iterate = stepDef.iterate;

          // Idempotency guard: skip if instances already exist
          const alreadyExpanded = graph.steps.some(
            (s) => s.parentStepId === nextStep.id,
          );

          if (!alreadyExpanded) {
            // Read source artifact
            const sourcePath = join(this.runDir, iterate.source);
            if (!existsSync(sourcePath)) {
              return {
                action: "stop",
                reason: `Iterate source artifact not found: ${iterate.source}`,
                level: "error",
              };
            }
            const content = readFileSync(sourcePath, "utf-8");

            // Apply regex with global + multiline flags
            const regex = new RegExp(iterate.pattern, "gm");
            let match: RegExpExecArray | null;
            const items: string[] = [];
            while ((match = regex.exec(content)) !== null) {
              items.push(match[1] ?? match[0]);
            }

            if (items.length === 0) {
              return {
                action: "stop",
                reason: `Iterate pattern matched no items from ${iterate.source}`,
                level: "error",
              };
            }

            // Expand and persist
            const expandedGraph = expandIteration(
              graph,
              nextStep.id,
              items,
              nextStep.prompt,
            );
            writeGraph(this.runDir, expandedGraph);
          }

          // Re-read graph and dispatch first pending instance
          const freshGraph = readGraph(this.runDir);
          const firstInstance = getNextPendingStep(freshGraph);
          if (!firstInstance) {
            return {
              action: "stop",
              reason: "All steps complete after expansion",
              level: "info",
            };
          }

          // Apply context injection for the instance
          let instancePrompt = firstInstance.prompt;
          const instanceInjected = injectContext(firstInstance.id, definition, this.runDir);
          if (instanceInjected) {
            instancePrompt = instanceInjected + instancePrompt;
          }

          return {
            action: "dispatch",
            step: {
              unitType: "custom-step",
              unitId: firstInstance.id,
              prompt: instancePrompt,
            },
          };
        }

        const injected = injectContext(nextStep.id, definition, this.runDir);
        if (injected) {
          prompt = injected + prompt;
        }
      } catch {
        // If DEFINITION.yaml is unreadable, skip context injection silently
      }
    }

    return {
      action: "dispatch",
      step: {
        unitType: "custom-step",
        unitId: nextStep.id,
        prompt,
      },
    };
  }

  async reconcile(
    _state: EngineState,
    completedStep: CompletedStep,
  ): Promise<ReconcileResult> {
    const graph = readGraph(this.runDir);
    const updatedGraph = markStepComplete(graph, completedStep.unitId);
    writeGraph(this.runDir, updatedGraph);

    const remaining = updatedGraph.steps.filter(
      (s) => s.status !== "complete" && s.status !== "expanded",
    );

    if (remaining.length === 0) {
      return { outcome: "stop", reason: "All steps complete" };
    }

    return { outcome: "continue" };
  }

  getDisplayMetadata(state: EngineState): DisplayMetadata {
    const rawState = state.raw as {
      _graph?: WorkflowGraph;
      _definition?: { name: string };
    };

    const nonExpanded = rawState._graph?.steps.filter((s) => s.status !== "expanded") ?? [];
    const total = nonExpanded.length;

    const completed = state.isComplete
      ? total
      : nonExpanded.filter((s) => s.status === "complete").length;

    return {
      engineLabel: rawState._definition?.name ?? "Custom Pipeline",
      currentPhase: state.phase,
      progressSummary: state.isComplete
        ? "All steps complete"
        : `Step ${completed + 1} of ${total}`,
      stepCount: { completed, total },
    };
  }
}
