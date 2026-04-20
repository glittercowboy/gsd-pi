/**
 * GSD Gate Registry — single source of truth for quality-gate ownership.
 *
 * Each gate declares which workflow turn owns it, the scope at which it is
 * persisted in the `quality_gates` table, and the question/guidance text used
 * in the prompt that turn sends. The registry replaces the ad-hoc
 * `GATE_QUESTIONS` table that used to live in `auto-prompts.ts`, and every
 * layer of the prompt system (prompt builders, dispatch rules, state
 * derivation, tool handlers) consults it so a pending gate can never be
 * silently dropped.
 *
 * Design notes:
 *   - `GATE_REGISTRY` is exhaustiveness-checked against `GateId` via
 *     `satisfies Record<GateId, GateDefinition>`, so adding a new GateId
 *     without a registry entry is a compile error.
 *   - `getGatesForTurn(turn)` returns the definitions a turn owns.
 *   - `assertGateCoverage(pending, turn)` throws a GSDError if the pending
 *     list for a turn contains unknown gates, or if any gate owned by the
 *     turn is missing from the pending list.
 */

import { GSDError, GSD_PARSE_ERROR } from "./errors.js";
import type { GateId, GateRow, GateScope } from "./types.js";

/** Which workflow turn is responsible for evaluating / closing a gate. */
export type OwnerTurn =
  | "gate-evaluate"
  | "execute-task"
  | "complete-slice"
  | "validate-milestone";

export interface GateDefinition {
  id: GateId;
  scope: GateScope;
  ownerTurn: OwnerTurn;
  /** One-line question the assistant must answer. */
  question: string;
  /** Markdown guidance describing what a good answer looks like. */
  guidance: string;
  /** H3 section header used in the artifact the turn writes
   *  (e.g. "Operational Readiness" for Q8 in the slice summary). */
  promptSection: string;
}

export const GATE_REGISTRY = {
  Q3: {
    id: "Q3",
    scope: "slice",
    ownerTurn: "gate-evaluate",
    question: "How can this be exploited?",
    guidance: [
      "Identify abuse scenarios: parameter tampering, replay attacks, privilege escalation.",
      "Map data exposure risks: PII, tokens, secrets accessible through this slice.",
      "Define input trust boundaries: untrusted user input reaching DB, API, or filesystem.",
      "If none apply, return verdict 'omitted' with rationale explaining why.",
    ].join("\n"),
    promptSection: "Abuse Surface",
  },
  Q4: {
    id: "Q4",
    scope: "slice",
    ownerTurn: "gate-evaluate",
    question: "What existing promises does this break?",
    guidance: [
      "List which existing requirements (R001, R003, etc.) are touched by this slice.",
      "Identify what must be re-tested after shipping.",
      "Flag decisions that should be revisited given the new scope.",
      "If no existing requirements are affected, return verdict 'omitted'.",
    ].join("\n"),
    promptSection: "Broken Promises",
  },
  Q5: {
    id: "Q5",
    scope: "task",
    ownerTurn: "execute-task",
    question: "What breaks when dependencies fail?",
    guidance: [
      "Enumerate the task's external dependencies (APIs, filesystem, network, subprocesses).",
      "Describe the failure path for each: timeout, malformed response, connection loss.",
      "Verify the implementation handles each failure or explicitly bubbles the error.",
      "Return verdict 'omitted' only if the task has no external dependencies.",
    ].join("\n"),
    promptSection: "Failure Modes",
  },
  Q6: {
    id: "Q6",
    scope: "task",
    ownerTurn: "execute-task",
    question: "What is the 10x load breakpoint?",
    guidance: [
      "Identify the resource that saturates first at 10x the expected load.",
      "Describe the protection applied (pool sizing, rate limiting, pagination, caching).",
      "Return verdict 'omitted' if the task has no runtime load dimension.",
    ].join("\n"),
    promptSection: "Load Profile",
  },
  Q7: {
    id: "Q7",
    scope: "task",
    ownerTurn: "execute-task",
    question: "What negative tests protect this task?",
    guidance: [
      "List malformed inputs, error paths, and boundary conditions the tests cover.",
      "Point to the specific test files or cases that assert each negative scenario.",
      "Return verdict 'omitted' only if the task has no meaningful negative surface.",
    ].join("\n"),
    promptSection: "Negative Tests",
  },
  Q8: {
    id: "Q8",
    scope: "slice",
    ownerTurn: "complete-slice",
    question: "How will ops know this slice is healthy or broken?",
    guidance: [
      "Describe the health signal (metric, log line, dashboard) that proves the slice works.",
      "Describe the failure signal that triggers an alert or paging.",
      "Document the recovery procedure and any monitoring gaps.",
      "Return verdict 'omitted' only for slices with no runtime behavior at all.",
    ].join("\n"),
    promptSection: "Operational Readiness",
  },
  MV01: {
    id: "MV01",
    scope: "milestone",
    ownerTurn: "validate-milestone",
    question: "Is every success criterion in the milestone roadmap satisfied?",
    guidance: [
      "Walk the success-criteria checklist from the milestone roadmap.",
      "For each criterion, point to the slice / assessment / verification evidence that proves it.",
      "Return verdict 'flag' if any criterion is unmet or unverifiable.",
    ].join("\n"),
    promptSection: "Success Criteria Checklist",
  },
  MV02: {
    id: "MV02",
    scope: "milestone",
    ownerTurn: "validate-milestone",
    question: "Does every slice have a SUMMARY.md and a passing assessment?",
    guidance: [
      "Confirm every slice listed in the roadmap has a SUMMARY.md.",
      "Confirm each slice has an ASSESSMENT verdict of 'pass' (or justified 'omitted').",
      "Flag missing artifacts and slices with outstanding follow-ups or known limitations.",
    ].join("\n"),
    promptSection: "Slice Delivery Audit",
  },
  MV03: {
    id: "MV03",
    scope: "milestone",
    ownerTurn: "validate-milestone",
    question: "Do the slices integrate end-to-end?",
    guidance: [
      "Trace at least one cross-slice flow proving the pieces compose.",
      "Flag gaps where two slices were built in isolation with no integration evidence.",
    ].join("\n"),
    promptSection: "Cross-Slice Integration",
  },
  MV04: {
    id: "MV04",
    scope: "milestone",
    ownerTurn: "validate-milestone",
    question: "Are all touched requirements covered and still coherent?",
    guidance: [
      "For each requirement advanced, validated, surfaced, or invalidated across the milestone's slices, confirm the milestone-level evidence matches.",
      "Flag requirements that slices claim to advance but no artifact proves.",
    ].join("\n"),
    promptSection: "Requirement Coverage",
  },
} as const satisfies Record<GateId, GateDefinition>;

