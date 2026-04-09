import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseMilestoneTarget } from "../commands/handlers/auto.js";

describe("parseMilestoneTarget", () => {
  it("extracts a simple milestone ID", () => {
    const result = parseMilestoneTarget("auto M016");
    assert.equal(result.milestoneId, "M016");
    assert.equal(result.rest, "auto");
  });

  it("extracts a milestone ID with unique suffix", () => {
    const result = parseMilestoneTarget("auto M001-a3b4c5 --verbose");
    assert.equal(result.milestoneId, "M001-a3b4c5");
    assert.equal(result.rest, "auto --verbose");
  });

  it("returns null when no milestone ID is present", () => {
    const result = parseMilestoneTarget("auto --verbose");
    assert.equal(result.milestoneId, null);
    assert.equal(result.rest, "auto --verbose");
  });

  it("extracts milestone ID with flags in any order", () => {
    const result = parseMilestoneTarget("auto --verbose M003 --debug");
    assert.equal(result.milestoneId, "M003");
    assert.equal(result.rest, "auto --verbose --debug");
  });

  it("returns null for plain 'auto'", () => {
    const result = parseMilestoneTarget("auto");
    assert.equal(result.milestoneId, null);
    assert.equal(result.rest, "auto");
  });

  it("extracts from 'next' command", () => {
    const result = parseMilestoneTarget("next M012");
    assert.equal(result.milestoneId, "M012");
    assert.equal(result.rest, "next");
  });

  it("handles milestone ID at the start of input", () => {
    const result = parseMilestoneTarget("M007");
    assert.equal(result.milestoneId, "M007");
    assert.equal(result.rest, "");
  });

  it("picks the first milestone ID when multiple appear", () => {
    // Edge case: user accidentally types two. First one wins.
    const result = parseMilestoneTarget("auto M001 M002");
    assert.equal(result.milestoneId, "M001");
    // M002 remains in rest since only the first match is removed
    assert.ok(result.rest.includes("M002"));
  });

  it("does not match bare numbers without M prefix", () => {
    const result = parseMilestoneTarget("auto 016");
    assert.equal(result.milestoneId, null);
  });
});
