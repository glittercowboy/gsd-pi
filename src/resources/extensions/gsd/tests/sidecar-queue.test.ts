/**
 * sidecar-queue.test.ts — Source-level contract tests for the sidecar queue pattern (S03).
 *
 * Verifies the structural invariants of the sidecar queue: the SidecarItem type,
 * AutoSession sidecarQueue field, enqueue patterns in postUnitPostVerification,
 * and dequeue logic in autoLoop. These are source-reading tests — no runtime required.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSourceRegion } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_TS_PATH = join(__dirname, "..", "auto", "session.ts");
const POST_UNIT_TS_PATH = join(__dirname, "..", "auto-post-unit.ts");
const AUTO_LOOP_TS_PATH = join(__dirname, "..", "auto", "loop.ts");

function getSessionTsSource(): string {
  return readFileSync(SESSION_TS_PATH, "utf-8");
}

function getPostUnitTsSource(): string {
  return readFileSync(POST_UNIT_TS_PATH, "utf-8");
}

function getAutoLoopTsSource(): string {
  return readFileSync(AUTO_LOOP_TS_PATH, "utf-8");
}

/**
 * Extract the body of postUnitPostVerification from auto-post-unit.ts source.
 */
function getPostUnitPostVerificationBody(): string {
  const source = getPostUnitTsSource();
  const fnIdx = source.indexOf("export async function postUnitPostVerification");
  assert.ok(fnIdx > -1, "postUnitPostVerification must exist in auto-post-unit.ts");
  return source.slice(fnIdx);
}

// ─── SidecarItem type contract ───────────────────────────────────────────────

test("SidecarItem type is exported from session.ts", () => {
  const source = getSessionTsSource();
  assert.ok(
    source.includes("export interface SidecarItem"),
    "session.ts must export the SidecarItem interface",
  );
});

test("SidecarItem has required kind field with hook/triage/quick-task union", () => {
  const source = getSessionTsSource();
  const ifaceIdx = source.indexOf("export interface SidecarItem");
  const ifaceBlock = extractSourceRegion(source, "export interface SidecarItem");
  assert.ok(
    ifaceBlock.includes('"hook"') && ifaceBlock.includes('"triage"') && ifaceBlock.includes('"quick-task"'),
    "SidecarItem.kind must be a union of 'hook' | 'triage' | 'quick-task'",
  );
});

// ─── AutoSession sidecarQueue field ──────────────────────────────────────────

test("AutoSession declares sidecarQueue field", () => {
  const source = getSessionTsSource();
  assert.ok(
    source.includes("sidecarQueue"),
    "AutoSession must declare sidecarQueue property",
  );
  assert.ok(
    source.includes("SidecarItem[]"),
    "sidecarQueue must be typed as SidecarItem[]",
  );
});

test("AutoSession resets sidecarQueue in reset()", () => {
  const source = getSessionTsSource();
  const resetIdx = source.indexOf("reset(): void");
  assert.ok(resetIdx > -1, "AutoSession must have a reset() method");
  const resetBlock = extractSourceRegion(source, "reset(): void");
  assert.ok(
    resetBlock.includes("sidecarQueue"),
    "reset() must clear sidecarQueue",
  );
});

// ─── postUnitPostVerification: no inline dispatch ────────────────────────────

test("postUnitPostVerification does not call pi.sendMessage", () => {
  const body = getPostUnitPostVerificationBody();
  assert.ok(
    !body.includes("pi.sendMessage"),
    "postUnitPostVerification must not call pi.sendMessage — all dispatch goes through sidecar queue",
  );
});

test("postUnitPostVerification does not call newSession", () => {
  const body = getPostUnitPostVerificationBody();
  assert.ok(
    !body.includes("s.cmdCtx.newSession") && !body.includes("cmdCtx.newSession"),
    "postUnitPostVerification must not call newSession — all dispatch goes through sidecar queue",
  );
});

// ─── postUnitPostVerification: sidecar enqueue for hooks ─────────────────────

test("postUnitPostVerification pushes to sidecarQueue for hooks", () => {
  const source = getPostUnitTsSource();
  // Find the hook section (marked by the post-unit hooks comment)
  const hookSectionStart = source.indexOf("// ── Post-unit hooks");
  assert.ok(hookSectionStart > -1, "auto-post-unit.ts must have a post-unit hooks section");
  const triageSectionStart = source.indexOf("// ── Triage check");
  assert.ok(triageSectionStart > -1, "auto-post-unit.ts must have a triage check section");
  const hookSection = source.slice(hookSectionStart, triageSectionStart);
  assert.ok(
    hookSection.includes("enqueueSidecar(") || hookSection.includes("s.sidecarQueue.push("),
    "hook section must enqueue to sidecarQueue (via enqueueSidecar or direct push)",
  );
  assert.ok(
    hookSection.includes('"hook"'),
    "hook sidecar item must reference kind 'hook'",
  );
});

// ─── postUnitPostVerification: sidecar enqueue for triage ────────────────────

test("postUnitPostVerification pushes to sidecarQueue for triage", () => {
  const source = getPostUnitTsSource();
  const triageSectionStart = source.indexOf("// ── Triage check");
  const quickTaskSectionStart = source.indexOf("// ── Quick-task dispatch");
  assert.ok(triageSectionStart > -1, "auto-post-unit.ts must have a triage check section");
  assert.ok(quickTaskSectionStart > -1, "auto-post-unit.ts must have a quick-task dispatch section");
  const triageSection = source.slice(triageSectionStart, quickTaskSectionStart);
  assert.ok(
    triageSection.includes("enqueueSidecar(") || triageSection.includes("s.sidecarQueue.push("),
    "triage section must enqueue to sidecarQueue (via enqueueSidecar or direct push)",
  );
  assert.ok(
    triageSection.includes('"triage"'),
    "triage sidecar item must reference kind 'triage'",
  );
});

// ─── postUnitPostVerification: sidecar enqueue for quick-tasks ───────────────

test("postUnitPostVerification pushes to sidecarQueue for quick-tasks", () => {
  const source = getPostUnitTsSource();
  const quickTaskSectionStart = source.indexOf("// ── Quick-task dispatch");
  assert.ok(quickTaskSectionStart > -1, "auto-post-unit.ts must have a quick-task dispatch section");
  const quickTaskSection = source.slice(quickTaskSectionStart);
  assert.ok(
    quickTaskSection.includes("enqueueSidecar(") || quickTaskSection.includes("s.sidecarQueue.push("),
    "quick-task section must enqueue to sidecarQueue (via enqueueSidecar or direct push)",
  );
  assert.ok(
    quickTaskSection.includes('"quick-task"'),
    "quick-task sidecar item must reference kind 'quick-task'",
  );
});

// ─── autoLoop: sidecar dequeue ───────────────────────────────────────────────

test("autoLoop has sidecar-dequeue phase", () => {
  const source = getAutoLoopTsSource();
  assert.ok(
    source.includes('"sidecar-dequeue"'),
    "autoLoop must log phase: 'sidecar-dequeue' when draining the sidecar queue",
  );
});

test("autoLoop does not have inline dispatch loop", () => {
  const source = getAutoLoopTsSource();
  assert.ok(
    !source.includes('"await-inline-dispatch"'),
    "autoLoop must not contain 'await-inline-dispatch' — replaced by sidecar queue",
  );
  assert.ok(
    !source.includes("while (inlineResult"),
    "autoLoop must not contain a while(inlineResult...) loop — replaced by sidecar queue drain",
  );
});
