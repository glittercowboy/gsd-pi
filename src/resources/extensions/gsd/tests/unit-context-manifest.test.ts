// GSD-2 — #4782 phase 1: schema tests + CI coverage guard for manifests.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_KEYS,
  KNOWN_UNIT_TYPES,
  UNIT_MANIFESTS,
  resolveManifest,
  type ArtifactKey,
  type SkillsPolicy,
  type UnitContextManifest,
} from "../unit-context-manifest.ts";

// ─── Coverage: every known unit type has a manifest ──────────────────────

test("#4782 phase 1: every KNOWN_UNIT_TYPES entry has a UNIT_MANIFESTS entry", () => {
  for (const unitType of KNOWN_UNIT_TYPES) {
    assert.ok(
      UNIT_MANIFESTS[unitType],
      `unit type "${unitType}" is declared in KNOWN_UNIT_TYPES but has no manifest`,
    );
  }
});

test("#4782 phase 1: every UNIT_MANIFESTS entry corresponds to a known unit type", () => {
  const known = new Set<string>(KNOWN_UNIT_TYPES as readonly string[]);
  for (const unitType of Object.keys(UNIT_MANIFESTS)) {
    assert.ok(
      known.has(unitType),
      `manifest entry "${unitType}" is not in KNOWN_UNIT_TYPES — add it there or remove the manifest`,
    );
  }
});

// ─── Coverage: every unitType stringly-typed in auto-dispatch.ts is known ─

test("#4782 phase 1: every unitType string in auto-dispatch.ts has a manifest", () => {
  // Source-only coverage check — read the dispatcher and enumerate its
  // unitType literals. This is a CI guard against manifest drift: if a
  // new dispatch rule is added without a corresponding manifest entry,
  // this test fails loudly. Read-only check of source text; the cheapest
  // way to enumerate declared unit types without running the dispatcher.
  // allow-source-grep: enumerate unitType literals for CI coverage guard
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dispatchSrc = readFileSync(join(__dirname, "..", "auto-dispatch.ts"), "utf-8");
  const matches = Array.from(dispatchSrc.matchAll(/unitType:\s*"([^"]+)"/g));
  const seen = new Set<string>();
  for (const m of matches) {
    const t = m[1];
    if (!t) continue;
    seen.add(t);
  }
  const missing: string[] = [];
  for (const t of seen) {
    if (!UNIT_MANIFESTS[t as keyof typeof UNIT_MANIFESTS]) {
      missing.push(t);
    }
  }
  assert.deepEqual(missing, [], `unit types dispatched in auto-dispatch.ts but missing from UNIT_MANIFESTS: ${missing.join(", ")}`);
});

// ─── Shape: every manifest conforms to the schema invariants ──────────────

test("#4782 phase 1: every manifest's artifacts reference known ArtifactKey values", () => {
  const validKeys = new Set<string>(ARTIFACT_KEYS as readonly string[]);
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const all: ArtifactKey[] = [
      ...manifest.artifacts.inline,
      ...manifest.artifacts.excerpt,
      ...manifest.artifacts.onDemand,
    ];
    for (const key of all) {
      assert.ok(
        validKeys.has(key),
        `manifest "${unitType}" references unknown artifact key "${key}"`,
      );
    }
  }
});

test("#4782 phase 1: no manifest has the same artifact key in inline AND excerpt (mutually exclusive)", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const inline = new Set<string>(manifest.artifacts.inline as readonly string[]);
    const clashes = (manifest.artifacts.excerpt as readonly string[]).filter(k => inline.has(k));
    assert.deepEqual(
      clashes,
      [],
      `manifest "${unitType}" has overlapping inline+excerpt artifact keys: ${clashes.join(", ")}. Pick one.`,
    );
  }
});

test("#4782 phase 1: every manifest has a positive maxSystemPromptChars", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    assert.ok(
      typeof manifest.maxSystemPromptChars === "number" && manifest.maxSystemPromptChars > 0,
      `manifest "${unitType}" has invalid maxSystemPromptChars: ${manifest.maxSystemPromptChars}`,
    );
  }
});

test("#4782 phase 1: skills policy shapes are valid discriminated-union members", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const p = manifest.skills as SkillsPolicy;
    switch (p.mode) {
      case "none":
      case "all":
        break;
      case "allowlist":
        assert.ok(
          Array.isArray(p.skills) && p.skills.every(s => typeof s === "string"),
          `manifest "${unitType}" has allowlist policy with invalid skills[]`,
        );
        break;
      default: {
        const _exhaustive: never = p;
        void _exhaustive;
        assert.fail(`manifest "${unitType}" has unrecognized skills.mode`);
      }
    }
  }
});

// ─── Lookup helper ────────────────────────────────────────────────────────

test("#4782 phase 1: resolveManifest returns null for an unknown unit type", () => {
  assert.strictEqual(resolveManifest("never-dispatched-unit-type"), null);
});

test("#4782 phase 1: resolveManifest returns a manifest for every known unit type", () => {
  for (const unitType of KNOWN_UNIT_TYPES) {
    const m = resolveManifest(unitType);
    assert.ok(m, `resolveManifest("${unitType}") should return a manifest`);
    // Identity check — the helper should return the exact object, not a copy.
    assert.strictEqual(m, UNIT_MANIFESTS[unitType]);
  }
});

// ─── Phase-2 target: complete-milestone manifest reflects #4780's excerpt shape ─

test("#4782 phase 1: complete-milestone manifest declares slice-summary as excerpt (matches #4780)", () => {
  const m = UNIT_MANIFESTS["complete-milestone"];
  assert.ok(
    m.artifacts.excerpt.includes("slice-summary"),
    "complete-milestone should declare slice-summary as excerpt (alignment with #4780)",
  );
  assert.ok(
    !m.artifacts.inline.includes("slice-summary"),
    "complete-milestone should NOT declare slice-summary as inline — that was the #4780 bloat",
  );
});

// ─── Phase-2 target: reassess-roadmap manifest is the tightest budget ────

test("#4782 phase 1: reassess-roadmap manifest has the smallest budget among manifests", () => {
  const m = UNIT_MANIFESTS["reassess-roadmap"];
  for (const [unitType, other] of Object.entries(UNIT_MANIFESTS)) {
    if (unitType === "reassess-roadmap") continue;
    assert.ok(
      m.maxSystemPromptChars <= other.maxSystemPromptChars,
      `reassess-roadmap budget (${m.maxSystemPromptChars}) should be ≤ ${unitType} budget (${other.maxSystemPromptChars})`,
    );
  }
});
