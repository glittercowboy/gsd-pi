/**
 * GSD Task Complexity Classification
 *
 * Classifies task plans and unit types by complexity to enable model routing.
 * Pure heuristics + adaptive learning — no LLM calls, sub-millisecond.
 *
 * Combined approach:
 * - Task plan analysis (step count, file count, description length, signal words)
 * - Unit type defaults (complete-slice → light, replan → heavy, etc.)
 * - Budget pressure thresholds (50/75/90% graduated downgrade)
 * - Adaptive learning via routing-history (optional)
 *
 * Classification output uses our TokenProfile-aligned TaskComplexity type
 * for the simple classifier, and ComplexityTier for the full unit classifier.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComplexityTier, ClassificationResult, TaskMetadata } from "./types.js";

// Re-export for convenience
export type { ComplexityTier, ClassificationResult, TaskMetadata };

// ─── Simple Task Complexity (for task plan analysis) ──────────────────────

export type TaskComplexity = "simple" | "standard" | "complex";

/** Words that signal non-trivial work requiring full reasoning capacity */
const COMPLEXITY_SIGNALS = [
  "research", "investigate", "refactor", "migrate", "integrate",
  "complex", "architect", "redesign", "security", "performance",
  "concurrent", "parallel", "distributed", "backward.?compat",
  "migration", "architecture", "concurrency", "compatibility",
];
const COMPLEXITY_PATTERN = new RegExp(COMPLEXITY_SIGNALS.join("|"), "i");

/**
 * Classify a task plan by its structural complexity.
 * Used by dispatch to select execution_simple vs execution model.
 */
