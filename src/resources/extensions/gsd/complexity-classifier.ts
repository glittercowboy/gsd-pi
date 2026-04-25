// GSD Extension — Complexity Classifier
// Classifies unit complexity for dynamic model routing.
// Pure heuristics + adaptive learning — no LLM calls. Sub-millisecond classification.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { getAdaptiveTierAdjustment } from "./routing-history.js";
import { parseUnitId } from "./unit-id.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ComplexityTier = "light" | "standard" | "heavy";

export interface ClassificationResult {
  tier: ComplexityTier;
  reason: string;
  downgraded: boolean;   // true if budget pressure lowered the tier
  taskMetadata?: TaskMetadata;
}

export interface TaskMetadata {
  fileCount?: number;
  dependencyCount?: number;
  isNewFile?: boolean;
  tags?: string[];
  estimatedLines?: number;
  codeBlockCount?: number;      // number of fenced code blocks in plan
  complexityKeywords?: string[]; // detected complexity signals
}

// ─── Unit Type → Default Tier Mapping ────────────────────────────────────────

const UNIT_TYPE_TIERS: Record<string, ComplexityTier> = {
  // Tier 1 — Light: compact verification turns
  "run-uat": "light",

  // Tier 2 — Standard: research, routine discussion, slice completion
  // complete-slice can carry large inlined context; avoid routing it to the
  // cheapest "light" model by default (#4520).
  "complete-slice": "standard",
  "discuss-milestone": "standard",
  "discuss-slice": "standard",
  "research-milestone": "standard",
  "research-slice": "standard",

  // Tier 3 — Heavy: planning, execution, replanning (requires deep reasoning)
  // Planning is heavy so it uses the best configured model (e.g. Opus) and is
  // not downgraded by dynamic routing when a capable model is configured.
  "plan-milestone": "heavy",
  "plan-slice": "heavy",
  "execute-task": "standard",   // default standard, upgraded by metadata
  "replan-slice": "heavy",
  "reassess-roadmap": "heavy",
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify unit complexity to determine which model tier to use.
 *
 * @param unitType    The type of unit being dispatched
 * @param unitId      The unit ID (e.g. "M001/S01/T01")
 * @param basePath    Project base path (for reading task plans)
 * @param budgetPct   Current budget usage as fraction (0.0-1.0+), or undefined if no budget
 * @param metadata    Optional pre-parsed task metadata
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
    const result: ClassificationResult = { tier: "light", reason: "hook unit", downgraded: false, taskMetadata: undefined };
    return applyBudgetPressure(result, budgetPct);
  }

  // Start with the default tier for this unit type
  let tier = UNIT_TYPE_TIERS[unitType] ?? "standard";
  let reason = `unit type: ${unitType}`;
  let taskMeta: TaskMetadata | undefined;

  // For execute-task, analyze task metadata for complexity signals
  if (unitType === "execute-task") {
    // Extract metadata once and reuse throughout to avoid double-extraction
    taskMeta = metadata ?? extractTaskMetadata(unitId, basePath);
    const taskAnalysis = analyzeTaskComplexity(unitId, basePath, taskMeta);
    tier = taskAnalysis.tier;
    reason = taskAnalysis.reason;
  }

  // For plan-slice, check if the slice has many tasks (complex planning)
  if (unitType === "plan-slice" || unitType === "plan-milestone") {
    const planAnalysis = analyzePlanComplexity(unitId, basePath);
    if (planAnalysis) {
      tier = planAnalysis.tier;
      reason = planAnalysis.reason;
    }
  }

  // Adaptive learning: check if history suggests bumping the tier
  // Use already-extracted taskMeta.tags if available to avoid double-extraction
  const tags = taskMeta?.tags ?? metadata?.tags;
  const adaptiveAdjustment = getAdaptiveTierAdjustment(unitType, tier, tags);
  if (adaptiveAdjustment && tierOrdinal(adaptiveAdjustment) > tierOrdinal(tier)) {
    reason = `${reason} (adaptive: high failure rate at ${tier})`;
    tier = adaptiveAdjustment;
  }

  const result: ClassificationResult = { tier, reason, downgraded: false, taskMetadata: taskMeta };
  return applyBudgetPressure(result, budgetPct);
}

