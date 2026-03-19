/**
 * Tests for domain classification — file path pattern matching, split
 * analysis, and manual override.
 *
 * Validates:
 * - Known frontend patterns → "frontend"
 * - Known backend patterns → "backend"
 * - Known infra patterns → "infra"
 * - Known data patterns → "data"
 * - Known test patterns → "test"
 * - Unclassified default for ambiguous/unknown paths
 * - Mixed files with clear majority → majority domain
 * - Mixed files without majority → "unclassified"
 * - Empty input → "unclassified"
 * - Manual override updates domain + confidence
 * - analyzeDomainSplit integration via mocked dependencies
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/team-domain.test.ts
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Mutable state for mocks ────────────────────────────────────────────────
// Controls what the mocked files.ts and paths.ts return per slice.

let mockRoadmapContent: string | null = "mock-roadmap";
let mockRoadmapPath: string | null = "/base/milestones/M001/M001-ROADMAP.md";
let mockSlicePlans: Record<string, { filesLikelyTouched: string[] }> = {};
let mockSlicePaths: Record<string, string> = {};
let mockRoadmapSlices: Array<{ id: string; title: string; risk: string; depends: string[]; done: boolean; demo: string }> = [];

// ─── Module-level mocks (K005 — BEFORE dynamic import) ─────────────────────

mock.module("../paths.js", {
  namedExports: {
    resolveMilestoneFile: (_bp: string, _mid: string, type: string) => {
      if (type === "ROADMAP") return mockRoadmapPath;
      return null;
    },
    resolveSliceFile: (_bp: string, _mid: string, sid: string, _type: string) => {
      return mockSlicePaths[sid] ?? null;
    },
  },
});

mock.module("../files.js", {
  namedExports: {
    loadFile: async (path: string) => {
      if (path === mockRoadmapPath) return mockRoadmapContent;
      // For slice plans, look up by path
      for (const [sid, p] of Object.entries(mockSlicePaths)) {
        if (path === p) return `plan-content-${sid}`;
      }
      return null;
    },
    parseRoadmap: (_content: string) => ({
      title: "Test Milestone",
      vision: "",
      successCriteria: [],
      slices: mockRoadmapSlices,
      boundaryMap: [],
    }),
    parsePlan: (content: string) => {
      // content = "plan-content-S01" → extract "S01"
      const match = content.match(/plan-content-(.+)$/);
      const sid = match?.[1] ?? "";
      return mockSlicePlans[sid] ?? { filesLikelyTouched: [] };
    },
  },
});

// ─── Dynamic import after mock setup (K005 pattern) ─────────────────────────
const {
  classifyDomain,
  analyzeDomainSplit,
  applyDomainOverride,
  DOMAIN_PATTERNS,
} = await import("../team-domain.js");

type DomainLabel = import("../team-domain.js").DomainLabel;

// ─── Tests: classifyDomain() ─────────────────────────────────────────────────

describe("classifyDomain", () => {
  it("classifies known frontend patterns", () => {
    const files = [
      "src/components/App.tsx",
      "src/hooks/useAuth.ts",
      "src/pages/Home.tsx",
    ];
    assert.equal(classifyDomain(files), "frontend");
  });

  it("classifies known backend patterns", () => {
    const files = [
      "src/api/routes.ts",
      "src/db/schema.ts",
      "src/middleware/auth.ts",
    ];
    assert.equal(classifyDomain(files), "backend");
  });

  it("classifies known infra patterns", () => {
    const files = [
      "terraform/main.tf",
      ".github/workflows/ci.yml",
      "Dockerfile",
    ];
    assert.equal(classifyDomain(files), "infra");
  });

  it("classifies known data patterns", () => {
    const files = [
      "src/data/loader.ts",
      "src/analytics/tracker.ts",
      "src/etl/pipeline.ts",
    ];
    assert.equal(classifyDomain(files), "data");
  });

  it("classifies known test patterns", () => {
    const files = [
      "src/tests/unit.test.ts",
      "src/__tests__/integration.ts",
      "tests/fixtures/data.json",
    ];
    assert.equal(classifyDomain(files), "test");
  });

  it("returns unclassified for unknown patterns (no domain majority)", () => {
    const files = [
      "src/types/shared.ts",
      "src/utils/helpers.ts",
      "README.md",
    ];
    assert.equal(classifyDomain(files), "unclassified");
  });

  it("returns majority domain when clear majority exists", () => {
    // 2/3 files are frontend (.tsx matches), format.ts doesn't match
    const files = [
      "src/components/A.tsx",
      "src/components/B.tsx",
      "src/utils/format.ts",
    ];
    assert.equal(classifyDomain(files), "frontend");
  });

  it("returns unclassified when no single domain has majority", () => {
    const files = [
      "src/components/A.tsx",  // frontend
      "src/api/routes.ts",     // backend
      "src/infra/deploy.ts",   // infra
    ];
    assert.equal(classifyDomain(files), "unclassified");
  });

  it("returns unclassified for empty input", () => {
    assert.equal(classifyDomain([]), "unclassified");
  });

  it("returns unclassified for a single ambiguous file", () => {
    assert.equal(classifyDomain(["package.json"]), "unclassified");
  });

  it("handles .jsx files as frontend", () => {
    const files = [
      "src/components/Button.jsx",
      "src/views/Dashboard.jsx",
    ];
    assert.equal(classifyDomain(files), "frontend");
  });

  it("handles mixed classified/unclassified with majority in classified", () => {
    // 2 frontend + 1 unclassifiable = 2/2 classified are frontend → majority
    const files = [
      "src/components/A.tsx",
      "src/hooks/useX.ts",
      "package.json",
    ];
    assert.equal(classifyDomain(files), "frontend");
  });
});

// ─── Tests: DOMAIN_PATTERNS ──────────────────────────────────────────────────

describe("DOMAIN_PATTERNS", () => {
  it("has entries for all non-unclassified domains", () => {
    const expectedDomains: DomainLabel[] = ["frontend", "backend", "infra", "data", "test"];
    for (const d of expectedDomains) {
      assert.ok(DOMAIN_PATTERNS.has(d), `missing patterns for domain "${d}"`);
      const patterns = DOMAIN_PATTERNS.get(d)!;
      assert.ok(patterns.length > 0, `empty patterns for domain "${d}"`);
    }
  });

  it("does not include unclassified as a pattern key", () => {
    assert.equal(DOMAIN_PATTERNS.has("unclassified"), false);
  });
});

// ─── Tests: applyDomainOverride() ────────────────────────────────────────────

describe("applyDomainOverride", () => {
  it("overrides domain and sets confidence to 1.0", () => {
    const proposal = {
      slices: [
        { id: "S01", title: "Frontend Work", domain: "frontend" as DomainLabel, files: ["a.tsx"], confidence: 0.8 },
        { id: "S02", title: "Backend Work", domain: "backend" as DomainLabel, files: ["b.ts"], confidence: 0.9 },
      ],
      edges: [{ from: "S01", to: "S02" }],
      overrides: new Map<string, DomainLabel>(),
    };

    const result = applyDomainOverride(proposal, { S01: "infra" });
    assert.equal(result.slices[0].domain, "infra");
    assert.equal(result.slices[0].confidence, 1.0);
    // Non-overridden slice stays the same
    assert.equal(result.slices[1].domain, "backend");
    assert.equal(result.slices[1].confidence, 0.9);
    // Override recorded in the map
    assert.equal(result.overrides.get("S01"), "infra");
  });

  it("preserves edges through override", () => {
    const proposal = {
      slices: [
        { id: "S01", title: "A", domain: "frontend" as DomainLabel, files: [], confidence: 0.5 },
      ],
      edges: [{ from: "S01", to: "S02" }],
      overrides: new Map<string, DomainLabel>(),
    };
    const result = applyDomainOverride(proposal, { S01: "backend" });
    assert.deepEqual(result.edges, [{ from: "S01", to: "S02" }]);
  });

  it("merges with existing overrides", () => {
    const existing = new Map<string, DomainLabel>([["S01", "infra"]]);
    const proposal = {
      slices: [
        { id: "S01", title: "A", domain: "infra" as DomainLabel, files: [], confidence: 1.0 },
        { id: "S02", title: "B", domain: "backend" as DomainLabel, files: [], confidence: 0.7 },
      ],
      edges: [],
      overrides: existing,
    };
    const result = applyDomainOverride(proposal, { S02: "data" });
    assert.equal(result.overrides.get("S01"), "infra");  // preserved from existing
    assert.equal(result.overrides.get("S02"), "data");    // new override
  });
});

// ─── Tests: analyzeDomainSplit() ─────────────────────────────────────────────

describe("analyzeDomainSplit", () => {
  beforeEach(() => {
    // Reset mock state
    mockRoadmapContent = "mock-roadmap";
    mockRoadmapPath = "/base/milestones/M001/M001-ROADMAP.md";
    mockSlicePlans = {};
    mockSlicePaths = {};
    mockRoadmapSlices = [];
  });

  it("produces domain assignments from a mocked roadmap", async () => {
    mockRoadmapSlices = [
      { id: "S01", title: "UI Components", risk: "low", depends: [], done: false, demo: "" },
      { id: "S02", title: "API Layer", risk: "low", depends: ["S01"], done: false, demo: "" },
      { id: "S03", title: "Deploy Pipeline", risk: "medium", depends: ["S01", "S02"], done: false, demo: "" },
    ];
    mockSlicePaths = {
      S01: "/base/milestones/M001/slices/S01/S01-PLAN.md",
      S02: "/base/milestones/M001/slices/S02/S02-PLAN.md",
      S03: "/base/milestones/M001/slices/S03/S03-PLAN.md",
    };
    mockSlicePlans = {
      S01: { filesLikelyTouched: ["src/components/App.tsx", "src/hooks/useAuth.ts", "src/pages/Home.tsx"] },
      S02: { filesLikelyTouched: ["src/api/routes.ts", "src/db/schema.ts", "src/middleware/auth.ts"] },
      S03: { filesLikelyTouched: ["terraform/main.tf", ".github/workflows/ci.yml", "Dockerfile"] },
    };

    const result = await analyzeDomainSplit("/base", "M001");

    // 3 slices classified
    assert.equal(result.slices.length, 3);
    assert.equal(result.slices[0].domain, "frontend");
    assert.equal(result.slices[1].domain, "backend");
    assert.equal(result.slices[2].domain, "infra");

    // Confidence should be 1.0 for pure-domain slices
    assert.equal(result.slices[0].confidence, 1.0);
    assert.equal(result.slices[1].confidence, 1.0);
    assert.equal(result.slices[2].confidence, 1.0);

    // Titles preserved
    assert.equal(result.slices[0].title, "UI Components");
    assert.equal(result.slices[1].title, "API Layer");
    assert.equal(result.slices[2].title, "Deploy Pipeline");

    // Dependency edges: S01→S02, S01→S03, S02→S03
    assert.equal(result.edges.length, 3);
    assert.deepEqual(result.edges[0], { from: "S01", to: "S02" });
    assert.deepEqual(result.edges[1], { from: "S01", to: "S03" });
    assert.deepEqual(result.edges[2], { from: "S02", to: "S03" });

    // Empty overrides
    assert.equal(result.overrides.size, 0);
  });

  it("returns empty proposal when roadmap path is null", async () => {
    mockRoadmapPath = null;
    const result = await analyzeDomainSplit("/base", "M999");
    assert.equal(result.slices.length, 0);
    assert.equal(result.edges.length, 0);
  });

  it("returns empty proposal when roadmap content is null", async () => {
    mockRoadmapContent = null;
    const result = await analyzeDomainSplit("/base", "M001");
    assert.equal(result.slices.length, 0);
    assert.equal(result.edges.length, 0);
  });

  it("classifies slices with no plan files as unclassified", async () => {
    mockRoadmapSlices = [
      { id: "S01", title: "Mystery Work", risk: "low", depends: [], done: false, demo: "" },
    ];
    // No slice path or plan for S01
    mockSlicePaths = {};
    mockSlicePlans = {};

    const result = await analyzeDomainSplit("/base", "M001");
    assert.equal(result.slices.length, 1);
    assert.equal(result.slices[0].domain, "unclassified");
    assert.equal(result.slices[0].confidence, 0);
    assert.deepEqual(result.slices[0].files, []);
  });

  it("handles mixed-domain slices with partial confidence", async () => {
    mockRoadmapSlices = [
      { id: "S01", title: "Mixed Slice", risk: "low", depends: [], done: false, demo: "" },
    ];
    mockSlicePaths = { S01: "/base/milestones/M001/slices/S01/S01-PLAN.md" };
    // 2 frontend files + 1 ambiguous = frontend with <1.0 confidence
    mockSlicePlans = {
      S01: { filesLikelyTouched: ["src/components/A.tsx", "src/hooks/useX.ts", "package.json"] },
    };

    const result = await analyzeDomainSplit("/base", "M001");
    assert.equal(result.slices[0].domain, "frontend");
    // 2 frontend out of 3 total files = 2/3 ≈ 0.667
    assert.ok(result.slices[0].confidence > 0.6 && result.slices[0].confidence < 0.7,
      `expected confidence ~0.667, got ${result.slices[0].confidence}`);
  });
});
