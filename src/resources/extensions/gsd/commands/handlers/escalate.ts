// GSD Extension — /gsd escalate Command Handler (ADR-011 Phase 2)
// Surface and resolve mid-execution escalations from the CLI.

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { projectRoot } from "../context.js";
import { getActiveMilestoneId } from "../../state.js";
import {
  readEscalationArtifact,
  formatEscalationForDisplay,
  resolveEscalation,
  listActionableEscalations,
  listAllEscalations,
} from "../../escalation.js";
import { saveDecisionToDb } from "../../db-writer.js";
import { loadEffectiveGSDPreferences } from "../../preferences.js";
import { invalidateStateCache } from "../../state.js";
import { emitUokAuditEvent, buildAuditEnvelope } from "../../uok/audit.js";

function helpMessage(): string {
  return [
    "/gsd escalate — manage mid-execution escalations (ADR-011 Phase 2)",
    "",
    "Subcommands:",
    "  list [--all]           show pending escalations (use --all to include resolved)",
    "  show <taskId>          print the escalation artifact",
    "  resolve <taskId> <choice> [rationale...]",
    "                         resolve an escalation — choice is an option id,",
    "                         `accept` (use recommendation), or `reject-blocker`",
    "                         (convert to a blocker and trigger slice replan)",
    "",
    "Note: disabling `phases.mid_execution_escalation` does NOT clear pending",
    "escalations. If you need to drain them, re-enable the flag, resolve via",
    "`/gsd escalate resolve`, then disable.",
  ].join("\n");
}

function formatListEntries(
  rows: ReturnType<typeof listActionableEscalations>,
  basePath: string,
): string {
  if (rows.length === 0) return "No escalations.";
  return rows.map((t) => {
    const art = t.escalation_artifact_path ? readEscalationArtifact(t.escalation_artifact_path) : null;
    const status = t.escalation_pending ? "PENDING (paused)" : t.escalation_awaiting_review ? "awaiting-review" : "resolved";
    const question = art?.question ?? "(artifact missing)";
    return `  ${t.slice_id}/${t.id}  [${status}]  ${question}`;
  }).join("\n");
}