/**
 * Get a short label for the tier (for dashboard display).
 */
export function tierLabel(tier: ComplexityTier): string {
  switch (tier) {
    case "light": return "L";
    case "standard": return "S";
    case "heavy": return "H";
  }
}

/**
 * Get the tier ordering value (for comparison).
 */
export function tierOrdinal(tier: ComplexityTier): number {
  switch (tier) {
    case "light": return 0;
    case "standard": return 1;
    case "heavy": return 2;
  }
}

// ─── Task Complexity Analysis ────────────────────────────────────────────────

interface TaskAnalysis {
  tier: ComplexityTier;
  reason: string;
}

function analyzeTaskComplexity(
  unitId: string,
  basePath: string,
  metadata?: TaskMetadata,
): TaskAnalysis {
  // Try to read task plan for complexity signals
  const meta = metadata ?? extractTaskMetadata(unitId, basePath);

  // Heavy signals
  if (meta.dependencyCount && meta.dependencyCount >= 3) {
    return { tier: "heavy", reason: `${meta.dependencyCount} dependencies` };
  }
  if (meta.fileCount && meta.fileCount >= 6) {
    return { tier: "heavy", reason: `${meta.fileCount} files to modify` };
  }
  if (meta.estimatedLines && meta.estimatedLines >= 500) {
    return { tier: "heavy", reason: `~${meta.estimatedLines} lines estimated` };
  }

  // Heavy signals from complexity keywords (Phase 4)
  if (meta.complexityKeywords && meta.complexityKeywords.length >= 2) {
    return { tier: "heavy", reason: `complex: ${meta.complexityKeywords.join(", ")}` };
  }
  if (meta.codeBlockCount && meta.codeBlockCount >= 5) {
    return { tier: "heavy", reason: `${meta.codeBlockCount} code blocks in plan` };
  }

  // Standard signals from single complexity keyword
  if (meta.complexityKeywords && meta.complexityKeywords.length === 1) {
    return { tier: "standard", reason: `${meta.complexityKeywords[0]} task` };
  }

  // Light signals (simple tasks)
  if (meta.tags?.some(t => /^(docs?|readme|comment|config|typo|rename)$/i.test(t))) {
    return { tier: "light", reason: `simple task: ${meta.tags.join(", ")}` };
  }
  if (meta.fileCount !== undefined && meta.fileCount <= 1 && !meta.isNewFile) {
    return { tier: "light", reason: "single file modification" };
  }

  // Standard by default
  return { tier: "standard", reason: "standard execution task" };
}

function analyzePlanComplexity(
  unitId: string,
  basePath: string,
): TaskAnalysis | null {
  // Check if this is a milestone-level plan (more complex) vs single slice
  const { milestone: mid, slice: sid } = parseUnitId(unitId);
  if (!sid) {
    // Milestone-level planning is always heavy — requires full context and best model
    return { tier: "heavy", reason: "milestone-level planning" };
  }

  // For slice planning, try to read the context/research to gauge complexity
  // If research exists and is large, bump to heavy
  const researchPath = join(gsdRoot(basePath), mid, "slices", sid, "RESEARCH.md");
  try {
    if (existsSync(researchPath)) {
      const content = readFileSync(researchPath, "utf-8");
      const lineCount = content.split("\n").length;
      if (lineCount > 200) {
        return { tier: "heavy", reason: `complex slice: ${lineCount}-line research` };
      }
    }
  } catch {
    // Non-fatal
  }

  return null; // Use default tier
}

/**
 * Extract task metadata from the task plan file on disk.
 */
