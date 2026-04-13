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

// ─── mismatched oauth credential for non-OAuth provider (#2083) ───────────────

describe("AuthStorage — oauth credential for non-OAuth provider (#2083)", () => {
	it("returns undefined when openrouter has type:oauth (no registered OAuth provider)", async (t) => {
		// Simulates the bug: OpenRouter credential stored as type:"oauth"
		// but OpenRouter is not a registered OAuth provider.
		const storage = inMemory({
			openrouter: {
				type: "oauth",
				access_token: "sk-or-v1-fake",
				refresh_token: "rt-fake",
				expires: Date.now() + 3_600_000,
			},
		});

		// Isolate from any real OPENROUTER_API_KEY in the environment so the
		// fall-through to env / fallback finds nothing and returns undefined.
		const origEnv = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		t.after(() => {
			if (origEnv === undefined) {
				delete process.env.OPENROUTER_API_KEY;
			} else {
				process.env.OPENROUTER_API_KEY = origEnv;
			}
		});

		// Before the fix, getApiKey returns undefined because
		// resolveCredentialApiKey calls getOAuthProvider("openrouter") → null → undefined.
		// The key in the oauth credential is never extracted.
		const key = await storage.getApiKey("openrouter");
		// After the fix, the oauth credential with an unrecognised provider
		// should be skipped, and getApiKey should fall through to env / fallback.
		// With no env var and no fallback resolver configured, the result is undefined.
		assert.equal(key, undefined);
	});

	it("falls through to env var when openrouter has type:oauth credential", async (t) => {
		const storage = inMemory({
			openrouter: {
				type: "oauth",
				access_token: "sk-or-v1-fake",
				refresh_token: "rt-fake",
				expires: Date.now() + 3_600_000,
			},
		});

		// Simulate OPENROUTER_API_KEY being set via env
		const origEnv = process.env.OPENROUTER_API_KEY;
		t.after(() => {
			if (origEnv === undefined) {
				delete process.env.OPENROUTER_API_KEY;
			} else {
				process.env.OPENROUTER_API_KEY = origEnv;
			}
		});

		process.env.OPENROUTER_API_KEY = "sk-or-v1-env-key";
		const key = await storage.getApiKey("openrouter");
		assert.equal(key, "sk-or-v1-env-key");
	});

	it("falls through to fallback resolver when openrouter has type:oauth credential", async (t) => {
		const storage = inMemory({
			openrouter: {
				type: "oauth",
				access_token: "sk-or-v1-fake",
				refresh_token: "rt-fake",
				expires: Date.now() + 3_600_000,
			},
		});

		// Isolate from any real OPENROUTER_API_KEY so env fallback is skipped
		// and the fallback resolver is reached.
		const origEnv = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		t.after(() => {
			if (origEnv === undefined) {
				delete process.env.OPENROUTER_API_KEY;
			} else {
				process.env.OPENROUTER_API_KEY = origEnv;
			}
		});

		storage.setFallbackResolver((provider) =>
			provider === "openrouter" ? "sk-or-v1-fallback" : undefined,
		);

		const key = await storage.getApiKey("openrouter");
		assert.equal(key, "sk-or-v1-fallback");
	});
});

// ─── Gemini CLI OAuth token detection ─────────────────────────────────────────

