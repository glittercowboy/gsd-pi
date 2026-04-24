/**
 * Integration tests for remote-questions HTTP client proxy routing.
 *
 * Spawns a real local HTTP CONNECT proxy stub, then asserts that
 * apiRequest actually routes HTTPS traffic through the proxy.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { ProxyAgent } from "undici";
import { apiRequest } from "../http-client.js";

interface ProxyStub {
  server: http.Server;
  port: number;
  requests: Array<{ method?: string; url?: string }>;
  sockets: Set<Socket | Duplex>;
}

function createConnectProxy(): Promise<ProxyStub> {
  const requests: ProxyStub["requests"] = [];
  const sockets = new Set<Socket | Duplex>();

  const server = http.createServer();
  server.on("connect", (req, clientSocket) => {
    sockets.add(clientSocket);
    requests.push({ method: req.method, url: req.url });
    // Accept CONNECT to prove proxy was used, then destroy to trigger expected TLS error.
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    setTimeout(() => {
      clientSocket.destroy();
      sockets.delete(clientSocket);
    }, 50);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as import("node:net").AddressInfo).port;
      resolve({ server, port, requests, sockets });
    });
    server.on("error", reject);
  });
}

function closeServer(stub: ProxyStub): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of stub.sockets) {
      socket.destroy();
    }
    stub.server.close(() => resolve());
  });
}

describe("apiRequest proxy integration", () => {
  let proxy: ProxyStub;

  before(async () => {
    proxy = await createConnectProxy();
  });

  after(async () => {
    await closeServer(proxy);
  });

  it("routes an HTTPS request through the proxy via CONNECT tunnel", async () => {
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const agent = new ProxyAgent(proxyUrl);

    try {
      await apiRequest("https://api.telegram.org/botFAKE/getMe", "POST", undefined, {
        agent,
        errorLabel: "Test",
      });
      assert.fail("expected request to fail due to closed proxy tunnel");
    } catch (err) {
      // Expected: TLS handshake fails because proxy tunnel closes immediately
      assert.ok(err instanceof Error, "expected an Error");
    } finally {
      await agent.close();
    }

    assert.equal(proxy.requests.length, 1, "expected exactly one proxy request");
    assert.equal(proxy.requests[0].method, "CONNECT", "expected proxy to receive CONNECT");
    assert.ok(
      proxy.requests[0].url?.includes("api.telegram.org"),
      `expected proxy URL to include target host, got: ${proxy.requests[0].url}`,
    );
  });

  it("creates a ProxyAgent with credentials and routes through proxy", async () => {
    proxy.requests.length = 0;

    const proxyUrl = `http://user:pass@127.0.0.1:${proxy.port}`;
    const agent = new ProxyAgent(proxyUrl);

    try {
      await apiRequest("https://api.telegram.org/botFAKE/getMe", "POST", undefined, {
        agent,
        errorLabel: "Test",
      });
      assert.fail("expected request to fail due to closed proxy tunnel");
    } catch (err) {
      assert.ok(err instanceof Error, "expected an Error");
    } finally {
      await agent.close();
    }

    assert.equal(proxy.requests.length, 1, "expected exactly one proxy request");
    assert.equal(proxy.requests[0].method, "CONNECT", "expected proxy to receive CONNECT");
  });
});
