import { loadFile } from "./files.js";
import { resolveSliceFile, resolveTaskFile, resolveTasksDir, resolveTaskFiles } from "./paths.js";

export interface ValidationIssue {
  severity: "info" | "warning" | "error";
  scope: "slice-plan" | "task-plan" | "task-summary" | "slice-summary";
  file: string;
  ruleId: string;
  message: string;
  suggestion?: string;
}

function getSection(content: string, heading: string, level: number = 2): string | null {
  const prefix = "#".repeat(level) + " ";
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${prefix}${escaped}\\s*$`, "m");
  const match = regex.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(new RegExp(`^#{1,${level}} `, "m"));
  const end = nextHeading ? nextHeading.index! : rest.length;
  return rest.slice(0, end).trim();
}

function getFrontmatter(content: string): string | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const afterFirst = trimmed.indexOf("\n");
  if (afterFirst === -1) return null;
  const rest = trimmed.slice(afterFirst + 1);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) return null;
  return rest.slice(0, endIdx);
}

function hasFrontmatterKey(content: string, key: string): boolean {
  const fm = getFrontmatter(content);
  if (!fm) return false;
  return new RegExp(`^${key}:`, "m").test(fm);
}

function normalizeMeaningfulLines(text: string): string[] {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !line.startsWith("<!--"))
    .filter(line => !line.endsWith("-->"))
    .filter(line => !/^[-*]\s*\{\{.+\}\}$/.test(line))
    .filter(line => !/^\{\{.+\}\}$/.test(line));
}

function sectionLooksPlaceholderOnly(text: string | null): boolean {
  if (!text) return true;
  const lines = normalizeMeaningfulLines(text)
    .map(line => line.replace(/^[-*]\s+/, "").trim())
    .filter(line => line.length > 0);

  if (lines.length === 0) return true;

  return lines.every(line => {
    const lower = line.toLowerCase();
    return lower === "none" ||
      lower.endsWith(": none") ||
      lower.includes("{{") ||
      lower.includes("}}") ||
      lower.startsWith("required for non-trivial") ||
      lower.startsWith("describe how a future agent") ||
      lower.startsWith("prefer:") ||
      lower.startsWith("keep this section concise");
  });
}

function textSuggestsObservabilityRelevant(content: string): boolean {
  const lower = content.toLowerCase();
  const needles = [
    " api", "route", "server", "worker", "queue", "job", "sync", "import",
    "webhook", "auth", "db", "database", "migration", "cache", "background",
    "polling", "realtime", "socket", "stateful", "integration", "ui", "form",
    "submit", "status", "service", "pipeline", "health endpoint", "error path"
  ];
  return needles.some(needle => lower.includes(needle));
}

function verificationMentionsDiagnostics(section: string | null): boolean {
  if (!section) return false;
  const lower = section.toLowerCase();
  const needles = [
    "error", "failure", "diagnostic", "status", "health", "inspect", "log",
    "network", "console", "retry", "last error", "correlation", "readiness"
  ];
  return needles.some(needle => lower.includes(needle));
}

export function validateSlicePlanContent(file: string, content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ── Plan quality rules (always run, not gated by runtime relevance) ──

  const tasksSection = getSection(content, "Tasks", 2);
  if (tasksSection) {
    const lines = tasksSection.split("\n");
    const taskLinePattern = /^- \[[ x]\] \*\*T\d+:/;
    const taskLineIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (taskLinePattern.test(lines[i])) taskLineIndices.push(i);
    }

    for (let t = 0; t < taskLineIndices.length; t++) {
      const start = taskLineIndices[t];
      const end = t + 1 < taskLineIndices.length ? taskLineIndices[t + 1] : lines.length;
      // Check lines between this task header and the next (or section end)
      const bodyLines = lines.slice(start + 1, end);
      const meaningful = bodyLines.filter(l => l.trim().length > 0);
      if (meaningful.length === 0) {
        issues.push({
          severity: "warning",
          scope: "slice-plan",
          file,
          ruleId: "empty_task_entry",
          message: "Inline task entry has no description content beneath the checkbox line.",
          suggestion: "Add at least a Why/Files/Do/Verify summary so the task is self-describing.",
        });
      }
    }
  }

  // ── Observability rules (gated by runtime relevance) ──

  const relevant = textSuggestsObservabilityRelevant(content);
  if (!relevant) return issues;

  const obs = getSection(content, "Observability / Diagnostics", 2);
  const verification = getSection(content, "Verification", 2);

  if (!obs) {
    issues.push({
      severity: "warning",
      scope: "slice-plan",
      file,
      ruleId: "missing_observability_section",
      message: "Slice plan appears non-trivial but is missing `## Observability / Diagnostics`.",
      suggestion: "Add runtime signals, inspection surfaces, failure visibility, and redaction constraints.",
    });
  } else if (sectionLooksPlaceholderOnly(obs)) {
    issues.push({
      severity: "warning",
      scope: "slice-plan",
      file,
      ruleId: "observability_section_placeholder_only",
      message: "Slice plan has `## Observability / Diagnostics` but it still looks like placeholder text.",
      suggestion: "Replace placeholders with concrete signals and inspection surfaces a future agent should trust.",
    });
  }

  if (!verificationMentionsDiagnostics(verification)) {
    issues.push({
      severity: "warning",
      scope: "slice-plan",
      file,
      ruleId: "verification_missing_diagnostic_check",
      message: "Slice verification does not appear to include any diagnostic or failure-path check.",
      suggestion: "Add at least one verification step for inspectable failure state, structured error output, status surface, or equivalent.",
    });
  }

  return issues;
}

