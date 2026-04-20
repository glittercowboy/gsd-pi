/**
 * Tests for slice-level parallel eligibility.
 * Verifies getEligibleSlices() correctly determines which slices
 * can run in parallel based on dependency satisfaction.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getEligibleSlices } from "../slice-parallel-eligibility.js";

describe("getEligibleSlices", () => {
  it("diamond DAG: S01 done, S02 depends:[S01], S03 depends:[S01] → both eligible", () => {
    const slices = [
      { id: "S01", done: true, depends: [] },
      { id: "S02", done: false, depends: ["S01"] },
      { id: "S03", done: false, depends: ["S01"] },
    ];
    const completed = new Set(["S01"]);
    const result = getEligibleSlices(slices, completed);
    const ids = result.map(s => s.id);
    assert.deepStrictEqual(ids.sort(), ["S02", "S03"]);
  });

  it("linear chain: S01→S02→S03, only S01 done → only S02 eligible", () => {
    const slices = [
      { id: "S01", done: true, depends: [] },
      { id: "S02", done: false, depends: ["S01"] },
      { id: "S03", done: false, depends: ["S02"] },
    ];
    const completed = new Set(["S01"]);
    const result = getEligibleSlices(slices, completed);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "S02");
  });

  it("no deps declared: S01 done, S02 no deps, S03 no deps → only S02 eligible (positional fallback)", () => {
    const slices = [
      { id: "S01", done: true, depends: [] },
      { id: "S02", done: false, depends: [] },
      { id: "S03", done: false, depends: [] },
    ];
    const completed = new Set(["S01"]);
    const result = getEligibleSlices(slices, completed);
    // Positional fallback: when no deps declared, only the first non-done slice
    // after all positionally-earlier slices are done is eligible
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "S02");
  });

  it("all done: empty result", () => {
    const slices = [
      { id: "S01", done: true, depends: [] },
      { id: "S02", done: true, depends: ["S01"] },
      { id: "S03", done: true, depends: ["S02"] },
    ];
    const completed = new Set(["S01", "S02", "S03"]);
    const result = getEligibleSlices(slices, completed);
    assert.equal(result.length, 0);
  });

  it("empty input: empty result", () => {
    const result = getEligibleSlices([], new Set());
    assert.equal(result.length, 0);
  });

  it("mixed deps and no-deps: only dep-satisfied slices with explicit deps are eligible alongside positional", () => {
    const slices = [
      { id: "S01", done: true, depends: [] },
      { id: "S02", done: false, depends: ["S01"] },  // explicit dep satisfied
      { id: "S03", done: false, depends: [] },         // no deps, positional fallback
      { id: "S04", done: false, depends: ["S01"] },  // explicit dep satisfied
    ];
    const completed = new Set(["S01"]);
    const result = getEligibleSlices(slices, completed);
    const ids = result.map(s => s.id);
    // S02 and S04 have explicit deps satisfied; S03 has no deps but
    // positionally S02 (before it) is not done, so S03 is blocked by positional rule
    assert.ok(ids.includes("S02"), "S02 should be eligible (dep on S01 satisfied)");
    assert.ok(ids.includes("S04"), "S04 should be eligible (dep on S01 satisfied)");
  });

  it("unsatisfied dependency blocks slice", () => {
    const slices = [
      { id: "S01", done: false, depends: [] },
      { id: "S02", done: false, depends: ["S01"] },
    ];
    const completed = new Set<string>();
    const result = getEligibleSlices(slices, completed);
    // S01 has no deps and is first → eligible by positional
    // S02 depends on S01 which is not completed → blocked
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "S01");
  });
});
