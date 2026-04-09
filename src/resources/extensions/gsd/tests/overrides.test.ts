// GSD Extension - Override Tests
// Tests for parseOverrides, appendOverride, loadActiveOverrides, formatOverridesSection, resolveAllOverrides

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseOverrides, appendOverride, loadActiveOverrides, formatOverridesSection, resolveAllOverrides } from '../files.ts';
import type { Override } from '../files.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gsd-overrides-test-${prefix}-`));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs.length = 0;
}

describe('overrides', () => {
  afterEach(() => cleanup());

  test('parseOverrides: empty content', () => {
    const result = parseOverrides(""); assert.deepStrictEqual(result.length, 0, "empty content returns no overrides");
  });

  test('parseOverrides: single active override', () => {
    const content = `# GSD Overrides\n\nUser-issued overrides that supersede plan document content.\n\n---\n\n## Override: 2026-03-14T10:00:00.000Z\n\n**Change:** Use Postgres instead of SQLite\n**Scope:** active\n**Applied-at:** M001/S02/T03\n\n---\n`;
    const result = parseOverrides(content);
    assert.deepStrictEqual(result.length, 1, "parses one override");
    assert.deepStrictEqual(result[0].timestamp, "2026-03-14T10:00:00.000Z", "correct timestamp");
    assert.deepStrictEqual(result[0].change, "Use Postgres instead of SQLite", "correct change");
    assert.deepStrictEqual(result[0].scope, "active", "correct scope");
    assert.deepStrictEqual(result[0].appliedAt, "M001/S02/T03", "correct appliedAt");
  });

  test('parseOverrides: multiple overrides, mixed scopes', () => {
    const content = `# GSD Overrides\n\n---\n\n## Override: 2026-03-14T10:00:00.000Z\n\n**Change:** Use Postgres instead of SQLite\n**Scope:** resolved\n**Applied-at:** M001/S02/T03\n\n---\n\n## Override: 2026-03-14T11:00:00.000Z\n\n**Change:** Use JWT instead of session cookies\n**Scope:** active\n**Applied-at:** M001/S03/T01\n\n---\n`;
    const result = parseOverrides(content);
    assert.deepStrictEqual(result.length, 2, "parses two overrides");
    assert.deepStrictEqual(result[0].scope, "resolved", "first is resolved");
    assert.deepStrictEqual(result[1].scope, "active", "second is active");
    assert.deepStrictEqual(result[1].change, "Use JWT instead of session cookies", "second change text");
  });

  test('appendOverride: creates new file', async () => {
    const tmp = makeTempDir("append-new");
    await appendOverride(tmp, "Use Postgres", "M001/S01/T01");
    const content = readFileSync(join(tmp, ".gsd", "OVERRIDES.md"), "utf-8");
    assert.ok(content.includes("# GSD Overrides"), "has header");
    assert.ok(content.includes("**Change:** Use Postgres"), "has change");
    assert.ok(content.includes("**Scope:** active"), "has active scope");
    assert.ok(content.includes("**Applied-at:** M001/S01/T01"), "has appliedAt");
  });

  test('appendOverride: appends to existing file', async () => {
    const tmp = makeTempDir("append-existing");
    await appendOverride(tmp, "First override", "M001/S01/T01");
    await appendOverride(tmp, "Second override", "M001/S02/T02");
    const content = readFileSync(join(tmp, ".gsd", "OVERRIDES.md"), "utf-8");
    assert.ok(content.includes("**Change:** First override"), "has first override");
    assert.ok(content.includes("**Change:** Second override"), "has second override");
    const parsed = parseOverrides(content);
    assert.deepStrictEqual(parsed.length, 2, "two overrides in file");
  });

  test('loadActiveOverrides: no file', async () => {
    const tmp = makeTempDir("load-no-file");
    const result = await loadActiveOverrides(tmp);
    assert.deepStrictEqual(result.length, 0, "returns empty when no file");
  });

  test('loadActiveOverrides: filters to active only', async () => {
    const tmp = makeTempDir("load-filter");
    const content = `# GSD Overrides\n\n---\n\n## Override: 2026-03-14T10:00:00.000Z\n\n**Change:** Resolved change\n**Scope:** resolved\n**Applied-at:** M001/S01/T01\n\n---\n\n## Override: 2026-03-14T11:00:00.000Z\n\n**Change:** Active change\n**Scope:** active\n**Applied-at:** M001/S02/T01\n\n---\n`;
    writeFileSync(join(tmp, ".gsd", "OVERRIDES.md"), content, "utf-8");
    const result = await loadActiveOverrides(tmp);
    assert.deepStrictEqual(result.length, 1, "only one active override");
    assert.deepStrictEqual(result[0].change, "Active change", "correct active change");
  });

  test('formatOverridesSection: empty array', () => {
    const result = formatOverridesSection([]); assert.deepStrictEqual(result, "", "empty overrides returns empty string");
  });

  test('formatOverridesSection: formats section', () => {
    const overrides: Override[] = [
      { timestamp: "2026-03-14T10:00:00.000Z", change: "Use Postgres", scope: "active", appliedAt: "M001/S01/T01" },
    ];
    const result = formatOverridesSection(overrides);
    assert.ok(result.includes("## Active Overrides (supersede plan content)"), "has header");
    assert.ok(result.includes("**Use Postgres**"), "has change text");
    assert.ok(result.includes("supersede any conflicting content"), "has instruction");
  });

  test('resolveAllOverrides: marks all as resolved', async () => {
    const tmp = makeTempDir("resolve-all");
    await appendOverride(tmp, "First", "M001/S01/T01");
    await appendOverride(tmp, "Second", "M001/S02/T01");
    let active = await loadActiveOverrides(tmp);
    assert.deepStrictEqual(active.length, 2, "two active before resolve");
    await resolveAllOverrides(tmp);
    active = await loadActiveOverrides(tmp);
    assert.deepStrictEqual(active.length, 0, "no active after resolve");
    const content = readFileSync(join(tmp, ".gsd", "OVERRIDES.md"), "utf-8");
    const allOverrides = parseOverrides(content);
    assert.deepStrictEqual(allOverrides.length, 2, "still two overrides total");
    assert.ok(allOverrides.every(o => o.scope === "resolved"), "all resolved");
  });

  test('resolveAllOverrides: no file — no error', async () => {
    const tmp = makeTempDir("resolve-no-file");
    await resolveAllOverrides(tmp);
    assert.ok(true, "resolveAllOverrides with no file does not throw");
  });
});
