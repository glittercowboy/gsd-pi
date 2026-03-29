import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { repairToolJson, hasYamlBulletLists } from "../repair-tool-json.ts";

describe("repairToolJson — YAML bullet list repair (#2660)", () => {
	// ── Detection ──────────────────────────────────────────────────────────

	test("hasYamlBulletLists detects YAML-style bullets", () => {
		assert.equal(
			hasYamlBulletLists('"keyDecisions": - Used Web Notification API'),
			true,
		);
	});

	test("hasYamlBulletLists ignores negative numbers", () => {
		assert.equal(
			hasYamlBulletLists('"offset": -1'),
			false,
			"negative number should not be detected as YAML bullet",
		);
	});

	test("hasYamlBulletLists returns false for valid JSON", () => {
		assert.equal(
			hasYamlBulletLists('{"keyDecisions": ["item1", "item2"]}'),
			false,
		);
	});

	// ── Single bullet item ────────────────────────────────────────────────

	test("repairs single YAML bullet to JSON array", () => {
		const malformed = '{"keyDecisions": - Used Web Notification API}';
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);
		assert.deepEqual(parsed.keyDecisions, ["Used Web Notification API"]);
	});

	// ── Multiple bullet items (newline-separated) ─────────────────────────

	test("repairs multiple YAML bullets separated by newlines", () => {
		const malformed =
			'{"keyDecisions": - Used Web Notification API\n  - Chose Tauri over Electron\n  - Adopted SQLite for storage, "title": "M005"}';
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);
		assert.deepEqual(parsed.keyDecisions, [
			"Used Web Notification API",
			"Chose Tauri over Electron",
			"Adopted SQLite for storage",
		]);
		assert.equal(parsed.title, "M005");
	});

	// ── Multiple fields with YAML bullets ─────────────────────────────────

	test("repairs multiple fields each with YAML bullet lists", () => {
		const malformed =
			'{"keyDecisions": - decision one\n  - decision two, "keyFiles": - src/lib.rs — Extended menu\n  - src/main.ts — Entry point, "title": "done"}';
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);
		assert.deepEqual(parsed.keyDecisions, ["decision one", "decision two"]);
		assert.deepEqual(parsed.keyFiles, [
			"src/lib.rs \u2014 Extended menu",
			"src/main.ts \u2014 Entry point",
		]);
		assert.equal(parsed.title, "done");
	});

	// ── Exact reproduction from issue #2660 ───────────────────────────────

	test("repairs the exact malformed JSON from issue #2660", () => {
		const malformed = `{"milestoneId": "M005", "title": "Native Desktop Polish", "oneLiner": "summary", "narrative": "details", "successCriteriaResults": "all pass", "definitionOfDoneResults": "all done", "requirementOutcomes": "met", "keyDecisions": - Used Web Notification API (new window.Notification()) instead of Tauri sendNotification wrapper, "keyFiles": - src-tauri/src/lib.rs \u2014 Extended menu builder with notification toggle, "lessonsLearned": - Always test notification permissions before sending, "followUps": "none", "deviations": "none", "verificationPassed": true}`;

		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);

		assert.equal(parsed.milestoneId, "M005");
		assert.equal(parsed.title, "Native Desktop Polish");
		assert.ok(Array.isArray(parsed.keyDecisions), "keyDecisions should be an array");
		assert.ok(parsed.keyDecisions[0].includes("Web Notification API"));
		assert.ok(Array.isArray(parsed.keyFiles), "keyFiles should be an array");
		assert.ok(parsed.keyFiles[0].includes("src-tauri/src/lib.rs"));
		assert.ok(Array.isArray(parsed.lessonsLearned), "lessonsLearned should be an array");
		assert.equal(parsed.verificationPassed, true);
	});

	// ── Passthrough for valid JSON ────────────────────────────────────────

	test("returns valid JSON unchanged", () => {
		const valid = '{"keyDecisions": ["item1", "item2"], "count": -5}';
		const result = repairToolJson(valid);
		assert.equal(result, valid, "valid JSON should be returned unchanged");
	});

	// ── Negative numbers are preserved ────────────────────────────────────

	test("does not mangle negative numbers", () => {
		const valid = '{"offset": -1, "limit": -100}';
		const result = repairToolJson(valid);
		assert.equal(result, valid);
	});
});
