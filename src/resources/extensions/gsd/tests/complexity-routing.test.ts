/**
 * Complexity Routing — unit tests for M004/S03.
 *
 * Tests task complexity classification accuracy and dispatch integration.
 * Uses direct imports for the classifier (pure function, no heavy deps)
 * and source-level checks for dispatch/preference wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTaskComplexity } from "../complexity.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const preferencesSrc = readFileSync(join(__dirname, "..", "preferences.ts"), "utf-8");
const complexitySrc = readFileSync(join(__dirname, "..", "complexity.ts"), "utf-8");

// ═══════════════════════════════════════════════════════════════════════════
// Classification: Simple Tasks
// ═══════════════════════════════════════════════════════════════════════════

test("classify: minimal task plan (2 steps, 1 file) → simple", () => {
  const plan = `# T01: Add config key

## Steps
1. Add key to interface
2. Update validation

## Files
- \`config.ts\`
`;
  assert.equal(classifyTaskComplexity(plan), "simple");
});

test("classify: 3 steps, 2 files, short description → simple", () => {
  const plan = `# T01: Update types

Short description.

## Steps
1. Add type
2. Export it
3. Update imports

## Files
- \`types.ts\`
- \`index.ts\`
`;
  assert.equal(classifyTaskComplexity(plan), "simple");
});

// ═══════════════════════════════════════════════════════════════════════════
// Classification: Standard Tasks
// ═══════════════════════════════════════════════════════════════════════════

test("classify: medium task plan (5 steps, 4 files) → standard", () => {
  const plan = `# T02: Implement auth middleware

Add JWT verification middleware.

## Steps
1. Create middleware file
2. Add token verification
3. Wire into router
4. Add error handling
5. Update types

## Files
- \`middleware.ts\`
- \`auth.ts\`
- \`router.ts\`
- \`types.ts\`
`;
  assert.equal(classifyTaskComplexity(plan), "standard");
});

test("classify: 3 steps but complexity signal word → standard (not simple)", () => {
  const plan = `# T01: Refactor auth

## Steps
1. Extract helper
2. Update callers
3. Test

## Files
- \`auth.ts\`
`;
  assert.equal(classifyTaskComplexity(plan), "standard");
});

test("classify: 4 steps, short but 4 files → standard", () => {
  const plan = `# T01: Wire up

Short.

## Steps
1. Step one
2. Step two
3. Step three
4. Step four

## Files
- \`a.ts\`
- \`b.ts\`
- \`c.ts\`
- \`d.ts\`
`;
  assert.equal(classifyTaskComplexity(plan), "standard");
});

// ═══════════════════════════════════════════════════════════════════════════
// Classification: Complex Tasks
// ═══════════════════════════════════════════════════════════════════════════

test("classify: large task plan (10 steps, 8 files) → complex", () => {
  const plan = `# T03: Migrate database schema

Full database migration with backward compatibility.

## Steps
1. Create migration file
2. Add new columns
3. Migrate existing data
4. Update ORM models
5. Update API handlers
6. Update tests
7. Run migration locally
8. Verify rollback
9. Update docs
10. Deploy staging

## Files
- \`migrations/001.ts\`
- \`models/user.ts\`
- \`models/session.ts\`
- \`api/users.ts\`
- \`api/sessions.ts\`
- \`tests/user.test.ts\`
- \`tests/session.test.ts\`
- \`docs/schema.md\`
`;
  assert.equal(classifyTaskComplexity(plan), "complex");
});

test("classify: long description (>2000 chars) → complex", () => {
  const longDesc = "A".repeat(2100);
  const plan = `# T01: Complex task

${longDesc}

## Steps

1. Do it
2. Done
`;
  assert.equal(classifyTaskComplexity(plan), "complex");
});

// ═══════════════════════════════════════════════════════════════════════════
// Classification: Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

test("classify: empty plan → standard (conservative default)", () => {
  assert.equal(classifyTaskComplexity(""), "standard");
});

test("classify: plan with no Steps section → standard", () => {
  const plan = `# T01: Something\n\nJust a description with no structure.\n`;
  assert.equal(classifyTaskComplexity(plan), "standard");
});

test("classify: null-ish input → standard", () => {
  assert.equal(classifyTaskComplexity("   "), "standard");
});

// ═══════════════════════════════════════════════════════════════════════════
// Complexity Signal Words
// ═══════════════════════════════════════════════════════════════════════════

test("classify: 'investigate' signal prevents simple classification", () => {
  const plan = `# T01: Investigate auth bug\n\n## Steps\n1. Check logs\n2. Fix\n`;
  assert.equal(classifyTaskComplexity(plan), "standard");
});

test("classify: 'security' signal prevents simple classification", () => {
  const plan = `# T01: Security audit\n\n## Steps\n1. Review\n2. Fix\n`;
  assert.equal(classifyTaskComplexity(plan), "standard");
});

// ═══════════════════════════════════════════════════════════════════════════
// Model Config — execution_simple
// ═══════════════════════════════════════════════════════════════════════════

test("preferences: GSDModelConfig includes execution_simple field", () => {
  const v1Match = preferencesSrc.match(/interface GSDModelConfig\s*\{[^}]*execution_simple/);
  assert.ok(v1Match, "GSDModelConfig should have execution_simple field");
  const v2Match = preferencesSrc.match(/interface GSDModelConfigV2\s*\{[^}]*execution_simple/);
  assert.ok(v2Match, "GSDModelConfigV2 should have execution_simple field");
});

test("preferences: budget profile sets execution_simple model", () => {
  const budgetIdx = preferencesSrc.indexOf('case "budget":');
  const balancedIdx = preferencesSrc.indexOf('case "balanced":');
  const budgetBlock = preferencesSrc.slice(budgetIdx, balancedIdx);
  assert.ok(budgetBlock.includes("execution_simple:"), "budget profile should set execution_simple");
});

test("preferences: resolveModelWithFallbacksForUnit handles execute-task-simple", () => {
  assert.ok(
    preferencesSrc.includes('"execute-task-simple"'),
    "should have execute-task-simple case in model resolution",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Classifier Module Structure
// ═══════════════════════════════════════════════════════════════════════════

test("complexity: module exports classifyTaskComplexity function", () => {
  assert.ok(
    complexitySrc.includes("export function classifyTaskComplexity"),
    "should export classifyTaskComplexity",
  );
});

test("complexity: module exports TaskComplexity type", () => {
  assert.ok(
    complexitySrc.includes("export type TaskComplexity"),
    "should export TaskComplexity type",
  );
});

test("complexity: classifier uses conservative defaults", () => {
  // Verify empty/missing input returns standard
  assert.ok(
    complexitySrc.includes('return "standard"'),
    "should have standard as default return",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit Complexity Classification (from #579 — combined)
// ═══════════════════════════════════════════════════════════════════════════

const complexitySrcFull = readFileSync(join(__dirname, "..", "complexity.ts"), "utf-8");

test("unit-classify: classifyUnitComplexity is exported", () => {
  assert.ok(
    complexitySrcFull.includes("export function classifyUnitComplexity"),
    "should export classifyUnitComplexity",
  );
});

test("unit-classify: unit type tier mapping exists", () => {
  assert.ok(complexitySrcFull.includes("UNIT_TYPE_TIERS"), "should have unit type tier mapping");
  assert.ok(complexitySrcFull.includes('"complete-slice": "light"'), "complete-slice should be light");
  assert.ok(complexitySrcFull.includes('"replan-slice": "heavy"'), "replan-slice should be heavy");
});

test("unit-classify: hook units default to light", () => {
  assert.ok(
    complexitySrcFull.includes('startsWith("hook/")') && complexitySrcFull.includes('"light"'),
    "hook units should default to light tier",
  );
});

test("unit-classify: budget pressure has graduated thresholds", () => {
  assert.ok(complexitySrcFull.includes("budgetPct >= 0.9"), "should have 90% threshold");
  assert.ok(complexitySrcFull.includes("budgetPct >= 0.75"), "should have 75% threshold");
  assert.ok(complexitySrcFull.includes("budgetPct < 0.5"), "should skip below 50%");
});

test("unit-classify: escalateTier function exists", () => {
  assert.ok(
    complexitySrcFull.includes("export function escalateTier"),
    "should export escalateTier for failure recovery",
  );
});

test("unit-classify: tierLabel function exists", () => {
  assert.ok(
    complexitySrcFull.includes("export function tierLabel"),
    "should export tierLabel for dashboard display",
  );
});

test("unit-classify: ComplexityTier imported from types.ts", () => {
  assert.ok(
    complexitySrcFull.includes('from "./types.js"') && complexitySrcFull.includes("ComplexityTier"),
    "should import ComplexityTier from types",
  );
});
