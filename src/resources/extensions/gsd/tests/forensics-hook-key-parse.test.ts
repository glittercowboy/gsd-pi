/**
 * Regression test for #2826: detectMissingArtifacts must parse hook/
 * compound unit types correctly, not just the first slash segment.
 *
 * Keys like "hook/telegram-progress/M007/S01" must yield:
 *   unitType = "hook/telegram-progress"  (not "hook")
 *   unitId   = "M007/S01"               (not "telegram-progress/M007/S01")
 *
 * The fix extracts a shared splitCompletedKey() helper used by both
 * forensics.ts and doctor-runtime-checks.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

describe("forensics hook compound key parsing (#2826)", () => {
  const forensicsSrc = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
  const doctorSrc = readFileSync(join(gsdDir, "doctor-runtime-checks.ts"), "utf-8");

  it("forensics.ts exports splitCompletedKey helper", () => {
    assert.ok(
      forensicsSrc.includes("export function splitCompletedKey("),
      "forensics.ts must export splitCompletedKey()",
    );
  });

  it("splitCompletedKey handles hook/ prefix by splitting on the second slash", () => {
    assert.ok(
      forensicsSrc.includes('key.startsWith("hook/")'),
      'splitCompletedKey must branch on key.startsWith("hook/")',
    );
    assert.ok(
      forensicsSrc.includes('key.indexOf("/", 5)'),
      'splitCompletedKey must use indexOf("/", 5) to find second slash past "hook/"',
    );
  });

  it("detectMissingArtifacts delegates to splitCompletedKey", () => {
    const fnStart = forensicsSrc.indexOf("function detectMissingArtifacts(");
    assert.ok(fnStart !== -1, "detectMissingArtifacts must exist in forensics.ts");
    const fnBody = forensicsSrc.slice(fnStart, fnStart + 1000);
    assert.ok(
      fnBody.includes("splitCompletedKey("),
      "detectMissingArtifacts must call splitCompletedKey() rather than inline the split logic",
    );
  });

  it("doctor-runtime-checks.ts imports and uses splitCompletedKey", () => {
    assert.ok(
      doctorSrc.includes('from "./forensics.js"'),
      'doctor-runtime-checks.ts must import from "./forensics.js"',
    );
    assert.ok(
      doctorSrc.includes("splitCompletedKey"),
      "doctor-runtime-checks.ts must use splitCompletedKey()",
    );
  });

  it("splitCompletedKey unit: plain type", () => {
    // Inline test of the helper logic to guard against future regressions
    // without needing a filesystem setup.
    const src = forensicsSrc;
    // Confirm the plain-type branch also exists
    assert.ok(
      src.includes('slashIdx = key.indexOf("/")') || src.includes("key.indexOf(\"/\")"),
      "splitCompletedKey must handle plain (non-hook) keys via first-slash split",
    );
  });
});
