// Regression test for #3616: DefaultResourceLoader.reload() must invalidate
// the jiti module cache before loading extensions, so that edits to
// extension source on disk are picked up on the next reload (not served
// stale from memory).
//
// Verified end-to-end behaviourally: we write a .ts extension that
// registers a tool whose NAME is a module-scope constant, load it,
// rewrite the source with a new constant value, reload(), and assert
// the observable tool name reflects the NEW source. Without jiti cache
// invalidation, the second reload would re-register the stale name.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DefaultResourceLoader } from "./resource-loader.js";
import { SettingsManager } from "./settings-manager.js";
import { resetExtensionLoaderCache } from "./extensions/loader.js";

let testDir: string;

function writeExtensionWithToolName(extPath: string, toolName: string): void {
	// Extension factory signature expected by the loader. Uses `any` so the
	// test stays decoupled from the ExtensionAPI type shape.
	writeFileSync(
		extPath,
		[
			`const TOOL_NAME = "${toolName}";`,
			`export default function activate(api: any) {`,
			`  api.registerTool({`,
			`    name: TOOL_NAME,`,
			`    label: TOOL_NAME,`,
			`    description: "test tool — source-generated name",`,
			`    parameters: { type: "object", properties: {}, additionalProperties: false },`,
			`    execute: async () => ({ content: [], details: undefined }),`,
			`  });`,
			`}`,
			"",
		].join("\n"),
	);
}

describe("#3616 — DefaultResourceLoader.reload() invalidates extension module cache", () => {
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "resource-loader-cache-reset-"));
		// Ensure a clean jiti singleton — prior tests in this process may
		// have populated it with unrelated entries.
		resetExtensionLoaderCache();
	});

	afterEach(() => {
		resetExtensionLoaderCache();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("reload() picks up source edits after the extension has been loaded once", async () => {
		const agentDir = join(testDir, "agent-home");
		const extPath = join(testDir, "reload-probe.ts");

		// v1 — initial content
		writeExtensionWithToolName(extPath, "probe_v1");

		const loader = new DefaultResourceLoader({
			cwd: testDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			additionalExtensionPaths: [extPath],
		});

		await loader.reload();

		const toolsV1 = [...loader.getExtensions().extensions.flatMap((e) => [...e.tools.keys()])];
		assert.ok(
			toolsV1.includes("probe_v1"),
			`first reload should register probe_v1; got=${JSON.stringify(toolsV1)}`,
		);

		// v2 — overwrite the source on disk with a different tool name.
		writeExtensionWithToolName(extPath, "probe_v2");
		// Bump mtime explicitly so file-stat–based cache strategies (jiti's
		// moduleCache consults Node's require.cache, which some runtimes
		// tiebreak on mtime) always see "newer than last seen". On Windows
		// NTFS + node the default fs mtime resolution can silently collapse
		// two writes in the same tick to an identical mtime — that fooled
		// the Windows CI run on #3616.
		const futureTime = new Date(Date.now() + 5000);
		utimesSync(extPath, futureTime, futureTime);

		await loader.reload();

		const toolsV2 = [...loader.getExtensions().extensions.flatMap((e) => [...e.tools.keys()])];
		assert.ok(
			toolsV2.includes("probe_v2"),
			`second reload must observe the edited source (probe_v2) — if reload() ` +
				`fails to reset the jiti cache, the stale module returns probe_v1. got=${JSON.stringify(toolsV2)}`,
		);
		assert.ok(
			!toolsV2.includes("probe_v1"),
			`second reload must NOT still expose the stale probe_v1 name; got=${JSON.stringify(toolsV2)}`,
		);
	});
});