export function classifyTaskComplexity(planContent: string): TaskComplexity {
  if (!planContent || planContent.trim().length === 0) return "standard";

  const stepsMatch = planContent.match(/##\s*Steps\s*\n([\s\S]*?)(?=\n##|\n---|$)/i);
  const stepsSection = stepsMatch?.[1] ?? "";
  const stepCount = (stepsSection.match(/^\s*\d+\.\s/gm) ?? []).length;

  if (!stepsMatch) return "standard";

  const stepsIdx = planContent.search(/##\s*Steps/i);
  const descriptionLength = stepsIdx > 0 ? planContent.slice(0, stepsIdx).length : planContent.length;

  const filePatterns = planContent.match(/`[a-zA-Z0-9_/.-]+\.[a-z]{1,4}`/g) ?? [];
  const uniqueFiles = new Set(filePatterns.map(f => f.replace(/`/g, "")));
  const fileCount = uniqueFiles.size;

  const hasComplexitySignals = COMPLEXITY_PATTERN.test(planContent);

  // Count fenced code blocks (from #579 Phase 4)
  const codeBlockCount = (planContent.match(/^```/gm) ?? []).length / 2;

  if (stepCount >= 8 || fileCount >= 8 || descriptionLength > 2000 || codeBlockCount >= 5) {
    return "complex";
  }

  if (stepCount <= 3 && descriptionLength < 500 && fileCount <= 3 && !hasComplexitySignals) {
    return "simple";
  }

  return "standard";
}

// ─── Unit Type → Default Tier Mapping (from #579) ─────────────────────────

const UNIT_TYPE_TIERS: Record<string, ComplexityTier> = {
  // Light: structured summaries, completion, UAT
  "complete-slice": "light",
  "run-uat": "light",

  // Standard: research, routine planning
  "research-milestone": "standard",
  "research-slice": "standard",
  "plan-milestone": "standard",
  "plan-slice": "standard",

  // Heavy: execution default (upgraded by metadata), replanning
  "execute-task": "standard",
  "replan-slice": "heavy",
  "reassess-roadmap": "heavy",
  "complete-milestone": "standard",
};

/**
 * Classify unit complexity for model routing.
 * Uses unit type defaults, task metadata analysis, and budget pressure.
 *
 * @param unitType  The type of unit being dispatched
 * @param unitId    The unit ID (e.g. "M001/S01/T01")
 * @param basePath  Project base path (for reading task plans)
 * @param budgetPct Current budget usage as fraction (0.0-1.0+), or undefined
 * @param metadata  Optional pre-parsed task metadata
 */
export function classifyUnitComplexity(
  unitType: string,
  unitId: string,
  basePath: string,
  budgetPct?: number,
  metadata?: TaskMetadata,
): ClassificationResult {
  // Hook units default to light
  if (unitType.startsWith("hook/")) {
    return applyBudgetPressure({ tier: "light", reason: "hook unit", downgraded: false }, budgetPct);
  }

  // Triage/capture units default to light
  if (unitType === "triage-captures" || unitType.startsWith("quick-task")) {
    return applyBudgetPressure({ tier: "light", reason: `${unitType} unit`, downgraded: false }, budgetPct);
  }

  let tier = UNIT_TYPE_TIERS[unitType] ?? "standard";
  let reason = `unit type: ${unitType}`;

  // For execute-task, analyze task metadata for complexity signals
  if (unitType === "execute-task") {
    const analysis = analyzeTaskFromPlan(unitId, basePath, metadata);
    if (analysis) {
      tier = analysis.tier;
      reason = analysis.reason;
    }
  }

  return applyBudgetPressure({ tier, reason, downgraded: false }, budgetPct);
}

// ─── Tier Helpers ─────────────────────────────────────────────────────────

export function tierLabel(tier: ComplexityTier): string {
  switch (tier) {
    case "light": return "L";
    case "standard": return "S";
    case "heavy": return "H";
  }
}

export function tierOrdinal(tier: ComplexityTier): number {
  switch (tier) {
    case "light": return 0;
    case "standard": return 1;
    case "heavy": return 2;
  }
}

export function escalateTier(currentTier: ComplexityTier): ComplexityTier | null {
  switch (currentTier) {
    case "light": return "standard";
    case "standard": return "heavy";
    case "heavy": return null;
  }
}

// ─── Budget Pressure (from #579 — graduated thresholds) ───────────────────

function applyBudgetPressure(
  result: ClassificationResult,
  budgetPct?: number,
): ClassificationResult {
  if (budgetPct === undefined || budgetPct < 0.5) return result;

  const original = result.tier;

  if (budgetPct >= 0.9) {
    // >90%: almost everything goes to light
    if (result.tier !== "heavy") {
      result.tier = "light";
    } else {
      result.tier = "standard";
    }
  } else if (budgetPct >= 0.75) {
    // 75-90%: only heavy stays, standard → light
    if (result.tier === "standard") {
      result.tier = "light";
    }
  } else {
    // 50-75%: standard → light
    if (result.tier === "standard") {
      result.tier = "light";
    }
  }

  if (result.tier !== original) {
    result.downgraded = true;
    result.reason = `${result.reason} (budget pressure: ${Math.round(budgetPct * 100)}%)`;
  }

  return result;
}

// ─── Task Plan Analysis ───────────────────────────────────────────────────

interface TaskAnalysis {
  tier: ComplexityTier;
  reason: string;
}

function analyzeTaskFromPlan(
  unitId: string,
  basePath: string,
  metadata?: TaskMetadata,
): TaskAnalysis | null {
  // Try to read the task plan for analysis
  const parts = unitId.split("/");
  if (parts.length < 3) return null;

  const [mid, sid, tid] = parts;
  const planPath = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks", `${tid}-PLAN.md`);

  let planContent = "";
  try {
    if (existsSync(planPath)) {
      planContent = readFileSync(planPath, "utf-8");
    }
  } catch {
    return null;
  }

  if (!planContent) return null;

  const taskComplexity = classifyTaskComplexity(planContent);

  // Map TaskComplexity to ComplexityTier
  switch (taskComplexity) {
    case "simple": return { tier: "light", reason: "task plan: simple (few steps, small scope)" };
    case "complex": return { tier: "heavy", reason: "task plan: complex (many steps/files or signal words)" };
    default: return { tier: "standard", reason: "task plan: standard complexity" };
  }
}