export function extractTaskMetadata(unitId: string, basePath: string): TaskMetadata {
  const meta: TaskMetadata = {};
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  if (!mid || !sid || !tid) return meta;
  const taskPlanPath = join(gsdRoot(basePath), mid, "slices", sid, "tasks", `${tid}-PLAN.md`);

  try {
    if (!existsSync(taskPlanPath)) return meta;
    const content = readFileSync(taskPlanPath, "utf-8");
    const lines = content.split("\n");

    // Count files mentioned in "Files:" or "- Files:" lines
    const fileLines = lines.filter(l => /^\s*-?\s*files?\s*:/i.test(l));
    if (fileLines.length > 0) {
      // Count comma-separated or bullet-pointed files
      const allFiles = new Set<string>();
      for (const line of fileLines) {
        const filesStr = line.replace(/^\s*-?\s*files?\s*:\s*/i, "");
        const files = filesStr.split(/[,;]/).map(f => f.trim()).filter(Boolean);
        files.forEach(f => allFiles.add(f));
      }
      meta.fileCount = allFiles.size;
    }

    // Check for "new file" or "create" keywords
    meta.isNewFile = lines.some(l => /\b(create|new file|scaffold|bootstrap)\b/i.test(l));

    // Look for tags/labels in frontmatter or content
    const tags: string[] = [];
    if (content.match(/\b(refactor|migration|architect)/i)) tags.push("refactor");
    if (content.match(/\b(test|spec|coverage)\b/i)) tags.push("test");
    if (content.match(/\b(doc|readme|comment|jsdoc)\b/i)) tags.push("docs");
    if (content.match(/\b(config|env|setting)\b/i)) tags.push("config");
    if (content.match(/\b(rename|typo|spelling)\b/i)) tags.push("rename");
    meta.tags = tags;

    // Try to extract estimated lines from content
    const estimateMatch = content.match(/~?\s*(\d+)\s*lines?\b/i);
    if (estimateMatch) {
      meta.estimatedLines = parseInt(estimateMatch[1], 10);
    }

    // Phase 4: Deeper introspection signals

    // Count fenced code blocks (```) — more code blocks = more complex implementation
    const codeBlockMatches = content.match(/^```/gm);
    meta.codeBlockCount = codeBlockMatches ? Math.floor(codeBlockMatches.length / 2) : 0;

    // Detect complexity keywords that suggest harder tasks
    const complexityKeywords: string[] = [];
    if (content.match(/\b(migration|migrate|schema change)\b/i)) complexityKeywords.push("migration");
    if (content.match(/\b(architect|design pattern|system design)\b/i)) complexityKeywords.push("architecture");
    if (content.match(/\b(security|auth|encrypt|credential|vulnerability)\b/i)) complexityKeywords.push("security");
    if (content.match(/\b(performance|optimize|cache|index)\b/i)) complexityKeywords.push("performance");
    if (content.match(/\b(concurrent|parallel|race condition|mutex|lock)\b/i)) complexityKeywords.push("concurrency");
    if (content.match(/\b(backward.?compat|breaking change|deprecat)\b/i)) complexityKeywords.push("compatibility");
    meta.complexityKeywords = complexityKeywords;
  } catch {
    // Non-fatal — metadata extraction is best-effort
  }

  return meta;
}

// ─── Budget Pressure ─────────────────────────────────────────────────────────

/**
 * Apply budget pressure to a classification result.
 * As budget usage increases, more aggressively downgrade tiers.
 *
 * - <50%:   Normal classification (no change)
 * - 50-75%: Tier 2 → Tier 1 where possible
 * - 75-90%: Only heavy tasks keep configured model
 * - >90%:   Everything except replan-slice gets cheapest model
 */
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
      // Even heavy gets downgraded to standard
      result.tier = "standard";
    }
  } else if (budgetPct >= 0.75) {
    // 75-90%: only heavy stays, everything else goes to light
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
