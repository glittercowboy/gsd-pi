// GSD Extension — Regression tests for auto-mode warning noise (PR #4294)
//
// Three independent bug fixes, three regression tests:
//
//   1. auto-model-selection.ts — buildFlatRateContext detached
//      getProviderAuthMode from its receiver, losing `this` and throwing
//      "Cannot read properties of undefined (reading 'registeredProviders')".
//      Runtime test: pass a registry whose method actually uses `this` and
//      verify the returned authMode survives (proves the method is called
//      with correct binding).
//
//   2. auto-worktree.ts — isSamePath logged every error as a warning,
//      including ENOENT when a worktree's .gsd dir hadn't been created yet.
//      Source-check test: the catch block must short-circuit on ENOENT
//      before hitting logWarning. Follows the same style as
//      copy-planning-artifacts-samepath.test.ts.
//
//   3. guided-flow.ts — checkAutoStartAfterDiscuss unconditionally tried
//      to unlink DISCUSSION-MANIFEST.json and warned on ENOENT even when
//      the milestone never had a discussion phase. Source-check test:
//      the unlink must be guarded with existsSync, matching the
//      CONTEXT-DRAFT.md cleanup pattern two lines above.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildFlatRateContext } from "../auto-model-selection.ts";
import { extractSourceRegion } from "./test-helpers.ts";

// ─── Bug 2: this-binding regression ─────────────────────────────────────

test("buildFlatRateContext invokes getProviderAuthMode with correct `this`", () => {
  // Mimics ModelRegistry: getProviderAuthMode reads from an instance field.
  // Detaching the method to a local variable would break this — the old code
  // did `const fn = ctx.modelRegistry.getProviderAuthMode; fn(provider)`,
  // which called the method with `this === undefined` and threw.
  const providerData = new Map<string, string>([
    ["claude-code", "externalCli"],
    ["anthropic", "apiKey"],
  ]);
  const registry = {
    _providers: providerData,
    getProviderAuthMode(provider: string): string {
      // Access via `this` — fails loudly if the method was called unbound.
      const map = this._providers;
      return map.get(provider) ?? "apiKey";
    },
  };

  const ctx = buildFlatRateContext("claude-code", { modelRegistry: registry });
  assert.equal(
    ctx.authMode,
    "externalCli",
    "authMode should be extracted when getProviderAuthMode is called as a method",
  );

  const ctx2 = buildFlatRateContext("anthropic", { modelRegistry: registry });
  assert.equal(ctx2.authMode, "apiKey");
});

// ─── Bug 1: isSamePath source check ─────────────────────────────────────

test("isSamePath short-circuits ENOENT before logging a warning", () => {
  const srcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const src = readFileSync(srcPath, "utf-8");

  const fnIdx = src.indexOf("function isSamePath");
  assert.ok(fnIdx !== -1, "isSamePath function exists");

  // Grab the function body (enough to cover the catch block).
  const fnBody = extractSourceRegion(src, "function isSamePath", { fromIdx: fnIdx });

  const catchIdx = fnBody.indexOf("catch");
  assert.ok(catchIdx !== -1, "isSamePath has a catch block");

  const enoentIdx = fnBody.indexOf("ENOENT", catchIdx);
  const warnIdx = fnBody.indexOf("logWarning", catchIdx);

  assert.ok(enoentIdx !== -1, "catch block must handle ENOENT explicitly");
  assert.ok(warnIdx !== -1, "catch block still warns on non-ENOENT errors");
  assert.ok(
    enoentIdx < warnIdx,
    "ENOENT early-return must precede the logWarning call",
  );
});

// ─── Bug 3: guided-flow manifest unlink source check ────────────────────

test("checkAutoStartAfterDiscuss guards DISCUSSION-MANIFEST.json unlink with existsSync", () => {
  const srcPath = join(import.meta.dirname, "..", "guided-flow.ts");
  const src = readFileSync(srcPath, "utf-8");

  const fnIdx = src.indexOf("function checkAutoStartAfterDiscuss");
  assert.ok(fnIdx !== -1, "checkAutoStartAfterDiscuss function exists");

  // Locate the manifest cleanup comment and its surrounding block.
  const cleanupIdx = src.indexOf(
    "remove discussion manifest after auto-start",
    fnIdx,
  );
  assert.ok(cleanupIdx !== -1, "manifest cleanup block still exists");

  // Everything from the comment to a short distance below should contain
  // the existsSync guard before the unlinkSync call.
  const block = extractSourceRegion(src, "remove discussion manifest after auto-start", { fromIdx: cleanupIdx });

  const existsIdx = block.indexOf("existsSync(manifestPath)");
  const unlinkIdx = block.indexOf("unlinkSync(manifestPath)");

  assert.ok(existsIdx !== -1, "manifest unlink must be guarded by existsSync");
  assert.ok(unlinkIdx !== -1, "manifest unlink still happens when file exists");
  assert.ok(
    existsIdx < unlinkIdx,
    "existsSync guard must precede the unlinkSync call",
  );
});
