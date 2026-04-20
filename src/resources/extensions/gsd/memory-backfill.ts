// GSD2 — Decisions -> memories backfill (ADR-013 step 5)
//
// Idempotent one-shot migration that copies every active decisions row into
// the memories table with category="architecture" and a structured_fields
// payload preserving the original gsd_save_decision schema (when_context,
// scope, decision, choice, rationale, made_by, revisable, sourceDecisionId).
//
// The backfill exists so the cutover in ADR-013 step 6 can drop the
// decisions table without losing schema fidelity. Idempotency is enforced
// by tagging each backfilled memory with structured_fields.sourceDecisionId
// and skipping any decision whose ID already appears in the memories table.
//
// Triggered opportunistically by buildBeforeAgentStartResult so the cost
// only ever fires once per project. Costs O(N) inserts on first run where
// N is the active-decisions count; subsequent runs are an O(N) lookup that
// finds existing markers and exits.

import { isDbAvailable, _getAdapter } from "./gsd-db.js";
import { createMemory } from "./memory-store.js";
import { logWarning } from "./workflow-logger.js";

interface DecisionRow {
  id: string;
  when_context: string;
  scope: string;
  decision: string;
  choice: string;
  rationale: string;
  made_by: string;
  revisable: string;
  superseded_by: string | null;
}

/**
 * Backfill active decisions rows into the memories table.
 *
 * - Idempotent (per-row): every row written carries
 *   `structured_fields.sourceDecisionId = "<decisionId>"`. Each candidate
 *   decision is checked individually; only decisions whose id is already
 *   present in the memory store are skipped. A user-authored memory with
 *   their own `sourceDecisionId` does NOT abort the backfill.
 * - Best-effort: never throws. Logs and returns 0 on failure so a broken
 *   backfill cannot block agent startup.
 * - Active-only: skips rows where `superseded_by IS NOT NULL`. Superseded
 *   decisions are historical record; the memory store is for active
 *   knowledge.
 *
 * Returns the number of memories written (0 when already backfilled or
 * when the DB has no decisions). Callers can log the result or surface it
 * to the user.
 */
export function backfillDecisionsToMemories(): number {
  if (!isDbAvailable()) return 0;
  const adapter = _getAdapter();
  if (!adapter) return 0;

  try {
    const decisions = adapter
      .prepare("SELECT id, when_context, scope, decision, choice, rationale, made_by, revisable, superseded_by FROM decisions WHERE superseded_by IS NULL")
      .all() as Array<Record<string, unknown>>;

    if (decisions.length === 0) return 0;

    // Per-row idempotency: each memory backfilled from a decision carries
    // structured_fields.sourceDecisionId="<decisionId>". Skipping is decided
    // per row by matching that exact id, NOT by a global sentinel — a global
    // sentinel would silently abort the backfill if a user manually called
    // capture_thought with their own structuredFields.sourceDecisionId.
    const checkExisting = adapter.prepare(
      "SELECT 1 FROM memories WHERE structured_fields LIKE :pattern LIMIT 1",
    );

    let written = 0;
    for (const raw of decisions) {
      const row: DecisionRow = {
        id: String(raw["id"] ?? ""),
        when_context: String(raw["when_context"] ?? ""),
        scope: String(raw["scope"] ?? ""),
        decision: String(raw["decision"] ?? ""),
        choice: String(raw["choice"] ?? ""),
        rationale: String(raw["rationale"] ?? ""),
        made_by: String(raw["made_by"] ?? "agent"),
        revisable: String(raw["revisable"] ?? ""),
        superseded_by: raw["superseded_by"] == null ? null : String(raw["superseded_by"]),
      };
      if (!row.id) continue;

      // Pattern is anchored to the JSON-stringified shape and the exact
      // decision id to avoid prefix collisions (e.g. "D1" vs "D10").
      if (checkExisting.get({ ":pattern": `%"sourceDecisionId":"${row.id}"%` })) continue;

      const content = synthesizeContent(row);
      const id = createMemory({
        category: "architecture",
        content,
        scope: row.scope || "project",
        confidence: 0.85,
        structuredFields: {
          sourceDecisionId: row.id,
          when_context: row.when_context,
          scope: row.scope,
          decision: row.decision,
          choice: row.choice,
          rationale: row.rationale,
          made_by: row.made_by,
          revisable: row.revisable,
        },
      });
      if (id) written += 1;
    }

    return written;
  } catch (e) {
    logWarning("memory-backfill", `decisions->memories backfill failed: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Combine the decision's structured fields into a 1-3 sentence content
 * string suitable for keyword retrieval and human review.
 *
 * Format: "<decision> Chose: <choice>. Rationale: <rationale>."
 * Truncates each field to keep the synthesized line under ~600 chars so
 * memory_query rendering stays readable.
 */
function synthesizeContent(row: DecisionRow): string {
  const trim = (value: string, max: number): string => {
    const cleaned = value.replace(/\s+/g, " ").trim();
    return cleaned.length > max ? cleaned.slice(0, max - 1) + "\u2026" : cleaned;
  };
  const parts: string[] = [];
  const decision = trim(row.decision, 240);
  const choice = trim(row.choice, 200);
  const rationale = trim(row.rationale, 200);
  if (decision) parts.push(decision);
  if (choice) parts.push(`Chose: ${choice}.`);
  if (rationale) parts.push(`Rationale: ${rationale}.`);
  return parts.join(" ");
}