export type GateRegistry = typeof GATE_REGISTRY;

/** Stable ordered lists per owner turn — iteration order matches declaration. */
const ORDERED_GATES: readonly GateDefinition[] = Object.values(GATE_REGISTRY) as readonly GateDefinition[];

/** Return every gate owned by a turn, in stable declaration order. */
export function getGatesForTurn(turn: OwnerTurn): GateDefinition[] {
  return ORDERED_GATES.filter((g) => g.ownerTurn === turn);
}

/** Return the set of gate ids a turn owns. */
export function getGateIdsForTurn(turn: OwnerTurn): Set<GateId> {
  return new Set(getGatesForTurn(turn).map((g) => g.id));
}

/** Look up a definition by gate id, or undefined if unknown. */
export function getGateDefinition(id: string): GateDefinition | undefined {
  return (GATE_REGISTRY as Record<string, GateDefinition>)[id];
}

/** Look up the owner turn for a gate id. Throws if the gate is unknown. */
export function getOwnerTurn(id: GateId): OwnerTurn {
  const def = GATE_REGISTRY[id];
  if (!def) {
    throw new GSDError(GSD_PARSE_ERROR, `gate-registry: unknown gate id "${id}"`);
  }
  return def.ownerTurn;
}

/**
 * Assert that the pending gate rows for a turn match what the registry says
 * the turn owns. Fails loudly rather than silently skipping.
 *
 * - Every row in `pending` must have a definition whose `ownerTurn` matches `turn`.
 *   (The caller is responsible for scoping the pending list — e.g. filtering
 *   by slice scope before passing it in.)
 * - `options.requireAll` (default true): every gate the turn owns must appear
 *   in `pending`. Set to false for turns like `execute-task` that only need
 *   coverage for the subset of gates that were seeded (e.g. tasks with no
 *   external dependencies have no Q5 row).
 */
export function assertGateCoverage(
  pending: ReadonlyArray<Pick<GateRow, "gate_id">>,
  turn: OwnerTurn,
  options: { requireAll?: boolean } = {},
): void {
  const requireAll = options.requireAll ?? true;
  const expected = getGateIdsForTurn(turn);
  const pendingIds = new Set(pending.map((g) => g.gate_id));

  const unknown: string[] = [];
  for (const id of pendingIds) {
    const def = getGateDefinition(id);
    if (!def) {
      unknown.push(id);
      continue;
    }
    if (def.ownerTurn !== turn) {
      unknown.push(`${id} (owned by ${def.ownerTurn}, not ${turn})`);
    }
  }

  if (unknown.length > 0) {
    throw new GSDError(
      GSD_PARSE_ERROR,
      `assertGateCoverage: turn "${turn}" received pending gates it does not own: ${unknown.join(", ")}`,
    );
  }

  if (requireAll) {
    const missing: GateId[] = [];
    for (const id of expected) {
      if (!pendingIds.has(id)) missing.push(id);
    }
    if (missing.length > 0) {
      throw new GSDError(
        GSD_PARSE_ERROR,
        `assertGateCoverage: turn "${turn}" is missing required gates: ${missing.join(", ")}`,
      );
    }
  }
}
