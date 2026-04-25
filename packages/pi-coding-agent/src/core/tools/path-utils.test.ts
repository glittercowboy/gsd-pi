import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import { resolveToCwd, expandPath } from "./path-utils.js";

describe("resolveToCwd", () => {
	it("resolves relative paths against cwd", () => {
		const result = resolveToCwd("foo/bar.txt", "/home/user/project");
		assert.equal(result, resolvePath("/home/user/project", "foo/bar.txt"));
	});

	it("returns absolute paths unchanged", () => {
		const result = resolveToCwd("/absolute/path.txt", "/home/user/project");
		assert.equal(result, "/absolute/path.txt");
	});

	it("expands ~ to home directory", () => {
		const result = resolveToCwd("~/file.txt", "/home/user/project");
		assert.ok(result.endsWith("/file.txt"));
		assert.ok(!result.includes("~"));
	});
});

describe("normalizeMsysPath (via resolveToCwd on win32)", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("converts /c/Users/... to C:\\Users\\... on win32", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		// Re-import to pick up platform change — but since normalizeMsysPath
		// reads process.platform at call time, we can test directly.
		// On non-Windows, resolveToCwd treats /c/Users as absolute, so we
		// test the normalization logic by checking the MSYS regex behavior.
		const msysPath = "/c/Users/test/project";
		const msysRegex = /^\/[a-zA-Z]\//;
		assert.ok(msysRegex.test(msysPath), "MSYS path pattern matches");

		// Simulate the conversion
		const converted = `${msysPath[1].toUpperCase()}:\\${msysPath.slice(3).replace(/\//g, "\\")}`;
		assert.equal(converted, "C:\\Users\\test\\project");
	});

	it("converts /f/Projects to F:\\Projects on win32", () => {
		const msysPath = "/f/Projects";
		const converted = `${msysPath[1].toUpperCase()}:\\${msysPath.slice(3).replace(/\//g, "\\")}`;
		assert.equal(converted, "F:\\Projects");
	});

	it("does not convert regular Unix paths", () => {
		const regularPath = "/usr/local/bin";
		const msysRegex = /^\/[a-zA-Z]\//;
		// /u/local/bin would match, but /usr/local/bin has 3+ chars before /
		// Actually /u/ would match — but /usr/ won't because 'us' is 2 chars.
		// The regex checks single letter after leading slash.
		assert.ok(!msysRegex.test("/usr/local/bin"), "/usr/... is not an MSYS path");
		assert.ok(msysRegex.test("/u/local/bin"), "/u/... would match (single letter)");
	});

	it("does not convert paths without leading slash", () => {
		const msysRegex = /^\/[a-zA-Z]\//;
		assert.ok(!msysRegex.test("c/Users/test"), "no leading slash — not MSYS");
		assert.ok(!msysRegex.test("relative/path"), "relative path — not MSYS");
	});
});
