import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  supportsServiceTier,
  formatServiceTierStatus,
  formatServiceTierFooterStatus,
  resolveServiceTierIcon,
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

  test("returns true for vibeproxy-openai/gpt-5.4 (proxy provider-prefixed)", () => {
    assert.equal(supportsServiceTier("vibeproxy-openai/gpt-5.4"), true);
  });

  test("returns false for gpt-5.5 until service_tier payload support is verified", () => {
    assert.equal(supportsServiceTier("gpt-5.5"), false);
  });

  test("returns false for provider-only identifier without gpt-5.4 model suffix", () => {
    assert.equal(supportsServiceTier("vibeproxy-openai"), false);
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

  test("mentions provider-agnostic model gating", () => {
    const output = formatServiceTierStatus("priority");
    assert.ok(output.includes("regardless of provider"), `Expected provider note in: ${output}`);
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

// ─── formatServiceTierFooterStatus ───────────────────────────────────────────

describe("formatServiceTierFooterStatus", () => {
  test("returns priority footer status for supported model", () => {
    assert.equal(formatServiceTierFooterStatus("priority", "vibeproxy-openai/gpt-5.4"), "fast: ⚡ priority");
  });

  test("returns undefined for unsupported model", () => {
    assert.equal(formatServiceTierFooterStatus("priority", "claude-opus-4-6"), undefined);
  });

  test("returns undefined when tier is disabled", () => {
    assert.equal(formatServiceTierFooterStatus(undefined, "gpt-5.4"), undefined);
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
