/**
 * auto-session-encapsulation.test.ts — Guards the AutoSession encapsulation invariant.
 *
 * All mutable auto-mode state must live in AutoSession (auto/session.ts).
 * auto.ts must not declare module-level `let` or `var` variables.
 *
 * These tests parse auto.ts source to detect violations, so they fail at
 * test time — before a PR merges — when someone accidentally adds mutable
 * module-level state to auto.ts instead of AutoSession.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_TS_PATH = join(__dirname, "..", "auto.ts");
const SESSION_TS_PATH = join(__dirname, "..", "auto", "session.ts");

function getAutoTsSource(): string {
  return readFileSync(AUTO_TS_PATH, "utf-8");
}

function getSessionTsSource(): string {
  return readFileSync(SESSION_TS_PATH, "utf-8");
}

// ── Invariant 1: No module-level mutable variables in auto.ts ────────────────

test("auto.ts has no module-level let declarations", () => {
  const source = getAutoTsSource();
  const lines = source.split("\n");
  const violations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Match lines starting with `let ` or `export let ` (module-level)
    // Skip lines inside functions/blocks (indented)
    if (/^(export\s+)?let\s+/.test(line)) {
      violations.push(`line ${i + 1}: ${line.trim()}`);
    }
  }

  assert.equal(
    violations.length,
    0,
    `auto.ts must not have module-level \`let\` declarations. ` +
    `All mutable state belongs in AutoSession (auto/session.ts).\n` +
    `Violations:\n${violations.join("\n")}`,
  );
});

test("auto.ts has no module-level var declarations", () => {
  const source = getAutoTsSource();
  const lines = source.split("\n");
  const violations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(export\s+)?var\s+/.test(line)) {
      violations.push(`line ${i + 1}: ${line.trim()}`);
    }
  }

  assert.equal(
    violations.length,
    0,
    `auto.ts must not have module-level \`var\` declarations. ` +
    `All mutable state belongs in AutoSession (auto/session.ts).\n` +
    `Violations:\n${violations.join("\n")}`,
  );
});

// ── Invariant 2: AutoSession singleton is the only mutable module-level binding ──

test("auto.ts has exactly one module-level const for AutoSession", () => {
  const source = getAutoTsSource();
  const lines = source.split("\n");

  const sessionConsts = lines.filter(line =>
    /^const\s+\w+\s*=\s*new\s+AutoSession/.test(line),
  );

  assert.equal(
    sessionConsts.length,
    1,
    `auto.ts should have exactly one \`const s = new AutoSession()\`. ` +
    `Found ${sessionConsts.length}: ${sessionConsts.join(", ")}`,
  );
});

// ── Invariant 3: AutoSession.reset() covers all instance properties ──────────

test("AutoSession.reset() references every instance property", () => {
  const source = getSessionTsSource();

  // Extract property names from class body (lines like `  propName = ...` or `  propName:`)
  // Skip readonly collections (Maps/Sets) that use .clear() instead of reassignment
  const propertyPattern = /^\s+(readonly\s+)?(\w+)\s*[:=]/;
  const properties: string[] = [];
  let inClass = false;
  let inMethod = false;
  let braceDepth = 0;

  for (const line of source.split("\n")) {
    if (/^export class AutoSession/.test(line)) {
      inClass = true;
      braceDepth = 0;
      continue;
    }
    if (!inClass) continue;

    // Track brace depth to distinguish properties from method bodies
    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }

    // Class-level properties are at brace depth 1 (inside the class, outside methods)
    if (braceDepth === 1 && !inMethod) {
      const match = line.match(propertyPattern);
      if (match && match[2]) {
        const propName = match[2];
        // Skip method-like names and type-only declarations
        if (!["constructor", "clearTimers", "resetDispatchCounters", "lockBasePath",
               "completeCurrentUnit", "reset", "toJSON"].includes(propName)) {
          properties.push(propName);
        }
      }
    }

    // Detect method start/end
    if (braceDepth === 1 && /^\s+(get |async )?(\w+)\s*\(/.test(line)) {
      inMethod = true;
    }
    if (braceDepth === 1 && inMethod) {
      inMethod = false;
    }
  }

  // Extract the reset() method body
  const resetMatch = source.match(/reset\(\): void \{([\s\S]*?)^\s{2}\}/m);
  assert.ok(resetMatch, "AutoSession.reset() method not found");
  const resetBody = resetMatch![1]!;

  const intentionallySkipped = new Set<string>([]);

  const missingFromReset: string[] = [];
  for (const prop of properties) {
    if (intentionallySkipped.has(prop)) continue;
    // Check if the property name appears in reset body (as `this.prop` assignment or `.clear()`)
    if (!resetBody.includes(`this.${prop}`)) {
      missingFromReset.push(prop);
    }
  }

  assert.equal(
    missingFromReset.length,
    0,
    `AutoSession.reset() must reference every instance property. ` +
    `Missing: ${missingFromReset.join(", ")}. ` +
    `If a property should persist across resets, add it to the intentionallySkipped set in this test.`,
  );
});

// ── Invariant 4: AutoSession.toJSON() provides diagnostic visibility ─────────

test("AutoSession.toJSON() includes key diagnostic properties", () => {
  const source = getSessionTsSource();

  const toJSONMatch = source.match(/toJSON\(\)[\s\S]*?return \{([\s\S]*?)\};/);
  assert.ok(toJSONMatch, "AutoSession.toJSON() method not found");
  const toJSONBody = toJSONMatch![1]!;

  // These are the minimum properties needed for diagnostic snapshots
  const requiredDiagnostics = [
    "active",
    "paused",
    "basePath",
    "currentMilestoneId",
    "currentUnit",
  ];

  const missing = requiredDiagnostics.filter(prop => !toJSONBody.includes(prop));

  assert.equal(
    missing.length,
    0,
    `AutoSession.toJSON() must include diagnostic properties: ${missing.join(", ")}`,
  );
});

// ── Invariant 5: No state-bearing module-level consts that should be in AutoSession ──

test("auto.ts module-level consts are only AutoSession instance, true constants, or static accessors", () => {
  const source = getAutoTsSource();
  const lines = source.split("\n");
  const violations: string[] = [];

  // Patterns that are acceptable at module level
  const allowedPatterns = [
    /^const s = new AutoSession/,                 // The session singleton
    /^const [A-Z_]+\s*=/,                          // UPPER_CASE constants
    /^const \w+StateAccessors/,                    // Static accessor objects
    /^const \w+:\s*\w+\s*=/,                       // Typed constants
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^(export\s+)?const\s+/.test(line)) continue;

    const isAllowed = allowedPatterns.some(p => p.test(line.replace(/^export\s+/, "")));
    if (!isAllowed) {
      // Check if it looks like mutable state (arrays, objects with mutable semantics)
      if (/= new (Map|Set|Array)\(/.test(line) || /= \[\]/.test(line)) {
        violations.push(`line ${i + 1}: ${line.trim()}`);
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `auto.ts has module-level const declarations that look like mutable state. ` +
    `Move these into AutoSession:\n${violations.join("\n")}`,
  );
});

// ── Invariant 6: session.ts file exists and exports AutoSession ──────────────

test("auto/session.ts exports AutoSession class", () => {
  const source = getSessionTsSource();
  assert.ok(
    /export class AutoSession/.test(source),
    "auto/session.ts must export the AutoSession class",
  );
});

test("AutoSession has a reset() method", () => {
  const source = getSessionTsSource();
  assert.ok(
    /reset\(\): void/.test(source),
    "AutoSession must have a reset(): void method",
  );
});

test("AutoSession has a toJSON() method", () => {
  const source = getSessionTsSource();
  assert.ok(
    /toJSON\(\)/.test(source),
    "AutoSession must have a toJSON() method for diagnostics",
  );
});
