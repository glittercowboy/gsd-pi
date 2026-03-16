// gsd-inspect — Tests for /gsd inspect output formatting
//
// Tests the pure formatInspectOutput function with known data.

import { createTestContext } from './test-helpers.ts';
import { formatInspectOutput, type InspectData } from '../commands.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ── formats output with schema version, counts, and recent entries ──
console.log("# === gsd-inspect: full output formatting ===");
{
  const data: InspectData = {
    schemaVersion: 2,
    counts: { decisions: 12, requirements: 8, artifacts: 3 },
    recentDecisions: [
      { id: "D012", decision: "Use SQLite for persistence", choice: "node:sqlite with fallback" },
      { id: "D011", decision: "Markdown dual-write", choice: "DB-first then regenerate" },
    ],
    recentRequirements: [
      { id: "R015", status: "active", description: "Commands register via pi.registerCommand" },
      { id: "R014", status: "active", description: "DB writes use upsert pattern" },
    ],
  };

  const output = formatInspectOutput(data);

  assertMatch(output, /=== GSD Database Inspect ===/, "contains header");
  assertMatch(output, /Schema version: 2/, "contains schema version");
  assertMatch(output, /Decisions:\s+12/, "contains decisions count");
  assertMatch(output, /Requirements:\s+8/, "contains requirements count");
  assertMatch(output, /Artifacts:\s+3/, "contains artifacts count");
  assertMatch(output, /Recent decisions:/, "contains recent decisions header");
  assertMatch(output, /D012: Use SQLite for persistence → node:sqlite with fallback/, "contains D012 entry");
  assertMatch(output, /D011: Markdown dual-write → DB-first then regenerate/, "contains D011 entry");
  assertMatch(output, /Recent requirements:/, "contains recent requirements header");
  assertMatch(output, /R015 \[active\]: Commands register via pi\.registerCommand/, "contains R015 entry");
  assertMatch(output, /R014 \[active\]: DB writes use upsert pattern/, "contains R014 entry");
}

// ── handles zero counts and no recent entries ──
console.log("# === gsd-inspect: empty data ===");
{
  const data: InspectData = {
    schemaVersion: 1,
    counts: { decisions: 0, requirements: 0, artifacts: 0 },
    recentDecisions: [],
    recentRequirements: [],
  };

  const output = formatInspectOutput(data);

  assertMatch(output, /Schema version: 1/, "contains schema version 1");
  assertMatch(output, /Decisions:\s+0/, "zero decisions");
  assertMatch(output, /Requirements:\s+0/, "zero requirements");
  assertMatch(output, /Artifacts:\s+0/, "zero artifacts");
  assertTrue(!output.includes("Recent decisions:"), "no recent decisions section when empty");
  assertTrue(!output.includes("Recent requirements:"), "no recent requirements section when empty");
}

// ── handles null schema version ──
console.log("# === gsd-inspect: null schema version ===");
{
  const data: InspectData = {
    schemaVersion: null,
    counts: { decisions: 0, requirements: 0, artifacts: 0 },
    recentDecisions: [],
    recentRequirements: [],
  };

  const output = formatInspectOutput(data);
  assertMatch(output, /Schema version: unknown/, "null version shows as unknown");
}

// ── formats up to 5 recent entries ──
console.log("# === gsd-inspect: five recent entries ===");
{
  const data: InspectData = {
    schemaVersion: 2,
    counts: { decisions: 5, requirements: 5, artifacts: 0 },
    recentDecisions: [
      { id: "D005", decision: "Dec 5", choice: "C5" },
      { id: "D004", decision: "Dec 4", choice: "C4" },
      { id: "D003", decision: "Dec 3", choice: "C3" },
      { id: "D002", decision: "Dec 2", choice: "C2" },
      { id: "D001", decision: "Dec 1", choice: "C1" },
    ],
    recentRequirements: [
      { id: "R005", status: "active", description: "Req 5" },
      { id: "R004", status: "done", description: "Req 4" },
      { id: "R003", status: "active", description: "Req 3" },
      { id: "R002", status: "active", description: "Req 2" },
      { id: "R001", status: "done", description: "Req 1" },
    ],
  };

  const output = formatInspectOutput(data);

  for (let i = 1; i <= 5; i++) {
    assertMatch(output, new RegExp(`D00${i}: Dec ${i} → C${i}`), `contains D00${i}`);
  }
  for (let i = 1; i <= 5; i++) {
    assertMatch(output, new RegExp(`R00${i}`), `contains R00${i}`);
  }
  assertMatch(output, /\[active\]/, "contains active status");
  assertMatch(output, /\[done\]/, "contains done status");
}

// ── output is multiline text (not JSON) ──
console.log("# === gsd-inspect: output format ===");
{
  const data: InspectData = {
    schemaVersion: 2,
    counts: { decisions: 1, requirements: 1, artifacts: 0 },
    recentDecisions: [{ id: "D001", decision: "Test", choice: "Yes" }],
    recentRequirements: [{ id: "R001", status: "active", description: "Test req" }],
  };

  const output = formatInspectOutput(data);
  const lines = output.split("\n");
  assertTrue(lines.length > 5, "output has multiple lines");
  assertTrue(!output.startsWith("{"), "output is not JSON");
}

report();
