// GSD-2 — Regression tests for importLocalModule candidate resolution (#3954)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { _buildImportCandidates } from "./workflow-tools.js";

describe("_buildImportCandidates", () => {
  it("includes dist/ fallback for src/ paths", () => {
    const candidates = _buildImportCandidates("../../../src/resources/extensions/gsd/db-writer.js");
    assert.ok(
      candidates.some((c) => c.includes("/dist/resources/extensions/gsd/db-writer.js")),
      "should include dist/ swapped candidate",
    );
  });

  it("includes src/ fallback for dist/ paths", () => {
    const candidates = _buildImportCandidates("../../../dist/resources/extensions/gsd/db-writer.js");
    assert.ok(
      candidates.some((c) => c.includes("/src/resources/extensions/gsd/db-writer.js")),
      "should include src/ swapped candidate",
    );
  });

  it("includes .ts variants for .js paths", () => {
    const candidates = _buildImportCandidates("../../../src/resources/extensions/gsd/db-writer.js");
    assert.ok(
      candidates.some((c) => c.endsWith("db-writer.ts") && c.includes("/src/")),
      "should include .ts variant for original src/ path",
    );
    assert.ok(
      candidates.some((c) => c.endsWith("db-writer.ts") && c.includes("/dist/")),
      "should include .ts variant for swapped dist/ path",
    );
  });

  it("returns original path first", () => {
    const input = "../../../src/resources/extensions/gsd/db-writer.js";
    const candidates = _buildImportCandidates(input);
    assert.equal(candidates[0], input, "first candidate should be the original path");
  });

  it("handles paths without src/ or dist/ gracefully", () => {
    const candidates = _buildImportCandidates("./local-module.js");
    assert.equal(candidates.length, 2, "should have original + .ts variant only");
    assert.equal(candidates[0], "./local-module.js");
    assert.equal(candidates[1], "./local-module.ts");
  });
});