export async function handleEscalateCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  void pi;

  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "help") {
    ctx.ui.notify(helpMessage(), "info");
    return;
  }

  const basePath = projectRoot();
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  if (prefs?.phases?.mid_execution_escalation !== true) {
    ctx.ui.notify(
      "Escalation is off. Enable with `phases: { mid_execution_escalation: true }` in your PREFERENCES.md.",
      "warning",
    );
    return;
  }

  const milestoneId = await getActiveMilestoneId(basePath);
  if (!milestoneId) {
    ctx.ui.notify("No active milestone — cannot list escalations.", "warning");
    return;
  }

  // ── list ────────────────────────────────────────────────────────────────
  if (trimmed === "list" || trimmed === "list --all" || trimmed === "--all") {
    const includeAll = trimmed.includes("--all");
    const rows = includeAll ? listAllEscalations(milestoneId) : listActionableEscalations(milestoneId);
    const body = formatListEntries(rows, basePath);
    ctx.ui.notify(
      `${includeAll ? "All escalations" : "Actionable escalations"} for ${milestoneId}:\n${body}`,
      "info",
    );
    return;
  }

  // Parse a possibly-slice-qualified task id: "Sxx/Tyy" or plain "Tyy".
  // Returns { sliceId?, taskId }.
  const parseTaskRef = (ref: string): { sliceId?: string; taskId: string } => {
    const slash = ref.indexOf("/");
    if (slash > 0) {
      return { sliceId: ref.slice(0, slash), taskId: ref.slice(slash + 1) };
    }
    return { taskId: ref };
  };

  // Resolve a task ref to a single row, surfacing ambiguity when a bare task
  // id matches more than one slice.
  const locateRow = (ref: string): ReturnType<typeof listAllEscalations>[number] | "ambiguous" | "not-found" => {
    const { sliceId, taskId } = parseTaskRef(ref);
    const rows = listAllEscalations(milestoneId).filter(
      (t) => t.id === taskId && (sliceId === undefined || t.slice_id === sliceId),
    );
    if (rows.length === 0) return "not-found";
    if (rows.length > 1) return "ambiguous";
    return rows[0]!;
  };

  // ── show <taskRef> ──────────────────────────────────────────────────────
  if (trimmed.startsWith("show ")) {
    const ref = trimmed.slice(5).trim();
    const row = locateRow(ref);
    if (row === "ambiguous") {
      ctx.ui.notify(`Task ${ref} matches multiple slices. Use Sxx/Tyy format.`, "warning");
      return;
    }
    if (row === "not-found" || !row.escalation_artifact_path) {
      ctx.ui.notify(`No escalation found for ${ref} in ${milestoneId}.`, "warning");
      return;
    }
    const art = readEscalationArtifact(row.escalation_artifact_path);
    if (!art) {
      ctx.ui.notify(`Escalation artifact at ${row.escalation_artifact_path} is missing or malformed.`, "error");
      return;
    }
    ctx.ui.notify(formatEscalationForDisplay(art), "info");
    return;
  }

  // ── resolve <taskRef> <choice> [rationale...] ───────────────────────────
  if (trimmed.startsWith("resolve ")) {
    const parts = trimmed.slice(8).trim().split(/\s+/);
    const ref = parts[0];
    const choice = parts[1];
    const rationale = parts.slice(2).join(" ").trim();
    if (!ref || !choice) {
      ctx.ui.notify("Usage: /gsd escalate resolve <taskId|Sxx/Tyy> <choice> [rationale...]", "warning");
      return;
    }

    const row = locateRow(ref);
    if (row === "ambiguous") {
      ctx.ui.notify(`Task ${ref} matches multiple slices. Use Sxx/Tyy format.`, "warning");
      return;
    }
    if (row === "not-found") {
      ctx.ui.notify(`No escalation found for ${ref} in ${milestoneId}.`, "warning");
      return;
    }
    const taskId = row.id;

    const result = resolveEscalation(basePath, milestoneId, row.slice_id, taskId, choice, rationale);
    invalidateStateCache();

    if (result.status !== "resolved" && result.status !== "rejected-to-blocker") {
      ctx.ui.notify(result.message, result.status === "invalid-choice" ? "warning" : "error");
      return;
    }

    // Persist the user's choice as a decision (only for resolved, not reject-blocker).
    if (result.status === "resolved") {
      try {
        const art = row.escalation_artifact_path ? readEscalationArtifact(row.escalation_artifact_path) : null;
        const scope = `${milestoneId}/${row.slice_id}/${taskId}`;
        const decisionText = art?.question ?? `escalation on ${taskId}`;
        const choiceLabel = choice === "accept"
          ? `${art?.recommendation ?? "accepted"} (recommended)`
          : (result.chosenOption?.label ?? choice);
        const { id: decisionId } = await saveDecisionToDb({
          scope,
          decision: decisionText,
          choice: choiceLabel,
          rationale: rationale || result.chosenOption?.tradeoffs || "User-resolved escalation.",
          made_by: "human",
          source: "escalation",
          when_context: `ADR-011 escalation resolved ${new Date().toISOString()}`,
        }, basePath);

        emitUokAuditEvent(basePath, buildAuditEnvelope({
          traceId: `escalation:${milestoneId}:${row.slice_id}:${taskId}`,
          category: "gate",
          type: "escalation-decision-persisted",
          payload: {
            milestoneId,
            sliceId: row.slice_id,
            taskId,
            decisionId,
            choice,
          },
        }));

        ctx.ui.notify(
          `${result.message}\nDecision recorded as ${decisionId}. Run /gsd auto to continue.`,
          "success",
        );
      } catch (decErr) {
        ctx.ui.notify(
          `${result.message}\nWARN: decision persistence failed: ${(decErr as Error).message}`,
          "warning",
        );
      }
      return;
    }

    // rejected-to-blocker path
    ctx.ui.notify(`${result.message} Run /gsd auto to trigger the replan.`, "success");
    return;
  }

  ctx.ui.notify(`Unknown subcommand. ${helpMessage()}`, "warning");
}
