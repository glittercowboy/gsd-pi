// GSD2 — Regression test for LSP legacy server key aliases
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * When a default server key is renamed (e.g., kotlin-language-server → kotlin-lsp),
 * user overrides referencing the old key must still merge correctly via LEGACY_ALIASES.
 *
 * This test exercises the merge path through loadConfig() with a temp project
 * containing an lsp.json that uses the legacy key.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "./config.js";

describe("LSP legacy server key aliases", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-alias-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("merges user override with legacy key 'kotlin-language-server' into 'kotlin-lsp'", () => {
		// Write an lsp.json that uses the old key name with a command that exists (node)
		// so resolveCommand doesn't filter it out.
		const overrideConfig = {
			servers: {
				"kotlin-language-server": {
					command: "node",
				},
			},
		};
		fs.writeFileSync(
			path.join(tmpDir, "lsp.json"),
			JSON.stringify(overrideConfig),
		);

		// Also add root markers so the server is detected
		fs.writeFileSync(path.join(tmpDir, "build.gradle.kts"), "");

		const config = loadConfig(tmpDir);

		// The merged config should have kotlin-lsp (new key) with the user's command override
		const kotlinServer = config.servers["kotlin-lsp"];
		assert.ok(kotlinServer, "kotlin-lsp should exist in merged config");
		assert.equal(
			kotlinServer.command,
			"node",
			"command should be overridden from user config via legacy alias",
		);
		assert.ok(
			kotlinServer.fileTypes.includes(".kt"),
			"fileTypes should be inherited from defaults",
		);

		// The old key should NOT appear as a separate entry
		assert.equal(
			config.servers["kotlin-language-server"],
			undefined,
			"legacy key should not appear as separate server",
		);
	});
});
