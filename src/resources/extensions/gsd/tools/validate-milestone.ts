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
import { resolveCanonicalMilestoneRoot } from "../worktree-manager.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { VALIDATION_VERDICTS, isValidMilestoneVerdict } from "../verdict-parser.js";
import { insertMilestoneValidationGates } from "../milestone-validation-gates.js";
import { logWarning } from "../workflow-logger.js";
import { UokGateRunner } from "../uok/gate-runner.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { resolveUokFlags } from "../uok/flags.js";

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

export interface ValidateMilestoneOptions {
  uokGatesEnabled?: boolean;
  traceId?: string;
  turnId?: string;
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
  opts?: ValidateMilestoneOptions,
): Promise<ValidateMilestoneResult | { error: string }> {
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  if (!isValidMilestoneVerdict(params.verdict)) {
    return { error: `verdict must be one of: ${VALIDATION_VERDICTS.join(", ")}` };
  }

  // ── Resolve paths and render markdown ────────────────────────────────
  // #4761: route through the canonical-root resolver so that when a live
  // worktree exists for this milestone, validation reads/writes the
  // worktree's artifacts instead of stale project-root state.
  const validationMd = renderValidationMarkdown(params);

  const canonicalBase = resolveCanonicalMilestoneRoot(basePath, params.milestoneId);

  let validationPath: string;
  const milestoneDir = resolveMilestonePath(canonicalBase, params.milestoneId);
  if (milestoneDir) {
    validationPath = join(milestoneDir, `${params.milestoneId}-VALIDATION.md`);
  } else {
    const gsdDir = join(canonicalBase, ".gsd");
    const manualDir = join(gsdDir, "milestones", params.milestoneId);
    validationPath = join(manualDir, `${params.milestoneId}-VALIDATION.md`);
  }

  // ── DB write first — matches complete-task/complete-slice pattern ───
  // Write DB before disk so a crash between the two leaves a recoverable
  // state: the DB row exists but the file is missing, which projection
  // rendering can regenerate. The inverse (file exists, no DB row) is
  // harder to detect and recover from (#2725).
  const validatedAt = new Date().toISOString();
  const slices = getMilestoneSlices(params.milestoneId);
  const gateSliceId = slices.length > 0 ? slices[0].id : "_milestone";

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
    insertMilestoneValidationGates(
      params.milestoneId,
      gateSliceId,
      params.verdict,
      validatedAt,
    );
  });

  // ── Filesystem render (outside transaction) ────────────────────────────
  // If disk render fails, roll back the DB row so state stays consistent.
  try {
    await saveFile(validationPath, validationMd);
  } catch (renderErr) {
    logWarning("tool", `validate_milestone — disk render failed, rolling back DB row: ${(renderErr as Error).message}`);
    deleteAssessmentByScope(params.milestoneId, 'milestone-validation');
    return { error: `disk render failed: ${(renderErr as Error).message}` };
  }

  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  const prefs = loadEffectiveGSDPreferences()?.preferences;
  const gatesEnabled = opts?.uokGatesEnabled ?? resolveUokFlags(prefs).gates;
  if (gatesEnabled) {
    try {
      const gateRunner = new UokGateRunner();
      const nonPassVerdict = params.verdict !== "pass";
      gateRunner.register({
        id: "milestone-validation-gates",
        type: "verification",
        execute: async () => ({
          outcome: nonPassVerdict ? "manual-attention" : "pass",
          failureClass: nonPassVerdict ? "manual-attention" : "none",
          rationale: `milestone validation verdict: ${params.verdict}`,
          findings: nonPassVerdict
            ? [params.verdictRationale, params.remediationPlan ?? ""].filter(Boolean).join("\n")
            : "",
        }),
      });
      await gateRunner.run("milestone-validation-gates", {
        basePath,
        traceId: opts?.traceId ?? `validate-milestone:${params.milestoneId}`,
        turnId: opts?.turnId ?? `${params.milestoneId}:validate`,
        milestoneId: params.milestoneId,
        sliceId: gateSliceId,
        unitType: "validate-milestone",
        unitId: params.milestoneId,
      });
    } catch (err) {
      logWarning(
        "tool",
        `validate_milestone — failed to persist UOK gate result: ${(err as Error).message}`,
      );
    }
  }

  return {
    milestoneId: params.milestoneId,
    verdict: params.verdict,
    validationPath,
  };
}
