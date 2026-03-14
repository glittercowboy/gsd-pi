import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthStorage } from "./auth-storage.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeKey(key: string) {
	return { type: "api_key" as const, key };
}

function inMemory(data: Record<string, unknown> = {}) {
	return AuthStorage.inMemory(data as any);
}

// ─── single credential (backward compat) ─────────────────────────────────────

describe("AuthStorage — single credential (backward compat)", () => {
	it("returns the api key for a provider with one key", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-abc") });
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-abc");
	});

	it("returns undefined for unknown provider", async () => {
		const storage = inMemory({});
		const key = await storage.getApiKey("unknown");
		assert.equal(key, undefined);
	});

	it("runtime override takes precedence over stored key", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-stored") });
		storage.setRuntimeApiKey("anthropic", "sk-runtime");
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-runtime");
	});
});

// ─── multiple credentials ─────────────────────────────────────────────────────

describe("AuthStorage — multiple credentials", () => {
	it("round-robins across multiple api keys without sessionId", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")],
		});

		const keys = new Set<string>();
		for (let i = 0; i < 6; i++) {
			const k = await storage.getApiKey("anthropic");
			assert.ok(k, `call ${i} should return a key`);
			keys.add(k);
		}
		// All three keys should have been selected across 6 calls
		assert.deepEqual(keys, new Set(["sk-1", "sk-2", "sk-3"]));
	});

	it("session-sticky: same sessionId always picks the same key", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")],
		});

		const sessionId = "sess-abc";
		const first = await storage.getApiKey("anthropic", sessionId);
		for (let i = 0; i < 5; i++) {
			const k = await storage.getApiKey("anthropic", sessionId);
			assert.equal(k, first, `call ${i} should be sticky to first selection`);
		}
	});

	it("different sessionIds may select different keys", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")],
		});

		const results = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const k = await storage.getApiKey("anthropic", `sess-${i}`);
			if (k) results.add(k);
		}
		// With 20 different sessions and 3 keys, we should see more than one key
		assert.ok(results.size > 1, "multiple sessions should hash to different keys");
	});
});

// ─── login accumulation ───────────────────────────────────────────────────────

describe("AuthStorage — login accumulation", () => {
	it("accumulates api keys on repeated set()", () => {
		const storage = inMemory({});
		storage.set("anthropic", makeKey("sk-1"));
		storage.set("anthropic", makeKey("sk-2"));
		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds.length, 2);
		assert.deepEqual(
			creds.map((c) => (c.type === "api_key" ? c.key : null)),
			["sk-1", "sk-2"],
		);
	});

	it("deduplicates identical api keys", () => {
		const storage = inMemory({});
		storage.set("anthropic", makeKey("sk-1"));
		storage.set("anthropic", makeKey("sk-1"));
		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds.length, 1);
	});
});

// ─── backoff / markUsageLimitReached ─────────────────────────────────────────

describe("AuthStorage — rate-limit backoff", () => {
	it("returns true when a backed-off credential has an alternate", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		// Use sk-1 via round-robin (first call, index 0)
		await storage.getApiKey("anthropic");

		// Mark it as rate-limited; sk-2 should still be available
		const hasAlternate = storage.markUsageLimitReached("anthropic");
		assert.equal(hasAlternate, true);
	});

	it("returns false when all credentials are backed off", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		// Back off both keys
		await storage.getApiKey("anthropic"); // uses index 0
		storage.markUsageLimitReached("anthropic"); // backs off index 0
		await storage.getApiKey("anthropic"); // uses index 1
		const hasAlternate = storage.markUsageLimitReached("anthropic"); // backs off index 1
		assert.equal(hasAlternate, false);
	});

	it("backed-off credential is skipped; next available key is returned", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		// First call → sk-1 (round-robin index 0)
		const first = await storage.getApiKey("anthropic");
		assert.equal(first, "sk-1");

		// Back off sk-1
		storage.markUsageLimitReached("anthropic");

		// Next call should skip backed-off sk-1 and return sk-2
		const second = await storage.getApiKey("anthropic");
		assert.equal(second, "sk-2");
	});

	it("single credential: markUsageLimitReached returns false", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");
		const hasAlternate = storage.markUsageLimitReached("anthropic");
		assert.equal(hasAlternate, false);
	});

	it("single credential: unknown error type skips backoff entirely", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");

		// Mark with unknown error type (transport failure)
		const hasAlternate = storage.markUsageLimitReached("anthropic", undefined, {
			errorType: "unknown",
		});
		assert.equal(hasAlternate, false);

		// Key should still be available — backoff was not applied
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-only");
	});

	it("multiple credentials: unknown error type still backs off the used credential", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});
		await storage.getApiKey("anthropic"); // uses sk-1

		// Mark with unknown error type — should still back off when alternates exist
		const hasAlternate = storage.markUsageLimitReached("anthropic", undefined, {
			errorType: "unknown",
		});
		assert.equal(hasAlternate, true);

		// Next call should return sk-2
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-2");
	});

	it("single credential: rate_limit error type still backs off", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");

		// rate_limit should still back off even single credentials
		const hasAlternate = storage.markUsageLimitReached("anthropic", undefined, {
			errorType: "rate_limit",
		});
		assert.equal(hasAlternate, false);

		// Key should be backed off
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, undefined);
	});

	it("session-sticky: marks the correct credential as backed off", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		const sessionId = "sess-xyz";
		const chosen = await storage.getApiKey("anthropic", sessionId);
		assert.ok(chosen);

		// Back off the chosen credential for this session
		const hasAlternate = storage.markUsageLimitReached("anthropic", sessionId);
		assert.equal(hasAlternate, true);

		// Next call with same session should return the other key
		const next = await storage.getApiKey("anthropic", sessionId);
		assert.ok(next);
		assert.notEqual(next, chosen);
	});
});

// ─── areAllCredentialsBackedOff ───────────────────────────────────────────────

describe("AuthStorage — areAllCredentialsBackedOff", () => {
	it("returns false when no credentials are configured", () => {
		const storage = inMemory({});
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
	});

	it("returns false when credentials exist and none are backed off", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-abc") });
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
	});

	it("returns true when the single credential is backed off", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");
		storage.markUsageLimitReached("anthropic");
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), true);
	});

	it("returns false when at least one credential is still available", async () => {
		const storage = inMemory({ anthropic: [makeKey("sk-1"), makeKey("sk-2")] });
		await storage.getApiKey("anthropic"); // uses index 0
		storage.markUsageLimitReached("anthropic"); // backs off index 0
		// index 1 is still available
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
	});

	it("returns true when all credentials are backed off", async () => {
		const storage = inMemory({ anthropic: [makeKey("sk-1"), makeKey("sk-2")] });
		await storage.getApiKey("anthropic"); // uses index 0
		storage.markUsageLimitReached("anthropic"); // backs off index 0
		await storage.getApiKey("anthropic"); // uses index 1
		storage.markUsageLimitReached("anthropic"); // backs off index 1
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), true);
	});
});

// ─── getAll truncation ────────────────────────────────────────────────────────

describe("AuthStorage — getAll()", () => {
	it("returns first credential only for providers with multiple keys", () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
			openai: makeKey("sk-openai"),
		});
		const all = storage.getAll();
		assert.ok(all["anthropic"]?.type === "api_key");
		assert.equal((all["anthropic"] as any).key, "sk-1");
		assert.equal((all["openai"] as any).key, "sk-openai");
	});
});
