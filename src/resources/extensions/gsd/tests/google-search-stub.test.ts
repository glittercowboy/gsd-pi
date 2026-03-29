// GSD-2 — Tests for google-search deprecation stub (STUB-01, STUB-02)
import test from "node:test";
import assert from "node:assert/strict";

// ─── Tests ────────────────────────────────────────────────────────────────────

test("google-search stub: default export is a function", async (t) => {
  // STUB-01: stub has a default export function accepting ExtensionAPI
  t.todo("Implement after Plan 10-02 replaces index.ts with stub");
});

test("google-search stub: registers session_start handler", async (t) => {
  // STUB-01: stub calls pi.on("session_start", ...)
  t.todo("Implement after Plan 10-02 replaces index.ts with stub");
});

test("google-search stub: does NOT call registerTool", async (t) => {
  // STUB-02: stub is a no-op for tools
  t.todo("Implement after Plan 10-02 replaces index.ts with stub");
});

test("google-search stub: session_start warning contains package name", async (t) => {
  // STUB-01: warning includes @gsd-extensions/google-search
  t.todo("Implement after Plan 10-02 replaces index.ts with stub");
});

test("google-search stub: session_start warning contains install command", async (t) => {
  // STUB-01: warning includes "gsd extensions install"
  t.todo("Implement after Plan 10-02 replaces index.ts with stub");
});
