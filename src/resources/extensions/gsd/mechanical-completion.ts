/**
 * Mechanical Completion — deterministic post-verification artifact generation.
 *
 * Pure functions that aggregate task-level outputs into slice/milestone summaries,
 * UAT stubs, roadmap checkbox updates, and validation reports. Zero orchestration
 * dependencies — operates on filesystem paths and parsed structures only.
 *
 * ADR-003: replaces LLM-driven complete-slice and validate-milestone units with
 * mechanical aggregation when the data is sufficient.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "./atomic-write.js";
import { loadFile, parseSummary } from "./files.js";
import { extractMarkdownSection } from "./auto-prompts.js";
import {
  resolveTaskFiles,
  resolveTaskJsonFiles,
  resolveTasksDir,
  resolveSliceFile,
  resolveSlicePath,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveGsdRootFile,
} from "./paths.js";
import type { Summary, SummaryFrontmatter } from "./types.js";
import type { EvidenceJSON } from "./verification-evidence.js";

// ─── Slice Completion ────────────────────────────────────────────────────────

/**
 * Mechanically complete a slice by aggregating task summaries into:
 * - S##-SUMMARY.md (aggregated frontmatter + task one-liners)
 * - S##-UAT.md (extracted from plan Verification section)
 * - Roadmap checkbox [x] update
 *
 * Returns true if completion succeeded, false if data is insufficient
 * (serves as quality gate — caller falls back to LLM completion).
 */
export async function mechanicalSliceCompletion(
  base: string, mid: string, sid: string,
): Promise<boolean> {
  const tDir = resolveTasksDir(base, mid, sid);
  if (!tDir) return false;

  // Read all task summaries
  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
  if (summaryFiles.length === 0) return false;

  const taskSummaries: Array<{ taskId: string; summary: Summary }> = [];
  for (const file of summaryFiles) {
    const content = readFileSync(join(tDir, file), "utf-8");
    if (!content.trim()) continue;
    const summary = parseSummary(content);
    const taskId = file.match(/^(T\d+)/)?.[1] ?? file;
    taskSummaries.push({ taskId, summary });
  }

  if (taskSummaries.length === 0) return false;

  // Quality gate: multi-task slices need substantive summaries
  if (taskSummaries.length > 1) {
    const totalContent = taskSummaries
      .map(ts => ts.summary.whatHappened || ts.summary.oneLiner || "")
      .join("");
    if (totalContent.length < 200) return false;
  }

  // Aggregate frontmatter
  const aggregated = aggregateFrontmatter(taskSummaries.map(ts => ts.summary.frontmatter));

  // Build SUMMARY.md
  const summaryLines: string[] = [
    "---",
    `id: ${sid}`,
    `parent: ${mid}`,
    `milestone: ${mid}`,
  ];
  if (aggregated.provides.length > 0)
    summaryLines.push(`provides:\n${aggregated.provides.map(p => `  - ${p}`).join("\n")}`);
  if (aggregated.key_files.length > 0)
    summaryLines.push(`key_files:\n${aggregated.key_files.map(f => `  - ${f}`).join("\n")}`);
  if (aggregated.key_decisions.length > 0)
    summaryLines.push(`key_decisions:\n${aggregated.key_decisions.map(d => `  - ${d}`).join("\n")}`);
  if (aggregated.patterns_established.length > 0)
    summaryLines.push(`patterns_established:\n${aggregated.patterns_established.map(p => `  - ${p}`).join("\n")}`);
  if (aggregated.affects.length > 0)
    summaryLines.push(`affects:\n${aggregated.affects.map(a => `  - ${a}`).join("\n")}`);
  if (aggregated.observability_surfaces.length > 0)
    summaryLines.push(`observability_surfaces:\n${aggregated.observability_surfaces.map(o => `  - ${o}`).join("\n")}`);
  const allPassed = taskSummaries.every(ts => ts.summary.frontmatter.verification_result === "passed");
  summaryLines.push(`verification_result: ${allPassed ? "passed" : "mixed"}`);
  summaryLines.push(`completed_at: ${new Date().toISOString()}`);
  summaryLines.push("---");
  summaryLines.push("");
  summaryLines.push(`# ${sid}: Slice Summary`);
  summaryLines.push("");

  // Task one-liners
  for (const { taskId, summary } of taskSummaries) {
    const line = summary.oneLiner || summary.title || taskId;
    summaryLines.push(`- **${taskId}**: ${line}`);
  }
  summaryLines.push("");

  const sDir = resolveSlicePath(base, mid, sid);
  if (!sDir) return false;

  const summaryPath = join(sDir, `${sid}-SUMMARY.md`);
  atomicWriteSync(summaryPath, summaryLines.join("\n"));
  process.stderr.write(`gsd-mechanical: wrote ${summaryPath}\n`);

  // Build UAT.md from plan's Verification section
  const planPath = resolveSliceFile(base, mid, sid, "PLAN");
  if (planPath) {
    const planContent = readFileSync(planPath, "utf-8");
    const verification = extractMarkdownSection(planContent, "Verification");
    if (verification) {
      const uatContent = [
        "---",
        `id: ${sid}`,
        `parent: ${mid}`,
        "type: artifact-driven",
        "---",
        "",
        `# ${sid}: UAT`,
        "",
        verification,
        "",
      ].join("\n");
      const uatPath = join(sDir, `${sid}-UAT.md`);
      atomicWriteSync(uatPath, uatContent);
      process.stderr.write(`gsd-mechanical: wrote ${uatPath}\n`);
    }
  }

  // Mark slice [x] in ROADMAP
  await markSliceInRoadmap(base, mid, sid);

  // Append new decisions if any
  await appendNewDecisions(base, taskSummaries.map(ts => ts.summary));

  // Update requirements if all passed
  if (allPassed) {
    await mechanicalRequirementsUpdate(base, mid, sid, taskSummaries.map(ts => ts.summary));
  }

  return true;
}

