import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp } from "../timestamp.js";

describe("formatTimestamp", () => {
	// Use a fixed local timestamp to avoid timezone issues
	const d = new Date(2026, 2, 24, 10, 34, 0); // Mar 24, 2026 10:34:00 local time
	const ts = d.getTime();

	test("date-time-iso format (default)", () => {
		assert.equal(formatTimestamp(ts, "date-time-iso"), "2026-03-24 10:34");
		assert.equal(formatTimestamp(ts), "2026-03-24 10:34"); // default
	});

	test("date-time-us format", () => {
		assert.equal(formatTimestamp(ts, "date-time-us"), "03-24-2026 10:34 AM");
	});

	test("US format handles PM correctly", () => {
		const pm = new Date(2026, 2, 24, 14, 5, 0).getTime();
		assert.equal(formatTimestamp(pm, "date-time-us"), "03-24-2026 2:05 PM");
	});

	test("US format handles noon as 12 PM", () => {
		const noon = new Date(2026, 2, 24, 12, 0, 0).getTime();
		assert.equal(formatTimestamp(noon, "date-time-us"), "03-24-2026 12:00 PM");
	});

	test("US format handles midnight as 12 AM", () => {
		const midnight = new Date(2026, 2, 24, 0, 0, 0).getTime();
		assert.equal(formatTimestamp(midnight, "date-time-us"), "03-24-2026 12:00 AM");
	});

	test("ISO format pads single digit months and days", () => {
		const jan1 = new Date(2026, 0, 1, 9, 5, 0).getTime();
		assert.equal(formatTimestamp(jan1, "date-time-iso"), "2026-01-01 09:05");
	});
});
