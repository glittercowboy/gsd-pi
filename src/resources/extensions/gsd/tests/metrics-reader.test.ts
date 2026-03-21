/**
 * Tests for metrics-reader JSONL durability
 *
 * Validates crash resilience for dispatch-metrics.jsonl parsing:
 * - Partial writes, truncated JSON, blank lines, malformed content
 * - All must be handled gracefully without throwing
 *
 * @module metrics-reader.test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readMetricsJsonl } from "../metrics-reader.js";
import type { UnitMetrics } from "../metrics.js";

// ─── Test Fixtures ────────────────────────────────────────────────────────────

/** Create a realistic UnitMetrics with required fields. */
function makeUnit(
  type: string,
  id: string,
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  } = {}
): UnitMetrics {
  const startedAt = opts.inputTokens ? Date.now() - 1800000 : Date.now() - 100000;
  const finishedAt = Date.now() - 50000;

  return {
    type,
    id,
    model: "claude-3-sonnet",
    startedAt,
    finishedAt,
    tokens: {
      input: opts.inputTokens ?? 10000,
      output: opts.outputTokens ?? 5000,
      cacheRead: 0,
      cacheWrite: 0,
      total: (opts.inputTokens ?? 10000) + (opts.outputTokens ?? 5000),
    },
    cost: opts.cost ?? 0.15,
    toolCalls: 5,
    assistantMessages: 3,
    userMessages: 2,
  };
}

