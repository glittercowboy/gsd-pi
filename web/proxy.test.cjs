/**
 * web/proxy.test.ts — unit tests for auth middleware
 *
 * Tests the proxy() function that protects /api/* routes with:
 * - Bearer token or _token query parameter auth
 * - Origin validation (if present)
 * - Allow-through for non-API routes
 */

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jiti = require("jiti")(__filename, { interopDefault: true, debug: false });

// ---------------------------------------------------------------------------
// Load the proxy function via jiti (handles TypeScript imports)
// ---------------------------------------------------------------------------

const { proxy } = jiti("./proxy.ts");

// ---------------------------------------------------------------------------
// Mock NextRequest (minimal implementation for testing)
// ---------------------------------------------------------------------------

class MockNextRequest {
  constructor(url, options = {}) {
    this.url = url;
    const parsed = new URL(url);
    this.nextUrl = {
      pathname: parsed.pathname,
      searchParams: parsed.searchParams,
    };
    // Normalize headers to lowercase for case-insensitive lookups
    const headers = options.headers ?? {};
    this._headers = new Map(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
  }

  // Next.js compatibility - headers.get should be case-insensitive
  get headers() {
    return {
      get: (name) => this._headers.get(name.toLowerCase()),
      set: (name, value) => this._headers.set(name.toLowerCase(), value),
      has: (name) => this._headers.has(name.toLowerCase()),
    };
  }
}

// ---------------------------------------------------------------------------
// Helper to mock environment variables
// ---------------------------------------------------------------------------

function mockEnv(token, host = "127.0.0.1", port = "3000", allowedOrigins) {
  const originalEnv = { ...process.env };

  if (token !== null) {
    process.env.GSD_WEB_AUTH_TOKEN = token;
  } else {
    delete process.env.GSD_WEB_AUTH_TOKEN;
  }

  process.env.GSD_WEB_HOST = host;
  process.env.GSD_WEB_PORT = port;

  if (allowedOrigins !== undefined) {
    process.env.GSD_WEB_ALLOWED_ORIGINS = allowedOrigins;
  } else {
    delete process.env.GSD_WEB_ALLOWED_ORIGINS;
  }

  return () => {
    // Restore original env
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxy - auth token validation", () => {
  test("allows API route with valid Bearer token", (t) => {
    const cleanup = mockEnv("test-token-123");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: { authorization: "Bearer test-token-123" },
    });

    const result = proxy(request);
    // NextResponse.next() returns a NextResponse object (not undefined)
    // The absence of error status indicates the request is allowed through
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should not return error status");
    }
  });

  test("allows API route with valid _token query parameter", (t) => {
    const cleanup = mockEnv("test-token-456");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot?_token=test-token-456", {});

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should not return error status");
    }
  });

  test("rejects API route with invalid Bearer token", (t) => {
    const cleanup = mockEnv("correct-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: { authorization: "Bearer wrong-token" },
    });

    const result = proxy(request);
    assert.ok(result, "should return a response (reject)");
    assert.equal(result.status, 401, "should return 401 Unauthorized");
  });

  test("rejects API route with missing token when one is configured", (t) => {
    const cleanup = mockEnv("configured-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {});

    const result = proxy(request);
    assert.ok(result, "should return a response (reject)");
    assert.equal(result.status, 401, "should return 401 Unauthorized");
  });

  test("allows API route when no token is configured (dev mode)", (t) => {
    const cleanup = mockEnv(null);

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {});

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should not return error status in dev mode");
    }
  });

  test("prefers Bearer token over _token parameter", (t) => {
    const cleanup = mockEnv("bearer-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot?_token=query-token", {
      headers: { authorization: "Bearer bearer-token" },
    });

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "Bearer token should allow request");
    }
  });
});

