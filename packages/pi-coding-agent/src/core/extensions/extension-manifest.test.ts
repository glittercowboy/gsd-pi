// GSD-2 — Extension Manifest Tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readManifest, readManifestFromEntryPath } from "./extension-manifest.js";

describe("readManifest", () => {
	it("returns null for missing directory", () => {
		assert.equal(readManifest("/nonexistent/path"), null);
	});

	it("returns null for directory without manifest", () => {
		const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
		assert.equal(readManifest(dir), null);
	});

	it("returns null for invalid JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
		writeFileSync(join(dir, "extension-manifest.json"), "not json{{{", "utf-8");
		assert.equal(readManifest(dir), null);
	});

	it("returns null for manifest missing required fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
		writeFileSync(
			join(dir, "extension-manifest.json"),
			JSON.stringify({ id: "test", name: "test" }),
		);
		assert.equal(readManifest(dir), null);
	});

	it("returns valid manifest", () => {
		const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
		const manifest = {
			id: "test-ext",
			name: "Test Extension",
			version: "1.0.0",
			tier: "bundled",
			requires: { platform: ">=2.29.0" },
		};
		writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify(manifest));
		const result = readManifest(dir);
		assert.equal(result?.id, "test-ext");
		assert.equal(result?.tier, "bundled");
	});
});

describe("readManifestFromEntryPath", () => {
	it("reads manifest from parent of entry path", () => {
		const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
		const extDir = join(dir, "my-ext");
		mkdirSync(extDir);
		writeFileSync(
			join(extDir, "extension-manifest.json"),
			JSON.stringify({
				id: "my-ext",
				name: "My Extension",
				version: "1.0.0",
				tier: "community",
			}),
		);
		writeFileSync(join(extDir, "index.ts"), "");

		const result = readManifestFromEntryPath(join(extDir, "index.ts"));
		assert.equal(result?.id, "my-ext");
		assert.equal(result?.tier, "community");
	});

	it("returns null when entry path parent has no manifest", () => {
		const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
		assert.equal(readManifestFromEntryPath(join(dir, "index.ts")), null);
	});
});
