import test from "node:test";
import assert from "node:assert/strict";

// Import directly from the leaf module — no transitive dependencies.
import { isInfrastructureError, INFRA_ERROR_CODES } from "../auto/infra-errors.js";

// ── INFRA_ERROR_CODES constant ───────────────────────────────────────────────

test("INFRA_ERROR_CODES contains the expected codes", () => {
  for (const code of [
    "ENOSPC", "ENOMEM", "EROFS", "EDQUOT", "EMFILE", "ENFILE",
    "EAGAIN", "ECONNREFUSED", "ENOTFOUND", "ENETUNREACH",
  ]) {
    assert.ok(INFRA_ERROR_CODES.has(code), `missing ${code}`);
  }
  assert.equal(INFRA_ERROR_CODES.size, 10, "unexpected extra codes");
});

// ── isInfrastructureError: code property detection ───────────────────────────

test("detects ENOSPC via code property", () => {
  const err = Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" });
  assert.equal(isInfrastructureError(err), "ENOSPC");
});

test("detects ENOMEM via code property", () => {
  const err = Object.assign(new Error("Cannot allocate memory"), { code: "ENOMEM" });
  assert.equal(isInfrastructureError(err), "ENOMEM");
});

test("detects EROFS via code property", () => {
  const err = Object.assign(new Error("read-only filesystem"), { code: "EROFS" });
  assert.equal(isInfrastructureError(err), "EROFS");
});

test("detects EDQUOT via code property", () => {
  const err = Object.assign(new Error("quota exceeded"), { code: "EDQUOT" });
  assert.equal(isInfrastructureError(err), "EDQUOT");
});

test("detects EMFILE via code property", () => {
  const err = Object.assign(new Error("too many open files"), { code: "EMFILE" });
  assert.equal(isInfrastructureError(err), "EMFILE");
});

test("detects ENFILE via code property", () => {
  const err = Object.assign(new Error("file table overflow"), { code: "ENFILE" });
  assert.equal(isInfrastructureError(err), "ENFILE");
});

test("detects EAGAIN via code property", () => {
  const err = Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
  assert.equal(isInfrastructureError(err), "EAGAIN");
});

test("detects EAGAIN in error message fallback", () => {
  const err = new Error("spawn failed: EAGAIN resource temporarily unavailable");
  assert.equal(isInfrastructureError(err), "EAGAIN");
});

test("detects ECONNREFUSED via code property", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED" });
  assert.equal(isInfrastructureError(err), "ECONNREFUSED");
});

test("detects ENOTFOUND via code property", () => {
  const err = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" });
  assert.equal(isInfrastructureError(err), "ENOTFOUND");
});

test("detects ENETUNREACH via code property", () => {
  const err = Object.assign(new Error("connect ENETUNREACH 2607:f8b0:4004::"), { code: "ENETUNREACH" });
  assert.equal(isInfrastructureError(err), "ENETUNREACH");
});

// ── isInfrastructureError: message fallback ──────────────────────────────────

test("falls back to message scanning when no code property", () => {
  const err = new Error("pip install failed: ENOSPC: no space left on device");
  assert.equal(isInfrastructureError(err), "ENOSPC");
});

test("detects code in stringified non-Error value", () => {
  assert.equal(isInfrastructureError("ENOMEM: cannot allocate memory"), "ENOMEM");
});

test("detects EDQUOT in nested error message", () => {
  const err = new Error("write failed: EDQUOT disk quota exceeded on /dev/sda1");
  assert.equal(isInfrastructureError(err), "EDQUOT");
});

// ── isInfrastructureError: negative cases ────────────────────────────────────

test("returns null for transient network errors", () => {
  assert.equal(isInfrastructureError(new Error("ETIMEDOUT: connection timed out")), null);
});

test("returns null for generic errors", () => {
  assert.equal(isInfrastructureError(new Error("Something went wrong")), null);
});

test("returns null for null input", () => {
  assert.equal(isInfrastructureError(null), null);
});

test("returns null for undefined input", () => {
  assert.equal(isInfrastructureError(undefined), null);
});

test("returns null for non-infra code property", () => {
  const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  assert.equal(isInfrastructureError(err), null);
});

// ── isInfrastructureError: edge cases ────────────────────────────────────────

test("message fallback still fires even if code property is non-infra", () => {
  // code is ECONNRESET (not infra) but message contains ENOSPC
  const err = Object.assign(new Error("something ENOSPC happened"), { code: "ECONNRESET" });
  assert.equal(isInfrastructureError(err), "ENOSPC");
});

test("plain object with code property works", () => {
  assert.equal(isInfrastructureError({ code: "ENOSPC", message: "disk full" }), "ENOSPC");
});

test("numeric error input returns null", () => {
  assert.equal(isInfrastructureError(42), null);
});