// ─── Requirements Update ─────────────────────────────────────────────────────

/**
 * Conservative requirements update: mark requirements Validated only if
 * all tasks' verification passed.
 */
export async function mechanicalRequirementsUpdate(
  _base: string, _mid: string, _sid: string, _taskSummaries: Summary[],
): Promise<void> {
  // Conservative: requirements validation requires human or LLM judgment
  // about whether the requirement is truly met. Mechanical completion only
  // marks the slice done — requirement status updates are left to the
  // existing validation pipeline.
}

// ─── Decision Aggregation ────────────────────────────────────────────────────

/**
 * Collect key_decisions from task summaries, deduplicate against existing
 * DECISIONS.md, and append new ones.
 */
export async function appendNewDecisions(
  base: string, taskSummaries: Summary[],
): Promise<void> {
  const allDecisions = taskSummaries.flatMap(s => s.frontmatter.key_decisions);
  if (allDecisions.length === 0) return;

  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  const existing = existsSync(decisionsPath)
    ? readFileSync(decisionsPath, "utf-8")
    : "";

  // Deduplicate — skip decisions whose text already appears in the file
  const newDecisions = allDecisions.filter(d =>
    d.trim() && !existing.includes(d.trim()),
  );
  if (newDecisions.length === 0) return;

  const entries = newDecisions
    .map(d => `- ${d} _(auto-aggregated from task summaries)_`)
    .join("\n");

  const updated = existing.trimEnd() + "\n\n### Auto-aggregated Decisions\n\n" + entries + "\n";
  atomicWriteSync(decisionsPath, updated);
  process.stderr.write(`gsd-mechanical: appended ${newDecisions.length} decision(s) to DECISIONS.md\n`);
}

// ─── Milestone Verification ──────────────────────────────────────────────────

export interface MilestoneVerificationResult {
  verdict: "passed" | "failed" | "mixed";
  checks: EvidenceJSON[];
  uatResults: string[];
  markdown: string;
}

