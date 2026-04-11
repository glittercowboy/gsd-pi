/**
 * Regression test for #2931: completing-milestone gate should treat
 * "None required", "N/A", "Not applicable", etc. as equivalent to "none"
 * and skip the operational verification content check entirely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isVerificationNotApplicable } from "../auto-dispatch.ts";

test("isVerificationNotApplicable: bare 'none' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("none"), true);
});

test("isVerificationNotApplicable: 'None' (capitalized) is not applicable", () => {
  assert.equal(isVerificationNotApplicable("None"), true);
});

test("isVerificationNotApplicable: 'NONE' (uppercase) is not applicable", () => {
  assert.equal(isVerificationNotApplicable("NONE"), true);
});

test("isVerificationNotApplicable: 'None required' is not applicable (#2931)", () => {
  assert.equal(isVerificationNotApplicable("None required"), true);
});

test("isVerificationNotApplicable: 'None needed' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("None needed"), true);
});

test("isVerificationNotApplicable: 'None planned' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("None planned"), true);
});

test("isVerificationNotApplicable: 'None — <rationale>' is not applicable (#3897)", () => {
  assert.equal(
    isVerificationNotApplicable("None — no new background jobs, workers, or lifecycle changes introduced."),
    true,
  );
});

test("isVerificationNotApplicable: em dash without spaces is not applicable (#3897)", () => {
  assert.equal(isVerificationNotApplicable("none—inline"), true);
});

test("isVerificationNotApplicable: 'N/A' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("N/A"), true);
});

test("isVerificationNotApplicable: 'n/a' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("n/a"), true);
});

test("isVerificationNotApplicable: 'Not applicable' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("Not applicable"), true);
});

test("isVerificationNotApplicable: 'Not required' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("Not required"), true);
});

test("isVerificationNotApplicable: 'Not needed' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("Not needed"), true);
});

test("isVerificationNotApplicable: 'No operational verification needed' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("No operational verification needed"), true);
});

test("isVerificationNotApplicable: 'No operational' is not applicable", () => {
  assert.equal(isVerificationNotApplicable("No operational"), true);
});

test("isVerificationNotApplicable: empty string is not applicable", () => {
  assert.equal(isVerificationNotApplicable(""), true);
});

test("isVerificationNotApplicable: whitespace-only is not applicable", () => {
  assert.equal(isVerificationNotApplicable("   "), true);
});

// Positive cases: these SHOULD require verification
test("isVerificationNotApplicable: 'Run load tests' requires verification", () => {
  assert.equal(isVerificationNotApplicable("Run load tests"), false);
});

test("isVerificationNotApplicable: 'Verify API response times under load' requires verification", () => {
  assert.equal(isVerificationNotApplicable("Verify API response times under load"), false);
});

test("isVerificationNotApplicable: 'Monitor error rates for 24h' requires verification", () => {
  assert.equal(isVerificationNotApplicable("Monitor error rates for 24h"), false);
});

// Regression: #3634 — "Not provided." default from plan-milestone
test("isVerificationNotApplicable: 'Not provided.' is not applicable (#3634)", () => {
  assert.equal(isVerificationNotApplicable("Not provided."), true);
});

test("isVerificationNotApplicable: 'Not provided' (no period) is not applicable (#3634)", () => {
  assert.equal(isVerificationNotApplicable("Not provided"), true);
});

test("isVerificationNotApplicable: trailing period does not defeat match (#3634)", () => {
  assert.equal(isVerificationNotApplicable("None required."), true);
  assert.equal(isVerificationNotApplicable("N/A."), true);
  assert.equal(isVerificationNotApplicable("Not applicable."), true);
});
