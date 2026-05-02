/**
 * Unit tests for the EVAL-FIX frontmatter schema and parser.
 *
 * Schema is the single source of truth for the contract between the fix
 * agent (writes EVAL-FIX.md) and the handler (recomputes counts/status,
 * never trusts LLM arithmetic). Regex over LLM prose is forbidden — every
 * consumer reads the validated frontmatter only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EVAL_FIX_SCHEMA_VERSION,
  deriveCounts,
  deriveStatus,
  extractFrontmatterRaw,
  isCitationEvidence,
  parseEvalFixFrontmatter,
  validateFixesAgainstReview,
  type EvalFixEntryT,
  type EvalFixFrontmatterT,
} from "../eval-fix-schema.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const VALID_FIXES_BLOCK = [
  "fixes:",
  "  - gap_id: G01",
  "    dimension: observability",
  "    severity: major",
  "    action: code_change",
  "    files_touched:",
  "      - path: src/llm/wrapper.ts",
  "        change: modified",
  "    evidence: \"src/llm/wrapper.ts:42 — emit('llm.latency', { latency_ms })\"",
  "    rationale: \"Adds latency emission so the dimension has runtime evidence.\"",
].join("\n");

const HAPPY_PATH_FRONTMATTER = [
  "---",
  `schema: ${EVAL_FIX_SCHEMA_VERSION}`,
  "status: COMPLETE",
  "generated: 2026-04-29T10:15:00Z",
  "slice: S07",
  "milestone: M001-eh88as",
  "review_source: S07-EVAL-REVIEW.md",
  "review_generated: 2026-04-28T14:00:00Z",
  VALID_FIXES_BLOCK,
  "counts:",
  "  fixed: 1",
  "  partial: 0",
  "  declined: 0",
  "  total: 1",
  "---",
  "",
  "# Detailed write-up",
  "Free-form prose body. Never parsed.",
].join("\n");

function happyPathWith(replace: Record<string, string>): string {
  let out = HAPPY_PATH_FRONTMATTER;
  for (const [from, to] of Object.entries(replace)) {
    out = out.replace(from, to);
  }
  return out;
}

// ─── extractFrontmatterRaw ────────────────────────────────────────────────────

describe("extractFrontmatterRaw", () => {
  it("returns the YAML content between --- delimiters", () => {
    const result = extractFrontmatterRaw("---\nfoo: bar\n---\nbody");
    assert.deepEqual(result, { yaml: "foo: bar" });
  });

  it("errors when the first line is not ---", () => {
    const result = extractFrontmatterRaw("foo: bar\n---\nbody");
    assert.ok("error" in result);
  });

  it("errors when no closing --- is found", () => {
    const result = extractFrontmatterRaw("---\nfoo: bar\nbody");
    assert.ok("error" in result);
  });

  it("handles CRLF line endings", () => {
    const result = extractFrontmatterRaw("---\r\nfoo: bar\r\n---\r\nbody");
    assert.deepEqual(result, { yaml: "foo: bar" });
  });
});

// ─── parseEvalFixFrontmatter — happy path ─────────────────────────────────────

describe("parseEvalFixFrontmatter (happy path)", () => {
  it("accepts a fully-populated frontmatter and returns the typed object", () => {
    const result = parseEvalFixFrontmatter(HAPPY_PATH_FRONTMATTER);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.schema, EVAL_FIX_SCHEMA_VERSION);
      assert.equal(result.data.status, "COMPLETE");
      assert.equal(result.data.slice, "S07");
      assert.equal(result.data.milestone, "M001-eh88as");
      assert.equal(result.data.review_source, "S07-EVAL-REVIEW.md");
      assert.equal(result.data.fixes.length, 1);
      assert.equal(result.data.fixes[0].gap_id, "G01");
      assert.equal(result.data.fixes[0].action, "code_change");
      assert.equal(result.data.fixes[0].files_touched.length, 1);
      assert.equal(result.data.fixes[0].files_touched[0].change, "modified");
      assert.equal(result.data.counts.total, 1);
    }
  });

  it("accepts an empty fixes[] array (edge: NO_OP record)", () => {
    const noOp = HAPPY_PATH_FRONTMATTER
      .replace("status: COMPLETE", "status: NO_OP")
      .replace(VALID_FIXES_BLOCK, "fixes: []")
      .replace("  fixed: 1", "  fixed: 0")
      .replace("  total: 1", "  total: 0");
    const result = parseEvalFixFrontmatter(noOp);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.fixes.length, 0);
      assert.equal(result.data.status, "NO_OP");
    }
  });

  it("accepts fractional-seconds in the generated/review_generated timestamps", () => {
    const withMs = HAPPY_PATH_FRONTMATTER
      .replace("generated: 2026-04-29T10:15:00Z", "generated: 2026-04-29T10:15:00.123Z")
      .replace("review_generated: 2026-04-28T14:00:00Z", "review_generated: 2026-04-28T14:00:00.456Z");
    const result = parseEvalFixFrontmatter(withMs);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.generated, "2026-04-29T10:15:00.123Z");
      assert.equal(result.data.review_generated, "2026-04-28T14:00:00.456Z");
    }
  });

  it("rejects forged counts that disagree with fixes[] (anti-Goodhart)", () => {
    const wrong = HAPPY_PATH_FRONTMATTER
      .replace("  fixed: 1", "  fixed: 2")
      .replace("  total: 1", "  total: 2");
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.pointer, "/counts");
      assert.match(result.error, /counts must match fixes/);
    }
  });

  it("rejects a forged status that hides declined entries as COMPLETE", () => {
    const wrong = HAPPY_PATH_FRONTMATTER
      .replace("    action: code_change", "    action: declined")
      .replace("  fixed: 1", "  fixed: 0")
      .replace("  declined: 0", "  declined: 1");
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.pointer, "/status");
      assert.match(result.error, /status must be PARTIAL/);
    }
  });
});

// ─── parseEvalFixFrontmatter — failure paths ──────────────────────────────────

describe("parseEvalFixFrontmatter (failure paths)", () => {
  it("rejects a missing frontmatter delimiter with pointer `/`", () => {
    const result = parseEvalFixFrontmatter("# just a body\nno frontmatter at all");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.pointer, "/");
      assert.match(result.error, /opening `---`/);
    }
  });

  it("rejects malformed YAML with pointer `/` and an error mentioning YAML", () => {
    const malformed = "---\nfoo: : bar\n---\n";
    const result = parseEvalFixFrontmatter(malformed);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.pointer, "/");
      assert.match(result.error, /YAML/);
    }
  });

  it("rejects a wrong schema version literal", () => {
    const wrong = HAPPY_PATH_FRONTMATTER.replace(
      `schema: ${EVAL_FIX_SCHEMA_VERSION}`,
      "schema: eval-fix/v2",
    );
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /schema/);
  });

  it("rejects a status outside the enum", () => {
    const wrong = happyPathWith({ "status: COMPLETE": "status: SUPER_DUPER" });
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /status/);
  });

  it("rejects a fix entry whose action is outside the enum", () => {
    const wrong = HAPPY_PATH_FRONTMATTER.replace(
      "    action: code_change",
      "    action: invented_action",
    );
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /action/);
  });

  it("rejects a gap_id that does not match /^G\\d+$/ (regression: only audit-issued IDs allowed)", () => {
    const wrong = HAPPY_PATH_FRONTMATTER.replace("  - gap_id: G01", "  - gap_id: g1");
    assert.notEqual(wrong, HAPPY_PATH_FRONTMATTER, "fixture replacement must succeed");
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /gap_id/);
  });

  it("rejects a slice ID that does not match /^S\\d+$/ (defense in depth)", () => {
    const wrong = happyPathWith({ "slice: S07": "slice: ../../etc/passwd" });
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /slice/);
  });

  it("rejects a review_source that contains a path separator (basename-only contract)", () => {
    for (const bad of [
      ".gsd/milestones/M001/slices/S07/S07-EVAL-REVIEW.md",
      "../../etc/passwd",
      "C:\\Windows\\System32\\foo.md",
      ".",
      "..",
    ]) {
      const wrong = happyPathWith({ "review_source: S07-EVAL-REVIEW.md": `review_source: ${bad}` });
      const result = parseEvalFixFrontmatter(wrong);
      assert.equal(result.ok, false, `must reject review_source=${JSON.stringify(bad)}`);
      if (!result.ok) assert.match(result.pointer, /review_source/);
    }
  });

  it("accepts a review_source that is a plain basename", () => {
    const result = parseEvalFixFrontmatter(HAPPY_PATH_FRONTMATTER);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.review_source, "S07-EVAL-REVIEW.md");
  });

  it("rejects an empty evidence string (anti-Goodhart contract)", () => {
    const wrong = HAPPY_PATH_FRONTMATTER.replace(
      "    evidence: \"src/llm/wrapper.ts:42 — emit('llm.latency', { latency_ms })\"",
      "    evidence: \"\"",
    );
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /evidence/);
  });

  it("rejects an empty rationale string", () => {
    const wrong = HAPPY_PATH_FRONTMATTER.replace(
      "    rationale: \"Adds latency emission so the dimension has runtime evidence.\"",
      "    rationale: \"\"",
    );
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /rationale/);
  });

  it("rejects files_touched with an unknown change literal", () => {
    const wrong = HAPPY_PATH_FRONTMATTER.replace(
      "        change: modified",
      "        change: deepfried",
    );
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /change/);
  });

  it("rejects negative counts in the histogram", () => {
    const wrong = HAPPY_PATH_FRONTMATTER.replace("  fixed: 1", "  fixed: -1");
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /fixed/);
  });

  it("rejects a missing required field (review_generated)", () => {
    const wrong = HAPPY_PATH_FRONTMATTER
      .split("\n")
      .filter((l) => !l.startsWith("review_generated:"))
      .join("\n");
    const result = parseEvalFixFrontmatter(wrong);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.pointer, /review_generated/);
  });
});

// ─── deriveCounts ─────────────────────────────────────────────────────────────

describe("deriveCounts", () => {
  function entry(action: EvalFixEntryT["action"], gap = "G01"): EvalFixEntryT {
    return {
      gap_id: gap,
      dimension: "observability",
      severity: "major",
      action,
      files_touched: [],
      evidence: "x",
      rationale: "y",
    };
  }

  it("returns zeros for an empty fixes list and total === 0", () => {
    const counts = deriveCounts([]);
    assert.deepEqual(counts, { fixed: 0, partial: 0, declined: 0, total: 0 });
  });

  it("counts code_change/test_added/dependency_added/doc_only as fixed", () => {
    const counts = deriveCounts([
      entry("code_change", "G01"),
      entry("test_added", "G02"),
      entry("dependency_added", "G03"),
      entry("doc_only", "G04"),
    ]);
    assert.equal(counts.fixed, 4);
    assert.equal(counts.partial, 0);
    assert.equal(counts.declined, 0);
    assert.equal(counts.total, 4);
  });

  it("counts partial and declined separately", () => {
    const counts = deriveCounts([
      entry("code_change", "G01"),
      entry("partial", "G02"),
      entry("declined", "G03"),
    ]);
    assert.deepEqual(counts, { fixed: 1, partial: 1, declined: 1, total: 3 });
  });
});

// ─── deriveStatus ─────────────────────────────────────────────────────────────

describe("deriveStatus", () => {
  it("returns NO_OP when total === 0", () => {
    assert.equal(deriveStatus({ fixed: 0, partial: 0, declined: 0, total: 0 }), "NO_OP");
  });

  it("returns COMPLETE when every gap is fully fixed", () => {
    assert.equal(deriveStatus({ fixed: 3, partial: 0, declined: 0, total: 3 }), "COMPLETE");
  });

  it("returns PARTIAL when any partial entry exists", () => {
    assert.equal(deriveStatus({ fixed: 2, partial: 1, declined: 0, total: 3 }), "PARTIAL");
  });

  it("returns PARTIAL when any declined entry exists", () => {
    assert.equal(deriveStatus({ fixed: 2, partial: 0, declined: 1, total: 3 }), "PARTIAL");
  });

  it("returns PARTIAL when fixed === 0 but total > 0 (all declined)", () => {
    assert.equal(deriveStatus({ fixed: 0, partial: 0, declined: 2, total: 2 }), "PARTIAL");
  });
});

// ─── isCitationEvidence ───────────────────────────────────────────────────────

describe("isCitationEvidence", () => {
  it("accepts a file:line citation", () => {
    assert.ok(isCitationEvidence("src/llm/wrapper.ts:42 — emit('llm.latency', { latency_ms })"));
    assert.ok(isCitationEvidence("packages/x/y.test.ts:117"));
  });

  it("accepts a test path even without a line citation", () => {
    assert.ok(isCitationEvidence("tests/llm-budget.test.ts: asserts the request is rejected"));
    assert.ok(isCitationEvidence("packages/x/__tests__/y.test.ts"));
    assert.ok(isCitationEvidence("internal/parser_test.go"));
    assert.ok(isCitationEvidence("api/test_handlers.py"));
  });

  it("rejects whitespace-only or near-empty strings", () => {
    assert.equal(isCitationEvidence(""), false);
    assert.equal(isCitationEvidence(" "), false);
    assert.equal(isCitationEvidence("x"), false);
    assert.equal(isCitationEvidence("xy"), false);
  });

  it("rejects token-only descriptions that have no citation or test path", () => {
    assert.equal(isCitationEvidence("see PR"), false);
    assert.equal(isCitationEvidence("see comment"), false);
    assert.equal(isCitationEvidence("// TODO: log llm.latency"), false);
    assert.equal(isCitationEvidence("documented in the README"), false);
  });

  it("rejects a bare extension citation with no filename in front (`.ts:1`)", () => {
    assert.equal(isCitationEvidence(".ts:1"), false);
    assert.equal(isCitationEvidence("the .ts:1 example"), false);
  });

  it("rejects version-token-shaped strings whose 'extension' is digits (`v1.2:3`)", () => {
    assert.equal(isCitationEvidence("v1.2:3 mentioned"), false);
    assert.equal(isCitationEvidence("released v1.2:3"), false);
  });

  it("returns false on huge inputs in linear time (ReDoS regression)", () => {
    const huge = "a".repeat(100_000);
    const start = process.hrtime.bigint();
    const result = isCitationEvidence(huge);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(result, false);
    assert.ok(elapsedMs < 50, `evidence guard must be linear-time; took ${elapsedMs}ms`);
  });

  it("enforces the 4 KiB cap in UTF-8 bytes, not UTF-16 code units", () => {
    // Each 😀 is 4 bytes in UTF-8 but only 2 UTF-16 code units. 1100 emoji =
    // 4400 bytes (over the cap) but only 2200 .length (under the cap).
    // A regex citation is appended so the fast-path would otherwise succeed.
    const evidence = "😀".repeat(1100) + " src/x.ts:1";
    assert.ok(evidence.length < 4096, "fixture precondition: code-unit count is under the cap");
    assert.equal(isCitationEvidence(evidence), false);
  });
});

// ─── validateFixesAgainstReview ───────────────────────────────────────────────

describe("validateFixesAgainstReview", () => {
  function entry(over: Partial<EvalFixEntryT> = {}): EvalFixEntryT {
    return {
      gap_id: "G01",
      dimension: "observability",
      severity: "major",
      action: "code_change",
      files_touched: [{ path: "src/x.ts", change: "modified" }],
      evidence: "src/x.ts:42 — emit('x.metric', { v })",
      rationale: "Adds the runtime emission.",
      ...over,
    };
  }
  function fixDoc(fixes: EvalFixEntryT[]): EvalFixFrontmatterT {
    return {
      schema: "eval-fix/v1",
      status: "COMPLETE",
      generated: "2026-04-29T10:15:00Z",
      slice: "S07",
      milestone: "M001",
      review_source: "S07-EVAL-REVIEW.md",
      review_generated: "2026-04-28T14:00:00Z",
      fixes,
      counts: { fixed: fixes.length, partial: 0, declined: 0, total: fixes.length },
    };
  }
  function expected(
    ids: readonly string[],
    over: Record<string, { dimension?: EvalFixEntryT["dimension"]; severity?: EvalFixEntryT["severity"] }> = {},
  ): Map<string, { dimension: EvalFixEntryT["dimension"]; severity: EvalFixEntryT["severity"] }> {
    const m = new Map<string, { dimension: EvalFixEntryT["dimension"]; severity: EvalFixEntryT["severity"] }>();
    for (const id of ids) {
      m.set(id, {
        dimension: over[id]?.dimension ?? "observability",
        severity: over[id]?.severity ?? "major",
      });
    }
    return m;
  }

  it("returns ok when fixes is a permutation of expectedGaps", () => {
    const result = validateFixesAgainstReview(
      fixDoc([entry({ gap_id: "G01" }), entry({ gap_id: "G02" })]),
      expected(["G02", "G01"]),
    );
    assert.equal(result.ok, true);
  });

  it("rejects when an audit gap is missing from fixes (Goodhart-by-omission, BLOCKER-3)", () => {
    const result = validateFixesAgainstReview(
      fixDoc([entry({ gap_id: "G01" })]),
      expected(["G01", "G02"]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /G02/);
      assert.equal(result.pointer, "/fixes");
    }
  });

  it("rejects a phantom gap_id not in the audit", () => {
    const result = validateFixesAgainstReview(
      fixDoc([entry({ gap_id: "G01" }), entry({ gap_id: "G99" })]),
      expected(["G01"]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /G99/);
      assert.match(result.pointer, /gap_id/);
    }
  });

  it("rejects duplicate gap_id entries", () => {
    const result = validateFixesAgainstReview(
      fixDoc([entry({ gap_id: "G01" }), entry({ gap_id: "G01" })]),
      expected(["G01"]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /duplicate/);
  });

  it("rejects a fix that downgrades the audit's severity (mirrored-metadata contract)", () => {
    const result = validateFixesAgainstReview(
      fixDoc([entry({ gap_id: "G01", severity: "minor" })]),
      expected(["G01"], { G01: { severity: "major" } }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.pointer, /\/fixes\/0\/severity/);
      assert.match(result.error, /severity=major/);
    }
  });

  it("rejects a fix that rewrites the audit's dimension", () => {
    const result = validateFixesAgainstReview(
      fixDoc([entry({ gap_id: "G01", dimension: "guardrails" })]),
      expected(["G01"], { G01: { dimension: "observability" } }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.pointer, /\/fixes\/0\/dimension/);
      assert.match(result.error, /dimension=observability/);
    }
  });

  it("rejects a non-declined entry whose evidence is not a citation (MAJOR-2)", () => {
    const result = validateFixesAgainstReview(
      fixDoc([entry({ gap_id: "G01", evidence: "see PR" })]),
      expected(["G01"]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.pointer, /\/fixes\/0\/evidence/);
      assert.match(result.error, /file:line|test/);
    }
  });

  it("exempts declined entries from the citation requirement", () => {
    const result = validateFixesAgainstReview(
      fixDoc([entry({
        gap_id: "G01",
        action: "declined",
        files_touched: [],
        evidence: "Sink wiring blocked on infra ticket; declining rather than emitting tokenistic call.",
      })]),
      expected(["G01"]),
    );
    assert.equal(result.ok, true);
  });
});
