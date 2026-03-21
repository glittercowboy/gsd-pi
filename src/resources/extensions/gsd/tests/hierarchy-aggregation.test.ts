/**
 * Tests for hierarchy aggregation utilities:
 * - parseDurationMinutes()
 * - formatDurationMinutes()
 * - aggregateChildFrontmatter()
 *
 * Runs synchronously with createTestContext (consistent with other GSD tests).
 * Uses Node built-in test runner for execution, report() for pass/fail tracking.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestContext } from "./test-helpers.ts";
import {
  parseDurationMinutes,
  formatDurationMinutes,
  aggregateChildFrontmatter,
} from "../files.ts";

const { assertEq, assertTrue, report } = createTestContext();

// ─── Temp directory for fixture files ──────────────────────────────────────

const tmpBase = join(tmpdir(), `gsd-aggregation-test-${Date.now()}`);
mkdirSync(tmpBase, { recursive: true });

function writeSummaryFixture(name: string, frontmatter: Record<string, unknown>, body = ""): string {
  const fmLines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        fmLines.push(`${key}: []`);
      } else {
        fmLines.push(`${key}:`);
        for (const item of value) {
          fmLines.push(`  - ${item}`);
        }
      }
    } else if (typeof value === "boolean") {
      fmLines.push(`${key}: ${value}`);
    } else {
      fmLines.push(`${key}: ${value}`);
    }
  }
  fmLines.push("---");
  const content = fmLines.join("\n") + "\n\n" + body;
  const filePath = join(tmpBase, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ─── parseDurationMinutes tests ────────────────────────────────────────────

console.log("── parseDurationMinutes ──");

assertEq(parseDurationMinutes("15m"), 15, '15m → 15');
assertEq(parseDurationMinutes("1h"), 60, '1h → 60');
assertEq(parseDurationMinutes("1h30m"), 90, '1h30m → 90');
assertEq(parseDurationMinutes("~20m"), 20, '~20m → 20');
assertEq(parseDurationMinutes("≈10m"), 10, '≈10m → 10');
assertEq(parseDurationMinutes(""), 0, 'empty → 0');
assertEq(parseDurationMinutes("garbage"), 0, 'garbage → 0');
assertEq(parseDurationMinutes("2h"), 120, '2h → 120');
assertEq(parseDurationMinutes("0m"), 0, '0m → 0');
assertEq(parseDurationMinutes("2h 5m"), 125, '2h 5m → 125');
assertEq(parseDurationMinutes(undefined), 0, 'undefined → 0');
assertEq(parseDurationMinutes(null), 0, 'null → 0');

// ─── formatDurationMinutes tests ───────────────────────────────────────────

console.log("── formatDurationMinutes ──");

assertEq(formatDurationMinutes(15), "15m", '15 → "15m"');
assertEq(formatDurationMinutes(0), "0m", '0 → "0m"');
assertEq(formatDurationMinutes(60), "1h 0m", '60 → "1h 0m"');
assertEq(formatDurationMinutes(90), "1h 30m", '90 → "1h 30m"');
assertEq(formatDurationMinutes(125), "2h 5m", '125 → "2h 5m"');

// ─── aggregateChildFrontmatter tests ───────────────────────────────────────

console.log("── aggregateChildFrontmatter: deduplication ──");

{
  const a = writeSummaryFixture("task-a.md", {
    id: "T01",
    key_files: ["src/foo.ts", "src/bar.ts"],
    key_decisions: ["D001"],
    patterns_established: ["pattern-a"],
    duration: "15m",
    verification_result: "passed",
  }, "# T01 Summary\n**Built foo and bar**");

  const b = writeSummaryFixture("task-b.md", {
    id: "T02",
    key_files: ["src/bar.ts", "src/baz.ts"],
    key_decisions: ["D002"],
    patterns_established: ["pattern-b"],
    duration: "1h",
    verification_result: "passed",
  }, "# T02 Summary\n**Built baz**");

  const result = aggregateChildFrontmatter([a, b]);

  assertEq(result.key_files.sort(), ["src/bar.ts", "src/baz.ts", "src/foo.ts"], "key_files deduplicated");
  assertEq(result.key_decisions.sort(), ["D001", "D002"], "key_decisions merged");
  assertEq(result.patterns_established.sort(), ["pattern-a", "pattern-b"], "patterns merged");
}

console.log("── aggregateChildFrontmatter: duration summing ──");

{
  const a = writeSummaryFixture("dur-a.md", {
    id: "T01",
    duration: "15m",
    verification_result: "passed",
  });
  const b = writeSummaryFixture("dur-b.md", {
    id: "T02",
    duration: "1h",
    verification_result: "passed",
  });

  const result = aggregateChildFrontmatter([a, b]);
  assertEq(result.duration_minutes, 75, "sum of 15m + 1h = 75");
  assertEq(result.duration_formatted, "1h 15m", "formatted as 1h 15m");
}

console.log("── aggregateChildFrontmatter: all_passed when all passed ──");

{
  const a = writeSummaryFixture("pass-a.md", {
    id: "T01",
    verification_result: "passed",
  });
  const b = writeSummaryFixture("pass-b.md", {
    id: "T02",
    verification_result: "passed",
  });

  const result = aggregateChildFrontmatter([a, b]);
  assertTrue(result.all_passed, "all_passed should be true");
}

console.log("── aggregateChildFrontmatter: all_passed false when one failed ──");

{
  const a = writeSummaryFixture("mixed-a.md", {
    id: "T01",
    verification_result: "passed",
  });
  const b = writeSummaryFixture("mixed-b.md", {
    id: "T02",
    verification_result: "failed",
  });

  const result = aggregateChildFrontmatter([a, b]);
  assertTrue(!result.all_passed, "all_passed should be false when one failed");
  assertEq(result.verification_results["T01"], "passed", "T01 passed");
  assertEq(result.verification_results["T02"], "failed", "T02 failed");
}

console.log("── aggregateChildFrontmatter: empty paths ──");

{
  const result = aggregateChildFrontmatter([]);
  assertEq(result.key_files, [], "empty key_files");
  assertEq(result.key_decisions, [], "empty key_decisions");
  assertEq(result.patterns_established, [], "empty patterns");
  assertEq(result.duration_minutes, 0, "zero duration");
  assertEq(result.duration_formatted, "0m", "formatted as 0m");
  assertEq(result.verification_results, {}, "empty verification_results");
  assertTrue(!result.all_passed, "all_passed false for empty input");
}

console.log("── aggregateChildFrontmatter: non-existent file skipped ──");

{
  const a = writeSummaryFixture("exists.md", {
    id: "T01",
    key_files: ["src/foo.ts"],
    duration: "10m",
    verification_result: "passed",
  });

  const result = aggregateChildFrontmatter([
    a,
    join(tmpBase, "does-not-exist.md"),
  ]);

  assertEq(result.key_files, ["src/foo.ts"], "existing file key_files preserved");
  assertEq(result.duration_minutes, 10, "only existing file duration counted");
  assertTrue(result.all_passed, "all_passed true (only valid child passed)");
}

console.log("── aggregateChildFrontmatter: sparse frontmatter ──");

{
  const sparse = writeSummaryFixture("sparse.md", {
    id: "T99",
    verification_result: "passed",
  }, "# Sparse summary\n**Minimal task**");

  const result = aggregateChildFrontmatter([sparse]);
  assertEq(result.key_files, [], "empty key_files from sparse");
  assertEq(result.key_decisions, [], "empty key_decisions from sparse");
  assertEq(result.duration_minutes, 0, "zero duration from sparse");
  assertTrue(result.all_passed, "all_passed for single passed child");
  assertEq(result.verification_results["T99"], "passed", "T99 in verification_results");
}

console.log("── aggregateChildFrontmatter: empty id falls back to filename ──");

{
  // Use explicit content since writeSummaryFixture would produce `id: ` which
  // parseFrontmatterMap turns into [] (per K004).
  const noIdPath = join(tmpBase, "no-id-task.md");
  writeFileSync(noIdPath, "---\nid:\nverification_result: passed\n---\n\n# No ID\n**test**\n", "utf-8");

  const result = aggregateChildFrontmatter([noIdPath]);
  assertTrue("no-id-task" in result.verification_results, "falls back to filename basename when id is empty/array");
}

console.log("── aggregateChildFrontmatter: no frontmatter at all ──");

{
  const noFmPath = join(tmpBase, "no-frontmatter.md");
  writeFileSync(noFmPath, "# Just a heading\nSome text", "utf-8");

  // Should not crash — parseSummary handles missing frontmatter
  const result = aggregateChildFrontmatter([noFmPath]);
  assertEq(result.duration_minutes, 0, "no duration from file without frontmatter");
}

// ─── Teardown ──────────────────────────────────────────────────────────────

rmSync(tmpBase, { recursive: true, force: true });

// ─── Report ────────────────────────────────────────────────────────────────

report();
