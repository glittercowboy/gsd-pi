import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// gsd-inspect — Tests for /gsd inspect output formatting
//
// Tests the pure formatInspectOutput function with known data.

import { formatInspectOutput, type InspectData } from '../commands-inspect.ts';

describe('gsd-inspect', () => {
  test('full output formatting', () => {
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

    assert.match(output, /=== GSD Database Inspect ===/, "contains header");
    assert.match(output, /Schema version: 2/, "contains schema version");
    assert.match(output, /Decisions:\s+12/, "contains decisions count");
    assert.match(output, /Requirements:\s+8/, "contains requirements count");
    assert.match(output, /Artifacts:\s+3/, "contains artifacts count");
    assert.match(output, /Recent decisions:/, "contains recent decisions header");
    assert.match(output, /D012: Use SQLite for persistence → node:sqlite with fallback/, "contains D012 entry");
    assert.match(output, /D011: Markdown dual-write → DB-first then regenerate/, "contains D011 entry");
    assert.match(output, /Recent requirements:/, "contains recent requirements header");
    assert.match(output, /R015 \[active\]: Commands register via pi\.registerCommand/, "contains R015 entry");
    assert.match(output, /R014 \[active\]: DB writes use upsert pattern/, "contains R014 entry");
  });

  test('empty data', () => {
    const data: InspectData = {
      schemaVersion: 1,
      counts: { decisions: 0, requirements: 0, artifacts: 0 },
      recentDecisions: [],
      recentRequirements: [],
    };

    const output = formatInspectOutput(data);

    assert.match(output, /Schema version: 1/, "contains schema version 1");
    assert.match(output, /Decisions:\s+0/, "zero decisions");
    assert.match(output, /Requirements:\s+0/, "zero requirements");
    assert.match(output, /Artifacts:\s+0/, "zero artifacts");
    assert.ok(!output.includes("Recent decisions:"), "no recent decisions section when empty");
    assert.ok(!output.includes("Recent requirements:"), "no recent requirements section when empty");
  });

  test('null schema version', () => {
    const data: InspectData = {
      schemaVersion: null,
      counts: { decisions: 0, requirements: 0, artifacts: 0 },
      recentDecisions: [],
      recentRequirements: [],
    };

    const output = formatInspectOutput(data);
    assert.match(output, /Schema version: unknown/, "null version shows as unknown");
  });

  test('five recent entries', () => {
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
      assert.match(output, new RegExp(`D00${i}: Dec ${i} → C${i}`), `contains D00${i}`);
    }
    for (let i = 1; i <= 5; i++) {
      assert.match(output, new RegExp(`R00${i}`), `contains R00${i}`);
    }
    assert.match(output, /\[active\]/, "contains active status");
    assert.match(output, /\[done\]/, "contains done status");
  });

  test('output format', () => {
    const data: InspectData = {
      schemaVersion: 2,
      counts: { decisions: 1, requirements: 1, artifacts: 0 },
      recentDecisions: [{ id: "D001", decision: "Test", choice: "Yes" }],
      recentRequirements: [{ id: "R001", status: "active", description: "Test req" }],
    };

    const output = formatInspectOutput(data);
    const lines = output.split("\n");
    assert.ok(lines.length > 5, "output has multiple lines");
    assert.ok(!output.startsWith("{"), "output is not JSON");
  });
});
