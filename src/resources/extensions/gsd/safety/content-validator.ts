/**
 * Lightweight content validator for auto-mode safety harness.
 * Validates that high-value unit outputs contain minimum expected content.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { existsSync, readFileSync } from "node:fs";
import { logWarning } from "../workflow-logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContentViolation {
  severity: "warning";
  reason: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate content quality for a completed unit.
 * Returns an array of violations. Empty array = content looks acceptable.
 *
 * @param unitType - The type of unit that completed (e.g. "plan-slice")
 * @param artifactPath - Absolute path to the primary artifact file
 */
export function validateContent(
  unitType: string,
  artifactPath: string | null,
): ContentViolation[] {
  if (!artifactPath || !existsSync(artifactPath)) return [];

  const validator = VALIDATORS[unitType];
  if (!validator) return [];

  try {
    const content = readFileSync(artifactPath, "utf-8");
    return validator(content);
  } catch (e) {
    logWarning("safety", `content validation read failed: ${(e as Error).message}`);
    return [];
  }
}

// ─── Validators ─────────────────────────────────────────────────────────────

type ContentValidatorFn = (content: string) => ContentViolation[];

const VALIDATORS: Record<string, ContentValidatorFn> = {
  "plan-slice": validatePlanSlice,
  "plan-milestone": validatePlanMilestone,
};

function validatePlanSlice(content: string): ContentViolation[] {
  const violations: ContentViolation[] = [];

  // Must have at least 1 task entry — single-task slices are valid (#3649)
  const taskCount = (content.match(/- \[[ x]\] \*\*T\d+/g) || []).length;
  if (taskCount < 1) {
    violations.push({
      severity: "warning",
      reason: `Slice plan has ${taskCount} task(s) — expected at least 1`,
    });
  }

  // Should have a Files Likely Touched section
  if (!content.includes("## Files Likely Touched") && !content.includes("## Files")) {
    violations.push({
      severity: "warning",
      reason: "Slice plan missing 'Files Likely Touched' section",
    });
  }

  // Should have a verification section
  if (!content.includes("Verify") && !content.includes("verify")) {
    violations.push({
      severity: "warning",
      reason: "Slice plan has no verification instructions",
    });
  }

  return violations;
}

function validatePlanMilestone(content: string): ContentViolation[] {
  const violations: ContentViolation[] = [];

  // Must have at least 1 slice entry
  const sliceCount = (content.match(/##\s+S\d+/g) || []).length;
  if (sliceCount < 1) {
    violations.push({
      severity: "warning",
      reason: `Milestone roadmap has ${sliceCount} slice(s) — expected at least 1`,
    });
  }

  return violations;
}
