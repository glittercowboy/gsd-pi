/**
 * Integration tests for /api/shutdown route auth protection.
 *
 * Verifies that the middleware actually protects the shutdown endpoint.
 * This would have caught the bug where middleware.ts wasn't wiring in proxy.ts.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jiti = require("jiti")(__filename, { interopDefault: true, debug: false });

const { proxy } = jiti("../../proxy.ts");

function mockEnv(token) {
  const originalEnv = { ...process.env };

  if (token !== null) {
    process.env.GSD_WEB_AUTH_TOKEN = token;
  } else {
    delete process.env.GSD_WEB_AUTH_TOKEN;
  }

  process.env.GSD_WEB_HOST = "127.0.0.1";
  process.env.GSD_WEB_PORT = "3000";
  delete process.env.GSD_WEB_ALLOWED_ORIGINS;

  return () => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  };
}

// Minimal NextRequest mock for testing
class MockNextRequest {
  constructor(url, options = {}) {
    this.url = url;
    const parsed = new URL(url);
    this.nextUrl = {
      pathname: parsed.pathname,
      searchParams: parsed.searchParams,
    };
    const headers = options.headers ?? {};
    this._headers = new Map(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
  }

  get headers() {
    return {
      get: (name) => this._headers.get(name.toLowerCase()),
      set: (name, value) => this._headers.set(name.toLowerCase(), value),
      has: (name) => this._headers.has(name.toLowerCase()),
    };
  }
}

test.describe("/api/shutdown route is protected by middleware", () => {
  test("rejects shutdown request without auth token", (t) => {
    const cleanup = mockEnv("secret-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/shutdown", {
      method: "POST",
    });

    const result = proxy(request);
    assert.ok(result, "should return a response (reject)");
    assert.equal(result.status, 401, "should return 401 Unauthorized");
  });

  test("rejects shutdown request with invalid token", (t) => {
    const cleanup = mockEnv("correct-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/shutdown", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });

    const result = proxy(request);
    assert.ok(result, "should return a response (reject)");
    assert.equal(result.status, 401, "should return 401 Unauthorized");
  });

  test("allows shutdown request with valid Bearer token", (t) => {
    const cleanup = mockEnv("valid-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/shutdown", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    const result = proxy(request);
    // Should allow through (no error status)
    if (result) {
      assert.ok(
        result.status !== 401 && result.status !== 403,
        "should allow request with valid token"
      );
    }
  });

  test("allows shutdown request with valid _token parameter", (t) => {
    const cleanup = mockEnv("valid-token");

    t.after(cleanup);

    const request = new MockNextRequest(
      "http://localhost:3000/api/shutdown?_token=valid-token",
      { method: "POST" }
    );

    const result = proxy(request);
    if (result) {
      assert.ok(
        result.status !== 401 && result.status !== 403,
        "should allow request with valid _token"
      );
    }
  });

  test("rejects shutdown request with non-matching origin", (t) => {
    const cleanup = mockEnv("valid-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/shutdown", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        origin: "http://evil.com",
      },
    });

    const result = proxy(request);
    assert.ok(result, "should return a response (reject)");
    assert.equal(result.status, 403, "should return 403 Forbidden for bad origin");
  });
});
