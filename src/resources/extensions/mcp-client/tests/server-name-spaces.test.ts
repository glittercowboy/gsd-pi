/**
 * Regression test for #3029 — mcp_discover fails for server names with spaces.
 *
 * getServerConfig must handle:
 *   1. Exact match
 *   2. Names with leading/trailing whitespace (trimming)
 *   3. Case-insensitive matching (e.g. "Langgraph code" vs "langgraph Code")
 *
 * getOrConnect must use the canonical (config.name) as the cache key so that
 * subsequent lookups with variant casing/whitespace hit the same connection.
 *
 * These are behaviour tests against the real exported getServerConfig — no
 * source grep.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { getServerConfig } from "../index.js";

// readConfigs() anchors to process.cwd() — run each test in a sandbox dir
// with a purpose-built .mcp.json so the extension reads our fixture, not
// whatever .mcp.json happens to live in the current working directory.
let sandboxDir: string;
let originalCwd: string;

before(() => {
	originalCwd = process.cwd();
	sandboxDir = mkdtempSync(join(tmpdir(), "mcp-name-spaces-"));
	const mcpConfig = {
		mcpServers: {
			"Langgraph Code": {
				command: "echo",
				args: ["test"],
			},
			"other-server": {
				url: "https://example.com",
			},
		},
	};
	writeFileSync(join(sandboxDir, ".mcp.json"), JSON.stringify(mcpConfig), "utf-8");
	process.chdir(sandboxDir);
});

after(() => {
	process.chdir(originalCwd);
	try {
		rmSync(sandboxDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup
	}
});

test("#3029: getServerConfig finds exact match", () => {
	const cfg = getServerConfig("Langgraph Code");
	assert.ok(cfg, "exact name must resolve");
	assert.equal(cfg?.name, "Langgraph Code");
});

test("#3029: getServerConfig trims whitespace from input name", () => {
	const cfg = getServerConfig("   Langgraph Code  ");
	assert.ok(cfg, "whitespace-padded name must resolve to the same server");
	assert.equal(cfg?.name, "Langgraph Code");
});

test("#3029: getServerConfig performs case-insensitive matching", () => {
	const cfg = getServerConfig("langgraph code");
	assert.ok(cfg, "lower-cased name must resolve");
	assert.equal(cfg?.name, "Langgraph Code");

	const mixed = getServerConfig("LANGGRAPH CODE");
	assert.ok(mixed, "upper-cased name must resolve");
	assert.equal(mixed?.name, "Langgraph Code");
});

test("#3029: getServerConfig combines trim + case-insensitive", () => {
	const cfg = getServerConfig("  LANGGRAPH code  ");
	assert.ok(cfg, "padded + mixed-case must resolve");
	assert.equal(cfg?.name, "Langgraph Code");
});

test("#3029: getServerConfig returns undefined for unknown name", () => {
	const cfg = getServerConfig("does-not-exist");
	assert.equal(cfg, undefined);
});