// ─── Temp File Management ─────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `metrics-reader-test-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function tempPath(name: string): string {
  return join(tempDir, name);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("readMetricsJsonl", () => {
  it("returns all UnitMetrics from valid multi-line JSONL", () => {
    const unit1 = makeUnit("research-milestone", "M001/R", { inputTokens: 50000, cost: 0.5 });
    const unit2 = makeUnit("execute-task", "M001/S01/T01", { inputTokens: 30000, cost: 0.3 });
    const unit3 = makeUnit("plan-slice", "M001/S01/P", { inputTokens: 20000, cost: 0.2 });

    const filePath = tempPath("valid.jsonl");
    const content = [unit1, unit2, unit3].map(u => JSON.stringify(u)).join("\n");
    writeFileSync(filePath, content, "utf-8");

    const result = readMetricsJsonl(filePath);

    assert.equal(result.units.length, 3, "Should parse 3 units");
    assert.equal(result.skippedLines, 0, "Should skip 0 lines");
    assert.equal(result.totalLines, 3, "Should count 3 total lines");

    assert.equal(result.units[0].type, "research-milestone");
    assert.equal(result.units[0].id, "M001/R");
    assert.equal(result.units[0].tokens.input, 50000);

    assert.equal(result.units[1].type, "execute-task");
    assert.equal(result.units[1].id, "M001/S01/T01");

    assert.equal(result.units[2].type, "plan-slice");
    assert.equal(result.units[2].id, "M001/S01/P");
  });

  it("returns empty array for empty file", () => {
    const filePath = tempPath("empty.jsonl");
    writeFileSync(filePath, "", "utf-8");

    const result = readMetricsJsonl(filePath);

    assert.equal(result.units.length, 0, "Should return empty array");
    assert.equal(result.skippedLines, 0, "Should skip 0 lines");
    assert.equal(result.totalLines, 0, "Should count 0 total lines");
  });

  it("skips blank lines and returns valid entries", () => {
    const unit1 = makeUnit("execute-task", "M001/S01/T01");
    const unit2 = makeUnit("execute-task", "M001/S01/T02");

    const filePath = tempPath("with-blanks.jsonl");
    // Interspersed blank lines (including leading/trailing)
    const content = `\n${JSON.stringify(unit1)}\n\n\n${JSON.stringify(unit2)}\n`;
    writeFileSync(filePath, content, "utf-8");

    const result = readMetricsJsonl(filePath);

    assert.equal(result.units.length, 2, "Should parse 2 valid units");
    assert.equal(result.skippedLines, 0, "Blank lines should not count as skipped");
    assert.equal(result.units[0].id, "M001/S01/T01");
    assert.equal(result.units[1].id, "M001/S01/T02");
  });

  it("skips truncated JSON lines and returns valid ones", () => {
    const unit1 = makeUnit("execute-task", "M001/S01/T01");
    const unit2 = makeUnit("execute-task", "M001/S01/T02");

    const filePath = tempPath("truncated.jsonl");
    // Simulate crash mid-write: valid line, truncated line, valid line
    const truncatedLine = '{"type":"execute-task","id":"M001/S01/T03","model":"claude'; // no closing
    const content = `${JSON.stringify(unit1)}\n${truncatedLine}\n${JSON.stringify(unit2)}`;
    writeFileSync(filePath, content, "utf-8");

    const result = readMetricsJsonl(filePath);

    assert.equal(result.units.length, 2, "Should parse 2 valid units (skip truncated)");
    assert.equal(result.skippedLines, 1, "Should skip 1 malformed line");
    assert.equal(result.totalLines, 3, "Should count 3 total lines");
    assert.equal(result.units[0].id, "M001/S01/T01");
    assert.equal(result.units[1].id, "M001/S01/T02");
  });

  it("returns empty array for file with only malformed content", () => {
    const filePath = tempPath("malformed-only.jsonl");
    const content = `not json at all\n{broken json\nalso "invalid"\n%%%garbage%%%`;
    writeFileSync(filePath, content, "utf-8");

    const result = readMetricsJsonl(filePath);

    assert.equal(result.units.length, 0, "Should return empty array for malformed-only file");
    assert.equal(result.skippedLines, 4, "Should skip all 4 malformed lines");
    assert.equal(result.totalLines, 4, "Should count 4 total lines");
  });

  it("returns empty result for nonexistent file", () => {
    const result = readMetricsJsonl("/nonexistent/path/to/file.jsonl");

    assert.equal(result.units.length, 0, "Should return empty array for missing file");
    assert.equal(result.skippedLines, 0, "Should skip 0 lines (file doesn't exist)");
    assert.equal(result.totalLines, 0, "Should count 0 lines");
  });

  it("handles mixed valid and invalid lines", () => {
    const unit1 = makeUnit("research-milestone", "M001/R");
    const unit2 = makeUnit("execute-task", "M001/S01/T01");

    const filePath = tempPath("mixed.jsonl");
    const lines = [
      JSON.stringify(unit1),
      "this is not json",
      JSON.stringify(unit2),
      '{"type":"incomplete","id":"no-close"',
      "", // blank line
      '{"type":"missing-id"}', // valid JSON but missing required 'id' field
    ];
    writeFileSync(filePath, lines.join("\n"), "utf-8");

    const result = readMetricsJsonl(filePath);

    assert.equal(result.units.length, 2, "Should parse 2 valid units");
    assert.equal(result.skippedLines, 3, "Should skip 3 lines (invalid JSON, incomplete, missing id)");
    // totalLines: 6 lines in the file
    assert.equal(result.totalLines, 6, "Should count 6 total lines");
  });

  it("handles valid JSON missing required fields", () => {
    const validUnit = makeUnit("execute-task", "M001/S01/T01");

    const filePath = tempPath("missing-fields.jsonl");
    const lines = [
      '{"type":"orphan"}', // missing 'id'
      '{"id":"loose"}', // missing 'type'
      JSON.stringify(validUnit),
      '{}', // missing both
    ];
    writeFileSync(filePath, lines.join("\n"), "utf-8");

    const result = readMetricsJsonl(filePath);

    assert.equal(result.units.length, 1, "Should parse only the complete unit");
    assert.equal(result.skippedLines, 3, "Should skip 3 incomplete entries");
    assert.equal(result.units[0].id, "M001/S01/T01");
  });

  it("handles file with only whitespace", () => {
    const filePath = tempPath("whitespace-only.jsonl");
    writeFileSync(filePath, "   \n\t\n   ", "utf-8");

    const result = readMetricsJsonl(filePath);

    assert.equal(result.units.length, 0, "Should return empty array for whitespace-only file");
    assert.equal(result.skippedLines, 0, "Should skip 0 lines (whitespace trimmed)");
  });
});