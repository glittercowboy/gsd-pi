import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  supportsServiceTier,
  formatServiceTierStatus,
  resolveServiceTierIcon,
  type ServiceTierSetting,
} from "../service-tier.ts";

// ─── supportsServiceTier ─────────────────────────────────────────────────────

describe("supportsServiceTier", () => {
  test("returns true for gpt-5.4", () => {
    assert.equal(supportsServiceTier("gpt-5.4"), true);
  });

  test("returns true for gpt-5.4-pro", () => {
    assert.equal(supportsServiceTier("gpt-5.4-pro"), true);
  });

  test("returns true for gpt-5.4-mini", () => {
    assert.equal(supportsServiceTier("gpt-5.4-mini"), true);
  });

  test("returns true for openai/gpt-5.4 (provider-prefixed)", () => {
    assert.equal(supportsServiceTier("openai/gpt-5.4"), true);
  });

  test("returns false for claude-opus-4-6", () => {
    assert.equal(supportsServiceTier("claude-opus-4-6"), false);
  });

  test("returns false for gemini-2.5-pro", () => {
    assert.equal(supportsServiceTier("gemini-2.5-pro"), false);
  });

  test("returns false for gpt-4o", () => {
    assert.equal(supportsServiceTier("gpt-4o"), false);
  });

  test("returns false for empty string", () => {
    assert.equal(supportsServiceTier(""), false);
  });
});

// ─── formatServiceTierStatus ─────────────────────────────────────────────────

describe("formatServiceTierStatus", () => {
  test("shows disabled when service_tier is undefined", () => {
    const output = formatServiceTierStatus(undefined);
    assert.ok(output.includes("disabled"), `Expected 'disabled' in: ${output}`);
  });

  test("shows priority when set to priority", () => {
    const output = formatServiceTierStatus("priority");
    assert.ok(output.includes("priority"), `Expected 'priority' in: ${output}`);
  });

  test("shows flex when set to flex", () => {
    const output = formatServiceTierStatus("flex");
    assert.ok(output.includes("flex"), `Expected 'flex' in: ${output}`);
  });
});

// ─── resolveServiceTierIcon ──────────────────────────────────────────────────

describe("resolveServiceTierIcon", () => {
  test("returns lightning bolt for priority tier on supported model", () => {
    const icon = resolveServiceTierIcon("priority", "gpt-5.4");
    assert.equal(icon, "⚡");
  });

  test("returns money icon for flex tier on supported model", () => {
    const icon = resolveServiceTierIcon("flex", "gpt-5.4");
    assert.equal(icon, "💰");
  });

  test("returns empty string when tier is set but model does not support it", () => {
    const icon = resolveServiceTierIcon("priority", "claude-opus-4-6");
    assert.equal(icon, "");
  });

  test("returns empty string when tier is undefined", () => {
    const icon = resolveServiceTierIcon(undefined, "gpt-5.4");
    assert.equal(icon, "");
  });

  test("returns empty string when both tier and model are unsupported", () => {
    const icon = resolveServiceTierIcon(undefined, "claude-opus-4-6");
    assert.equal(icon, "");
  });

  test("returns empty string when model is empty", () => {
    const icon = resolveServiceTierIcon("priority", "");
    assert.equal(icon, "");
  });
});
