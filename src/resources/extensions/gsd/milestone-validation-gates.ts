/**
 * Milestone validation quality gate persistence.
 *
 * #2945 Bug 4: validate-milestone was writing VALIDATION.md to disk and
 * inserting an assessment row, but never persisted structured quality_gates
 * records in the DB. This module inserts milestone-level validation gates
 * that correspond to the validation checks performed.
 *
 * Gate IDs for milestone validation:
 *   MV01 — Success criteria checklist
 *   MV02 — Slice delivery audit
 *   MV03 — Cross-slice integration
 *   MV04 — Requirement coverage
 *
 * These use the existing quality_gates table with scope "milestone".
 */

import { _getAdapter } from "./gsd-db.js";

/** Milestone validation gate IDs. */
const MILESTONE_GATE_IDS = ["MV01", "MV02", "MV03", "MV04"] as const;

/**
 * Insert milestone-level quality_gates records for a validation run.
 *
 * Each gate is inserted with status "complete" and a verdict derived
 * from the overall milestone validation verdict. Individual gate-level
 * verdicts are not available (the handler receives a single verdict),
 * so all gates share the overall verdict.
 */
export function insertMilestoneValidationGates(
  milestoneId: string,
  sliceId: string,
  verdict: string,
  evaluatedAt: string,
): void {
  const db = _getAdapter();
  if (!db) return;

  const gateVerdict = verdict === "pass" ? "pass" : "flag";

  for (const gateId of MILESTONE_GATE_IDS) {
    db.prepare(
      `INSERT OR REPLACE INTO quality_gates
       (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
       VALUES (:mid, :sid, :gid, 'milestone', '', 'complete', :verdict, :rationale, '', :evaluated_at)`,
    ).run({
      ":mid": milestoneId,
      ":sid": sliceId,
      ":gid": gateId,
      ":verdict": gateVerdict,
      ":rationale": `Milestone validation verdict: ${verdict}`,
      ":evaluated_at": evaluatedAt,
    });
  }
}
