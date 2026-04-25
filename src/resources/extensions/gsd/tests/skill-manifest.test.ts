// GSD2 + skill-manifest.test — unit coverage for the skill manifest resolver
//
// Focused tests for `resolveSkillManifest` and `filterSkillsByManifest`.
// Covers the wildcard semantics, the newly seeded unit-type entries
// (complete-milestone, validate-milestone, reassess-roadmap, research-slice,
// plan-slice, refine-slice, replan-slice, run-uat), and the deliberate
// wildcard fallback for the execute-task hot path (RFC #4779).

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSkillManifest,
  filterSkillsByManifest,
} from "../skill-manifest.js";

const NEWLY_WIRED_UNIT_TYPES = [
  "complete-milestone",
  "validate-milestone",
  "reassess-roadmap",
  "research-slice",
  "plan-slice",
  "refine-slice",
  "replan-slice",
  "run-uat",
] as const;

test("resolveSkillManifest returns null for undefined unit type (wildcard)", () => {
  assert.equal(resolveSkillManifest(undefined), null);
});

test("resolveSkillManifest returns null for unknown unit types (wildcard fallback)", () => {
  assert.equal(resolveSkillManifest("nonexistent-unit-type"), null);
});

test("resolveSkillManifest returns null for execute-task (intentional wildcard)", () => {
  // execute-task is the implementation hot path; allowlisting it requires
  // per-task skill hints from task-plan frontmatter. Documented in
  // skill-manifest.ts — regression guard.
  assert.equal(resolveSkillManifest("execute-task"), null);
});

for (const unitType of NEWLY_WIRED_UNIT_TYPES) {
  test(`resolveSkillManifest returns a non-empty allowlist for '${unitType}'`, () => {
    const allowlist = resolveSkillManifest(unitType);
    assert.ok(allowlist !== null, `${unitType} should resolve to an allowlist, not wildcard`);
    assert.ok(allowlist.length > 0, `${unitType} allowlist should not be empty`);
    // Every entry must be lowercase (normalized).
    for (const name of allowlist) {
      assert.equal(name, name.toLowerCase(), `${unitType} entry '${name}' should be lowercase`);
    }
  });
}

test("resolveSkillManifest: slice-level manifests include decompose-into-slices", () => {
  // Planning-shaped slice flows all benefit from the decomposition skill.
  // Sanity-check a representative entry from each.
  for (const unitType of ["research-slice", "plan-slice", "refine-slice", "replan-slice"] as const) {
    const allowlist = resolveSkillManifest(unitType);
    assert.ok(
      allowlist?.includes("decompose-into-slices"),
      `${unitType} should list decompose-into-slices`,
    );
  }
});

test("resolveSkillManifest: validation / completion flows include verify-before-complete", () => {
  for (const unitType of ["complete-milestone", "validate-milestone", "run-uat"] as const) {
    const allowlist = resolveSkillManifest(unitType);
    assert.ok(
      allowlist?.includes("verify-before-complete"),
      `${unitType} should list verify-before-complete`,
    );
  }
});

test("filterSkillsByManifest: pass-through when unit type is unknown", () => {
  const skills = [{ name: "swiftui" }, { name: "solidity-security" }];
  const result = filterSkillsByManifest(skills, "nonexistent-unit-type");
  assert.deepEqual(result, skills);
});

test("filterSkillsByManifest: pass-through when unitType is undefined", () => {
  const skills = [{ name: "swiftui" }];
  const result = filterSkillsByManifest(skills, undefined);
  assert.deepEqual(result, skills);
});

test("filterSkillsByManifest: restricts to allowlisted names for known unit type", () => {
  // research-slice allowlists include decompose-into-slices but not swiftui.
  const skills = [
    { name: "decompose-into-slices" },
    { name: "swiftui" },
    { name: "write-docs" },
  ];
  const result = filterSkillsByManifest(skills, "research-slice");
  const names = result.map(s => s.name);
  assert.ok(names.includes("decompose-into-slices"));
  assert.ok(names.includes("write-docs"));
  assert.ok(!names.includes("swiftui"));
});

test("filterSkillsByManifest: matching is case-insensitive via normalize", () => {
  const skills = [
    { name: "Write-Docs" }, // different case from manifest entry
    { name: "SWIFTUI" },
  ];
  const result = filterSkillsByManifest(skills, "research-milestone");
  const names = result.map(s => s.name);
  assert.ok(names.includes("Write-Docs"));
  assert.ok(!names.includes("SWIFTUI"));
});
