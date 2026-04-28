// GSD-2 — Phase 11 artifact validator tests.
// Verifies validateArtifact() correctly accepts valid PROJECT.md / REQUIREMENTS.md /
// ROADMAP.md fixtures and flags specific malformations with the expected error codes.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { validateArtifact } from "../schemas/validate.ts";
import type { ValidationError } from "../schemas/validate.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "__fixtures__");

function tempBase(): string {
  const base = join(tmpdir(), `gsd-validator-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  return base;
}

function hasErrorCode(errors: ValidationError[], code: string): boolean {
  return errors.some(e => e.code === code);
}

function writeArtifact(base: string, name: string, content: string): string {
  const p = join(base, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ─── PROJECT.md ─────────────────────────────────────────────────────────

test("Phase 11 validator: valid PROJECT.md fixture passes", (t) => {
  const result = validateArtifact(join(FIXTURES_DIR, "valid-project.md"), "project");
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});

test("Phase 11 validator: PROJECT.md missing 'What This Is' fails", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "PROJECT.md", `# Project

## Core Value

Something.

## Current State

Stuff.

## Architecture / Key Patterns

Patterns.

## Capability Contract

See .gsd/REQUIREMENTS.md.

## Milestone Sequence

- [ ] M001: Test — one
`);

  const result = validateArtifact(path, "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "missing-section"), "must flag missing section");
});

test("Phase 11 validator: PROJECT.md with template tokens fails", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "PROJECT.md", `# Project

## What This Is

{{whatTheProjectDoes}}

## Core Value

The thing.

## Current State

Now.

## Architecture / Key Patterns

Patterns.

## Capability Contract

See .gsd/REQUIREMENTS.md.

## Milestone Sequence

- [ ] M001: Test — one
`);

  const result = validateArtifact(path, "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "template-token"), "must flag unsubstituted template tokens");
});

test("Phase 11 validator: PROJECT.md with no milestones fails", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "PROJECT.md", `# Project

## What This Is

A test.

## Core Value

The thing.

## Current State

Now.

## Architecture / Key Patterns

Patterns.

## Capability Contract

See .gsd/REQUIREMENTS.md.

## Milestone Sequence

(no milestones yet)
`);

  const result = validateArtifact(path, "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "no-milestones"), "must flag empty milestone sequence");
});

test("Phase 11 validator: PROJECT.md with duplicate milestone IDs fails", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "PROJECT.md", `# Project

## What This Is

A test.

## Core Value

The thing.

## Current State

Now.

## Architecture / Key Patterns

Patterns.

## Capability Contract

See .gsd/REQUIREMENTS.md.

## Milestone Sequence

- [ ] M001: First — one
- [ ] M001: Duplicate — two
`);

  const result = validateArtifact(path, "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "duplicate-milestone"), "must flag duplicate milestone IDs");
});

test("Phase 11 validator: missing PROJECT.md file returns file-missing error", () => {
  const result = validateArtifact("/nonexistent/path/PROJECT.md", "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "file-missing"));
});

// ─── REQUIREMENTS.md ────────────────────────────────────────────────────

test("Phase 11 validator: valid REQUIREMENTS.md fixture passes", () => {
  const result = validateArtifact(join(FIXTURES_DIR, "valid-requirements.md"), "requirements");
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});

test("Phase 11 validator: REQUIREMENTS.md missing required section fails", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "REQUIREMENTS.md", `# Requirements

## Active

## Validated

## Deferred

## Out of Scope

## Coverage Summary
`);
  // missing ## Traceability

  const result = validateArtifact(path, "requirements");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "missing-section"));
});

test("Phase 11 validator: requirement under wrong section fails (status-section mismatch)", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "REQUIREMENTS.md", `# Requirements

## Active

### R001 — Mismatched
- Class: core-capability
- Status: deferred
- Description: should not be in Active
- Why it matters: status mismatch
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes:

## Validated

## Deferred

## Out of Scope

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|

## Coverage Summary

- Active requirements: 0
`);

  const result = validateArtifact(path, "requirements");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "status-section-mismatch"));
});

test("Phase 11 validator: requirement with invalid class fails", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "REQUIREMENTS.md", `# Requirements

## Active

### R001 — Bad class
- Class: imaginary-class
- Status: active
- Description: nope
- Why it matters: schema check
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes:

## Validated

## Deferred

## Out of Scope

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|

## Coverage Summary

- Active requirements: 1
`);

  const result = validateArtifact(path, "requirements");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "invalid-class"));
});

test("Phase 11 validator: REQUIREMENTS.md with dangling owner flagged when PROJECT.md provided", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const projectPath = writeArtifact(base, "PROJECT.md", `# Project

## What This Is
Test.

## Core Value
Thing.

## Current State
Now.

## Architecture / Key Patterns
Patterns.

## Capability Contract
See .gsd/REQUIREMENTS.md.

## Milestone Sequence

- [ ] M001: Real — present
`);

  const reqPath = writeArtifact(base, "REQUIREMENTS.md", `# Requirements

## Active

### R001 — Owner points to ghost milestone
- Class: core-capability
- Status: active
- Description: M999 doesn't exist in PROJECT.md
- Why it matters: cross-ref check
- Source: user
- Primary owning slice: M999/S01
- Supporting slices: none
- Validation: unmapped
- Notes:

## Validated

## Deferred

## Out of Scope

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|

## Coverage Summary

- Active requirements: 1
`);

  const result = validateArtifact(reqPath, "requirements", { crossRefs: { projectPath } });
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "dangling-owner"));
});

// ─── ROADMAP.md ─────────────────────────────────────────────────────────

test("Phase 11 validator: valid ROADMAP.md fixture passes (without cross-refs)", () => {
  const result = validateArtifact(join(FIXTURES_DIR, "valid-roadmap.md"), "roadmap");
  // May have orphan-slice warnings (no requirements provided) but no errors
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});

test("Phase 11 validator: ROADMAP.md with circular dependencies fails", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "ROADMAP.md", `# Roadmap

## Slices

### S01 — Cycle A
- Risk: low
- Depends: S02
- Demo: cycle test

### S02 — Cycle B
- Risk: low
- Depends: S01
- Demo: cycle test

## Definition of Done

- detect cycles
`);

  const result = validateArtifact(path, "roadmap");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "circular-dependency"));
});

test("Phase 11 validator: ROADMAP.md with dangling dependency fails", (t) => {
  const base = tempBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const path = writeArtifact(base, "ROADMAP.md", `# Roadmap

## Slices

### S01 — Real slice
- Risk: low
- Depends: S99
- Demo: dangling test

## Definition of Done

- detect dangling deps
`);

  const result = validateArtifact(path, "roadmap");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "dangling-dependency"));
});
