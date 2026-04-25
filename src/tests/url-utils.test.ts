import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isBlockedUrl, setFetchAllowedUrls, getFetchAllowedUrls } from "../resources/extensions/search-the-web/url-utils.ts";

describe("isBlockedUrl — SSRF protection", () => {
  it("blocks localhost", () => {
    assert.equal(isBlockedUrl("http://localhost/admin"), true);
    assert.equal(isBlockedUrl("http://localhost:8080/"), true);
  });

  it("blocks 127.0.0.0/8", () => {
    assert.equal(isBlockedUrl("http://127.0.0.1/"), true);
    assert.equal(isBlockedUrl("http://127.0.0.2:3000/path"), true);
  });

  it("blocks 10.0.0.0/8 (private)", () => {
    assert.equal(isBlockedUrl("http://10.0.0.1/"), true);
    assert.equal(isBlockedUrl("http://10.255.255.255/"), true);
  });

  it("blocks 172.16-31.x.x (private)", () => {
    assert.equal(isBlockedUrl("http://172.16.0.1/"), true);
    assert.equal(isBlockedUrl("http://172.31.255.255/"), true);
  });

  it("blocks 192.168.x.x (private)", () => {
    assert.equal(isBlockedUrl("http://192.168.1.1/"), true);
    assert.equal(isBlockedUrl("http://192.168.0.100:9200/"), true);
  });

  it("blocks 169.254.x.x (link-local / cloud metadata)", () => {
    assert.equal(isBlockedUrl("http://169.254.169.254/latest/meta-data/"), true);
  });

  it("blocks cloud metadata hostnames", () => {
    assert.equal(isBlockedUrl("http://metadata.google.internal/computeMetadata/"), true);
  });

  it("blocks non-http protocols", () => {
    assert.equal(isBlockedUrl("file:///etc/passwd"), true);
    assert.equal(isBlockedUrl("ftp://internal.server/data"), true);
  });

  it("blocks invalid URLs", () => {
    assert.equal(isBlockedUrl("not-a-url"), true);
    assert.equal(isBlockedUrl(""), true);
  });

  it("allows public URLs", () => {
    assert.equal(isBlockedUrl("https://example.com"), false);
    assert.equal(isBlockedUrl("https://api.github.com/repos"), false);
    assert.equal(isBlockedUrl("http://docs.python.org/3/"), false);
  });

  it("allows public IPs", () => {
    assert.equal(isBlockedUrl("http://8.8.8.8/"), false);
    assert.equal(isBlockedUrl("https://1.1.1.1/"), false);
  });
});

describe("REGRESSION #666: private URL blocked with no override", () => {
  afterEach(() => {
    setFetchAllowedUrls([]);
  });

  it("private IP is blocked by default, then unblocked by setFetchAllowedUrls", () => {
    const internalUrl = "http://192.168.1.100/internal-docs/api-reference";

    // Bug: private IP is blocked with no way to allowlist
    assert.equal(isBlockedUrl(internalUrl), true, "private IP is blocked by the hardcoded blocklist");

    // Fix: override the allowlist to include this host
    setFetchAllowedUrls(["192.168.1.100"]);
    assert.equal(isBlockedUrl(internalUrl), false, "private IP must not be blocked after override");
  });
});

describe("setFetchAllowedUrls — user override", () => {
  afterEach(() => {
    setFetchAllowedUrls([]);
  });

  it("defaults to empty allowlist", () => {
    assert.deepEqual(getFetchAllowedUrls(), []);
  });

  it("exempts an allowed hostname from blocking", () => {
    assert.equal(isBlockedUrl("http://192.168.1.100/docs"), true, "blocked by default");
    setFetchAllowedUrls(["192.168.1.100"]);
    assert.equal(isBlockedUrl("http://192.168.1.100/docs"), false, "allowed after override");
  });

  it("exempts localhost when explicitly allowed", () => {
    assert.equal(isBlockedUrl("http://localhost:3000/api"), true, "blocked by default");
    setFetchAllowedUrls(["localhost"]);
    assert.equal(isBlockedUrl("http://localhost:3000/api"), false, "allowed after override");
  });

  it("exempts cloud metadata hostname when allowed", () => {
    assert.equal(isBlockedUrl("http://metadata.google.internal/computeMetadata/"), true, "blocked by default");
    setFetchAllowedUrls(["metadata.google.internal"]);
    assert.equal(isBlockedUrl("http://metadata.google.internal/computeMetadata/"), false, "allowed after override");
  });

  it("does not affect URLs not in the allowlist", () => {
    setFetchAllowedUrls(["192.168.1.100"]);
    assert.equal(isBlockedUrl("http://192.168.1.200/secret"), true, "other private IPs still blocked");
    assert.equal(isBlockedUrl("http://localhost/admin"), true, "localhost still blocked");
  });

  it("still allows public URLs without configuration", () => {
    setFetchAllowedUrls(["192.168.1.100"]);
    assert.equal(isBlockedUrl("https://example.com"), false);
  });

  it("still blocks non-HTTP protocols even with allowlist", () => {
    setFetchAllowedUrls(["localhost"]);
    assert.equal(isBlockedUrl("file:///etc/passwd"), true, "file:// still blocked");
    assert.equal(isBlockedUrl("ftp://localhost/data"), true, "ftp:// still blocked");
  });

  it("is case-insensitive for hostnames", () => {
    setFetchAllowedUrls(["MyHost.Internal"]);
    assert.equal(isBlockedUrl("http://myhost.internal/api"), false);
  });
});