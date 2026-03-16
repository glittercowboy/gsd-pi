/**
 * Routing History — structural tests for adaptive learning module.
 *
 * Verifies routing-history.ts exports and structure from #579.
 * Uses source-level checks to avoid @gsd/pi-coding-agent import chain.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const historySrc = readFileSync(join(__dirname, "..", "routing-history.ts"), "utf-8");

// ═══════════════════════════════════════════════════════════════════════════
// Module Exports
// ═══════════════════════════════════════════════════════════════════════════

test("routing-history: exports initRoutingHistory", () => {
  assert.ok(historySrc.includes("export function initRoutingHistory"), "should export initRoutingHistory");
});

test("routing-history: exports recordOutcome", () => {
  assert.ok(historySrc.includes("export function recordOutcome"), "should export recordOutcome");
});

test("routing-history: exports recordFeedback", () => {
  assert.ok(historySrc.includes("export function recordFeedback"), "should export recordFeedback");
});

test("routing-history: exports getAdaptiveTierAdjustment", () => {
  assert.ok(historySrc.includes("export function getAdaptiveTierAdjustment"), "should export getAdaptiveTierAdjustment");
});

test("routing-history: exports resetRoutingHistory", () => {
  assert.ok(historySrc.includes("export function resetRoutingHistory"), "should export resetRoutingHistory");
});

// ═══════════════════════════════════════════════════════════════════════════
// Design Constants
// ═══════════════════════════════════════════════════════════════════════════

test("routing-history: uses rolling window of 50 entries", () => {
  assert.ok(historySrc.includes("ROLLING_WINDOW = 50"), "should use 50-entry rolling window");
});

test("routing-history: failure threshold is 20%", () => {
  assert.ok(historySrc.includes("FAILURE_THRESHOLD = 0.20"), "should use 20% failure threshold");
});

test("routing-history: feedback weight is 2x", () => {
  assert.ok(historySrc.includes("FEEDBACK_WEIGHT = 2"), "feedback should count 2x");
});

// ═══════════════════════════════════════════════════════════════════════════
// Type Structure
// ═══════════════════════════════════════════════════════════════════════════

test("routing-history: imports ComplexityTier from types.ts", () => {
  assert.ok(
    historySrc.includes('from "./types.js"') && historySrc.includes("ComplexityTier"),
    "should import ComplexityTier from types.ts",
  );
});

test("routing-history: defines RoutingHistoryData interface", () => {
  assert.ok(historySrc.includes("interface RoutingHistoryData"), "should define RoutingHistoryData");
});

test("routing-history: defines FeedbackEntry interface", () => {
  assert.ok(historySrc.includes("interface FeedbackEntry"), "should define FeedbackEntry");
});

// ═══════════════════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════════════════

test("routing-history: persists to routing-history.json", () => {
  assert.ok(historySrc.includes("routing-history.json"), "should persist to routing-history.json");
});

test("routing-history: has save and load functions", () => {
  assert.ok(historySrc.includes("saveHistory") || historySrc.includes("function save"), "should have save");
  assert.ok(historySrc.includes("loadHistory") || historySrc.includes("function load"), "should have load");
});
