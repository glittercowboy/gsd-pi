import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { repairToolJson, hasYamlBulletLists, hasXmlParameterTags, hasTruncatedNumbers } from "../repair-tool-json.js";

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

// ═══════════════════════════════════════════════════════════════════════════
// XML parameter tag repair (#3403)
// ═══════════════════════════════════════════════════════════════════════════

describe("repairToolJson — XML parameter tag stripping (#3403)", () => {
	test("hasXmlParameterTags detects opening tags", () => {
		assert.equal(
			hasXmlParameterTags('<parameter name="narrative">some text</parameter>'),
			true,
		);
	});

	test("hasXmlParameterTags returns false for clean JSON", () => {
		assert.equal(
			hasXmlParameterTags('{"narrative": "some text"}'),
			false,
		);
	});

	test("strips XML parameter tags from JSON values", () => {
		const malformed = '{"sliceId": "S03", "narrative": <parameter name="narrative">The slice work</parameter>}';
		const repaired = repairToolJson(malformed);
		// After stripping tags, the content should be parseable or at least tag-free
		assert.ok(!repaired.includes("<parameter"), "should not contain <parameter tags");
		assert.ok(!repaired.includes("</parameter>"), "should not contain </parameter> tags");
	});

	test("handles mixed XML and JSON content", () => {
		const malformed = '{"oneLiner": "done", "verification": <parameter name="verification">all tests pass</parameter>}';
		const repaired = repairToolJson(malformed);
		assert.ok(!repaired.includes("<parameter"), "XML tags should be stripped");
		assert.ok(repaired.includes("all tests pass"), "content should be preserved");
	});

	test("promotes XML parameters trapped inside valid JSON string values", () => {
		const malformed =
			'{"narrative":"text.</narrative>\\n<parameter name=\\"verification\\">all tests pass</parameter>\\n<parameter name=\\"verificationEvidence\\">[\\"npm test\\"]</parameter>","oneLiner":"done"}';
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);

		assert.equal(parsed.narrative, "text.");
		assert.equal(parsed.verification, "all tests pass");
		assert.deepEqual(parsed.verificationEvidence, ["npm test"]);
		assert.equal(parsed.oneLiner, "done");
		assert.ok(!parsed.narrative.includes("<parameter"), "narrative should not retain leaked XML");
	});

	test("promotes dangling XML parameters trapped inside valid JSON string values", () => {
		const malformed = JSON.stringify({
			narrative:
				'text.\n<parameter name="verification">all tests pass\n<parameter name="verificationEvidence">["npm test"]',
			oneLiner: "done",
		});
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);

		assert.equal(parsed.narrative, "text.");
		assert.equal(parsed.verification, "all tests pass");
		assert.deepEqual(parsed.verificationEvidence, ["npm test"]);
		assert.equal(parsed.oneLiner, "done");
		assert.ok(!parsed.narrative.includes("<parameter"), "narrative should not retain leaked XML");
	});

	test("promotes mixed dangling and closed XML parameters from valid JSON string values", () => {
		const malformed = JSON.stringify({
			narrative:
				'text.\n<parameter name="verification">all tests pass\n<parameter name="verificationEvidence">["npm test"]</parameter>',
			oneLiner: "done",
		});
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);

		assert.equal(parsed.narrative, "text.");
		assert.equal(parsed.verification, "all tests pass");
		assert.deepEqual(parsed.verificationEvidence, ["npm test"]);
		assert.equal(parsed.oneLiner, "done");
		assert.ok(!parsed.narrative.includes("<parameter"), "narrative should not retain leaked XML");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Truncated number repair (#3464)
// ═══════════════════════════════════════════════════════════════════════════

describe("repairToolJson — truncated number repair (#3464)", () => {
	test("hasTruncatedNumbers detects bare comma after colon", () => {
		assert.equal(hasTruncatedNumbers('"exitCode": ,'), true);
	});

	test("hasTruncatedNumbers detects bare minus before comma", () => {
		assert.equal(hasTruncatedNumbers('"exitCode": -,'), true);
	});

	test("hasTruncatedNumbers detects bare minus before closing brace", () => {
		assert.equal(hasTruncatedNumbers('"durationMs": -}'), true);
	});

	test("hasTruncatedNumbers returns false for valid numbers", () => {
		assert.equal(hasTruncatedNumbers('"exitCode": 0, "durationMs": 1234'), false);
	});

	test("hasTruncatedNumbers returns false for negative numbers", () => {
		assert.equal(hasTruncatedNumbers('"exitCode": -1, "offset": -100'), false);
	});

	test("repairs truncated exitCode with bare comma", () => {
		const malformed = '{"command": "npm test", "exitCode": , "verdict": "pass", "durationMs": 500}';
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);
		assert.equal(parsed.exitCode, 0);
		assert.equal(parsed.durationMs, 500);
	});

	test("repairs truncated exitCode with bare minus", () => {
		const malformed = '{"command": "npm test", "exitCode": -, "verdict": "pass", "durationMs": 1234}';
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);
		assert.equal(parsed.exitCode, 0);
		assert.equal(parsed.verdict, "pass");
	});

	test("repairs truncated durationMs at end of object", () => {
		const malformed = '{"command": "npm test", "exitCode": 0, "verdict": "pass", "durationMs": -}';
		const repaired = repairToolJson(malformed);
		const parsed = JSON.parse(repaired);
		assert.equal(parsed.durationMs, 0);
		assert.equal(parsed.exitCode, 0);
	});

	test("does not mangle valid negative numbers", () => {
		const valid = '{"exitCode": -1, "offset": -100}';
		const repaired = repairToolJson(valid);
		const parsed = JSON.parse(repaired);
		assert.equal(parsed.exitCode, -1);
		assert.equal(parsed.offset, -100);
	});
});
