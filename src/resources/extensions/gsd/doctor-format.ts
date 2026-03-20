import type { DoctorIssue, DoctorIssueCode, DoctorReport, DoctorSummary } from "./doctor-types.js";

function matchesScope(unitId: string, scope?: string): boolean {
  if (!scope) return true;
  return unitId === scope || unitId.startsWith(`${scope}/`) || unitId.startsWith(`${scope}`);
}

export function summarizeDoctorIssues(issues: DoctorIssue[]): DoctorSummary {
  const errors = issues.filter(issue => issue.severity === "error").length;
  const warnings = issues.filter(issue => issue.severity === "warning").length;
  const infos = issues.filter(issue => issue.severity === "info").length;
  const fixable = issues.filter(issue => issue.fixable).length;
  const byCodeMap = new Map<DoctorIssueCode, number>();
  for (const issue of issues) {
    byCodeMap.set(issue.code, (byCodeMap.get(issue.code) ?? 0) + 1);
  }
  const byCode = [...byCodeMap.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return { total: issues.length, errors, warnings, infos, fixable, byCode };
}

export function filterDoctorIssues(issues: DoctorIssue[], options?: { scope?: string; includeWarnings?: boolean; includeHistorical?: boolean }): DoctorIssue[] {
  let filtered = issues;
  if (options?.scope) filtered = filtered.filter(issue => matchesScope(issue.unitId, options.scope));
  if (!options?.includeWarnings) filtered = filtered.filter(issue => issue.severity === "error");
  return filtered;
}

export function formatDoctorReport(
  report: DoctorReport,
  options?: { scope?: string; includeWarnings?: boolean; maxIssues?: number; title?: string },
): string {
  const scopedIssues = filterDoctorIssues(report.issues, {
    scope: options?.scope,
    includeWarnings: options?.includeWarnings ?? true,
  });
  const summary = summarizeDoctorIssues(scopedIssues);
  const maxIssues = options?.maxIssues ?? 12;
  const lines: string[] = [];
  lines.push(options?.title ?? (summary.errors > 0 ? "GSD doctor found blocking issues." : "GSD doctor report."));
  lines.push(`Scope: ${options?.scope ?? "all milestones"}`);
  lines.push(`Issues: ${summary.total} total · ${summary.errors} error(s) · ${summary.warnings} warning(s) · ${summary.fixable} fixable`);

  if (summary.byCode.length > 0) {
    lines.push("Top issue types:");
    for (const item of summary.byCode.slice(0, 5)) {
      lines.push(`- ${item.code}: ${item.count}`);
    }
  }

  if (scopedIssues.length > 0) {
    lines.push("Priority issues:");
    for (const issue of scopedIssues.slice(0, maxIssues)) {
      const prefix = issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
      lines.push(`- [${prefix}] ${issue.unitId}: ${issue.message}${issue.file ? ` (${issue.file})` : ""}`);
    }
    if (scopedIssues.length > maxIssues) {
      lines.push(`- ...and ${scopedIssues.length - maxIssues} more in scope`);
    }
  }

  if (report.fixesApplied.length > 0) {
    lines.push("Fixes applied:");
    for (const fix of report.fixesApplied.slice(0, maxIssues)) lines.push(`- ${fix}`);
    if (report.fixesApplied.length > maxIssues) lines.push(`- ...and ${report.fixesApplied.length - maxIssues} more`);
  }

  return lines.join("\n");
}

export function formatDoctorIssuesForPrompt(issues: DoctorIssue[]): string {
  if (issues.length === 0) return "- No remaining issues in scope.";
  return issues.map(issue => {
    const prefix = issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
    return `- [${prefix}] ${issue.unitId} | ${issue.code} | ${issue.message}${issue.file ? ` | file: ${issue.file}` : ""} | fixable: ${issue.fixable ? "yes" : "no"}`;
  }).join("\n");
}

/**
 * Serialize a doctor report to JSON — suitable for CI/tooling integration.
 * Usage: /gsd doctor --json
 */
export function formatDoctorReportJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      ok: report.ok,
      basePath: report.basePath,
      generatedAt: new Date().toISOString(),
      summary: summarizeDoctorIssues(report.issues),
      issues: report.issues,
      fixesApplied: report.fixesApplied,
      ...(report.timing ? { timing: report.timing } : {}),
    },
    null,
    2,
  );
}
