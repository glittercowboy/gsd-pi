/**
 * Tests for headless completion detection.
 *
 * Verifies that isTerminalNotification only matches actual auto-mode stop
 * signals and does not false-positive on progress notifications that
 * happen to contain words like "complete" or "stopped".
 */

import test from "node:test";
import assert from "node:assert/strict";

// Import the module to get access to the functions via a dynamic import
// since headless.ts has side-effect-free detection functions but no exports.
// We'll test by extracting the logic inline.

// ─── Extracted detection logic (mirrors headless.ts) ────────────────────────

const TERMINAL_PREFIXES = ['auto-mode stopped', 'step-mode stopped']

function isTerminalNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  const message = String(event.message ?? '').toLowerCase()
  return TERMINAL_PREFIXES.some((prefix) => message.startsWith(prefix))
}

function isBlockedNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  const message = String(event.message ?? '').toLowerCase()
  return message.includes('blocked:')
}

function makeNotify(message: string): Record<string, unknown> {
  return { type: 'extension_ui_request', method: 'notify', message }
}

// ─── isTerminalNotification ─────────────────────────────────────────────────

test("detects 'Auto-mode stopped.' as terminal", () => {
  assert.ok(isTerminalNotification(makeNotify("Auto-mode stopped.")))
})

test("detects 'Auto-mode stopped (All milestones complete).' as terminal", () => {
  assert.ok(isTerminalNotification(makeNotify("Auto-mode stopped (All milestones complete). Session: $0.42 · 15K tokens · 8 units")))
})

test("detects 'Auto-mode stopped (Blocked: missing API key).' as terminal", () => {
  assert.ok(isTerminalNotification(makeNotify("Auto-mode stopped (Blocked: missing API key).")))
})

test("detects 'Auto-mode stopped (Milestone M001 complete).' as terminal", () => {
  assert.ok(isTerminalNotification(makeNotify("Auto-mode stopped (Milestone M001 complete).")))
})

test("detects 'Step-mode stopped.' as terminal", () => {
  assert.ok(isTerminalNotification(makeNotify("Step-mode stopped.")))
})

// ─── False positives that previously triggered early exit (#879) ────────────

test("does NOT match 'All slices are complete — nothing to discuss.'", () => {
  assert.ok(!isTerminalNotification(makeNotify("All slices are complete — nothing to discuss.")))
})

test("does NOT match 'Override(s) resolved — rewrite-docs completed.'", () => {
  assert.ok(!isTerminalNotification(makeNotify("Override(s) resolved — rewrite-docs completed.")))
})

test("does NOT match 'Skipped 5+ completed units. Yielding to UI before continuing.'", () => {
  assert.ok(!isTerminalNotification(makeNotify("Skipped 5+ completed units. Yielding to UI before continuing.")))
})

test("does NOT match 'Cannot dispatch reassess-roadmap: no completed slices.'", () => {
  assert.ok(!isTerminalNotification(makeNotify("Cannot dispatch reassess-roadmap: no completed slices.")))
})

test("does NOT match 'Committed: feat(S03): complete task implementation'", () => {
  assert.ok(!isTerminalNotification(makeNotify("Committed: feat(S03): complete task implementation")))
})

test("does NOT match 'Post-hook: applied 3 fix(es).'", () => {
  assert.ok(!isTerminalNotification(makeNotify("Post-hook: applied 3 fix(es).")))
})

test("does NOT match non-notify events", () => {
  assert.ok(!isTerminalNotification({ type: 'agent_end' }))
  assert.ok(!isTerminalNotification({ type: 'extension_ui_request', method: 'select', message: 'Auto-mode stopped.' }))
})

// ─── isBlockedNotification ──────────────────────────────────────────────────

test("detects blocked notification with 'Blocked:' prefix", () => {
  assert.ok(isBlockedNotification(makeNotify("Auto-mode stopped (Blocked: missing API key).")))
})

test("detects inline 'Blocked:' message", () => {
  assert.ok(isBlockedNotification(makeNotify("Blocked: no active milestone. Fix and run /gsd auto.")))
})

test("does NOT match 'blocked' without colon (avoids false positives)", () => {
  assert.ok(!isBlockedNotification(makeNotify("The request was blocked by the firewall")))
})
