import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConflictsWith } from "../agents.js";

describe("parseConflictsWith", () => {
	it("parses comma-separated conflict list", () => {
		const result = parseConflictsWith("plan-milestone, plan-slice, research-milestone");
		assert.deepEqual(result, ["plan-milestone", "plan-slice", "research-milestone"]);
	});

	it("returns undefined for undefined input", () => {
		assert.equal(parseConflictsWith(undefined), undefined);
	});

	it("returns undefined for empty string", () => {
		assert.equal(parseConflictsWith(""), undefined);
	});

	it("handles single value without commas", () => {
		const result = parseConflictsWith("plan-milestone");
		assert.deepEqual(result, ["plan-milestone"]);
	});

	it("trims whitespace from values", () => {
		const result = parseConflictsWith("  plan-milestone ,  plan-slice  ");
		assert.deepEqual(result, ["plan-milestone", "plan-slice"]);
	});

	it("filters out empty entries from trailing commas", () => {
		const result = parseConflictsWith("plan-milestone,,plan-slice,");
		assert.deepEqual(result, ["plan-milestone", "plan-slice"]);
	});
});
