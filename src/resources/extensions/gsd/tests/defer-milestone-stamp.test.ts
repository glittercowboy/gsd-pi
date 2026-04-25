/**
 * Regression test for #3542: defer and milestone captures must be stamped
 * as executed after triage resolution, regardless of directory state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTriageResolutions } from "../triage-resolution.ts";
import { appendCapture, markCaptureResolved, loadAllCaptures } from "../captures.ts";

test("defer captures without milestone ID are stamped as executed (#3542)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-stamp-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    appendCapture(base, "Improve error messages");
    const captures = loadAllCaptures(base);
    const id = captures[0].id;
    markCaptureResolved(base, id, "defer", "Deferred to a future UX-polish milestone", "Not urgent");

    executeTriageResolutions(base, "M001", "S01");

    const after = loadAllCaptures(base);
    const cap = after.find(c => c.id === id);
    assert.ok(cap?.executed, "Defer capture should be stamped as executed");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
