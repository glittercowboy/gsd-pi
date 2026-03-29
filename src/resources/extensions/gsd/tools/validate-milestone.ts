/**
 * validate-milestone handler — the core operation behind gsd_validate_milestone.
 *
 * Persists milestone validation results to the assessments table and
 * quality_gates table, renders VALIDATION.md to disk, and invalidates caches.
 *
 * #2945 Bug 4: Previously only wrote to assessments — quality_gates records
 * were never persisted, causing M002+ milestones to have zero gate records
 * despite passing validation.
 */

import { join } from "node:path";

import {
  transaction,
  insertAssessment,
  deleteAssessmentByScope,
  getMilestoneSlices,
} from "../gsd-db.js";
import { resolveMilestonePath, clearPathCache } from "../paths.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { VALIDATION_VERDICTS, isValidMilestoneVerdict } from "../verdict-parser.js";
import { insertMilestoneValidationGates } from "../milestone-validation-gates.js";

export interface ValidateMilestoneParams {
  milestoneId: string;
  verdict: "pass" | "needs-attention" | "needs-remediation";
  remediationRound: number;
  successCriteriaChecklist: string;
  sliceDeliveryAudit: string;
  crossSliceIntegration: string;
  requirementCoverage: string;
  verificationClasses?: string;
  verdictRationale: string;
  remediationPlan?: string;
}

export interface ValidateMilestoneResult {
  milestoneId: string;
  verdict: string;
  validationPath: string;
}

function renderValidationMarkdown(params: ValidateMilestoneParams): string {
  let md = `---
verdict: ${params.verdict}
remediation_round: ${params.remediationRound}
---

# Milestone Validation: ${params.milestoneId}

## Success Criteria Checklist
${params.successCriteriaChecklist}

## Slice Delivery Audit
${params.sliceDeliveryAudit}

## Cross-Slice Integration
${params.crossSliceIntegration}

## Requirement Coverage
${params.requirementCoverage}

${params.verificationClasses ? `## Verification Class Compliance
${params.verificationClasses}

` : ""}
## Verdict Rationale
${params.verdictRationale}
`;

  if (params.verdict === "needs-remediation" && params.remediationPlan) {
    md += `\n## Remediation Plan\n${params.remediationPlan}\n`;
  }

  return md;
}

export async function handleValidateMilestone(
  params: ValidateMilestoneParams,
  basePath: string,
): Promise<ValidateMilestoneResult | { error: string }> {
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  if (!isValidMilestoneVerdict(params.verdict)) {
    return { error: `verdict must be one of: ${VALIDATION_VERDICTS.join(", ")}` };
  }

  // ── Resolve paths and render markdown ────────────────────────────────
  const validationMd = renderValidationMarkdown(params);

  let validationPath: string;
  const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
  if (milestoneDir) {
    validationPath = join(milestoneDir, `${params.milestoneId}-VALIDATION.md`);
  } else {
    const gsdDir = join(basePath, ".gsd");
    const manualDir = join(gsdDir, "milestones", params.milestoneId);
    validationPath = join(manualDir, `${params.milestoneId}-VALIDATION.md`);
  }

  // ── DB write first — matches complete-task/complete-slice pattern ───
  // Write DB before disk so a crash between the two leaves a recoverable
  // state: the DB row exists but the file is missing, which projection
  // rendering can regenerate. The inverse (file exists, no DB row) is
  // harder to detect and recover from (#2725).
  const validatedAt = new Date().toISOString();

  transaction(() => {
    insertAssessment({
      path: validationPath,
      milestoneId: params.milestoneId,
      sliceId: null,
      taskId: null,
      status: params.verdict,
      scope: 'milestone-validation',
      fullContent: validationMd,
    });

    // #2945 Bug 4: persist quality_gates records alongside the assessment.
    // Previously only the assessment was written, leaving M002+ milestones
    // with zero quality_gate records despite passing validation.
    const slices = getMilestoneSlices(params.milestoneId);
    const sliceId = slices.length > 0 ? slices[0].id : "_milestone";
    insertMilestoneValidationGates(
      params.milestoneId,
      sliceId,
      params.verdict,
      validatedAt,
    );
  });

  // ── Filesystem render (outside transaction) ────────────────────────────
  // If disk render fails, roll back the DB row so state stays consistent.
  try {
    await saveFile(validationPath, validationMd);
  } catch (renderErr) {
    process.stderr.write(
      `gsd-db: validate_milestone — disk render failed, rolling back DB row: ${(renderErr as Error).message}\n`,
    );
    deleteAssessmentByScope(params.milestoneId, 'milestone-validation');
    return { error: `disk render failed: ${(renderErr as Error).message}` };
  }

  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  return {
    milestoneId: params.milestoneId,
    verdict: params.verdict,
    validationPath,
  };
}
