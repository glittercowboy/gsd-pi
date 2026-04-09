// GSD-2 — Regression test for #3616: reload() must reset jiti extension loader cache
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(process.cwd(), "packages/pi-coding-agent/src/core/resource-loader.ts"),
	"utf-8",
);

describe("#3616 — reload() must invalidate jiti module cache", () => {
	test("resource-loader imports resetExtensionLoaderCache from loader.js", () => {
		assert.ok(
			source.includes("resetExtensionLoaderCache"),
			"resource-loader.ts should import resetExtensionLoaderCache",
		);
		assert.ok(
			source.includes('from "./extensions/loader.js"'),
			"resetExtensionLoaderCache should be imported from extensions/loader.js",
		);
	});

	test("reload() calls resetExtensionLoaderCache before loadExtensions", () => {
		const reloadStart = source.indexOf("async reload(): Promise<void>");
		assert.ok(reloadStart >= 0, "should find reload() method");
		const reloadBody = source.slice(reloadStart, reloadStart + 4000);

		const resetIdx = reloadBody.indexOf("resetExtensionLoaderCache()");
		assert.ok(resetIdx >= 0, "reload() should call resetExtensionLoaderCache()");

		const loadIdx = reloadBody.indexOf("loadExtensions(");
		assert.ok(loadIdx >= 0, "reload() should call loadExtensions");

		assert.ok(
			resetIdx < loadIdx,
			"resetExtensionLoaderCache() must be called BEFORE loadExtensions to ensure fresh modules",
		);
	});
});
