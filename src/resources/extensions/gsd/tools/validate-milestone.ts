/**
 * validate-milestone handler — the core operation behind gsd_validate_milestone.
 *
 * Persists milestone validation results to the assessments table,
 * renders VALIDATION.md to disk, and invalidates caches.
 */

import { join } from "node:path";

import {
  transaction,
  _getAdapter,
} from "../gsd-db.js";
import { resolveMilestonePath, clearPathCache } from "../paths.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { VALIDATION_VERDICTS, isValidMilestoneVerdict } from "../verdict-parser.js";

export interface ValidateMilestoneParams {
  milestoneId: string;
  verdict: "pass" | "needs-attention" | "needs-remediation";
  remediationRound: number;
  successCriteriaChecklist: string;
  sliceDeliveryAudit: string;
  crossSliceIntegration: string;
  requirementCoverage: string;
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

  // ── Filesystem render ──────────────────────────────────────────────────
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

  try {
    await saveFile(validationPath, validationMd);
  } catch (renderErr) {
    process.stderr.write(
      `gsd-db: validate_milestone — disk render failed: ${(renderErr as Error).message}\n`,
    );
    return { error: `disk render failed: ${(renderErr as Error).message}` };
  }

  // ── DB write — store in assessments table ──────────────────────────────
  const validatedAt = new Date().toISOString();

  transaction(() => {
    const adapter = _getAdapter()!;
    adapter.prepare(
      `INSERT OR REPLACE INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content, created_at)
       VALUES (:path, :mid, NULL, NULL, :verdict, 'milestone-validation', :content, :created_at)`,
    ).run({
      ":path": validationPath,
      ":mid": params.milestoneId,
      ":verdict": params.verdict,
      ":content": validationMd,
      ":created_at": validatedAt,
    });
  });

  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  return {
    milestoneId: params.milestoneId,
    verdict: params.verdict,
    validationPath,
  };
}
