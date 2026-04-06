/**
 * Tests for MCP client OAuth auth provider support on HTTP transport.
 *
 * Verifies that:
 *  1. HTTP server configs with `headers` pass them to the transport via requestInit
 *  2. HTTP server configs with `oauth` config construct an OAuthClientProvider
 *  3. Servers without auth still connect without an auth provider
 *  4. Environment variable references in headers are resolved
 *
 * Reproduces issue #2160 — MCP HTTP transport lacks OAuth auth provider,
 * causing 401 errors when connecting to remote MCP servers (Sentry, Linear, etc.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHttpTransportOpts } from "../resources/extensions/mcp-client/auth.ts";

// ── Transport construction (SDK sanity checks) ───────────────────────────────

test("HTTP transport without auth config creates transport with no authProvider", async () => {
	const { StreamableHTTPClientTransport } = await import(
		"@modelcontextprotocol/sdk/client/streamableHttp.js"
	);

	const transport = new StreamableHTTPClientTransport(
		new URL("https://example.com/mcp"),
	);
	assert.ok(transport, "Transport should be created without auth");
});

test("HTTP transport with authProvider creates transport that can authenticate", async () => {
	const { StreamableHTTPClientTransport } = await import(
		"@modelcontextprotocol/sdk/client/streamableHttp.js"
	);

	// Minimal OAuthClientProvider mock
	const mockAuthProvider = {
		get redirectUrl() { return "http://localhost:3000/callback"; },
		get clientMetadata() {
			return {
				redirect_uris: ["http://localhost:3000/callback"],
				client_name: "gsd-test",
			};
		},
		clientInformation: () => undefined,
		tokens: () => ({ access_token: "test-token", token_type: "Bearer" }),
		saveTokens: () => {},
		redirectToAuthorization: () => {},
		saveCodeVerifier: () => {},
		codeVerifier: () => "verifier",
	};

	const transport = new StreamableHTTPClientTransport(
		new URL("https://example.com/mcp"),
		{ authProvider: mockAuthProvider },
	);
	assert.ok(transport, "Transport should accept authProvider option");
});

test("HTTP transport with requestInit headers passes them to requests", async () => {
	const { StreamableHTTPClientTransport } = await import(
		"@modelcontextprotocol/sdk/client/streamableHttp.js"
	);

	const transport = new StreamableHTTPClientTransport(
		new URL("https://example.com/mcp"),
		{
			requestInit: {
				headers: {
					Authorization: "Bearer my-token",
				},
			},
		},
	);
	assert.ok(transport, "Transport should accept requestInit with headers");
});

// ── buildHttpTransportOpts ──────────────────────────────────────────────────

test("buildHttpTransportOpts returns empty opts for config without auth", () => {
	const opts = buildHttpTransportOpts({});
	assert.deepEqual(opts, {}, "No auth config should produce empty opts");
});

test("buildHttpTransportOpts returns requestInit.headers for config with headers", () => {
	const opts = buildHttpTransportOpts({
		headers: { Authorization: "Bearer tok_123" },
	});

	assert.ok(opts.requestInit, "Should produce requestInit");
	const headers = opts.requestInit!.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer tok_123");
});

test("buildHttpTransportOpts resolves env vars in header values", () => {
	process.env.__TEST_MCP_TOKEN = "secret-456";

	const opts = buildHttpTransportOpts({
		headers: { Authorization: "Bearer ${__TEST_MCP_TOKEN}" },
	});

	const headers = opts.requestInit!.headers as Record<string, string>;
	assert.equal(
		headers.Authorization,
		"Bearer secret-456",
		"Env vars in headers should be resolved",
	);

	delete process.env.__TEST_MCP_TOKEN;
});

test("buildHttpTransportOpts resolves multiple env vars in a single header", () => {
	process.env.__TEST_MCP_USER = "alice";
	process.env.__TEST_MCP_PASS = "s3cret";

	const opts = buildHttpTransportOpts({
		headers: { "X-Custom": "${__TEST_MCP_USER}:${__TEST_MCP_PASS}" },
	});

	const headers = opts.requestInit!.headers as Record<string, string>;
	assert.equal(headers["X-Custom"], "alice:s3cret");

	delete process.env.__TEST_MCP_USER;
	delete process.env.__TEST_MCP_PASS;
});

test("buildHttpTransportOpts replaces missing env vars with empty string", () => {
	delete process.env.__NONEXISTENT_VAR;

	const opts = buildHttpTransportOpts({
		headers: { Authorization: "Bearer ${__NONEXISTENT_VAR}" },
	});

	const headers = opts.requestInit!.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer ");
});

test("buildHttpTransportOpts creates OAuthClientProvider for oauth config", () => {
	const opts = buildHttpTransportOpts({
		oauth: {
			clientId: "my-client",
			scopes: ["read"],
		},
	});

	assert.ok(opts.authProvider, "OAuth config should produce an authProvider");
	assert.ok(opts.authProvider.clientMetadata, "authProvider should have clientMetadata");
	assert.equal(typeof opts.authProvider.tokens, "function", "authProvider.tokens should be a function");
	assert.equal(typeof opts.authProvider.saveTokens, "function", "authProvider.saveTokens should be a function");
	assert.equal(typeof opts.authProvider.redirectToAuthorization, "function");
	assert.equal(typeof opts.authProvider.codeVerifier, "function");
	assert.equal(typeof opts.authProvider.saveCodeVerifier, "function");
});

test("OAuth provider clientInformation includes clientId", () => {
	const opts = buildHttpTransportOpts({
		oauth: {
			clientId: "test-id-123",
			clientSecret: "test-secret",
		},
	});

	const info = opts.authProvider!.clientInformation();
	assert.ok(info, "clientInformation should return data");
	assert.equal(info!.client_id, "test-id-123");
	assert.equal((info as any).client_secret, "test-secret");
});

test("OAuth provider clientMetadata includes scopes", () => {
	const opts = buildHttpTransportOpts({
		oauth: {
			clientId: "scoped-client",
			scopes: ["issues:read", "issues:write"],
		},
	});

	const meta = opts.authProvider!.clientMetadata;
	assert.ok(meta, "clientMetadata should exist");
	assert.equal((meta as any).scope, "issues:read issues:write");
});

test("OAuth provider stores and retrieves tokens", () => {
	const opts = buildHttpTransportOpts({
		oauth: { clientId: "token-test" },
	});

	const provider = opts.authProvider!;

	// Initially no tokens
	assert.equal(provider.tokens(), undefined);

	// Save tokens
	const tokens = { access_token: "at_123", token_type: "Bearer", refresh_token: "rt_456" };
	provider.saveTokens(tokens);

	// Retrieve tokens
	const stored = provider.tokens();
	assert.ok(stored);
	assert.equal(stored!.access_token, "at_123");
});

test("OAuth provider stores and retrieves code verifier", () => {
	const opts = buildHttpTransportOpts({
		oauth: { clientId: "pkce-test" },
	});

	const provider = opts.authProvider!;
	provider.saveCodeVerifier("my-verifier-string");
	assert.equal(provider.codeVerifier(), "my-verifier-string");
});

test("OAuth takes precedence over headers when both are provided", () => {
	const opts = buildHttpTransportOpts({
		headers: { Authorization: "Bearer static-token" },
		oauth: { clientId: "oauth-client" },
	});

	assert.ok(opts.authProvider, "OAuth should be used when both are provided");
	assert.ok(!opts.requestInit, "requestInit should not be set when OAuth is active");
});
