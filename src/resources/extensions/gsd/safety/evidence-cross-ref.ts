/**
 * Evidence cross-reference for auto-mode safety harness.
 * Compares the LLM's claimed verification evidence (command + exitCode)
 * against actual bash tool calls recorded by the evidence collector.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import type { BashEvidence, EvidenceEntry } from "./evidence-collector.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClaimedEvidence {
  command: string;
  exitCode: number;
  verdict: string;
}

export interface EvidenceMismatch {
  severity: "warning" | "error";
  claimed: ClaimedEvidence;
  actual: BashEvidence | null;
  reason: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Cross-reference claimed verification evidence against actual bash tool calls.
 *
 * Returns an array of mismatches. Empty array = all claims verified.
 * Skips entries that were coerced from strings (already flagged by db-tools.ts).
 */
export function crossReferenceEvidence(
  claimedEvidence: readonly ClaimedEvidence[],
  actualEvidence: readonly EvidenceEntry[],
): EvidenceMismatch[] {
  const bashCalls = actualEvidence.filter(
    (e): e is BashEvidence => e.kind === "bash",
  );
  const mismatches: EvidenceMismatch[] = [];

  for (const claimed of claimedEvidence) {
    // Skip coerced entries — they're already flagged with exitCode: -1
    // and verdict: "unknown (coerced from string)" by db-tools.ts
    if (claimed.verdict?.includes("coerced from string")) continue;
    if (claimed.exitCode === -1) continue;

    // Skip entries with empty or generic commands
    if (!claimed.command || claimed.command.length < 3) continue;

    // Find matching bash call by command substring match
    const match = findBestMatch(claimed.command, bashCalls);

    if (!match) {
      mismatches.push({
        severity: "warning",
        claimed,
        actual: null,
        reason: `No bash tool call found matching "${claimed.command.slice(0, 80)}"`,
      });
      continue;
    }

    // Exit code mismatch: LLM claims success but actual command failed
    if (claimed.exitCode === 0 && match.exitCode !== 0) {
      mismatches.push({
        severity: "error",
        claimed,
        actual: match,
        reason: `Claimed exitCode=0 but actual exitCode=${match.exitCode}`,
      });
    }
  }

  return mismatches;
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Find the best matching bash evidence entry for a claimed command.
 * Uses substring matching — the claimed command may be a shortened version
 * of the actual command, or vice versa.
 */
function findBestMatch(
  claimedCommand: string,
  bashCalls: readonly BashEvidence[],
): BashEvidence | null {
  const normalized = claimedCommand.trim();

  // Exact match first
  const exact = bashCalls.find(b => b.command.trim() === normalized);
  if (exact) return exact;

  // Substring match: claimed is contained in actual or actual in claimed
  const substring = bashCalls.find(
    b => b.command.includes(normalized) || normalized.includes(b.command),
  );
  if (substring) return substring;

  // Token match: split on whitespace and check significant overlap
  const claimedTokens = normalized.split(/\s+/).filter(t => t.length > 2);
  if (claimedTokens.length === 0) return null;

  let bestMatch: BashEvidence | null = null;
  let bestScore = 0;

  for (const call of bashCalls) {
    const callTokens = new Set(call.command.split(/\s+/));
    const matchCount = claimedTokens.filter(t => callTokens.has(t)).length;
    const score = matchCount / claimedTokens.length;
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = call;
    }
  }

  return bestMatch;
}
