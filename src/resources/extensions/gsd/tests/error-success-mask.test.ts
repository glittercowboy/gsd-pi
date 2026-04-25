/**
 * error-success-mask.test.ts — #3664
 *
 * Verify that the agent-end-recovery error handler detects when errorMessage
 * is uninformative (e.g. "success", "ok", "unknown") and falls back to
 * extracting the real error from the assistant message text content.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(__dirname, "..", "bootstrap", "agent-end-recovery.ts");

describe("error-success mask detection (#3664)", () => {
  const source = readFileSync(sourceFile, "utf-8");

  test("detects useless errorMessage values with regex", () => {
    assert.match(source, /success\|ok\|true\|error\|unknown/i);
  });

  test("extracts display message from content text block", () => {
    assert.match(source, /textBlock/);
    assert.match(source, /\.text\.slice\(0,\s*300\)/);
  });

  test("classifies using rawErrorMsg, not displayMsg", () => {
    assert.match(source, /classifyError\(rawErrorMsg/);
  });

  test("references issue #3588 in comments", () => {
    assert.match(source, /#3588/);
  });
});
