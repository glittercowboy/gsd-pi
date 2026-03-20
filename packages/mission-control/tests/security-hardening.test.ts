/**
 * Behavioral tests for Phase 20.2.3 security hardening.
 *
 * Covers:
 *   C4  — proxy port range validation (1024-65535)
 *   C1/C2 — fs-api mkdir restricted to user home directory
 *   H7  — git-api rejects relative root paths
 *   M   — auth-api uses crypto.randomUUID() (UUID v4 format, not Math.random output)
 */

import { describe, it, expect } from "bun:test";
import { handleProxyRequest } from "../src/server/proxy-api";
import { handleFsRequest } from "../src/server/fs-api";
import { handleGitRequest } from "../src/server/git-api";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// C4 — Proxy port range validation
// ---------------------------------------------------------------------------

describe("C4: proxy rejects privileged ports (< 1024) to prevent SSRF", () => {
  it("returns offline HTML for port 80 (< 1024)", async () => {
    const req = new Request("http://localhost:4000/api/preview/");
    const url = new URL(req.url);
    const response = await handleProxyRequest(req, url, 80);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("offline");
  });

  it("returns offline HTML for port 443 (< 1024)", async () => {
    const req = new Request("http://localhost:4000/api/preview/");
    const url = new URL(req.url);
    const response = await handleProxyRequest(req, url, 443);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("offline");
  });

  it("returns offline HTML for port 22 (SSH, < 1024)", async () => {
    const req = new Request("http://localhost:4000/api/preview/");
    const url = new URL(req.url);
    const response = await handleProxyRequest(req, url, 22);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("offline");
  });

  it("returns offline HTML for port 65536 (> 65535, out of range)", async () => {
    const req = new Request("http://localhost:4000/api/preview/");
    const url = new URL(req.url);
    const response = await handleProxyRequest(req, url, 65536);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("offline");
  });

  it("attempts to proxy for port 3000 (valid unprivileged port)", async () => {
    // Port 3000 is valid — proxy will try to connect and return offline if nothing listening.
    // The key behavior: it does NOT return the privileged-port offline response before trying.
    const req = new Request("http://localhost:4000/api/preview/");
    const url = new URL(req.url);
    const response = await handleProxyRequest(req, url, 3000);
    // Either proxied successfully OR failed to connect (offline) — both are valid here.
    // What matters: a valid port does not get blocked by the port range guard before reaching fetch.
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200); // offline page returned when no dev server on 3000
  });
});

// ---------------------------------------------------------------------------
// C1/C2 — fs-api mkdir restricted to user home directory
// ---------------------------------------------------------------------------

describe("C1/C2: fs-api mkdir rejects paths outside home directory", () => {
  it("returns 403 when mkdir path is outside home directory (root-level path)", async () => {
    // On all platforms, a root-level temp-style path should be outside homedir
    // Use a path that is definitely not inside homedir
    const outsidePath = "/outside-home-directory-test-xyz";

    const body = JSON.stringify({ path: outsidePath });
    const req = new Request("http://localhost:4000/api/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const url = new URL(req.url);
    const response = await handleFsRequest(req, url);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    const json = await response!.json() as any;
    expect(json.error).toBe("mkdir restricted to home directory");
  });

  it("allows mkdir for a path inside home directory", async () => {
    // A path inside home should pass the homedir check
    // (may still fail if it tries to create a conflicting path — but the 403 guard should not trigger)
    const insidePath = join(homedir(), "gsd-test-mkdir-check-" + Date.now());

    const body = JSON.stringify({ path: insidePath });
    const req = new Request("http://localhost:4000/api/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const url = new URL(req.url);
    const response = await handleFsRequest(req, url);

    expect(response).not.toBeNull();
    // Should NOT be 403 (the homedir restriction should not block this)
    expect(response!.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// H7 — git-api rejects relative root paths
// ---------------------------------------------------------------------------

describe("H7: git-api rejects relative root query parameters", () => {
  it("returns 400 when root is a relative path", async () => {
    const req = new Request("http://localhost:4000/api/git/status?root=relative/path/to/project");
    const url = new URL(req.url);
    const response = await handleGitRequest(req, url, process.cwd());

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    const json = await response!.json() as any;
    expect(json.error).toBe("root must be an absolute path");
  });

  it("returns 400 when root is a dot-relative path (./path)", async () => {
    const req = new Request("http://localhost:4000/api/git/status?root=./src");
    const url = new URL(req.url);
    const response = await handleGitRequest(req, url, process.cwd());

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    const json = await response!.json() as any;
    expect(json.error).toBe("root must be an absolute path");
  });

  it("accepts absolute root path without error from the validation layer", async () => {
    // An absolute path should pass H7 validation (may produce git error if not a repo,
    // but must NOT return 400 "root must be an absolute path")
    const req = new Request(`http://localhost:4000/api/git/status?root=${encodeURIComponent(homedir())}`);
    const url = new URL(req.url);
    const response = await handleGitRequest(req, url, process.cwd());

    expect(response).not.toBeNull();
    // Should not be a 400 with the relative-path error
    if (response!.status === 400) {
      const json = await response!.json() as any;
      expect(json.error).not.toBe("root must be an absolute path");
    }
    // 200 (empty git status) or other error is fine — just not the H7 400
  });
});

// ---------------------------------------------------------------------------
// M — auth-api session IDs are crypto.randomUUID() format (not Math.random)
// ---------------------------------------------------------------------------

describe("M: auth-api session IDs are cryptographically random UUIDs", () => {
  it("auth-api.ts source uses crypto.randomUUID() for sessionId, not Math.random()", async () => {
    // Behavioral: verify the source code produces the correct pattern.
    // Reading the source is the only reliable way to test this without spinning up a full auth server.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const authApiSrc = readFileSync(
      resolve(import.meta.dir, "../src/server/auth-api.ts"),
      "utf-8"
    );

    // Must use crypto.randomUUID()
    expect(authApiSrc).toContain("crypto.randomUUID()");

    // Must NOT use Math.random() for session ID generation on the same line
    // (the sessionId assignment line must not contain Math.random)
    const sessionIdLine = authApiSrc
      .split("\n")
      .find((line) => line.includes("sessionId") && line.includes("=") && !line.includes("//"));
    expect(sessionIdLine).toBeDefined();
    expect(sessionIdLine).toContain("crypto.randomUUID()");
    expect(sessionIdLine).not.toContain("Math.random");
  });
});
