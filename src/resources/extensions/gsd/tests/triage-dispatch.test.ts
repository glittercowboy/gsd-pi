/**
 * Triage dispatch behavioral contract tests.
 *
 * These tests verify triage/dispatch behavior by importing and calling the
 * actual modules: RuleRegistry, captures, and triage-resolution. No source
 * code inspection — everything is tested through the public API.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { RuleRegistry } from "../rule-registry.ts";
import {
  appendCapture,
  markCaptureResolved,
  markCaptureExecuted,
  loadPendingCaptures,
  hasPendingCaptures,
  loadAllCaptures,
} from "../captures.ts";
import {
  executeTriageResolutions,
  buildQuickTaskPrompt,
  loadDeferredCaptures,
  loadReplanCaptures,
} from "../triage-resolution.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function createTempProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-triage-dispatch-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), {
    recursive: true,
  });
  return base;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hook exclusion
// ═══════════════════════════════════════════════════════════════════════════════

describe("hook exclusion", () => {
  test("evaluatePostUnit returns null for triage-captures unit type", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("triage-captures", "u1", "/tmp");
    assert.strictEqual(result, null, "triage-captures should be excluded from hook triggering");
  });

  test("evaluatePostUnit returns null for quick-task unit type", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("quick-task", "u1", "/tmp");
    assert.strictEqual(result, null, "quick-task should be excluded from hook triggering");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Captures lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("captures lifecycle", () => {
  let base: string;

  beforeEach(() => {
    base = createTempProject();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("appendCapture creates a pending capture", () => {
    const id = appendCapture(base, "fix the typo in README");
    assert.ok(id.startsWith("CAP-"), "capture ID should start with CAP-");
    const pending = loadPendingCaptures(base);
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].text, "fix the typo in README");
    assert.strictEqual(pending[0].status, "pending");
  });

  test("markCaptureResolved moves capture to resolved status", () => {
    const id = appendCapture(base, "add logging");
    markCaptureResolved(base, id, "quick-task", "small standalone fix", "fits quick-task criteria");
    const all = loadAllCaptures(base);
    const capture = all.find(c => c.id === id);
    assert.ok(capture, "capture should exist");
    assert.strictEqual(capture!.status, "resolved");
    assert.strictEqual(capture!.classification, "quick-task");
  });

  test("markCaptureExecuted marks a resolved capture as executed", () => {
    const id = appendCapture(base, "update config");
    markCaptureResolved(base, id, "inject", "inject into current slice", "belongs in current work");
    markCaptureExecuted(base, id);
    const all = loadAllCaptures(base);
    const capture = all.find(c => c.id === id);
    assert.ok(capture, "capture should exist");
    assert.strictEqual(capture!.executed, true);
  });

  test("hasPendingCaptures returns false when all are resolved", () => {
    const id = appendCapture(base, "something");
    markCaptureResolved(base, id, "note", "just a note", "informational only");
    assert.strictEqual(hasPendingCaptures(base), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Triage resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe("triage resolution", () => {
  let base: string;

  beforeEach(() => {
    base = createTempProject();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("executeTriageResolutions processes resolved captures", () => {
    const id = appendCapture(base, "quick fix needed");
    markCaptureResolved(base, id, "quick-task", "small task", "standalone fix");
    const result = executeTriageResolutions(base, "M001", "S01");
    assert.ok(result.quickTasks.length >= 1, "should collect quick-task captures");
  });

  test("buildQuickTaskPrompt returns prompt with capture text", () => {
    const capture = {
      id: "CAP-test1234",
      text: "fix the broken import",
      timestamp: new Date().toISOString(),
      status: "resolved" as const,
      classification: "quick-task" as const,
    };
    const prompt = buildQuickTaskPrompt(capture);
    assert.ok(prompt.includes("fix the broken import"), "prompt should contain capture text");
    assert.ok(prompt.includes("CAP-test1234"), "prompt should contain capture ID");
    assert.ok(prompt.includes("Quick Task"), "prompt should have Quick Task header");
  });

  test("loadDeferredCaptures returns only defer-classified captures", () => {
    const id1 = appendCapture(base, "defer this");
    const id2 = appendCapture(base, "quick fix");
    markCaptureResolved(base, id1, "defer", "for later", "not urgent");
    markCaptureResolved(base, id2, "quick-task", "now", "small fix");
    const deferred = loadDeferredCaptures(base);
    assert.strictEqual(deferred.length, 1);
    assert.strictEqual(deferred[0].classification, "defer");
  });

  test("loadReplanCaptures returns only replan-classified captures", () => {
    const id1 = appendCapture(base, "replan this slice");
    const id2 = appendCapture(base, "just a note");
    markCaptureResolved(base, id1, "replan", "slice needs rework", "scope changed");
    markCaptureResolved(base, id2, "note", "fyi", "informational");
    const replans = loadReplanCaptures(base);
    assert.strictEqual(replans.length, 1);
    assert.strictEqual(replans[0].classification, "replan");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt templates
// ═══════════════════════════════════════════════════════════════════════════════

describe("prompt templates", () => {
  test("replan-slice.md includes {{captureContext}} variable", () => {
    const prompt = readFileSync(join(__dirname, "..", "prompts", "replan-slice.md"), "utf-8");
    assert.ok(prompt.includes("{{captureContext}}"), "replan-slice.md should include {{captureContext}}");
  });

  test("reassess-roadmap.md includes {{deferredCaptures}} variable", () => {
    const prompt = readFileSync(join(__dirname, "..", "prompts", "reassess-roadmap.md"), "utf-8");
    assert.ok(prompt.includes("{{deferredCaptures}}"), "reassess-roadmap.md should include {{deferredCaptures}}");
  });

  test("triage-captures.md has classification criteria and {{pendingCaptures}}", () => {
    const prompt = readFileSync(join(__dirname, "..", "prompts", "triage-captures.md"), "utf-8");
    assert.ok(prompt.includes("quick-task"), "should have quick-task classification");
    assert.ok(prompt.includes("inject"), "should have inject classification");
    assert.ok(prompt.includes("defer"), "should have defer classification");
    assert.ok(prompt.includes("replan"), "should have replan classification");
    assert.ok(prompt.includes("note"), "should have note classification");
    assert.ok(prompt.includes("{{pendingCaptures}}"), "should have pending captures variable");
  });
});
