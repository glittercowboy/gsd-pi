/**
 * Triage dispatch ordering contract tests.
 *
 * These tests verify structural invariants of the triage integration
 * by inspecting the actual source code of auto-post-unit.ts, auto.ts,
 * and post-unit-hooks.ts. Full behavioral testing requires the
 * @gsd/pi-coding-agent runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hooksPath = join(__dirname, "..", "post-unit-hooks.ts");
const registryPath = join(__dirname, "..", "rule-registry.ts");
const autoPromptsPath = join(__dirname, "..", "auto-prompts.ts");

// After decomposition, triage/dispatch logic lives in auto-post-unit.ts
const postUnitSrc = readFileSync(join(__dirname, "..", "auto-post-unit.ts"), "utf-8");
// auto.ts retains top-level orchestration and imports
const autoSrc = [
  readFileSync(join(__dirname, "..", "auto.ts"), "utf-8"),
  postUnitSrc,
  readFileSync(join(__dirname, "..", "auto-start.ts"), "utf-8"),
].join("\n");
// Hook exclusion logic lives in the rule-registry (facade delegates there)
const hooksSrc = [
  readFileSync(hooksPath, "utf-8"),
  readFileSync(registryPath, "utf-8"),
].join("\n");
const autoPromptsSrc = (() => { try { return readFileSync(autoPromptsPath, "utf-8"); } catch { return autoSrc; } })();

// ─── Hook exclusion ──────────────────────────────────────────────────────────

test("dispatch: triage-captures excluded from post-unit hook triggering", () => {
  assert.ok(
    hooksSrc.includes('"triage-captures"'),
    "post-unit-hooks.ts should reference triage-captures",
  );
  assert.ok(
    hooksSrc.includes('completedUnitType === "triage-captures"'),
    "should check for triage-captures in the hook exclusion guard",
  );
});

// ─── Triage check placement ──────────────────────────────────────────────────

test("dispatch: triage check appears after hook section and before stepMode check", () => {
  const triageCheckIndex = postUnitSrc.indexOf("// ── Triage check");
  const quickTaskIndex = postUnitSrc.indexOf("// ── Quick-task dispatch");
  const stepModeIndex = postUnitSrc.indexOf("if (s.stepMode)");

  assert.ok(triageCheckIndex > 0, "triage check block should exist");
  assert.ok(quickTaskIndex > 0, "quick-task dispatch block should exist");
  assert.ok(stepModeIndex > 0, "step mode check should exist");

  assert.ok(
    triageCheckIndex < quickTaskIndex,
    "triage check should come before quick-task dispatch",
  );
  assert.ok(
    quickTaskIndex < stepModeIndex,
    "quick-task dispatch should come before stepMode check",
  );
});

// ─── Guard conditions ────────────────────────────────────────────────────────

test("dispatch: triage check guards against step mode", () => {
  const triageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("// ── Triage check"),
    postUnitSrc.indexOf("// ── Quick-task dispatch"),
  );
  assert.ok(
    triageBlock.includes("!s.stepMode"),
    "triage block should guard against step mode",
  );
});

test("dispatch: triage check guards against hook unit types", () => {
  const triageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("// ── Triage check"),
    postUnitSrc.indexOf("// ── Quick-task dispatch"),
  );
  assert.ok(
    triageBlock.includes('!s.currentUnit.type.startsWith("hook/")'),
    "triage block should not fire for hook units",
  );
});

test("dispatch: triage check guards against triage-on-triage", () => {
  const triageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("// ── Triage check"),
    postUnitSrc.indexOf("// ── Quick-task dispatch"),
  );
  assert.ok(
    triageBlock.includes('s.currentUnit.type !== "triage-captures"'),
    "triage block should not fire for triage units",
  );
});

test("dispatch: triage check guards against quick-task triggering triage", () => {
  const triageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("// ── Triage check"),
    postUnitSrc.indexOf("// ── Quick-task dispatch"),
  );
  assert.ok(
    triageBlock.includes('s.currentUnit.type !== "quick-task"'),
    "triage block should not fire for quick-task units",
  );
});

test("dispatch: triage dispatch keeps the loop in continue mode", () => {
  const triageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("// ── Triage check"),
    postUnitSrc.indexOf("// ── Quick-task dispatch"),
  );
  assert.ok(
    triageBlock.includes('return "continue"') || triageBlock.includes("return enqueueSidecar("),
    "triage dispatch should return 'continue' after enqueuing sidecar work",
  );
});

test("dispatch: triage imports hasPendingCaptures and loadPendingCaptures", () => {
  assert.ok(
    autoSrc.includes("hasPendingCaptures") && autoSrc.includes("loadPendingCaptures"),
    "should import capture functions",
  );
  assert.ok(
    autoSrc.includes('from "./captures.js"'),
    "should import from captures module",
  );
});

// ─── Prompt integration ──────────────────────────────────────────────────────

test("dispatch: replan prompt builder loads capture context", () => {
  const src = autoPromptsSrc;
  assert.ok(
    src.includes("loadReplanCaptures"),
    "buildReplanSlicePrompt should load replan captures",
  );
  assert.ok(
    src.includes("captureContext"),
    "buildReplanSlicePrompt should pass captureContext to template",
  );
});

test("dispatch: reassess prompt builder loads deferred captures", () => {
  const src = autoPromptsSrc;
  assert.ok(
    src.includes("loadDeferredCaptures"),
    "buildReassessRoadmapPrompt should load deferred captures",
  );
  assert.ok(
    src.includes("deferredCaptures"),
    "buildReassessRoadmapPrompt should pass deferredCaptures to template",
  );
});

// ─── Prompt templates ────────────────────────────────────────────────────────

test("dispatch: replan prompt template includes captureContext variable", () => {
  const promptPath = join(__dirname, "..", "prompts", "replan-slice.md");
  const prompt = readFileSync(promptPath, "utf-8");
  assert.ok(
    prompt.includes("{{captureContext}}"),
    "replan-slice.md should include {{captureContext}}",
  );
});

test("dispatch: reassess prompt template includes deferredCaptures variable", () => {
  const promptPath = join(__dirname, "..", "prompts", "reassess-roadmap.md");
  const prompt = readFileSync(promptPath, "utf-8");
  assert.ok(
    prompt.includes("{{deferredCaptures}}"),
    "reassess-roadmap.md should include {{deferredCaptures}}",
  );
});

test("dispatch: triage prompt template exists and has classification criteria", () => {
  const promptPath = join(__dirname, "..", "prompts", "triage-captures.md");
  const prompt = readFileSync(promptPath, "utf-8");
  assert.ok(prompt.includes("quick-task"), "should have quick-task classification");
  assert.ok(prompt.includes("inject"), "should have inject classification");
  assert.ok(prompt.includes("defer"), "should have defer classification");
  assert.ok(prompt.includes("replan"), "should have replan classification");
  assert.ok(prompt.includes("note"), "should have note classification");
  assert.ok(prompt.includes("{{pendingCaptures}}"), "should have pending captures variable");
});

// ─── Dashboard integration ───────────────────────────────────────────────────

test("dashboard: AutoDashboardData includes pendingCaptureCount field", () => {
  assert.ok(
    autoSrc.includes("pendingCaptureCount"),
    "auto.ts should have pendingCaptureCount in AutoDashboardData",
  );
});

test("dashboard: getAutoDashboardData computes pendingCaptureCount", () => {
  assert.ok(
    autoSrc.includes("pendingCaptureCount = countPendingCaptures") ||
    autoSrc.includes("pendingCaptureCount = countPendingCaptures(basePath)"),
    "getAutoDashboardData should compute pendingCaptureCount from countPendingCaptures (single-read)",
  );
});

test("dashboard: overlay renders pending captures badge", () => {
  const overlayPath = join(__dirname, "..", "dashboard-overlay.ts");
  const overlaySrc = readFileSync(overlayPath, "utf-8");
  assert.ok(
    overlaySrc.includes("pendingCaptureCount"),
    "dashboard-overlay.ts should reference pendingCaptureCount",
  );
  assert.ok(
    overlaySrc.includes("pending capture"),
    "dashboard-overlay.ts should show pending captures text",
  );
});

test("dashboard: overlay labels triage-captures and quick-task unit types", () => {
  const overlayPath = join(__dirname, "..", "dashboard-overlay.ts");
  const overlaySrc = readFileSync(overlayPath, "utf-8");
  assert.ok(
    overlaySrc.includes('"triage-captures"'),
    "unitLabel should handle triage-captures",
  );
  assert.ok(
    overlaySrc.includes('"quick-task"'),
    "unitLabel should handle quick-task",
  );
});

// ─── Post-triage resolution execution ─────────────────────────────────────────

test("dispatch: post-triage resolution executor fires after triage-captures unit", () => {
  const postTriageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("Post-triage: execute actionable resolutions"),
  );
  assert.ok(
    postTriageBlock.includes('s.currentUnit.type === "triage-captures"'),
    "should check for triage-captures unit completion",
  );
  assert.ok(
    postTriageBlock.includes("executeTriageResolutions"),
    "should call executeTriageResolutions",
  );
});

test("dispatch: post-triage executor handles inject results", () => {
  const postTriageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("Post-triage: execute actionable resolutions"),
  );
  assert.ok(
    postTriageBlock.includes("triageResult.injected"),
    "should check injected count",
  );
});

test("dispatch: post-triage executor handles replan results", () => {
  const postTriageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("Post-triage: execute actionable resolutions"),
  );
  assert.ok(
    postTriageBlock.includes("triageResult.replanned"),
    "should check replanned count",
  );
});

test("dispatch: post-triage executor queues quick-tasks", () => {
  const postTriageBlock = postUnitSrc.slice(
    postUnitSrc.indexOf("Post-triage: execute actionable resolutions"),
  );
  assert.ok(
    postTriageBlock.includes("s.pendingQuickTasks"),
    "should push quick-tasks to s.pendingQuickTasks queue",
  );
});

// ─── Quick-task dispatch ──────────────────────────────────────────────────────

test("dispatch: quick-task dispatch block exists after triage check", () => {
  const quickTaskBlock = postUnitSrc.indexOf("// ── Quick-task dispatch");
  const triageBlock = postUnitSrc.indexOf("// ── Triage check");

  assert.ok(quickTaskBlock > 0, "quick-task dispatch block should exist");
  assert.ok(
    quickTaskBlock > triageBlock,
    "quick-task dispatch should come after triage check",
  );
});

test("dispatch: quick-task dispatch uses buildQuickTaskPrompt", () => {
  const quickTaskSection = postUnitSrc.slice(
    postUnitSrc.indexOf("// ── Quick-task dispatch"),
  );
  assert.ok(
    quickTaskSection.includes("buildQuickTaskPrompt"),
    "should call buildQuickTaskPrompt for quick-task dispatch",
  );
});

test("dispatch: quick-task dispatch marks capture as executed", () => {
  const quickTaskSection = postUnitSrc.slice(
    postUnitSrc.indexOf("// ── Quick-task dispatch"),
  );
  assert.ok(
    quickTaskSection.includes("markCaptureExecuted"),
    "should mark capture as executed after dispatch",
  );
});

test("dispatch: quick-task dispatch keeps the loop in continue mode", () => {
  const quickTaskSection = postUnitSrc.slice(
    postUnitSrc.indexOf("// ── Quick-task dispatch"),
    postUnitSrc.indexOf("if (s.stepMode)"),
  );
  assert.ok(
    quickTaskSection.includes('return "continue"') || quickTaskSection.includes("return enqueueSidecar("),
    "quick-task dispatch should return 'continue' after enqueuing sidecar work",
  );
});

// ─── Post-unit hook exclusion for quick-task ──────────────────────────────────

test("dispatch: quick-task excluded from post-unit hook triggering", () => {
  assert.ok(
    hooksSrc.includes('"quick-task"'),
    "post-unit-hooks.ts should reference quick-task",
  );
});

// ─── pendingQuickTasks queue lifecycle ────────────────────────────────────────

test("dispatch: pendingQuickTasks queue is reset on auto-mode start/stop", () => {
  const resetMatches = autoSrc.match(/s\.pendingQuickTasks = \[\]/g);
  assert.ok(
    resetMatches && resetMatches.length >= 2,
    "s.pendingQuickTasks should be reset in start and stop paths",
  );
});
