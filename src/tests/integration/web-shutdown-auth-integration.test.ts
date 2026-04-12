/**
 * Integration test for /api/shutdown auth protection.
 *
 * This test actually starts an HTTP server to verify the middleware works.
 * Requires: `npm run build:web-host` to build the Next.js app first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let server: ReturnType<typeof spawn> | null = null;
const SERVER_PORT = 3456; // Use different port to avoid conflicts

async function startTestServer() {
  const projectRoot = process.cwd();
  const serverPath = join(projectRoot, "dist", "web", "server.js");

  // Set environment for test server
  const env = {
    ...process.env,
    PORT: String(SERVER_PORT),
    GSD_WEB_AUTH_TOKEN: "test-token-uat-12345",
    GSD_WEB_HOST: "127.0.0.1",
    GSD_WEB_PORT: String(SERVER_PORT),
    NODE_ENV: "test",
  };

  server = spawn("node", [serverPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for server to start
  const readyPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server didn't start within 10s")), 10000);
    server!.stderr!.on("data", (data) => {
      if (data.toString().includes("ready") || data.toString().includes("started") || data.toString().includes("listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    // Also resolve after a short delay since the server might not log anything
    setTimeout(() => {
      clearTimeout(timeout);
      resolve();
    }, 2000);
  });

  try {
    await readyPromise;
    // Additional delay for server to be fully ready
    await sleep(1000);
  } catch (e) {
    server?.kill();
    throw e;
  }
}

function stopTestServer() {
  if (server) {
    server.kill("SIGTERM");
    server = null;
  }
}

async function makeShutdownRequest(options: {
  token?: string;
  origin?: string;
  method?: string;
}): Promise<{ status: number; body: string }> {
  const url = new URL(`http://127.0.0.1:${SERVER_PORT}/api/shutdown`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.token) {
    if (options.token.includes("?")) {
      // Query param format - strip the "?" marker before setting
      url.searchParams.set("_token", options.token.slice(1));
    } else {
      // Bearer header format
      headers["Authorization"] = `Bearer ${options.token}`;
    }
  }

  if (options.origin) {
    headers["Origin"] = options.origin;
  }

  const response = await fetch(url.toString(), {
    method: options.method || "POST",
    headers,
  });

  const body = await response.text();
  return { status: response.status, body };
}

import { existsSync } from "node:fs";

// Only run these tests if the web server is built
const describe = existsSync(join(process.cwd(), "dist", "web", "server.js"))
  ? test.describe
  : test.describe.skip;

describe("/api/shutdown auth integration", () => {
  test.before(async () => {
    await startTestServer();
  });

  test.after(async () => {
    stopTestServer();
  });

  test("rejects request without auth", async () => {
    const result = await makeShutdownRequest({});
    assert.equal(result.status, 401, "should return 401 without auth");
    assert.ok(result.body.includes("Unauthorized") || result.body.includes("unauthorized"));
  });

  test("rejects request with invalid token", async () => {
    const result = await makeShutdownRequest({ token: "wrong-token" });
    assert.equal(result.status, 401, "should return 401 with wrong token");
  });

  test("allows request with valid Bearer token", async () => {
    const result = await makeShutdownRequest({ token: "test-token-uat-12345" });
    assert.equal(result.status, 200, "should return 200 with valid token");
    assert.ok(result.body.includes("ok"));
  });

  test("allows request with valid _token parameter", async () => {
    const result = await makeShutdownRequest({
      token: "?test-token-uat-12345", // Special marker to use query param
    });
    assert.equal(result.status, 200, "should return 200 with valid _token");
    assert.ok(result.body.includes("ok"));
  });

  test("rejects request with bad origin", async () => {
    const result = await makeShutdownRequest({
      token: "test-token-uat-12345",
      origin: "http://evil.com",
    });
    assert.equal(result.status, 403, "should return 403 with bad origin");
  });
});
