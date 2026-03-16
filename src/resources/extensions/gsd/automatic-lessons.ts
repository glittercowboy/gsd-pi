/**
 * GSD Extension — Automatic Lesson Extraction
 *
 * Extracts actionable lessons from completed units based on:
 * - Task duration vs estimates
 * - Retry patterns
 * - Token overrun patterns
 * - Decision revisions
 *
 * Lessons are automatically appended to KNOWLEDGE.md to improve
 * future task planning and execution.
 */

import type { UnitMetrics } from "./metrics.js";
import { getLedger } from "./metrics.js";
import { appendKnowledge } from "./files.js";
import { gsdRoot } from "./paths.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────

export interface LessonTrigger {
  type: "time_overrun" | "retry" | "token_overrun" | "decision_revised";
  severity: "low" | "medium" | "high";
  details: string;
}

export interface ExtractedLesson {
  trigger: LessonTrigger;
  lesson: string;
  scope: string;
}

// ─── Thresholds ───────────────────────────────────────────────────────────

const TIME_OVERRUN_THRESHOLD = 2.0;    // 2x estimated time
const RETRY_THRESHOLD = 2;              // 2+ retries
const TOKEN_OVERRUN_THRESHOLD = 1.5;   // 1.5x expected tokens

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Check if a completed unit should trigger lesson extraction.
 */
export function shouldExtractLesson(
  unitType: string,
  unitId: string,
  metrics: UnitMetrics | null,
  retryCount: number,
  basePath: string,
): LessonTrigger | null {
  // Only extract lessons from execute-task units
  if (unitType !== "execute-task") return null;

  // Check for retries
  if (retryCount >= RETRY_THRESHOLD) {
    return {
      type: "retry",
      severity: retryCount >= 3 ? "high" : "medium",
      details: `Task ${unitId} required ${retryCount} retries`,
    };
  }

  // Check metrics-based triggers
  if (metrics) {
    // Time overrun: if task took significantly longer than expected
    // We infer this from token usage as a proxy
    const tokenOverrun = metrics.tokens.total > 50000; // High token count
    if (tokenOverrun) {
      return {
        type: "token_overrun",
        severity: metrics.tokens.total > 100000 ? "high" : "medium",
        details: `Task ${unitId} used ${Math.round(metrics.tokens.total / 1000)}K tokens`,
      };
    }
  }

  // Check for decision revisions in DECISIONS.md
  const decisionsPath = join(gsdRoot(basePath), "DECISIONS.md");
  if (existsSync(decisionsPath)) {
    const content = readFileSync(decisionsPath, "utf-8");
    // Look for revised decisions (contains "revised" or "superseded")
    const revisedMatch = content.match(/\|\s*D(\d+)\s*\|[^|]*\|[^|]*revised/gi);
    if (revisedMatch && revisedMatch.length > 0) {
      return {
        type: "decision_revised",
        severity: "medium",
        details: `${revisedMatch.length} decision(s) were revised during this milestone`,
      };
    }
  }

  return null;
}

/**
 * Extract a human-readable lesson from a trigger.
 */
export function extractLesson(
  trigger: LessonTrigger,
  unitId: string,
  taskTags: string[] = [],
): ExtractedLesson {
  let lesson: string;
  const scope = unitId.split("/").slice(0, 2).join("/"); // M001/S01

  switch (trigger.type) {
    case "retry":
      if (taskTags.includes("api") || taskTags.includes("integration")) {
        lesson = `External API/integration tasks may need retry handling. Consider adding 50% buffer time and implementing circuit breakers.`;
      } else if (taskTags.includes("test")) {
        lesson = `Test tasks with external dependencies often need retries. Consider using mocks or dedicated test fixtures.`;
      } else {
        lesson = `Complex tasks may require multiple attempts. Break into smaller subtasks or add pre-validation steps.`;
      }
      break;

    case "token_overrun":
      if (taskTags.includes("refactor")) {
        lesson = `Large refactor tasks exceed context limits. Split into file-by-file changes with incremental commits.`;
      } else if (taskTags.includes("docs")) {
        lesson = `Documentation tasks with extensive code references can be token-heavy. Generate docs incrementally by section.`;
      } else {
        lesson = `High-token tasks may indicate scope creep. Consider splitting into multiple focused tasks.`;
      }
      break;

    case "decision_revised":
      lesson = `Decisions were revised during execution. For future milestones, consider more thorough research phase before committing to architecture decisions.`;
      break;

    case "time_overrun":
      lesson = `Task took longer than expected. Review similar tasks in planning to add buffer time for comparable complexity.`;
      break;

    default:
      lesson = `Task ${unitId} encountered issues. Review execution logs for patterns.`;
  }

  return { trigger, lesson, scope };
}

/**
 * Automatically extract and save a lesson from a completed unit.
 * Returns the extracted lesson, or null if no lesson was warranted.
 */
export async function extractAndSaveLesson(
  unitType: string,
  unitId: string,
  basePath: string,
  retryCount: number,
  taskTags: string[] = [],
): Promise<ExtractedLesson | null> {
  // Get metrics for this unit
  const ledger = getLedger(basePath);
  const unitMetrics = ledger?.units.find(
    u => u.type === unitType && u.id === unitId
  ) ?? null;

  // Check if we should extract a lesson
  const trigger = shouldExtractLesson(unitType, unitId, unitMetrics, retryCount, basePath);
  if (!trigger) return null;

  // Extract the lesson
  const extracted = extractLesson(trigger, unitId, taskTags);

  // Only save high and medium severity lessons
  if (extracted.trigger.severity === "high" || extracted.trigger.severity === "medium") {
    try {
      await appendKnowledge(basePath, "lesson", extracted.lesson, extracted.scope);
    } catch {
      // Non-fatal — don't let lesson extraction break completion
    }
  }

  return extracted;
}

// ─── Utility: Get retry count for a unit ───────────────────────────────────

const retryTracker = new Map<string, number>();

export function trackRetry(unitKey: string): void {
  const current = retryTracker.get(unitKey) ?? 0;
  retryTracker.set(unitKey, current + 1);
}

export function getRetryCount(unitKey: string): number {
  return retryTracker.get(unitKey) ?? 0;
}

export function clearRetryTracking(unitKey: string): void {
  retryTracker.delete(unitKey);
}