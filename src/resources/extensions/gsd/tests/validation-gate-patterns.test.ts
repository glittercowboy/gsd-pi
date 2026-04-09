/**
 * Unit tests for the milestone completion validation gate pattern matching.
 *
 * The gate in auto-dispatch accepts two evidence formats:
 *   1. Structured template: content contains "Operational" AND ("MET" or "N/A")
 *   2. Prose evidence: matches /[Oo]perational[\s:][^\n]*(?:pass|verified|...)/i
 *
 * These tests exercise the exact same expressions used in auto-dispatch.ts
 * to ensure both formats are correctly recognized, and that content without
 * operational evidence is properly rejected.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Replicate the gate matching logic from auto-dispatch.ts ─────────────────

/**
 * Returns true when validation content contains acceptable operational
 * verification evidence (structured or prose).  Mirrors the inline checks
 * in the "execute → complete-milestone" dispatch rule.
 */
function hasOperationalEvidence(validationContent: string): boolean {
  const structuredMatch =
    validationContent.includes("Operational") &&
    (validationContent.includes("MET") || validationContent.includes("N/A") || validationContent.includes("SATISFIED"));
  const proseMatch =
    /[Oo]perational[\s\S]{0,500}?(?:✅|pass|verified|confirmed|met|complete|true|yes|addressed|covered|satisfied|partially|n\/a|not[\s-]+applicable)/i.test(
      validationContent,
    );
  return structuredMatch || proseMatch;
}

// ─── Structured format ───────────────────────────────────────────────────────

test("structured: Operational + MET passes", () => {
  const content = `| Criteria       | Status |
| Operational    | MET    |
| Functional     | MET    |`;
  assert.ok(hasOperationalEvidence(content));
});

test("structured: Operational + N/A passes", () => {
  const content = `| Criteria       | Status |
| Operational    | N/A    |
| Functional     | MET    |`;
  assert.ok(hasOperationalEvidence(content));
});

test("structured: Operational present with MET on another row still passes (includes is content-wide)", () => {
  // The structured check uses .includes() across the entire content,
  // so "MET" on the Functional row satisfies the condition alongside
  // "Operational" anywhere in the document.
  const content = `| Criteria       | Status  |
| Operational    | PENDING |
| Functional     | MET     |`;
  assert.ok(hasOperationalEvidence(content));
});

test("structured: Operational alone without any MET or N/A anywhere fails", () => {
  const content = `| Criteria       | Status  |
| Operational    | PENDING |
| Functional     | PENDING |`;
  assert.ok(!hasOperationalEvidence(content));
});

// ─── Prose format ────────────────────────────────────────────────────────────

test('prose: "Operational: verified" passes', () => {
  const content = `## Validation Report
Operational: verified — all endpoints responsive.
Functional: tests pass.`;
  assert.ok(hasOperationalEvidence(content));
});

test('prose: "Operational checks confirmed" passes', () => {
  const content = `## Validation Report
Operational checks confirmed by smoke test suite.`;
  assert.ok(hasOperationalEvidence(content));
});

test('prose: "Operational — pass" passes', () => {
  const content = `Operational — pass (all services healthy)`;
  assert.ok(hasOperationalEvidence(content));
});

test('prose: "operational: addressed" passes (case-insensitive)', () => {
  const content = `operational: addressed in CI pipeline run #42.`;
  assert.ok(hasOperationalEvidence(content));
});

test('prose: "Operational: not applicable" passes', () => {
  const content = `Operational: not applicable for this library-only change.`;
  assert.ok(hasOperationalEvidence(content));
});

test('prose: "Operational: n/a" passes', () => {
  const content = `Operational: n/a — no runtime components.`;
  assert.ok(hasOperationalEvidence(content));
});

test('prose: "Operational: complete" passes', () => {
  const content = `Operational: complete — all health checks green.`;
  assert.ok(hasOperationalEvidence(content));
});

// ─── Issue #2862: checkmark emoji ────────────────────────────────────────────

test('prose: "Operational: ✅" checkmark emoji passes (issue #2862)', () => {
  const content = `- **Operational:** ✅ DECISIONS.md documents D009-D013`;
  assert.ok(hasOperationalEvidence(content));
});

// ─── Issue #2866: multi-line, "satisfied", markdown bold ─────────────────────

test('multi-line: verdict on next line after Operational heading passes (issue #2866)', () => {
  const content = `### Operational Verification
All endpoints responsive. Health checks pass.`;
  assert.ok(hasOperationalEvidence(content));
});

test('prose: "PARTIALLY SATISFIED" passes (issue #2866)', () => {
  const content = `Operational class: ⚠️ PARTIALLY SATISFIED`;
  assert.ok(hasOperationalEvidence(content));
});

test('prose: "FULLY SATISFIED" passes (issue #2866)', () => {
  const content = `**Operational**: FULLY SATISFIED — all monitoring in place.`;
  assert.ok(hasOperationalEvidence(content));
});

test('structured: Operational + SATISFIED passes (issue #2866)', () => {
  const content = `| Criteria       | Status    |
| Operational    | SATISFIED |`;
  assert.ok(hasOperationalEvidence(content));
});

test('table with markdown bold: **Operational** passes (issue #2866)', () => {
  const content = `| **Operational** | ⚠️ Partially satisfied — monitoring gap noted |`;
  assert.ok(hasOperationalEvidence(content));
});

test('multi-line: Operational label and "confirmed" separated by line break passes (issue #2866)', () => {
  const content = `## Operational
Smoke tests confirmed all services healthy after deploy.`;
  assert.ok(hasOperationalEvidence(content));
});

// ─── Rejection cases ─────────────────────────────────────────────────────────

test("no operational evidence: unrelated content fails", () => {
  const content = `## Validation Report
All functional tests pass.
Code coverage at 92%.`;
  assert.ok(!hasOperationalEvidence(content));
});

test("no operational evidence: word 'operational' buried without qualifying keyword fails", () => {
  const content = `## Validation Report
The operational aspects were not evaluated in this round.`;
  assert.ok(!hasOperationalEvidence(content));
});

test("no operational evidence: empty content fails", () => {
  assert.ok(!hasOperationalEvidence(""));
});
