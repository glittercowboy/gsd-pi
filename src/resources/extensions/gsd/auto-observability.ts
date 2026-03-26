/**
 * Pre-dispatch observability checks for auto-mode units.
 * Validates plan/summary file quality and builds repair instructions
 * for the agent to fix gaps before proceeding with the unit.
 */

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import {
  validatePlanBoundary,
  validateExecuteBoundary,
  validateCompleteBoundary,
  formatValidationIssues,
} from "./observability-validator.js";
import type { ValidationIssue } from "./observability-validator.js";

export async function collectObservabilityWarnings(
  ctx: ExtensionContext,
  basePath: string,
  unitType: string,
  unitId: string,
): Promise<ValidationIssue[]> {
  // Hook units have custom artifacts — skip standard observability checks
  if (unitType.startsWith("hook/")) return [];

  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  const tid = parts[2];

  if (!mid || !sid) return [];

  let issues = [] as Awaited<ReturnType<typeof validatePlanBoundary>>;

  if (unitType === "plan-slice") {
    issues = await validatePlanBoundary(basePath, mid, sid);
  } else if (unitType === "execute-task" && tid) {
    issues = await validateExecuteBoundary(basePath, mid, sid, tid);
  } else if (unitType === "complete-slice") {
    issues = await validateCompleteBoundary(basePath, mid, sid);
  }

  if (issues.length > 0) {
    ctx.ui.notify(
      `Observability check (${unitType}) found ${issues.length} warning${issues.length === 1 ? "" : "s"}:\n${formatValidationIssues(issues)}`,
      "warning",
    );
  }

  return issues;
}

export function buildObservabilityRepairBlock(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "";
  const items = issues.map(issue => {
    const fileName = issue.file.split("/").pop() || issue.file;
    let line = `- **${fileName}**: ${issue.message}`;
    if (issue.suggestion) line += ` → ${issue.suggestion}`;
    return line;
  });
  return [
    "",
    "---",
    "",
    "## Pre-flight: Observability gaps to fix FIRST",
    "",
    "The following issues were detected in plan/summary files for this unit.",
    "**Read each flagged file, apply the fix described, then proceed with the unit.**",
    "",
    ...items,
    "",
    "---",
    "",
  ].join("\n");
}