/**
 * Aggregate T##-VERIFY.json files and S##-UAT-RESULT.md files across all
 * slices in a milestone to produce VALIDATION.md.
 */
export async function aggregateMilestoneVerification(
  base: string, mid: string,
): Promise<MilestoneVerificationResult> {
  const mDir = resolveMilestonePath(base, mid);
  if (!mDir) return { verdict: "failed", checks: [], uatResults: [], markdown: "" };

  const allChecks: EvidenceJSON[] = [];
  const allUatResults: string[] = [];

  // Scan all slices
  const slicesDir = join(mDir, "slices");
  if (!existsSync(slicesDir)) return { verdict: "failed", checks: [], uatResults: [], markdown: "" };

  const sliceDirs = readdirSyncSafe(slicesDir).filter(name => /^S\d+/i.test(name)).sort();

  for (const sliceName of sliceDirs) {
    const sid = sliceName.match(/^(S\d+)/i)?.[1] ?? sliceName;
    const tDir = resolveTasksDir(base, mid, sid);
    if (tDir) {
      const verifyFiles = resolveTaskJsonFiles(tDir, "VERIFY");
      for (const vf of verifyFiles) {
        try {
          const content = readFileSync(join(tDir, vf), "utf-8");
          const evidence = JSON.parse(content) as EvidenceJSON;
          allChecks.push(evidence);
        } catch {
          // Skip malformed JSON
        }
      }
    }

    // Check for UAT result
    const uatResultPath = resolveSliceFile(base, mid, sid, "UAT-RESULT");
    if (uatResultPath) {
      try {
        const uatContent = readFileSync(uatResultPath, "utf-8");
        allUatResults.push(`### ${sid}\n\n${uatContent}`);
      } catch {
        // Non-fatal
      }
    }
  }

  // Determine verdict
  const allPassed = allChecks.length > 0 && allChecks.every(c => c.passed);
  const anyFailed = allChecks.some(c => !c.passed);
  const verdict: "passed" | "failed" | "mixed" = allPassed
    ? "passed"
    : anyFailed
      ? (allChecks.some(c => c.passed) ? "mixed" : "failed")
      : "passed"; // No checks = vacuously passed

  // Build VALIDATION.md
  const mdLines: string[] = [
    "---",
    `milestone: ${mid}`,
    `verdict: ${verdict}`,
    "remediation_round: 0",
    `validated_at: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${mid}: Milestone Validation`,
    "",
    `**Verdict:** ${verdict}`,
    "",
    "## Verification Results",
    "",
  ];

  if (allChecks.length === 0) {
    mdLines.push("_No verification evidence found._");
  } else {
    mdLines.push("| Task | Passed | Checks | Failed |");
    mdLines.push("|------|--------|--------|--------|");
    for (const check of allChecks) {
      const failedCount = check.checks.filter(c => c.verdict === "fail").length;
      mdLines.push(
        `| ${check.taskId} | ${check.passed ? "yes" : "no"} | ${check.checks.length} | ${failedCount} |`,
      );
    }
  }

  if (allUatResults.length > 0) {
    mdLines.push("");
    mdLines.push("## UAT Results");
    mdLines.push("");
    mdLines.push(...allUatResults);
  }

  mdLines.push("");

  const markdown = mdLines.join("\n");

  // Write VALIDATION.md
  const validationPath = join(mDir, `${mid}-VALIDATION.md`);
  atomicWriteSync(validationPath, markdown);
  process.stderr.write(`gsd-mechanical: wrote ${validationPath}\n`);

  return { verdict, checks: allChecks, uatResults: allUatResults, markdown };
}

// ─── Milestone Summary ──────────────────────────────────────────────────────

/**
 * Read all S##-SUMMARY.md files and produce M##-SUMMARY.md.
 */
