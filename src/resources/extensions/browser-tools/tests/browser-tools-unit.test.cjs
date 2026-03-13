/**
 * browser-tools — Node-side unit tests
 *
 * Uses jiti for TypeScript imports (the resolve-ts ESM hook breaks on core.js),
 * node:test for the runner, and node:assert/strict for assertions.
 *
 * Tests pure functions from utils.ts, state.ts accessors, evaluate-helpers.ts
 * syntax, and constrainScreenshot from capture.ts.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jiti = require("jiti")(__filename, { interopDefault: true, debug: false });

// ---------------------------------------------------------------------------
// Module imports via jiti
// ---------------------------------------------------------------------------

const {
	parseRef,
	formatVersionedRef,
	staleRefGuidance,
	formatCompactStateSummary,
	verificationFromChecks,
	verificationLine,
	sanitizeArtifactName,
	isCriticalResourceType,
	getUrlHash,
	firstErrorLine,
	formatArtifactTimestamp,
} = jiti("../utils.ts");

const {
	getBrowser,
	setBrowser,
	getContext,
	setContext,
	getActiveFrame,
	setActiveFrame,
	getSessionStartedAt,
	setSessionStartedAt,
	getSessionArtifactDir,
	setSessionArtifactDir,
	getCurrentRefMap,
	setCurrentRefMap,
	getRefVersion,
	setRefVersion,
	getRefMetadata,
	setRefMetadata,
	getLastActionBeforeState,
	setLastActionBeforeState,
	getLastActionAfterState,
	setLastActionAfterState,
	resetAllState,
} = jiti("../state.ts");

const { EVALUATE_HELPERS_SOURCE } = jiti("../evaluate-helpers.ts");

const { constrainScreenshot } = jiti("../capture.ts");

// ---------------------------------------------------------------------------
// utils.ts — parseRef
// ---------------------------------------------------------------------------

describe("parseRef", () => {
	it("parses a valid versioned ref", () => {
		const result = parseRef("@v3:e12");
		assert.deepStrictEqual(result, {
			key: "e12",
			version: 3,
			display: "@v3:e12",
		});
	});

	it("parses a ref without leading @", () => {
		const result = parseRef("v1:e5");
		assert.deepStrictEqual(result, {
			key: "e5",
			version: 1,
			display: "@v1:e5",
		});
	});

	it("handles legacy (unversioned) format", () => {
		const result = parseRef("@e7");
		assert.deepStrictEqual(result, {
			key: "e7",
			version: null,
			display: "@e7",
		});
	});

	it("trims whitespace", () => {
		const result = parseRef("  @v2:e1  ");
		assert.equal(result.key, "e1");
		assert.equal(result.version, 2);
	});

	it("is case-insensitive", () => {
		const result = parseRef("@V10:E3");
		assert.equal(result.key, "e3");
		assert.equal(result.version, 10);
	});
});

// ---------------------------------------------------------------------------
// utils.ts — formatVersionedRef
// ---------------------------------------------------------------------------

describe("formatVersionedRef", () => {
	it("formats a versioned ref string", () => {
		assert.equal(formatVersionedRef(5, "e3"), "@v5:e3");
	});

	it("formats version 0", () => {
		assert.equal(formatVersionedRef(0, "e1"), "@v0:e1");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — staleRefGuidance
// ---------------------------------------------------------------------------

describe("staleRefGuidance", () => {
	it("includes the ref display and reason", () => {
		const result = staleRefGuidance("@v2:e5", "element removed");
		assert.ok(result.includes("@v2:e5"));
		assert.ok(result.includes("element removed"));
		assert.ok(result.includes("browser_snapshot_refs"));
	});
});

// ---------------------------------------------------------------------------
// utils.ts — formatCompactStateSummary
// ---------------------------------------------------------------------------

describe("formatCompactStateSummary", () => {
	it("formats a compact page state into a readable summary", () => {
		/** @type {import('../state.ts').CompactPageState} */
		const mockState = {
			url: "http://localhost:3000/dashboard",
			title: "Dashboard",
			focus: "input#search",
			headings: ["Welcome", "Recent Activity"],
			bodyText: "",
			counts: {
				landmarks: 3,
				buttons: 5,
				links: 12,
				inputs: 2,
			},
			dialog: { count: 0, title: "" },
			selectorStates: {},
		};

		const summary = formatCompactStateSummary(mockState);
		assert.ok(summary.includes("Title: Dashboard"));
		assert.ok(summary.includes("URL: http://localhost:3000/dashboard"));
		assert.ok(summary.includes("3 landmarks"));
		assert.ok(summary.includes("5 buttons"));
		assert.ok(summary.includes("12 links"));
		assert.ok(summary.includes("2 inputs"));
		assert.ok(summary.includes("Focused: input#search"));
		assert.ok(summary.includes('H1 "Welcome"'));
		assert.ok(summary.includes('H2 "Recent Activity"'));
	});

	it("omits focus line when empty", () => {
		const mockState = {
			url: "http://example.com",
			title: "Test",
			focus: "",
			headings: [],
			bodyText: "",
			counts: { landmarks: 0, buttons: 0, links: 0, inputs: 0 },
			dialog: { count: 0, title: "" },
			selectorStates: {},
		};
		const summary = formatCompactStateSummary(mockState);
		assert.ok(!summary.includes("Focused:"));
	});

	it("includes dialog title when present", () => {
		const mockState = {
			url: "http://example.com",
			title: "Test",
			focus: "",
			headings: [],
			bodyText: "",
			counts: { landmarks: 0, buttons: 0, links: 0, inputs: 0 },
			dialog: { count: 1, title: "Confirm Delete" },
			selectorStates: {},
		};
		const summary = formatCompactStateSummary(mockState);
		assert.ok(summary.includes('Active dialog: "Confirm Delete"'));
	});
});

