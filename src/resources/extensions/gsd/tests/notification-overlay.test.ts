// GSD Extension — Notification Overlay Tests
// Tests for message wrapping in the notification panel.
// Mirrors the private wrapText from notification-overlay.ts so its contract
// can be exercised without exporting internals.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@gsd/pi-tui";

// ── wrapText logic (mirrors the private function in notification-overlay.ts) ──

function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines = wrapTextWithAnsi(text, maxWidth);
  return lines.map((l) =>
    visibleWidth(l) > maxWidth ? truncateToWidth(l, maxWidth, "…") : l,
  );
}

describe("notification overlay — wrapText", () => {
  test("short text returns single line", () => {
    const result = wrapText("hello world", 80);
    assert.deepStrictEqual(result, ["hello world"]);
  });

  test("long text wraps at word boundaries without exceeding maxWidth", () => {
    const text = "This is a long notification message that should wrap across multiple lines";
    const result = wrapText(text, 40);
    assert.ok(result.length > 1, `expected multiple lines, got ${result.length}`);
    for (const line of result) {
      assert.ok(
        visibleWidth(line) <= 40,
        `line exceeds maxWidth: "${line}" (${visibleWidth(line)})`,
      );
    }
  });

  test("single word exceeding maxWidth is broken to fit column budget", () => {
    const result = wrapText("superlongwordthatexceedsmaxwidth", 10);
    for (const line of result) {
      assert.ok(
        visibleWidth(line) <= 10,
        `line exceeds maxWidth: "${line}" (${visibleWidth(line)})`,
      );
    }
  });

  test("preserves all words across wrapped lines", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const text = words.join(" ");
    const result = wrapText(text, 15);
    const rejoined = result.join(" ");
    for (const w of words) {
      assert.ok(rejoined.includes(w), `missing word: ${w}`);
    }
  });

  // Regression for #4465 — the previous .length-based wrapper could allow
  // lines to bleed past the panel border when measured in terminal columns.
  // Verify that every wrapped line stays within the column budget, including
  // for the real-world long multi-provider notification payload.
  test("regression #4465: long notification stays within column budget", () => {
    const msg =
      "GSD API Key Manager LLM Providers ✗ anthropic — not configured " +
      "(console.anthropic.com) ✗ openai — not configured " +
      "(platform.openai.com/api-keys) ✓ github-copilot — OAuth (expires in 13m) " +
      "✓ openai-codex — OAuth (expires in 99h 9m) ✓ google-gemini-cli — OAuth " +
      "(expired — will auto-refresh) ✓ google-antigravity — OAuth " +
      "(expired — will auto-refresh) ✗ google — not configured " +
      "(aistudio.google.com/apikey) ✗ groq — not configured";
    const maxWidth = 118;
    const result = wrapText(msg, maxWidth);
    for (const line of result) {
      assert.ok(
        visibleWidth(line) <= maxWidth,
        `line exceeds column budget: visibleWidth=${visibleWidth(line)} max=${maxWidth}: "${line}"`,
      );
    }
  });

  test("unbreakable long token (URL) is clamped to maxWidth", () => {
    const url = "https://example.com/" + "a".repeat(200);
    const result = wrapText(url, 40);
    for (const line of result) {
      assert.ok(
        visibleWidth(line) <= 40,
        `line exceeds maxWidth: visibleWidth=${visibleWidth(line)} line="${line}"`,
      );
    }
  });
});
