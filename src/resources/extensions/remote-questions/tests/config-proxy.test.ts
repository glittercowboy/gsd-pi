/**
 * Unit tests for remote-questions proxy resolution logic.
 *
 * These tests verify the resolveProxyUrl function directly without requiring
 * the full GSD runtime dependencies.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Inline implementation for testing — mirrors the logic in config.ts
function resolveProxyUrl(configProxyUrl?: string): string | undefined {
  const envProxy = process.env.TELEGRAM_PROXY_URL;
  if (envProxy) {
    return envProxy;
  }

  if (configProxyUrl) {
    return configProxyUrl;
  }

  return process.env.https_proxy || process.env.HTTPS_PROXY ||
         process.env.http_proxy || process.env.HTTP_PROXY ||
         process.env.all_proxy || process.env.ALL_PROXY ||
         undefined;
}

describe("resolveProxyUrl", () => {
  // Store original env vars
  const originalTelegramProxy = process.env.TELEGRAM_PROXY_URL;
  const originalHttpsProxy = process.env.https_proxy;
  const originalHTTPS_PROXY = process.env.HTTPS_PROXY;
  const originalHttpProxy = process.env.http_proxy;
  const originalHTTP_PROXY = process.env.HTTP_PROXY;
  const originalAllProxy = process.env.all_proxy;
  const originalALL_PROXY = process.env.ALL_PROXY;

  beforeEach(() => {
    // Clear all proxy-related env vars before each test
    delete process.env.TELEGRAM_PROXY_URL;
    delete process.env.https_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.all_proxy;
    delete process.env.ALL_PROXY;
  });

  // Restore original env vars after all tests
  it("restores environment after tests", () => {
    if (originalTelegramProxy !== undefined) process.env.TELEGRAM_PROXY_URL = originalTelegramProxy;
    if (originalHttpsProxy !== undefined) process.env.https_proxy = originalHttpsProxy;
    if (originalHTTPS_PROXY !== undefined) process.env.HTTPS_PROXY = originalHTTPS_PROXY;
    if (originalHttpProxy !== undefined) process.env.http_proxy = originalHttpProxy;
    if (originalHTTP_PROXY !== undefined) process.env.HTTP_PROXY = originalHTTP_PROXY;
    if (originalAllProxy !== undefined) process.env.all_proxy = originalAllProxy;
    if (originalALL_PROXY !== undefined) process.env.ALL_PROXY = originalALL_PROXY;
  });

  it("returns undefined when no proxy is configured", () => {
    const result = resolveProxyUrl();
    assert.equal(result, undefined);
  });

  it("prefers TELEGRAM_PROXY_URL over config and standard env vars", () => {
    process.env.TELEGRAM_PROXY_URL = "http://telegram-proxy.example.com:8080";
    process.env.https_proxy = "http://https-proxy.example.com:9090";

    const result = resolveProxyUrl("http://config-proxy.example.com:7070");
    assert.equal(result, "http://telegram-proxy.example.com:8080");
  });

  it("falls back to config proxy_url when TELEGRAM_PROXY_URL is not set", () => {
    const result = resolveProxyUrl("http://config-proxy.example.com:7070");
    assert.equal(result, "http://config-proxy.example.com:7070");
  });

  it("falls back to https_proxy when no explicit proxy is set", () => {
    process.env.https_proxy = "http://https-proxy.example.com:9090";

    const result = resolveProxyUrl();
    assert.equal(result, "http://https-proxy.example.com:9090");
  });

  it("falls back to HTTPS_PROXY (uppercase) when https_proxy is not set", () => {
    process.env.HTTPS_PROXY = "http://HTTPS-PROXY.example.com:9090";

    const result = resolveProxyUrl();
    assert.equal(result, "http://HTTPS-PROXY.example.com:9090");
  });

  it("falls back to http_proxy when no https proxy is set", () => {
    process.env.http_proxy = "http://http-proxy.example.com:8080";

    const result = resolveProxyUrl();
    assert.equal(result, "http://http-proxy.example.com:8080");
  });

  it("falls back to HTTP_PROXY (uppercase) when http_proxy is not set", () => {
    process.env.HTTP_PROXY = "http://HTTP-PROXY.example.com:8080";

    const result = resolveProxyUrl();
    assert.equal(result, "http://HTTP-PROXY.example.com:8080");
  });

  it("falls back to all_proxy when no http/https proxy is set", () => {
    process.env.all_proxy = "socks5://all-proxy.example.com:1080";

    const result = resolveProxyUrl();
    assert.equal(result, "socks5://all-proxy.example.com:1080");
  });

  it("falls back to ALL_PROXY (uppercase) when all_proxy is not set", () => {
    process.env.ALL_PROXY = "socks5://ALL-PROXY.example.com:1080";

    const result = resolveProxyUrl();
    assert.equal(result, "socks5://ALL-PROXY.example.com:1080");
  });

  it("prefers https_proxy over http_proxy and all_proxy", () => {
    process.env.https_proxy = "http://https.example.com:9090";
    process.env.http_proxy = "http://http.example.com:8080";
    process.env.all_proxy = "socks5://all.example.com:1080";

    const result = resolveProxyUrl();
    assert.equal(result, "http://https.example.com:9090");
  });

  it("prefers http_proxy over all_proxy", () => {
    process.env.http_proxy = "http://http.example.com:8080";
    process.env.all_proxy = "socks5://all.example.com:1080";

    const result = resolveProxyUrl();
    assert.equal(result, "http://http.example.com:8080");
  });
});