describe("AuthStorage — Gemini CLI OAuth token detection", () => {
	it("rejects Google OAuth access token (ya29. prefix) stored as api_key for google provider", () => {
		const storage = inMemory({});
		assert.throws(
			() => storage.set("google", makeKey("ya29.a0ARrdaM_fake_oauth_token_from_gemini_cli")),
			(err: Error) => {
				assert.ok(err.message.includes("OAuth access token"), `Expected message about OAuth token, got: ${err.message}`);
				assert.ok(
					err.message.includes("GEMINI_API_KEY") || err.message.includes("google-gemini-cli"),
					`Expected guidance about GEMINI_API_KEY or google-gemini-cli, got: ${err.message}`,
				);
				return true;
			},
		);
	});

	it("rejects Google OAuth access token for google provider via getApiKey when set as env var", async () => {
		const storage = inMemory({});
		// Simulate runtime override with OAuth token
		storage.setRuntimeApiKey("google", "ya29.c.b0AXv0zTPQ_fake_oauth_token");
		const key = await storage.getApiKey("google");
		// Should return undefined (blocked) or throw
		assert.equal(key, undefined, "OAuth token should be blocked for google provider");
	});

	it("allows legitimate Google API keys (AIza prefix) for google provider", () => {
		const storage = inMemory({});
		storage.set("google", makeKey("AIzaSyD_fake_legitimate_api_key_here"));
		const creds = storage.getCredentialsForProvider("google");
		assert.equal(creds.length, 1);
	});

	it("allows ya29 tokens for google-gemini-cli provider (OAuth is expected there)", () => {
		// google-gemini-cli stores OAuth credentials with type: "oauth", not "api_key"
		// But if someone somehow stored an api_key, it shouldn't be blocked for OAuth providers
		const storage = inMemory({});
		storage.set("google-gemini-cli", makeKey("ya29.a0ARrdaM_token_for_gemini_cli"));
		const creds = storage.getCredentialsForProvider("google-gemini-cli");
		assert.equal(creds.length, 1);
	});

	it("rejects Google OAuth token (ya29. prefix) for openai provider that uses GEMINI_API_KEY indirectly", () => {
		// Only google provider should be blocked, not others
		const storage = inMemory({});
		// This should NOT throw - other providers can have whatever keys they want
		storage.set("openai", makeKey("ya29.some_value"));
		const creds = storage.getCredentialsForProvider("openai");
		assert.equal(creds.length, 1);
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

// ─── getEarliestBackoffExpiry ─────────────────────────────────────────────────

describe("AuthStorage — getEarliestBackoffExpiry", () => {
	it("returns undefined when no credentials are configured for the provider", () => {
		const storage = inMemory({});
		assert.equal(storage.getEarliestBackoffExpiry("anthropic"), undefined);
	});

	it("returns undefined when credentials exist but none are backed off", () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		// No markUsageLimitReached call — credentialBackoff map is empty
		assert.equal(storage.getEarliestBackoffExpiry("anthropic"), undefined);
	});

	it("returns a future timestamp when a single credential is backed off", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");
		storage.markUsageLimitReached("anthropic");

		const expiry = storage.getEarliestBackoffExpiry("anthropic");
		assert.ok(expiry !== undefined, "should return a timestamp");
		assert.ok(expiry > Date.now(), "expiry should be in the future");
	});

	it("returns the earliest expiry when multiple credentials are backed off", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		// Back off both credentials with the default rate_limit backoff (30 s)
		await storage.getApiKey("anthropic"); // uses index 0
		storage.markUsageLimitReached("anthropic"); // backs off index 0
		await storage.getApiKey("anthropic"); // uses index 1
		storage.markUsageLimitReached("anthropic"); // backs off index 1

		const expiry = storage.getEarliestBackoffExpiry("anthropic");
		assert.ok(expiry !== undefined, "should return a timestamp");
		assert.ok(expiry > Date.now(), "expiry should be in the future");
	});

	it("returns undefined after backed-off credentials expire (cleans up entries)", () => {
		// Manually inject an already-expired backoff entry so we can test
		// the cleanup path without actually waiting 30 seconds.
		const storage = inMemory({ anthropic: makeKey("sk-only") });

		// Access private credentialBackoff map via type assertion to inject expired entry
		const credentialBackoff: Map<string, Map<number, number>> =
			(storage as any).credentialBackoff;
		const providerMap = new Map<number, number>();
		// expiresAt in the past
		providerMap.set(0, Date.now() - 1_000);
		credentialBackoff.set("anthropic", providerMap);

		// getEarliestBackoffExpiry should clean up the expired entry and return undefined
		const expiry = storage.getEarliestBackoffExpiry("anthropic");
		assert.equal(expiry, undefined);

		// Confirm the expired entry was removed from the map
		assert.equal(providerMap.size, 0, "expired entry should have been deleted");
	});

	it("returns undefined when provider is not in credentialBackoff map at all", () => {
		const storage = inMemory({ openai: makeKey("sk-openai") });
		// anthropic has no backoff map entry at all
		assert.equal(storage.getEarliestBackoffExpiry("anthropic"), undefined);
	});

	it("only returns expiry for the requested provider, not other providers", async () => {
		const storage = inMemory({
			anthropic: makeKey("sk-ant"),
			openai: makeKey("sk-oai"),
		});

		// Back off anthropic
		await storage.getApiKey("anthropic");
		storage.markUsageLimitReached("anthropic");

		// openai is not backed off
		assert.equal(storage.getEarliestBackoffExpiry("openai"), undefined);

		// anthropic is backed off
		const expiry = storage.getEarliestBackoffExpiry("anthropic");
		assert.ok(expiry !== undefined);
		assert.ok(expiry > Date.now());
	});

	it("returns the minimum expiry when one credential expires sooner than another", () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		const now = Date.now();
		const nearExpiry = now + 5_000;   // expires in 5 s
		const farExpiry  = now + 30_000;  // expires in 30 s

		// Inject two different backoff expiries manually
		const credentialBackoff: Map<string, Map<number, number>> =
			(storage as any).credentialBackoff;
		const providerMap = new Map<number, number>();
		providerMap.set(0, nearExpiry);
		providerMap.set(1, farExpiry);
		credentialBackoff.set("anthropic", providerMap);

		const expiry = storage.getEarliestBackoffExpiry("anthropic");
		assert.equal(expiry, nearExpiry, "should return the nearest (smallest) expiry");
	});
});

// ─── localhost baseUrl shortcut ────────────────────────────────────────────────

describe("AuthStorage — localhost baseUrl shortcut", () => {
	it("returns 'local-no-key-needed' for localhost provider with no configured key", async () => {
		const storage = inMemory({});
		const key = await storage.getApiKey("ollama", undefined, { baseUrl: "http://localhost:11434" });
		assert.equal(key, "local-no-key-needed");
	});

	it("returns 'local-no-key-needed' for 127.0.0.1 provider with no configured key", async () => {
		const storage = inMemory({});
		const key = await storage.getApiKey("custom", undefined, { baseUrl: "http://127.0.0.1:8080/v1" });
		assert.equal(key, "local-no-key-needed");
	});

	it("returns configured key from fallback resolver for localhost custom provider (#4106)", async () => {
		// Regression test: compaction called getApiKey(model) where model.baseUrl is localhost.
		// The localhost shortcut must NOT override an explicitly configured apiKey from models.json.
		const storage = inMemory({});
		storage.setFallbackResolver((provider) =>
			provider === "cliproxy" ? "sk-real-proxy-key" : undefined,
		);

		const key = await storage.getApiKey("cliproxy", undefined, { baseUrl: "http://localhost:8317/v1" });
		assert.equal(key, "sk-real-proxy-key");
	});

	it("returns configured key from fallback resolver when baseUrl uses 127.0.0.1 (#4106)", async () => {
		const storage = inMemory({});
		storage.setFallbackResolver((provider) =>
			provider === "myproxy" ? "sk-myproxy-key" : undefined,
		);

		const key = await storage.getApiKey("myproxy", undefined, { baseUrl: "http://127.0.0.1:9000/v1" });
		assert.equal(key, "sk-myproxy-key");
	});
});