describe("proxy - origin validation", () => {
  test("allows request with matching origin header", (t) => {
    const cleanup = mockEnv("test-token", "127.0.0.1", "3000");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: {
        authorization: "Bearer test-token",
        origin: "http://127.0.0.1:3000",
      },
    });

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should allow through with matching origin");
    }
  });

  test("rejects request with non-matching origin header", (t) => {
    const cleanup = mockEnv("test-token", "127.0.0.1", "3000");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: {
        authorization: "Bearer test-token",
        origin: "http://evil.com:3000",
      },
    });

    const result = proxy(request);
    assert.ok(result, "should return a response (reject)");
    assert.equal(result.status, 403, "should return 403 Forbidden");
  });

  test("allows request with origin from GSD_WEB_ALLOWED_ORIGINS", (t) => {
    const cleanup = mockEnv("test-token", "127.0.0.1", "3000", "https://tailscale.example.com,https://ngrok.example.com");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: {
        authorization: "Bearer test-token",
        origin: "https://tailscale.example.com",
      },
    });

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should allow through with whitelisted origin");
    }
  });

  test("allows request with no origin header (e.g., same-origin, curl, etc.)", (t) => {
    const cleanup = mockEnv("test-token", "127.0.0.1", "3000");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: { authorization: "Bearer test-token" },
    });

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should allow through with no origin header");
    }
  });

  test("respects custom host/port in origin validation", (t) => {
    const cleanup = mockEnv("test-token", "0.0.0.0", "8080");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: {
        authorization: "Bearer test-token",
        origin: "http://0.0.0.0:8080",
      },
    });

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should allow through with custom host:port origin");
    }
  });
});

describe("proxy - route filtering", () => {
  test("allows non-API routes through without auth check", (t) => {
    const cleanup = mockEnv("some-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/_next/static/chunks/main.js", {});

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should allow static assets through without auth");
    }
  });

  test("allows page routes through without auth check", (t) => {
    const cleanup = mockEnv("some-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/dashboard", {});

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should allow page routes through without auth");
    }
  });

  test("protects all API routes under /api/", (t) => {
    const cleanup = mockEnv("protected-token");

    t.after(cleanup);

    const apiPaths = [
      "/api/boot",
      "/api/shutdown",
      "/api/session/command",
      "/api/session/events",
      "/api/onboarding",
    ];

    for (const path of apiPaths) {
      const request = new MockNextRequest(`http://localhost:3000${path}`, {});
      const result = proxy(request);
      assert.ok(result, `${path} should be protected`);
      assert.equal(result.status, 401, `${path} should return 401 without auth`);
    }
  });
});

describe("proxy - edge cases", () => {
  test("handles Bearer token with extra whitespace", (t) => {
    const cleanup = mockEnv("the-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: { authorization: "Bearer  the-token  " }, // extra spaces
    });

    const result = proxy(request);
    // Note: Our mock handles case-insensitivity but the proxy code itself
    // does exact string matching, so extra spaces would cause auth failure
    // This test documents current behavior
    assert.ok(result, "extra spaces in token cause auth fail");
    assert.equal(result.status, 401);
  });

  test("handles multiple origins in GSD_WEB_ALLOWED_ORIGINS with spaces", (t) => {
    const cleanup = mockEnv("test-token", "127.0.0.1", "3000", " https://a.com , https://b.com , https://c.com ");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: {
        authorization: "Bearer test-token",
        origin: "https://b.com",
      },
    });

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "should trim and parse comma-separated origins");
    }
  });

  test("empty _token parameter is treated as missing", (t) => {
    const cleanup = mockEnv("real-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot?_token=", {});

    const result = proxy(request);
    assert.ok(result, "should reject empty token");
    assert.equal(result.status, 401, "should return 401");
  });

  test("case-insensitive header lookup works", (t) => {
    const cleanup = mockEnv("test-token");

    t.after(cleanup);

    const request = new MockNextRequest("http://localhost:3000/api/boot", {
      headers: { Authorization: "Bearer test-token" }, // Capital A
    });

    const result = proxy(request);
    if (result) {
      assert.ok(result.status !== 401 && result.status !== 403, "case-insensitive header lookup should work");
    }
  });
});