// ---------------------------------------------------------------------------
// utils.ts — verificationFromChecks
// ---------------------------------------------------------------------------

describe("verificationFromChecks", () => {
	it("returns verified=true when at least one check passes", () => {
		const checks = [
			{ name: "url_changed", passed: true },
			{ name: "title_changed", passed: false },
		];
		const result = verificationFromChecks(checks);
		assert.equal(result.verified, true);
		assert.ok(result.verificationSummary.includes("PASS"));
		assert.ok(result.verificationSummary.includes("url_changed"));
		assert.equal(result.retryHint, undefined);
	});

	it("returns verified=false when no checks pass", () => {
		const checks = [
			{ name: "url_changed", passed: false },
			{ name: "title_changed", passed: false },
		];
		const result = verificationFromChecks(checks, "try clicking again");
		assert.equal(result.verified, false);
		assert.ok(result.verificationSummary.includes("SOFT-FAIL"));
		assert.equal(result.retryHint, "try clicking again");
	});

	it("lists multiple passing checks", () => {
		const checks = [
			{ name: "a", passed: true },
			{ name: "b", passed: true },
		];
		const result = verificationFromChecks(checks);
		assert.ok(result.verificationSummary.includes("a"));
		assert.ok(result.verificationSummary.includes("b"));
	});
});

// ---------------------------------------------------------------------------
// utils.ts — verificationLine
// ---------------------------------------------------------------------------