export function validateTaskPlanContent(file: string, content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ── Plan quality rules (always run, not gated by runtime relevance) ──

  // Rule: empty or missing Steps section
  const stepsSection = getSection(content, "Steps", 2);
  if (stepsSection === null || sectionLooksPlaceholderOnly(stepsSection)) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "empty_steps_section",
      message: "Task plan has an empty or missing `## Steps` section.",
      suggestion: "Add concrete numbered implementation steps so execution has a clear sequence.",
    });
  }

  // Rule: placeholder-only Verification section
  const verificationSection = getSection(content, "Verification", 2);
  if (verificationSection !== null && sectionLooksPlaceholderOnly(verificationSection)) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "placeholder_verification",
      message: "Task plan has `## Verification` but it still looks like placeholder text.",
      suggestion: "Replace placeholders with concrete verification commands, test runs, or observable checks.",
    });
  }

  // Rule: scope estimate thresholds
  const fm = getFrontmatter(content);
  if (fm) {
    const stepsMatch = fm.match(/^estimated_steps:\s*(\d+)/m);
    const filesMatch = fm.match(/^estimated_files:\s*(\d+)/m);

    if (stepsMatch) {
      const estimatedSteps = parseInt(stepsMatch[1], 10);
      if (estimatedSteps >= 10) {
        issues.push({
          severity: "warning",
          scope: "task-plan",
          file,
          ruleId: "scope_estimate_steps_high",
          message: `Task plan estimates ${estimatedSteps} steps (threshold: 10). Consider splitting into smaller tasks.`,
          suggestion: "Break the task into sub-tasks or reduce scope so each task stays focused and completable in one pass.",
        });
      }
    }

    if (filesMatch) {
      const estimatedFiles = parseInt(filesMatch[1], 10);
      if (estimatedFiles >= 12) {
        issues.push({
          severity: "warning",
          scope: "task-plan",
          file,
          ruleId: "scope_estimate_files_high",
          message: `Task plan estimates ${estimatedFiles} files (threshold: 12). Consider splitting into smaller tasks.`,
          suggestion: "Break the task into sub-tasks or reduce scope to keep the change footprint manageable.",
        });
      }
    }
  }

  // Rule: Inputs and Expected Output should contain backtick-wrapped file paths
  const inputsSection = getSection(content, "Inputs", 2);
  const outputSection = getSection(content, "Expected Output", 2);
  const backtickPathPattern = /`[^`]*[./][^`]*`/;

  if (outputSection === null || !backtickPathPattern.test(outputSection)) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "missing_output_file_paths",
      message: "Task plan `## Expected Output` is missing or has no backtick-wrapped file paths.",
      suggestion: "List concrete output file paths in backticks (e.g. `src/types.ts`). These are machine-parsed to derive task dependencies.",
    });
  }

  if (inputsSection !== null && inputsSection.trim().length > 0 && !backtickPathPattern.test(inputsSection)) {
    issues.push({
      severity: "info",
      scope: "task-plan",
      file,
      ruleId: "missing_input_file_paths",
      message: "Task plan `## Inputs` has content but no backtick-wrapped file paths.",
      suggestion: "List input file paths in backticks (e.g. `src/config.json`). These are machine-parsed to derive task dependencies.",
    });
  }

  // ── Observability rules (gated by runtime relevance) ──

  const relevant = textSuggestsObservabilityRelevant(content);
  if (!relevant) return issues;

  const obs = getSection(content, "Observability Impact", 2);
  if (!obs) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "missing_observability_impact",
      message: "Task plan appears runtime-relevant but is missing `## Observability Impact`.",
      suggestion: "Explain what signals change, how a future agent inspects this task, and what failure state becomes visible.",
    });
  } else if (sectionLooksPlaceholderOnly(obs)) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "observability_impact_placeholder_only",
      message: "Task plan has `## Observability Impact` but it still looks empty or placeholder-only.",
      suggestion: "Fill in concrete inspection surfaces or explicitly justify why observability is not applicable.",
    });
  }

  return issues;
}

