// GSD Extension - Override Tests
// Tests for parseOverrides, appendOverride, loadActiveOverrides, formatOverridesSection, resolveAllOverrides

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestContext } from './test-helpers.ts';
import { parseOverrides, appendOverride, loadActiveOverrides, formatOverridesSection, resolveAllOverrides } from '../files.ts';
import type { Override } from '../files.ts';

const { assertEq, assertTrue, assertMatch, assertNoMatch, report } = createTestContext();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gsd-overrides-test-${prefix}-`));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

// ═══════════════════════════════════════════════════════════════════════════
// parseOverrides tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== parseOverrides: empty content ===');
{
  const result = parseOverrides("");
  assertEq(result.length, 0, "empty content returns no overrides");
}

console.log('\n=== parseOverrides: single active override ===');
{
  const content = `# GSD Overrides

User-issued overrides that supersede plan document content.

---

## Override: 2026-03-14T10:00:00.000Z

**Change:** Use Postgres instead of SQLite
**Scope:** active
**Applied-at:** M001/S02/T03

---
`;
  const result = parseOverrides(content);
  assertEq(result.length, 1, "parses one override");
  assertEq(result[0].timestamp, "2026-03-14T10:00:00.000Z", "correct timestamp");
  assertEq(result[0].change, "Use Postgres instead of SQLite", "correct change");
  assertEq(result[0].scope, "active", "correct scope");
  assertEq(result[0].appliedAt, "M001/S02/T03", "correct appliedAt");
}

console.log('\n=== parseOverrides: multiple overrides, mixed scopes ===');
{
  const content = `# GSD Overrides

---

## Override: 2026-03-14T10:00:00.000Z

**Change:** Use Postgres instead of SQLite
**Scope:** resolved
**Applied-at:** M001/S02/T03

---

## Override: 2026-03-14T11:00:00.000Z

**Change:** Use JWT instead of session cookies
**Scope:** active
**Applied-at:** M001/S03/T01

---
`;
  const result = parseOverrides(content);
  assertEq(result.length, 2, "parses two overrides");
  assertEq(result[0].scope, "resolved", "first is resolved");
  assertEq(result[1].scope, "active", "second is active");
  assertEq(result[1].change, "Use JWT instead of session cookies", "second change text");
}

// ═══════════════════════════════════════════════════════════════════════════
// appendOverride tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== appendOverride: creates new file ===');
{
  const tmp = makeTempDir("append-new");
  await appendOverride(tmp, "Use Postgres", "M001/S01/T01");
  const content = readFileSync(join(tmp, ".gsd", "OVERRIDES.md"), "utf-8");
  assertTrue(content.includes("# GSD Overrides"), "has header");
  assertTrue(content.includes("**Change:** Use Postgres"), "has change");
  assertTrue(content.includes("**Scope:** active"), "has active scope");
  assertTrue(content.includes("**Applied-at:** M001/S01/T01"), "has appliedAt");
}

console.log('\n=== appendOverride: appends to existing file ===');
{
  const tmp = makeTempDir("append-existing");
  await appendOverride(tmp, "First override", "M001/S01/T01");
  await appendOverride(tmp, "Second override", "M001/S02/T02");
  const content = readFileSync(join(tmp, ".gsd", "OVERRIDES.md"), "utf-8");
  assertTrue(content.includes("**Change:** First override"), "has first override");
  assertTrue(content.includes("**Change:** Second override"), "has second override");

  const parsed = parseOverrides(content);
  assertEq(parsed.length, 2, "two overrides in file");
}

// ═══════════════════════════════════════════════════════════════════════════
// loadActiveOverrides tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== loadActiveOverrides: no file ===');
{
  const tmp = makeTempDir("load-no-file");
  const result = await loadActiveOverrides(tmp);
  assertEq(result.length, 0, "returns empty when no file");
}

console.log('\n=== loadActiveOverrides: filters to active only ===');
{
  const tmp = makeTempDir("load-filter");
  const content = `# GSD Overrides

---

## Override: 2026-03-14T10:00:00.000Z

**Change:** Resolved change
**Scope:** resolved
**Applied-at:** M001/S01/T01

---

## Override: 2026-03-14T11:00:00.000Z

**Change:** Active change
**Scope:** active
**Applied-at:** M001/S02/T01

---
`;
  writeFileSync(join(tmp, ".gsd", "OVERRIDES.md"), content, "utf-8");
  const result = await loadActiveOverrides(tmp);
  assertEq(result.length, 1, "only one active override");
  assertEq(result[0].change, "Active change", "correct active change");
}

// ═══════════════════════════════════════════════════════════════════════════
// formatOverridesSection tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== formatOverridesSection: empty array ===');
{
  const result = formatOverridesSection([]);
  assertEq(result, "", "empty overrides returns empty string");
}

console.log('\n=== formatOverridesSection: formats section ===');
{
  const overrides: Override[] = [
    { timestamp: "2026-03-14T10:00:00.000Z", change: "Use Postgres", scope: "active", appliedAt: "M001/S01/T01" },
  ];
  const result = formatOverridesSection(overrides);
  assertTrue(result.includes("## Active Overrides (supersede plan content)"), "has header");
  assertTrue(result.includes("**Use Postgres**"), "has change text");
  assertTrue(result.includes("supersede any conflicting content"), "has instruction");
}

// ═══════════════════════════════════════════════════════════════════════════
// resolveAllOverrides tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== resolveAllOverrides: marks all as resolved ===');
{
  const tmp = makeTempDir("resolve-all");
  await appendOverride(tmp, "First", "M001/S01/T01");
  await appendOverride(tmp, "Second", "M001/S02/T01");

  // Verify both are active
  let active = await loadActiveOverrides(tmp);
  assertEq(active.length, 2, "two active before resolve");

  await resolveAllOverrides(tmp);

  // Verify all are resolved
  active = await loadActiveOverrides(tmp);
  assertEq(active.length, 0, "no active after resolve");

  const content = readFileSync(join(tmp, ".gsd", "OVERRIDES.md"), "utf-8");
  const allOverrides = parseOverrides(content);
  assertEq(allOverrides.length, 2, "still two overrides total");
  assertTrue(allOverrides.every(o => o.scope === "resolved"), "all resolved");
}

console.log('\n=== resolveAllOverrides: no file — no error ===');
{
  const tmp = makeTempDir("resolve-no-file");
  await resolveAllOverrides(tmp);
  // Should not throw
  assertTrue(true, "resolveAllOverrides with no file does not throw");
}

report();
