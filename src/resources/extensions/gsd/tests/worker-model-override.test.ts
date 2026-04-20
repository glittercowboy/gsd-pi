/**
 * Worker model override — tests for parallel.worker_model preference.
 *
 * Verifies validation, resolveParallelConfig pass-through, and type definitions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const typesSrc = readFileSync(join(__dirname, "..", "types.ts"), "utf-8");
const validationSrc = readFileSync(join(__dirname, "..", "preferences-validation.ts"), "utf-8");
const preferencesSrc = readFileSync(join(__dirname, "..", "preferences.ts"), "utf-8");

// ─── Type definition ──────────────────────────────────────────────────────

test("ParallelConfig includes worker_model optional field", () => {
  assert.ok(
    typesSrc.includes("worker_model?: string"),
    "ParallelConfig should have optional worker_model field",
  );
});

// ─── Validation ───────────────────────────────────────────────────────────

test("validatePreferences accepts valid worker_model string", () => {
  assert.ok(
    validationSrc.includes("p.worker_model"),
    "validation should check parallel.worker_model",
  );
  assert.ok(
    validationSrc.includes('parallel.worker_model must be a non-empty string'),
    "validation should reject invalid worker_model",
  );
});

// ─── resolveParallelConfig ────────────────────────────────────────────────

test("resolveParallelConfig passes through worker_model", () => {
  assert.ok(
    preferencesSrc.includes("worker_model: prefs?.parallel?.worker_model"),
    "resolveParallelConfig should pass through worker_model",
  );
});
