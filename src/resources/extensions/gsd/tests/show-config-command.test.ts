/**
 * /gsd show-config command — structural tests.
 *
 * Verifies the config overlay class and command handler exist
 * with correct structure.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const overlaySrc = readFileSync(join(__dirname, "..", "config-overlay.ts"), "utf-8");
const coreSrc = readFileSync(join(__dirname, "..", "commands", "handlers", "core.ts"), "utf-8");

// ─── Config overlay ───────────────────────────────────────────────────────

test("GSDConfigOverlay class is exported", () => {
  assert.ok(
    overlaySrc.includes("export class GSDConfigOverlay"),
    "GSDConfigOverlay should be exported",
  );
});

test("GSDConfigOverlay implements Component interface methods", () => {
  assert.ok(overlaySrc.includes("render("), "should have render method");
  assert.ok(overlaySrc.includes("handleInput("), "should have handleInput method");
  assert.ok(overlaySrc.includes("invalidate("), "should have invalidate method");
  assert.ok(overlaySrc.includes("dispose("), "should have dispose method");
});

test("formatConfigText function is exported", () => {
  assert.ok(
    overlaySrc.includes("export function formatConfigText"),
    "formatConfigText should be exported for non-overlay fallback",
  );
});

// ─── Command handler ──────────────────────────────────────────────────────

test("core handler routes show-config command", () => {
  assert.ok(
    coreSrc.includes('"show-config"'),
    "core handler should match show-config command",
  );
});

test("show-config has text fallback via formatConfigText", () => {
  assert.ok(
    coreSrc.includes("formatConfigText"),
    "show-config should use formatConfigText as fallback",
  );
});
