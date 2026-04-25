// GSD-2 — Extension Sort Tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sortExtensionPaths } from "./extension-sort.js";

function createExtDir(base: string, id: string, deps?: string[]): string {
	const dir = join(base, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "extension-manifest.json"),
		JSON.stringify({
			id,
			name: id,
			version: "1.0.0",
			tier: "bundled",
			requires: { platform: ">=2.29.0" },
			...(deps ? { dependencies: { extensions: deps } } : {}),
		}),
	);
	writeFileSync(join(dir, "index.ts"), `export default function() {}`);
	return join(dir, "index.ts");
}

describe("sortExtensionPaths", () => {
	it("returns empty for empty input", () => {
		const result = sortExtensionPaths([]);
		assert.deepEqual(result.sortedPaths, []);
		assert.deepEqual(result.warnings, []);
	});

	it("sorts independent extensions alphabetically", () => {
		const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
		const pathC = createExtDir(base, "charlie");
		const pathA = createExtDir(base, "alpha");
		const pathB = createExtDir(base, "bravo");

		const result = sortExtensionPaths([pathC, pathA, pathB]);
		assert.deepEqual(result.sortedPaths, [pathA, pathB, pathC]);
		assert.equal(result.warnings.length, 0);
	});

	it("sorts dependencies before dependents", () => {
		const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
		const pathBase = createExtDir(base, "base-ext");
		const pathDependent = createExtDir(base, "dependent-ext", ["base-ext"]);

		// Pass dependent first — sort should reorder
		const result = sortExtensionPaths([pathDependent, pathBase]);
		assert.deepEqual(result.sortedPaths, [pathBase, pathDependent]);
		assert.equal(result.warnings.length, 0);
	});

	it("handles deep dependency chains", () => {
		const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
		const pathA = createExtDir(base, "a");
		const pathB = createExtDir(base, "b", ["a"]);
		const pathC = createExtDir(base, "c", ["b"]);

		const result = sortExtensionPaths([pathC, pathB, pathA]);
		assert.deepEqual(result.sortedPaths, [pathA, pathB, pathC]);
		assert.equal(result.warnings.length, 0);
	});

	it("warns about missing dependencies but still loads", () => {
		const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
		const pathExt = createExtDir(base, "my-ext", ["nonexistent"]);

		const result = sortExtensionPaths([pathExt]);
		assert.equal(result.sortedPaths.length, 1);
		assert.equal(result.sortedPaths[0], pathExt);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0].message, /nonexistent.*not installed/);
	});

	it("warns about cycles but still loads both", () => {
		const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
		const pathA = createExtDir(base, "cycle-a", ["cycle-b"]);
		const pathB = createExtDir(base, "cycle-b", ["cycle-a"]);

		const result = sortExtensionPaths([pathA, pathB]);
		assert.equal(result.sortedPaths.length, 2);
		assert.ok(result.warnings.length > 0);
		assert.ok(result.warnings.some((w) => w.message.includes("cycle")));
	});

	it("silently ignores self-dependencies", () => {
		const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
		const pathExt = createExtDir(base, "self-dep", ["self-dep"]);

		const result = sortExtensionPaths([pathExt]);
		assert.deepEqual(result.sortedPaths, [pathExt]);
		assert.equal(result.warnings.length, 0);
	});

	it("prepends extensions without manifests", () => {
		const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
		const noManifestDir = join(base, "no-manifest");
		mkdirSync(noManifestDir, { recursive: true });
		writeFileSync(join(noManifestDir, "index.ts"), `export default function() {}`);
		const noManifestPath = join(noManifestDir, "index.ts");

		const pathWithManifest = createExtDir(base, "with-manifest");

		const result = sortExtensionPaths([pathWithManifest, noManifestPath]);
		assert.equal(result.sortedPaths[0], noManifestPath);
		assert.equal(result.sortedPaths[1], pathWithManifest);
	});

	it("handles non-array dependencies gracefully", () => {
		const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
		const dir = join(base, "bad-deps");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "extension-manifest.json"),
			JSON.stringify({
				id: "bad-deps",
				name: "bad-deps",
				version: "1.0.0",
				tier: "bundled",
				dependencies: { extensions: "not-an-array" },
			}),
		);
		writeFileSync(join(dir, "index.ts"), `export default function() {}`);

		const result = sortExtensionPaths([join(dir, "index.ts")]);
		assert.equal(result.sortedPaths.length, 1);
		assert.equal(result.warnings.length, 0);
	});
});
