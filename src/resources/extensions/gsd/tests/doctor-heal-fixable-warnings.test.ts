import test from "node:test";
import assert from "node:assert/strict";
import { isDoctorHealActionable } from "../commands-handlers.js";

test("doctor heal actionable filter keeps fixable warnings and errors", () => {
  assert.equal(isDoctorHealActionable({ fixable: true, severity: "warning" }), true);
  assert.equal(isDoctorHealActionable({ fixable: true, severity: "error" }), true);
});

test("doctor heal actionable filter excludes info and non-fixable issues", () => {
  assert.equal(isDoctorHealActionable({ fixable: true, severity: "info" }), false);
  assert.equal(isDoctorHealActionable({ fixable: false, severity: "warning" }), false);
  assert.equal(isDoctorHealActionable({ fixable: false, severity: "error" }), false);
});
