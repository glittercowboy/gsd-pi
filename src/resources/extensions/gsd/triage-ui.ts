/**
 * GSD Triage UI — Confirmation flow for programmatic triage results
 *
 * Used by auto-mode dispatch (S02) when triage fires between tasks.
 * For manual `/gsd triage`, the LLM session handles confirmation directly.
 *
 * This module provides `showTriageConfirmation` which presents each
 * triage result to the user via `showNextAction` and returns the
 * confirmed classifications.
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { showNextAction } from "../shared/mod.js";
import type { CaptureEntry, Classification, TriageResult } from "./captures.js";
import { markCaptureResolved } from "./captures.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfirmedTriage {
  captureId: string;
  classification: Classification;
  rationale: string;
  affectedFiles?: string[];
  targetSlice?: string;
  userOverride: boolean;  // true if user changed the proposed classification
}

// ─── Classification Labels ────────────────────────────────────────────────────

const CLASSIFICATION_LABELS: Record<Classification, { label: string; description: string }> = {
  "quick-task": {
    label: "Quick task",
    description: "Execute as a one-off at the next seam — no plan modification.",
  },
  "inject": {
    label: "Inject into plan",
    description: "Add a new task to the current slice plan.",
  },
  "defer": {
    label: "Defer",
    description: "Move to a future slice or milestone — not urgent now.",
  },
  "replan": {
    label: "Replan slice",
    description: "Remaining tasks need rewriting — triggers slice replan.",
  },
  "note": {
    label: "Note",
    description: "Informational only — no action needed.",
  },
};

const ALL_CLASSIFICATIONS: Classification[] = [
  "quick-task", "inject", "defer", "replan", "note",
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Present triage results to the user for confirmation.
 *
 * For each capture:
 * - note/defer: auto-confirm (no user interaction needed)
 * - quick-task/inject/replan: show confirmation UI with proposed + alternatives
 *
 * Returns confirmed results with final classifications.
 * Updates CAPTURES.md with resolved status.
 *
 * @param fileOverlaps - Map of captureId → list of planned task IDs whose files overlap
 */
export async function showTriageConfirmation(
  ctx: ExtensionCommandContext,
  triageResults: TriageResult[],
  captures: CaptureEntry[],
  basePath: string,
  fileOverlaps?: Map<string, string[]>,
): Promise<ConfirmedTriage[]> {
  const confirmed: ConfirmedTriage[] = [];
  const captureMap = new Map(captures.map(c => [c.id, c]));

  for (const result of triageResults) {
    const capture = captureMap.get(result.captureId);
    if (!capture) continue;

    // Auto-confirm note and defer — low-impact, no plan modification
    if (result.classification === "note" || result.classification === "defer") {
      const resolution = result.classification === "note"
        ? "acknowledged as note"
        : `deferred${result.targetSlice ? ` to ${result.targetSlice}` : ""}`;

      markCaptureResolved(
        basePath,
        result.captureId,
        result.classification,
        resolution,
        result.rationale,
      );

      confirmed.push({
        captureId: result.captureId,
        classification: result.classification,
        rationale: result.rationale,
        affectedFiles: result.affectedFiles,
        targetSlice: result.targetSlice,
        userOverride: false,
      });
      continue;
    }

    // Build summary lines for the confirmation UI
    const summary: string[] = [
      `"${capture.text}"`,
      "",
      `Proposed: **${CLASSIFICATION_LABELS[result.classification].label}** — ${result.rationale}`,
    ];

    // Add file overlap warning if present
    const overlaps = fileOverlaps?.get(result.captureId);
    if (overlaps && overlaps.length > 0) {
      summary.push("");
      summary.push(`⚠ Touches files planned for ${overlaps.join(", ")} — consider inject or defer`);
    }

    if (result.affectedFiles && result.affectedFiles.length > 0) {
      summary.push("");
      summary.push(`Files: ${result.affectedFiles.join(", ")}`);
    }

    // Build action options — proposed first (recommended), then alternatives
    const proposed = result.classification;
    const actions = ALL_CLASSIFICATIONS.map(cls => ({
      id: cls,
      label: CLASSIFICATION_LABELS[cls].label,
      description: CLASSIFICATION_LABELS[cls].description,
      recommended: cls === proposed,
    }));

    const choice = await showNextAction(ctx, {
      title: `Triage: ${result.captureId}`,
      summary,
      actions,
      notYetMessage: "Capture will remain pending for later triage.",
    });

    if (choice === "not_yet") {
      // User skipped — leave capture pending
      continue;
    }

    const finalClassification = choice as Classification;
    const userOverride = finalClassification !== proposed;
    const resolution = userOverride
      ? `user chose ${finalClassification} (was ${proposed})`
      : `confirmed as ${finalClassification}`;

    markCaptureResolved(
      basePath,
      result.captureId,
      finalClassification,
      resolution,
      userOverride ? `User override: ${result.rationale}` : result.rationale,
    );

    confirmed.push({
      captureId: result.captureId,
      classification: finalClassification,
      rationale: result.rationale,
      affectedFiles: result.affectedFiles,
      targetSlice: result.targetSlice,
      userOverride,
    });
  }

  return confirmed;
}
