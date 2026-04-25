// GSD-2 — #4782 phase 2 composer tests. Pure-function tests using mock
// resolvers plus an integration check that reassess-roadmap's migrated
// builder produces a prompt matching expectations.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  composeInlinedContext,
  composeUnitContext,
  manifestBudgetChars,
  type ArtifactResolver,
  type ExcerptResolver,
} from "../unit-context-composer.ts";
import type {
  ArtifactKey,
  BaseResolverContext,
  ComputedArtifactRegistry,
  UnitContextManifest,
} from "../unit-context-manifest.ts";
import { UNIT_MANIFESTS } from "../unit-context-manifest.ts";
import { buildReassessRoadmapPrompt } from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  upsertMilestonePlanning,
  insertSlice,
} from "../gsd-db.ts";

// ─── Pure composer tests ──────────────────────────────────────────────────

test("#4782 composer: returns empty string for unknown unit type", async () => {
  const out = await composeInlinedContext("never-dispatched", async () => "body");
  assert.strictEqual(out, "");
});

test("#4782 composer: walks the manifest's inline list in declared order", async () => {
  // reassess-roadmap manifest: [roadmap, slice-context, slice-summary, project, requirements, decisions]
  const calls: ArtifactKey[] = [];
  const resolver: ArtifactResolver = async (key) => {
    calls.push(key);
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  assert.deepEqual(calls, [
    "roadmap",
    "slice-context",
    "slice-summary",
    "project",
    "requirements",
    "decisions",
  ]);
  // Output joins blocks with the "---" separator.
  assert.match(out, /BODY:roadmap\n\n---\n\nBODY:slice-context/);
});

test("#4782 composer: null-returning resolvers are silently omitted", async () => {
  const resolver: ArtifactResolver = async (key) => {
    if (key === "slice-context" || key === "project") return null;
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  // slice-context + project skipped — not in output, no empty blocks
  assert.ok(!out.includes("BODY:slice-context"));
  assert.ok(!out.includes("BODY:project"));
  // Remaining keys still emitted in declared order
  assert.match(out, /BODY:roadmap\n\n---\n\nBODY:slice-summary\n\n---\n\nBODY:requirements\n\n---\n\nBODY:decisions/);
});

test("#4782 composer: empty-string resolvers are omitted (treated as no-op)", async () => {
  const resolver: ArtifactResolver = async (key) => {
    if (key === "slice-context") return "";
    if (key === "slice-summary") return null;
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  assert.ok(!out.includes("BODY:slice-context"));
  assert.ok(!out.includes("BODY:slice-summary"));
  // Must not leave double-separators when blocks are skipped
  assert.ok(!out.includes("---\n\n---"));
});

test("#4782 composer: resolver errors surface to caller", async () => {
  const resolver: ArtifactResolver = async () => {
    throw new Error("resolver boom");
  };
  await assert.rejects(
    () => composeInlinedContext("reassess-roadmap", resolver),
    /resolver boom/,
  );
});

test("#4782 composer: manifestBudgetChars returns declared budget", () => {
  const small = manifestBudgetChars("reassess-roadmap");
  assert.ok(small !== null && small > 0);
  assert.strictEqual(manifestBudgetChars("never-dispatched"), null);
});

// ─── Integration: migrated buildReassessRoadmapPrompt ─────────────────────

function makeFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-composer-pilot-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}

function seed(base: string, mid: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: mid, title: "Test", status: "active", depends_on: [] });
  upsertMilestonePlanning(mid, {
    title: "Test",
    status: "active",
    vision: "Ship it",
    successCriteria: ["It ships"],
    keyRisks: [],
    proofStrategy: [],
    verificationContract: "",
    verificationIntegration: "",
    verificationOperational: "",
    verificationUat: "",
    definitionOfDone: [],
    requirementCoverage: "",
    boundaryMapMarkdown: "",
  });
  insertSlice({
    id: "S01",
    milestoneId: mid,
    title: "First",
    status: "complete",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
}

function writeArtifacts(base: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n",
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
    "---\nid: S01\nparent: M001\n---\n# S01 Summary\n**One-liner**\n\n## What Happened\nDone.\n",
  );
}

test("#4782 phase 2: buildReassessRoadmapPrompt emits composer-shaped context with manifest-declared artifacts", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);

  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);

  // Context block wrapper from capPreamble
  assert.match(prompt, /## Inlined Context \(preloaded — do not re-read these files\)/);

  // Roadmap inlined first (manifest order)
  assert.match(prompt, /### Current Roadmap/);
  assert.match(prompt, /S01: First/);

  // Slice summary present
  assert.match(prompt, /### S01 Summary/);
  assert.match(prompt, /One-liner/);

  // Slice context is optional and not present in this fixture — must not
  // leave a stray empty section
  assert.ok(!prompt.includes("Slice Context (from discussion)"));
});

// ─── v2 surface (#4924) ───────────────────────────────────────────────────

const fakeBase: BaseResolverContext = {
  unitType: "reassess-roadmap",
  basePath: "/tmp/fake",
  milestoneId: "M001",
  sliceId: "S01",
};

test("#4924 v2 composer: returns empty sections for unknown unit type", async () => {
  const out = await composeUnitContext("never-dispatched", { base: fakeBase });
  assert.deepEqual(out, { prepend: "", inline: "" });
});

test("#4924 v2 composer: omitting resolveArtifact skips inline keys without erroring", async () => {
  const out = await composeUnitContext("reassess-roadmap", { base: fakeBase });
  assert.strictEqual(out.inline, "");
  assert.strictEqual(out.prepend, "");
});

test("#4924 v2 composer: walks inline + excerpt + computed sections in declared order", async () => {
  // Reuse the run-uat manifest shape (small inline, no excerpt/computed) and
  // synthesise a manifest-shape override via a temporary registration would
  // require touching production data. Instead, drive the composer through
  // the existing manifest plus mock resolvers and verify ordering against
  // the declared sequence.
  const calls: string[] = [];
  const resolveArtifact: ArtifactResolver = async (key) => {
    calls.push(`art:${key}`);
    return `BODY:${key}`;
  };
  const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" }, resolveArtifact });
  // run-uat manifest inline order: slice-uat, slice-summary, project
  assert.deepEqual(calls, ["art:slice-uat", "art:slice-summary", "art:project"]);
  assert.match(out.inline, /BODY:slice-uat\n\n---\n\nBODY:slice-summary\n\n---\n\nBODY:project/);
});

test("#4924 v2 composer: excerpt section calls resolveExcerpt for declared keys", async () => {
  // complete-milestone declares slice-summary as excerpt — perfect target.
  const inlineCalls: ArtifactKey[] = [];
  const excerptCalls: ArtifactKey[] = [];
  const resolveArtifact: ArtifactResolver = async (key) => {
    inlineCalls.push(key);
    return `INLINE:${key}`;
  };
  const resolveExcerpt: ExcerptResolver = async (key) => {
    excerptCalls.push(key);
    return `EXCERPT:${key}`;
  };
  const out = await composeUnitContext("complete-milestone", {
    base: { ...fakeBase, unitType: "complete-milestone" },
    resolveArtifact,
    resolveExcerpt,
  });
  assert.ok(excerptCalls.includes("slice-summary"));
  // Excerpt body appears in the composed inline section, after inline keys.
  assert.match(out.inline, /EXCERPT:slice-summary/);
  // The inline keys come first per the manifest order.
  const cmManifest = UNIT_MANIFESTS["complete-milestone"];
  const firstInlineKey = cmManifest.artifacts.inline[0]!;
  const firstInlineIdx = out.inline.indexOf(`INLINE:${firstInlineKey}`);
  const excerptIdx = out.inline.indexOf("EXCERPT:slice-summary");
  assert.ok(firstInlineIdx >= 0 && excerptIdx > firstInlineIdx, "inline body should precede excerpt body");
});

test("#4924 v2 composer: prepend block is separate from inline section", async () => {
  // No production manifest declares a prepend block yet (those land with
  // each batched migration). Drive the composer through a synthetic
  // manifest by patching UNIT_MANIFESTS just for this test.
  const original = UNIT_MANIFESTS["run-uat"];
  type Mutable<T> = { -readonly [P in keyof T]: T[P] };
  const patched: UnitContextManifest = {
    ...original,
    prepend: ["test-banner"] as never[], // computed id not in production registry — typed via cast for the test
  };
  (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = patched;
  try {
    const computed = {
      "test-banner": {
        build: async (_inputs: never, base: BaseResolverContext) => `BANNER for ${base.unitType}`,
        inputs: undefined as never,
      },
    } as unknown as ComputedArtifactRegistry;
    const out = await composeUnitContext("run-uat", {
      base: { ...fakeBase, unitType: "run-uat" },
      computed,
    });
    assert.strictEqual(out.prepend, "BANNER for run-uat");
    assert.strictEqual(out.inline, "");
  } finally {
    (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = original;
  }
});

test("#4924 v2 composer: missing computed registry entry is skipped silently", async () => {
  const original = UNIT_MANIFESTS["run-uat"];
  type Mutable<T> = { -readonly [P in keyof T]: T[P] };
  const patched: UnitContextManifest = {
    ...original,
    prepend: ["test-banner"] as never[],
  };
  (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = patched;
  try {
    // No `computed` registry supplied — declared id should be skipped, not throw.
    const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" } });
    assert.strictEqual(out.prepend, "");
  } finally {
    (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = original;
  }
});

test("#4924 v2 composer: computed builder returning null omits the section (no empty separator)", async () => {
  const original = UNIT_MANIFESTS["run-uat"];
  type Mutable<T> = { -readonly [P in keyof T]: T[P] };
  const patched: UnitContextManifest = {
    ...original,
    prepend: ["test-banner-a", "test-banner-b"] as never[],
  };
  (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = patched;
  try {
    const computed = {
      "test-banner-a": { build: async () => null, inputs: undefined as never },
      "test-banner-b": { build: async () => "B", inputs: undefined as never },
    } as unknown as ComputedArtifactRegistry;
    const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" }, computed });
    assert.strictEqual(out.prepend, "B");
    assert.ok(!out.prepend.includes("---"));
  } finally {
    (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = original;
  }
});

test("#4924 v2 composer: backward-compat — composeInlinedContext still works for v1 callers", async () => {
  const out = await composeInlinedContext("run-uat", async (key) => `BODY:${key}`);
  assert.match(out, /BODY:slice-uat\n\n---\n\nBODY:slice-summary\n\n---\n\nBODY:project/);
});

test("#4926 review: computed builders see normalized base.unitType matching the resolved manifest", async () => {
  // Caller passes one unitType to composeUnitContext but a different (stale)
  // value in opts.base. Composer must normalize so builders observe the
  // unitType the manifest was resolved against — preventing manifests and
  // computed context from drifting.
  const original = UNIT_MANIFESTS["run-uat"];
  type Mutable<T> = { -readonly [P in keyof T]: T[P] };
  const patched: UnitContextManifest = {
    ...original,
    prepend: ["test-banner"] as never[],
  };
  (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = patched;
  try {
    let observedUnitType: string | undefined;
    const computed = {
      "test-banner": {
        build: async (_inputs: never, base: BaseResolverContext) => {
          observedUnitType = base.unitType;
          return `BANNER for ${base.unitType}`;
        },
        inputs: undefined as never,
      },
    } as unknown as ComputedArtifactRegistry;
    const out = await composeUnitContext("run-uat", {
      // Deliberately mismatched: function arg "run-uat" vs. base.unitType "stale-other-unit".
      base: { ...fakeBase, unitType: "stale-other-unit" },
      computed,
    });
    assert.strictEqual(observedUnitType, "run-uat", "builder must see the unitType the manifest was resolved against");
    assert.strictEqual(out.prepend, "BANNER for run-uat");
  } finally {
    (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = original;
  }
});
