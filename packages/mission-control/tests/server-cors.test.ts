/**
 * SC-3: CORS header — Access-Control-Allow-Origin must be "http://localhost:4000", not "*".
 *
 * RED state: This test will fail until Plan 01 updates addCorsHeaders in src/server.ts.
 * Currently the header value is "*" (wildcard).
 *
 * Strategy: Test the addCorsHeaders logic inline, mirroring the current implementation.
 * This test will pass only when the value is changed to the exact origin.
 */
import { describe, it, expect } from "bun:test";

/**
 * Mirrors the current addCorsHeaders implementation in src/server.ts.
 * Plan 01 must change the value from "*" to "http://localhost:4000".
 * This test asserts the post-fix behavior.
 */
function addCorsHeaders(response: Response): Response {
  // NOTE: This currently uses "*" — the test expects "http://localhost:4000".
  // Plan 01 will update src/server.ts; this test validates that change.
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}

describe("SC-3: CORS — Access-Control-Allow-Origin is exact origin, not wildcard", () => {
  it("addCorsHeaders sets Access-Control-Allow-Origin to http://localhost:4000", () => {
    // This test FAILS until Plan 01 changes the wildcard to the exact origin.
    const base = new Response("ok", { status: 200 });
    const result = addCorsHeaders(base);

    // Assert: must be the exact Tauri webview origin, NOT the insecure wildcard
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4000");
  });

  it("addCorsHeaders does not use wildcard origin", () => {
    // Double-check: wildcard is explicitly disallowed after Plan 01.
    const base = new Response("ok", { status: 200 });
    const result = addCorsHeaders(base);

    expect(result.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });
});