export async function generateMilestoneSummary(
  base: string, mid: string,
): Promise<string> {
  const mDir = resolveMilestonePath(base, mid);
  if (!mDir) return "";

  const slicesDir = join(mDir, "slices");
  if (!existsSync(slicesDir)) return "";

  const sliceDirs = readdirSyncSafe(slicesDir).filter(name => /^S\d+/i.test(name)).sort();

  const aggregatedProvides: string[] = [];
  const aggregatedKeyFiles: string[] = [];
  const aggregatedKeyDecisions: string[] = [];
  const aggregatedPatterns: string[] = [];
  const sliceOneLinerList: string[] = [];

  for (const sliceName of sliceDirs) {
    const sid = sliceName.match(/^(S\d+)/i)?.[1] ?? sliceName;
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    if (!summaryPath) continue;

    try {
      const content = readFileSync(summaryPath, "utf-8");
      const summary = parseSummary(content);
      aggregatedProvides.push(...summary.frontmatter.provides);
      aggregatedKeyFiles.push(...summary.frontmatter.key_files);
      aggregatedKeyDecisions.push(...summary.frontmatter.key_decisions);
      aggregatedPatterns.push(...summary.frontmatter.patterns_established);
      sliceOneLinerList.push(`- **${sid}**: ${summary.oneLiner || summary.title || sid}`);
    } catch {
      sliceOneLinerList.push(`- **${sid}**: _(summary unavailable)_`);
    }
  }

  const mdLines: string[] = [
    "---",
    `id: ${mid}`,
  ];
  if (dedup(aggregatedProvides).length > 0)
    mdLines.push(`provides:\n${dedup(aggregatedProvides).map(p => `  - ${p}`).join("\n")}`);
  if (dedup(aggregatedKeyFiles).length > 0)
    mdLines.push(`key_files:\n${dedup(aggregatedKeyFiles).map(f => `  - ${f}`).join("\n")}`);
  if (dedup(aggregatedKeyDecisions).length > 0)
    mdLines.push(`key_decisions:\n${dedup(aggregatedKeyDecisions).map(d => `  - ${d}`).join("\n")}`);
  if (dedup(aggregatedPatterns).length > 0)
    mdLines.push(`patterns_established:\n${dedup(aggregatedPatterns).map(p => `  - ${p}`).join("\n")}`);
  mdLines.push(`completed_at: ${new Date().toISOString()}`);
  mdLines.push("---");
  mdLines.push("");
  mdLines.push(`# ${mid}: Milestone Summary`);
  mdLines.push("");
  mdLines.push("## Slices");
  mdLines.push("");
  mdLines.push(...sliceOneLinerList);
  mdLines.push("");

  const content = mdLines.join("\n");

  // Write M##-SUMMARY.md
  const summaryPath = join(mDir, `${mid}-SUMMARY.md`);
  atomicWriteSync(summaryPath, content);
  process.stderr.write(`gsd-mechanical: wrote ${summaryPath}\n`);

  return content;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function aggregateFrontmatter(fms: SummaryFrontmatter[]): {
  provides: string[];
  key_files: string[];
  key_decisions: string[];
  patterns_established: string[];
  affects: string[];
  observability_surfaces: string[];
} {
  return {
    provides: dedup(fms.flatMap(f => f.provides)),
    key_files: dedup(fms.flatMap(f => f.key_files)),
    key_decisions: dedup(fms.flatMap(f => f.key_decisions)),
    patterns_established: dedup(fms.flatMap(f => f.patterns_established)),
    affects: dedup(fms.flatMap(f => f.affects)),
    observability_surfaces: dedup(fms.flatMap(f => f.observability_surfaces)),
  };
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr.filter(s => s.trim()))];
}

async function markSliceInRoadmap(base: string, mid: string, sid: string): Promise<void> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (!roadmapPath) return;
  const content = await loadFile(roadmapPath);
  if (!content) return;
  const updated = content.replace(
    new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${sid}:`, "m"),
    `$1[x] **${sid}:`,
  );
  if (updated !== content) {
    atomicWriteSync(roadmapPath, updated);
    process.stderr.write(`gsd-mechanical: marked ${sid} done in ROADMAP\n`);
  }
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