export function validateTaskSummaryContent(file: string, content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!hasFrontmatterKey(content, "observability_surfaces")) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "missing_observability_frontmatter",
      message: "Task summary is missing `observability_surfaces` in frontmatter.",
      suggestion: "List the durable status/log/error surfaces a future agent should use.",
    });
  }

  const diagnostics = getSection(content, "Diagnostics", 2);
  if (!diagnostics) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "missing_diagnostics_section",
      message: "Task summary is missing `## Diagnostics`.",
      suggestion: "Document how to inspect what this task built later.",
    });
  } else if (sectionLooksPlaceholderOnly(diagnostics)) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "diagnostics_placeholder_only",
      message: "Task summary diagnostics section still looks like placeholder text.",
      suggestion: "Replace placeholders with concrete commands, endpoints, logs, error shapes, or failure artifacts.",
    });
  }

  const evidence = getSection(content, "Verification Evidence", 2);
  if (!evidence) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "evidence_block_missing",
      message: "Task summary is missing `## Verification Evidence`.",
      suggestion: "Add a verification evidence table showing gate check results (command, exit code, verdict, duration).",
    });
  } else if (sectionLooksPlaceholderOnly(evidence)) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "evidence_block_placeholder",
      message: "Task summary verification evidence section still looks like placeholder text.",
      suggestion: "Replace placeholders with actual gate results or note that no verification commands were discovered.",
    });
  }

  return issues;
}

export function validateSliceSummaryContent(file: string, content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!hasFrontmatterKey(content, "observability_surfaces")) {
    issues.push({
      severity: "warning",
      scope: "slice-summary",
      file,
      ruleId: "missing_observability_frontmatter",
      message: "Slice summary is missing `observability_surfaces` in frontmatter.",
      suggestion: "List the authoritative diagnostics and durable inspection surfaces for this slice.",
    });
  }

  const diagnostics = getSection(content, "Authoritative diagnostics", 3);
  if (!diagnostics) {
    issues.push({
      severity: "warning",
      scope: "slice-summary",
      file,
      ruleId: "missing_authoritative_diagnostics",
      message: "Slice summary is missing `### Authoritative diagnostics` in Forward Intelligence.",
      suggestion: "Tell future agents where to look first and why that signal is trustworthy.",
    });
  } else if (sectionLooksPlaceholderOnly(diagnostics)) {
    issues.push({
      severity: "warning",
      scope: "slice-summary",
      file,
      ruleId: "authoritative_diagnostics_placeholder_only",
      message: "Slice summary includes authoritative diagnostics but it still looks like placeholder text.",
      suggestion: "Replace placeholders with the real first-stop diagnostic surface for this slice.",
    });
  }

  return issues;
}

export async function validatePlanBoundary(basePath: string, milestoneId: string, sliceId: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const slicePlan = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  if (slicePlan) {
    const content = await loadFile(slicePlan);
    if (content) issues.push(...validateSlicePlanContent(slicePlan, content));
  }

  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId);
  const taskPlans = tasksDir ? resolveTaskFiles(tasksDir, "PLAN") : [];
  for (const file of taskPlans) {
    const taskId = file.split("-")[0];
    const taskPlan = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
    if (!taskPlan) continue;
    const content = await loadFile(taskPlan);
    if (content) issues.push(...validateTaskPlanContent(taskPlan, content));
  }

  return issues;
}

export async function validateExecuteBoundary(basePath: string, milestoneId: string, sliceId: string, taskId: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const slicePlan = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  if (slicePlan) {
    const content = await loadFile(slicePlan);
    if (content) issues.push(...validateSlicePlanContent(slicePlan, content));
  }

  const taskPlan = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
  if (taskPlan) {
    const content = await loadFile(taskPlan);
    if (content) issues.push(...validateTaskPlanContent(taskPlan, content));
  }

  return issues;
}

export async function validateCompleteBoundary(basePath: string, milestoneId: string, sliceId: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId);
  const taskSummaries = tasksDir ? resolveTaskFiles(tasksDir, "SUMMARY") : [];
  for (const file of taskSummaries) {
    const taskId = file.split("-")[0];
    const taskSummary = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "SUMMARY");
    if (!taskSummary) continue;
    const content = await loadFile(taskSummary);
    if (content) issues.push(...validateTaskSummaryContent(taskSummary, content));
  }

  const sliceSummary = resolveSliceFile(basePath, milestoneId, sliceId, "SUMMARY");
  if (sliceSummary) {
    const content = await loadFile(sliceSummary);
    if (content) issues.push(...validateSliceSummaryContent(sliceSummary, content));
  }

  return issues;
}

export function formatValidationIssues(issues: ValidationIssue[], limit: number = 4): string {
  if (issues.length === 0) return "";
  const lines = issues.slice(0, limit).map(issue => {
    const fileName = issue.file.split("/").pop() || issue.file;
    return `- ${fileName}: ${issue.message}`;
  });
  if (issues.length > limit) lines.push(`- ...and ${issues.length - limit} more`);
  return lines.join("\n");
}