describe("verificationLine", () => {
	it("formats a verification result into a single line", () => {
		const result = {
			verified: true,
			checks: [],
			verificationSummary: "PASS (url_changed)",
		};
		const line = verificationLine(result);
		assert.equal(line, "Verification: PASS (url_changed)");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — sanitizeArtifactName
// ---------------------------------------------------------------------------

describe("sanitizeArtifactName", () => {
	it("passes through valid names", () => {
		assert.equal(sanitizeArtifactName("my-trace", "default"), "my-trace");
	});

	it("replaces special characters with hyphens", () => {
		assert.equal(sanitizeArtifactName("hello world!@#", "default"), "hello-world");
	});

	it("strips leading/trailing hyphens", () => {
		assert.equal(sanitizeArtifactName("  --foo--  ", "default"), "foo");
	});

	it("returns fallback for empty string", () => {
		assert.equal(sanitizeArtifactName("", "fallback"), "fallback");
	});

	it("returns fallback for whitespace-only string", () => {
		assert.equal(sanitizeArtifactName("   ", "fallback"), "fallback");
	});

	it("returns fallback for all-special-chars string", () => {
		assert.equal(sanitizeArtifactName("@#$%", "default"), "default");
	});

	it("preserves dots and underscores", () => {
		assert.equal(sanitizeArtifactName("file_name.ext", "default"), "file_name.ext");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — isCriticalResourceType
// ---------------------------------------------------------------------------

describe("isCriticalResourceType", () => {
	it("returns true for document", () => {
		assert.equal(isCriticalResourceType("document"), true);
	});

	it("returns true for fetch", () => {
		assert.equal(isCriticalResourceType("fetch"), true);
	});

	it("returns true for xhr", () => {
		assert.equal(isCriticalResourceType("xhr"), true);
	});

	it("returns false for image", () => {
		assert.equal(isCriticalResourceType("image"), false);
	});

	it("returns false for font", () => {
		assert.equal(isCriticalResourceType("font"), false);
	});

	it("returns false for stylesheet", () => {
		assert.equal(isCriticalResourceType("stylesheet"), false);
	});

	it("returns false for script", () => {
		assert.equal(isCriticalResourceType("script"), false);
	});
});

// ---------------------------------------------------------------------------
// utils.ts — getUrlHash
// ---------------------------------------------------------------------------

describe("getUrlHash", () => {
	it("returns the hash from a URL", () => {
		assert.equal(getUrlHash("http://example.com/page#section"), "#section");
	});

	it("returns empty string when no hash", () => {
		assert.equal(getUrlHash("http://example.com/page"), "");
	});

	it("returns empty string for invalid URL", () => {
		assert.equal(getUrlHash("not-a-url"), "");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — firstErrorLine
// ---------------------------------------------------------------------------

describe("firstErrorLine", () => {
	it("extracts first line from an Error", () => {
		const err = new Error("line1\nline2\nline3");
		assert.equal(firstErrorLine(err), "line1");
	});

	it("handles string errors", () => {
		assert.equal(firstErrorLine("something broke"), "something broke");
	});

	it("handles null/undefined", () => {
		assert.equal(firstErrorLine(null), "unknown error");
		assert.equal(firstErrorLine(undefined), "unknown error");
	});

	it("handles objects without message property", () => {
		// {} has no .message, so falls to String({}) = "[object Object]"
		assert.equal(firstErrorLine({}), "[object Object]");
	});

	it("handles objects with empty message", () => {
		assert.equal(firstErrorLine({ message: "" }), "unknown error");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — formatArtifactTimestamp
// ---------------------------------------------------------------------------

describe("formatArtifactTimestamp", () => {
	it("formats a timestamp into an ISO-like string with dashes", () => {
		// 2024-01-15T10:30:45.123Z
		const ts = new Date("2024-01-15T10:30:45.123Z").getTime();
		const result = formatArtifactTimestamp(ts);
		// Should replace colons and dots with dashes
		assert.ok(!result.includes(":"));
		assert.ok(!result.includes("."));
		assert.ok(result.includes("2024-01-15"));
	});
});

// ---------------------------------------------------------------------------
// evaluate-helpers.ts — EVALUATE_HELPERS_SOURCE
// ---------------------------------------------------------------------------

describe("EVALUATE_HELPERS_SOURCE", () => {
	it("is a parseable string (valid JavaScript)", () => {
		assert.doesNotThrow(() => {
			new Function(EVALUATE_HELPERS_SOURCE);
		});
	});

	const expectedFunctions = [
		"cssPath",
		"simpleHash",
		"isVisible",
		"isEnabled",
		"inferRole",
		"accessibleName",
		"isInteractiveEl",
		"domPath",
		"selectorHints",
	];

	for (const fnName of expectedFunctions) {
		it(`contains assignment for pi.${fnName}`, () => {
			assert.ok(
				EVALUATE_HELPERS_SOURCE.includes(`pi.${fnName} = function`),
				`Expected pi.${fnName} = function assignment in source`,
			);
		});
	}
});

// ---------------------------------------------------------------------------
// state.ts — accessor round-trips
// ---------------------------------------------------------------------------

describe("state accessors", () => {
	beforeEach(() => {
		resetAllState();
	});

	it("setBrowser/getBrowser round-trip", () => {
		assert.equal(getBrowser(), null);
		const fakeBrowser = { close: () => {} };
		setBrowser(fakeBrowser);
		assert.equal(getBrowser(), fakeBrowser);
	});

	it("setContext/getContext round-trip", () => {
		assert.equal(getContext(), null);
		const fakeContext = { newPage: () => {} };
		setContext(fakeContext);
		assert.equal(getContext(), fakeContext);
	});

	it("setActiveFrame/getActiveFrame round-trip", () => {
		assert.equal(getActiveFrame(), null);
		const fakeFrame = { name: () => "test" };
		setActiveFrame(fakeFrame);
		assert.equal(getActiveFrame(), fakeFrame);
	});

	it("setSessionStartedAt/getSessionStartedAt round-trip", () => {
		assert.equal(getSessionStartedAt(), null);
		setSessionStartedAt(1234567890);
		assert.equal(getSessionStartedAt(), 1234567890);
	});

	it("setSessionArtifactDir/getSessionArtifactDir round-trip", () => {
		assert.equal(getSessionArtifactDir(), null);
		setSessionArtifactDir("/tmp/artifacts");
		assert.equal(getSessionArtifactDir(), "/tmp/artifacts");
	});

	it("setCurrentRefMap/getCurrentRefMap round-trip", () => {
		assert.deepStrictEqual(getCurrentRefMap(), {});
		const refMap = { e1: { ref: "e1", tag: "button" } };
		setCurrentRefMap(refMap);
		assert.deepStrictEqual(getCurrentRefMap(), refMap);
	});

	it("setRefVersion/getRefVersion round-trip", () => {
		assert.equal(getRefVersion(), 0);
		setRefVersion(5);
		assert.equal(getRefVersion(), 5);
	});

	it("setRefMetadata/getRefMetadata round-trip", () => {
		assert.equal(getRefMetadata(), null);
		const metadata = { url: "http://test.com", timestamp: 123, interactiveOnly: true, limit: 40, version: 1 };
		setRefMetadata(metadata);
		assert.deepStrictEqual(getRefMetadata(), metadata);
	});

	it("setLastActionBeforeState/getLastActionBeforeState round-trip", () => {
		assert.equal(getLastActionBeforeState(), null);
		const state = { url: "http://test.com", title: "Test", focus: "", headings: [], bodyText: "", counts: { landmarks: 0, buttons: 0, links: 0, inputs: 0 }, dialog: { count: 0, title: "" }, selectorStates: {} };
		setLastActionBeforeState(state);
		assert.deepStrictEqual(getLastActionBeforeState(), state);
	});

	it("setLastActionAfterState/getLastActionAfterState round-trip", () => {
		assert.equal(getLastActionAfterState(), null);
		const state = { url: "http://test.com/after", title: "After", focus: "", headings: [], bodyText: "", counts: { landmarks: 0, buttons: 0, links: 0, inputs: 0 }, dialog: { count: 0, title: "" }, selectorStates: {} };
		setLastActionAfterState(state);
		assert.deepStrictEqual(getLastActionAfterState(), state);
	});
});

// ---------------------------------------------------------------------------
// state.ts — resetAllState
// ---------------------------------------------------------------------------

describe("resetAllState", () => {
	it("clears all state back to defaults", () => {
		// Set various state values
		setBrowser({ close: () => {} });
		setContext({ newPage: () => {} });
		setActiveFrame({ name: () => "frame" });
		setSessionStartedAt(9999);
		setSessionArtifactDir("/tmp/test");
		setCurrentRefMap({ e1: {} });
		setRefVersion(10);
		setRefMetadata({ url: "http://x", timestamp: 1, interactiveOnly: true, limit: 40, version: 1 });
		setLastActionBeforeState({ url: "before" });
		setLastActionAfterState({ url: "after" });

		// Reset
		resetAllState();

		// Verify all cleared
		assert.equal(getBrowser(), null);
		assert.equal(getContext(), null);
		assert.equal(getActiveFrame(), null);
		assert.equal(getSessionStartedAt(), null);
		assert.equal(getSessionArtifactDir(), null);
		assert.deepStrictEqual(getCurrentRefMap(), {});
		assert.equal(getRefVersion(), 0);
		assert.equal(getRefMetadata(), null);
		assert.equal(getLastActionBeforeState(), null);
		assert.equal(getLastActionAfterState(), null);
	});
});

// ---------------------------------------------------------------------------
// capture.ts — constrainScreenshot
// ---------------------------------------------------------------------------

describe("constrainScreenshot", () => {
	// Helper: create a synthetic JPEG buffer via sharp
	async function createTestJpeg(width, height) {
		const sharp = require("sharp");
		return sharp({
			create: {
				width,
				height,
				channels: 3,
				background: { r: 128, g: 128, b: 128 },
			},
		})
			.jpeg({ quality: 80 })
			.toBuffer();
	}

	// Helper: create a synthetic PNG buffer via sharp
	async function createTestPng(width, height) {
		const sharp = require("sharp");
		return sharp({
			create: {
				width,
				height,
				channels: 4,
				background: { r: 128, g: 128, b: 128, alpha: 1 },
			},
		})
			.png()
			.toBuffer();
	}

	it("passes through a small JPEG unchanged", async () => {
		const buf = await createTestJpeg(800, 600);
		const result = await constrainScreenshot(null, buf, "image/jpeg", 80);
		// Should return the same buffer (no resize needed)
		assert.equal(Buffer.isBuffer(result), true);
		const sharp = require("sharp");
		const meta = await sharp(result).metadata();
		assert.equal(meta.width, 800);
		assert.equal(meta.height, 600);
	});

	it("resizes an oversized JPEG within 1568px", async () => {
		const buf = await createTestJpeg(3000, 2000);
		const result = await constrainScreenshot(null, buf, "image/jpeg", 80);
		assert.equal(Buffer.isBuffer(result), true);

		const sharp = require("sharp");
		const meta = await sharp(result).metadata();
		// Both dimensions should be <= 1568
		assert.ok(meta.width <= 1568, `width ${meta.width} should be <= 1568`);
		assert.ok(meta.height <= 1568, `height ${meta.height} should be <= 1568`);
		// Aspect ratio preserved: 3000/2000 = 1.5, so width = 1568, height ~= 1045
		assert.equal(meta.width, 1568);
		assert.ok(meta.height > 1000 && meta.height < 1100);
		assert.equal(meta.format, "jpeg");
	});

	it("resizes an oversized PNG and returns PNG", async () => {
		const buf = await createTestPng(2500, 1800);
		const result = await constrainScreenshot(null, buf, "image/png", 80);
		assert.equal(Buffer.isBuffer(result), true);

		const sharp = require("sharp");
		const meta = await sharp(result).metadata();
		assert.ok(meta.width <= 1568, `width ${meta.width} should be <= 1568`);
		assert.ok(meta.height <= 1568, `height ${meta.height} should be <= 1568`);
		assert.equal(meta.format, "png");
	});

	it("handles an image where only height exceeds the limit", async () => {
		const buf = await createTestJpeg(1000, 2000);
		const result = await constrainScreenshot(null, buf, "image/jpeg", 80);
		const sharp = require("sharp");
		const meta = await sharp(result).metadata();
		assert.ok(meta.width <= 1568);
		assert.ok(meta.height <= 1568);
		// Height was the constraining dimension
		assert.equal(meta.height, 1568);
	});
});
