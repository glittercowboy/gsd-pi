import test from "node:test";
import assert from "node:assert/strict";

import { classifyMilestoneSummaryContent } from "../milestone-summary-classifier.ts";

test("milestone SUMMARY classifier treats explicit failed status as failure", () => {
  assert.equal(
    classifyMilestoneSummaryContent([
      "---",
      "status: failed",
      "---",
      "",
      "# M001 Summary",
      "Recovery stopped.",
    ].join("\n")),
    "failure",
  );
});

test("milestone SUMMARY classifier does not treat historical not-complete prose as failure", () => {
  assert.equal(
    classifyMilestoneSummaryContent([
      "# M001 Summary",
      "",
      "This milestone was previously not complete, now resolved.",
    ].join("\n")),
    "unknown",
  );
});

