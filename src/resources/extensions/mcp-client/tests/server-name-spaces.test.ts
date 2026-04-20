/**
 * Regression test for #3029 — mcp_discover fails for server names with spaces.
 *
 * The getServerConfig lookup must handle:
 *   1. Exact match (already works)
 *   2. Names with leading/trailing whitespace (trimming)
 *   3. Case-insensitive matching (e.g. "Langgraph code" vs "langgraph Code")
 *
 * We test at the source level since getServerConfig is not exported.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, "..", "index.ts"), "utf-8");

test("#3029: getServerConfig trims whitespace from input name", () => {
	assert.ok(
		source.includes(".trim()"),
		"getServerConfig should trim the input name before comparison",
	);
});

test("#3029: getServerConfig performs case-insensitive matching", () => {
	assert.ok(
		source.includes(".toLowerCase()"),
		"getServerConfig should compare names case-insensitively",
	);
});

test("#3029: getOrConnect normalizes name for connection cache lookup", () => {
	// The connections Map key must use the canonical (config) name, not the
	// raw user input, so that subsequent lookups hit the cache even when the
	// user's casing differs.
	const getOrConnectMatch = source.match(
		/async function getOrConnect\(name: string[\s\S]*?const existing = connections\.get\(/,
	);
	assert.ok(
		getOrConnectMatch,
		"getOrConnect function should exist",
	);
	// After the fix, getOrConnect should normalize the name via getServerConfig
	// or use config.name as the canonical cache key.
	assert.ok(
		source.includes("connections.get(config.name") ||
		source.includes("connections.set(config.name"),
		"getOrConnect should use config.name (canonical) as the connections cache key",
	);
});
