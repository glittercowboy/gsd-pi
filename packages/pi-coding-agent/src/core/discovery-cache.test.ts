import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ModelDiscoveryCache } from "./discovery-cache.js";

let testDir: string;
let cachePath: string;

function markEntryStale(cache: ModelDiscoveryCache, provider: string): void {
	const entry = cache.get(provider);
	assert.ok(entry, `expected cache entry for ${provider}`);
	entry.fetchedAt = Date.now() - entry.ttlMs - 1;
}

beforeEach(() => {
	testDir = join(tmpdir(), `discovery-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
	cachePath = join(testDir, "discovery-cache.json");
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Cleanup best-effort
	}
});

// ─── basic operations ────────────────────────────────────────────────────────

describe("ModelDiscoveryCache — basic operations", () => {
	it("starts with no entries", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		assert.equal(cache.get("openai"), undefined);
	});

	it("stores and retrieves models", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		const models = [{ id: "gpt-4o", name: "GPT-4o" }];
		cache.set("openai", models);

		const entry = cache.get("openai");
		assert.ok(entry);
		assert.deepEqual(entry.models, models);
		assert.ok(entry.fetchedAt > 0);
		assert.ok(entry.ttlMs > 0);
	});

	it("persists to disk and reloads", () => {
		const cache1 = new ModelDiscoveryCache(cachePath);
		cache1.set("openai", [{ id: "gpt-4o" }]);

		const cache2 = new ModelDiscoveryCache(cachePath);
		const entry = cache2.get("openai");
		assert.ok(entry);
		assert.equal(entry.models[0].id, "gpt-4o");
	});

	it("clear removes a specific provider", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		cache.set("openai", [{ id: "gpt-4o" }]);
		cache.set("google", [{ id: "gemini-pro" }]);

		cache.clear("openai");
		assert.equal(cache.get("openai"), undefined);
		const googleEntry = cache.get("google");
		assert.ok(googleEntry);
		assert.equal(googleEntry.models[0].id, "gemini-pro");
	});

	it("clear without provider removes all entries", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		cache.set("openai", [{ id: "gpt-4o" }]);
		cache.set("google", [{ id: "gemini-pro" }]);

		cache.clear();
		assert.equal(cache.get("openai"), undefined);
		assert.equal(cache.get("google"), undefined);
	});
});

// ─── staleness ───────────────────────────────────────────────────────────────

describe("ModelDiscoveryCache — staleness", () => {
	it("newly set entries are not stale", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		cache.set("openai", [{ id: "gpt-4o" }]);
		assert.equal(cache.isStale("openai"), false);
	});

	it("missing providers are stale", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		assert.equal(cache.isStale("unknown"), true);
	});

	it("entries with expired TTL are stale", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		cache.set("openai", [{ id: "gpt-4o" }], 1); // 1ms TTL
		markEntryStale(cache, "openai");

		assert.equal(cache.isStale("openai"), true);
	});
});

// ─── getAll ──────────────────────────────────────────────────────────────────

describe("ModelDiscoveryCache — getAll", () => {
	it("returns non-stale entries by default", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		cache.set("openai", [{ id: "gpt-4o" }]);
		cache.set("stale", [{ id: "old" }], 1);
		markEntryStale(cache, "stale");

		const all = cache.getAll();
		assert.ok(all.has("openai"));
		assert.ok(!all.has("stale"));
	});

	it("returns all entries when includeStale is true", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		cache.set("openai", [{ id: "gpt-4o" }]);
		cache.set("stale", [{ id: "old" }], 1);
		markEntryStale(cache, "stale");

		const all = cache.getAll(true);
		assert.ok(all.has("openai"));
		assert.ok(all.has("stale"));
	});
});

// ─── edge cases ──────────────────────────────────────────────────────────────

describe("ModelDiscoveryCache — edge cases", () => {
	it("handles corrupted cache file gracefully", () => {
		writeFileSync(cachePath, "not valid json", "utf-8");
		const cache = new ModelDiscoveryCache(cachePath);
		assert.equal(cache.get("openai"), undefined);
	});

	it("handles wrong version gracefully", () => {
		writeFileSync(cachePath, JSON.stringify({ version: 99, entries: {} }), "utf-8");
		const cache = new ModelDiscoveryCache(cachePath);
		assert.equal(cache.get("openai"), undefined);
	});

	it("handles missing cache file", () => {
		const cache = new ModelDiscoveryCache(join(testDir, "nonexistent", "cache.json"));
		assert.equal(cache.get("openai"), undefined);
	});

	it("overwrites existing entry for same provider", () => {
		const cache = new ModelDiscoveryCache(cachePath);
		cache.set("openai", [{ id: "gpt-4o" }]);
		cache.set("openai", [{ id: "gpt-4o-mini" }]);

		const entry = cache.get("openai");
		assert.ok(entry);
		assert.equal(entry.models.length, 1);
		assert.equal(entry.models[0].id, "gpt-4o-mini");
	});
});
