/**
 * Slice parser tests — GSD 2 data layer.
 *
 * Phase 14-01: Tests for parseRoadmap, parsePlan, parseUat, and extended buildFullState.
 * These tests are RED until state-deriver.ts exports the new parsers and types.ts
 * replaces stubs with real GSD2RoadmapState/GSD2SlicePlan/GSD2UatFile types.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRoadmap, parsePlan, parseUat, buildFullState } from "../src/server/state-deriver";

let tempDir: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "slice-parsers-test-"));
}

afterEach(() => {
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// -- Fixtures --

const REALISTIC_ROADMAP_MD = `---
milestone_id: M001
milestone_name: Native Desktop
---

# M001 — Native Desktop

## Slices

## S01 — File Watcher Wiring [COMPLETE]

**Branch:** gsd/M001/S01
**Tasks:** 4 tasks
**Cost estimate:** ~$0.40

### Dependencies

None.

## S02 — WebSocket Server [IN PROGRESS]

**Branch:** gsd/M001/S02
**Tasks:** 5 tasks
**Cost estimate:** ~$1.20

### Dependencies

Depends on: S01 File Watcher Wiring

## S03 — Dashboard UI [PLANNED]

**Branch:** gsd/M001/S03
**Tasks:** 3 tasks
**Cost estimate:** ~$0.80

### Dependencies

Depends on: S01 File Watcher Wiring
Depends on: S02 WebSocket Server
`;

const REALISTIC_PLAN_MD = `---
slice_id: S01
cost_estimate: ~$0.40
---

# S01 Plan — File Watcher Wiring

## Tasks

- T01: Set up Bun file watcher [complete]
- T02: Implement debounce logic [complete]
- T03: Emit change events [pending]
- T04: Write integration tests [pending]

## Must-Haves

- Watcher must not re-emit duplicate events within debounce window
- Must handle file deletion without throwing
`;

const REALISTIC_UAT_MD = `# S01 UAT Checklist

- [x] UAT-01: File changes trigger watcher events within 200ms
- [ ] UAT-02: Debounce prevents duplicate events on rapid saves
- [x] UAT-03: Watcher survives file deletion without error
- [ ] UAT-04: Multiple simultaneous file changes batch into single event
`;

// -- parseRoadmap tests --

describe("parseRoadmap", () => {
  test("returns GSD2RoadmapState with slices array from realistic roadmap markdown", () => {
    const result = parseRoadmap(REALISTIC_ROADMAP_MD);

    expect(result).toBeDefined();
    expect(result.milestoneId).toBe("M001");
    expect(result.milestoneName).toBe("Native Desktop");
    expect(Array.isArray(result.slices)).toBe(true);
    expect(result.slices.length).toBe(3);
  });

  test("parses S01 slice with correct id, name, status=complete", () => {
    const result = parseRoadmap(REALISTIC_ROADMAP_MD);
    const s01 = result.slices.find((s) => s.id === "S01");

    expect(s01).toBeDefined();
    expect(s01!.name).toBe("File Watcher Wiring");
    expect(s01!.status).toBe("complete");
    expect(s01!.taskCount).toBe(4);
    expect(s01!.costEstimate).toBeCloseTo(0.40);
    expect(s01!.branch).toBe("gsd/M001/S01");
  });

  test("parses S02 slice with status=in_progress and dependency on S01", () => {
    const result = parseRoadmap(REALISTIC_ROADMAP_MD);
    const s02 = result.slices.find((s) => s.id === "S02");

    expect(s02).toBeDefined();
    expect(s02!.status).toBe("in_progress");
    expect(s02!.dependencies.length).toBeGreaterThan(0);
    const dep = s02!.dependencies.find((d) => d.id === "S01");
    expect(dep).toBeDefined();
  });

  test("parses S03 slice with status=planned and two dependencies", () => {
    const result = parseRoadmap(REALISTIC_ROADMAP_MD);
    const s03 = result.slices.find((s) => s.id === "S03");

    expect(s03).toBeDefined();
    expect(s03!.status).toBe("planned");
    expect(s03!.dependencies.length).toBe(2);
  });

  test("returns empty slices array on empty string — does not throw", () => {
    const result = parseRoadmap("");

    expect(result).toBeDefined();
    expect(Array.isArray(result.slices)).toBe(true);
    expect(result.slices.length).toBe(0);
  });

  test("returns empty slices array on malformed input — does not throw", () => {
    const result = parseRoadmap("just some random text without any headings");

    expect(result).toBeDefined();
    expect(Array.isArray(result.slices)).toBe(true);
    expect(result.slices.length).toBe(0);
  });

  test("result does not have a raw field (real parsed type, not stub)", () => {
    const result = parseRoadmap(REALISTIC_ROADMAP_MD);
    // The stub type had { raw: string }; the real type should NOT have this field
    expect((result as Record<string, unknown>).raw).toBeUndefined();
  });
});

// -- parsePlan tests --

describe("parsePlan", () => {
  test("returns GSD2SlicePlan with tasks array from realistic plan markdown", () => {
    const result = parsePlan(REALISTIC_PLAN_MD, "S01");

    expect(result).toBeDefined();
    expect(result.sliceId).toBe("S01");
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks.length).toBe(4);
  });

  test("parses task T01 with id=T01, name, status=complete", () => {
    const result = parsePlan(REALISTIC_PLAN_MD, "S01");
    const t01 = result.tasks.find((t) => t.id === "T01");

    expect(t01).toBeDefined();
    expect(t01!.name).toBe("Set up Bun file watcher");
    expect(t01!.status).toBe("complete");
  });

  test("parses task T03 with status=pending", () => {
    const result = parsePlan(REALISTIC_PLAN_MD, "S01");
    const t03 = result.tasks.find((t) => t.id === "T03");

    expect(t03).toBeDefined();
    expect(t03!.status).toBe("pending");
  });

  test("parses cost estimate from frontmatter", () => {
    const result = parsePlan(REALISTIC_PLAN_MD, "S01");

    expect(result.costEstimate).toBeCloseTo(0.40);
  });

  test("parses mustHaves from ## Must-Haves block", () => {
    const result = parsePlan(REALISTIC_PLAN_MD, "S01");

    expect(Array.isArray(result.mustHaves)).toBe(true);
    expect(result.mustHaves.length).toBeGreaterThan(0);
    expect(result.mustHaves.some((mh) => mh.includes("debounce"))).toBe(true);
  });

  test("returns empty tasks array on empty string — does not throw", () => {
    const result = parsePlan("", "S01");

    expect(result).toBeDefined();
    expect(result.sliceId).toBe("S01");
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks.length).toBe(0);
    expect(result.costEstimate).toBeNull();
  });

  test("result does not have a raw field (real parsed type, not stub)", () => {
    const result = parsePlan(REALISTIC_PLAN_MD, "S01");
    expect((result as Record<string, unknown>).raw).toBeUndefined();
  });
});

// -- parseUat tests --

describe("parseUat", () => {
  test("returns GSD2UatFile with items array from realistic UAT markdown", () => {
    const result = parseUat(REALISTIC_UAT_MD, "S01");

    expect(result).toBeDefined();
    expect(result.sliceId).toBe("S01");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(4);
  });

  test("parses UAT-01 as checked=true (- [x] syntax)", () => {
    const result = parseUat(REALISTIC_UAT_MD, "S01");
    const uat01 = result.items.find((i) => i.id === "UAT-01");

    expect(uat01).toBeDefined();
    expect(uat01!.checked).toBe(true);
    expect(uat01!.text).toContain("File changes trigger watcher");
  });

  test("parses UAT-02 as checked=false (- [ ] syntax)", () => {
    const result = parseUat(REALISTIC_UAT_MD, "S01");
    const uat02 = result.items.find((i) => i.id === "UAT-02");

    expect(uat02).toBeDefined();
    expect(uat02!.checked).toBe(false);
  });

  test("returns 2 checked and 2 unchecked items from fixture", () => {
    const result = parseUat(REALISTIC_UAT_MD, "S01");

    const checked = result.items.filter((i) => i.checked);
    const unchecked = result.items.filter((i) => !i.checked);

    expect(checked.length).toBe(2);
    expect(unchecked.length).toBe(2);
  });

  test("returns empty items array on empty string — does not throw", () => {
    const result = parseUat("", "S01");

    expect(result).toBeDefined();
    expect(result.sliceId).toBe("S01");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(0);
  });

  test("returns empty items array on malformed input — does not throw", () => {
    const result = parseUat("no checkboxes here\njust plain text", "S02");

    expect(result).toBeDefined();
    expect(result.sliceId).toBe("S02");
    expect(result.items.length).toBe(0);
  });
});

// -- buildFullState extension tests --

const GSD2_STATE_WITH_SLICE = `---
gsd_state_version: "1.0"
milestone: v2.0
milestone_name: Native Desktop
status: in_progress
active_milestone: M001
active_slice: S01
active_task: T01
auto_mode: false
cost: 0.00
tokens: 0
last_updated: "2026-03-12T10:00:00Z"
---
`;

describe("buildFullState — slice extension", () => {
  test("populates state.slices from M001-ROADMAP.md when roadmap exists", async () => {
    tempDir = makeTempDir();
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });

    writeFileSync(join(gsdDir, "STATE.md"), GSD2_STATE_WITH_SLICE);
    writeFileSync(join(gsdDir, "M001-ROADMAP.md"), REALISTIC_ROADMAP_MD);

    const state = await buildFullState(gsdDir);

    expect(Array.isArray(state.slices)).toBe(true);
    expect(state.slices.length).toBe(3);
    expect(state.slices[0].id).toBe("S01");
  });

  test("state.slices is empty array (not null) when roadmap is missing", async () => {
    tempDir = makeTempDir();
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, "STATE.md"), GSD2_STATE_WITH_SLICE);
    // No roadmap file

    const state = await buildFullState(gsdDir);

    expect(Array.isArray(state.slices)).toBe(true);
    expect(state.slices.length).toBe(0);
  });

  test("state.uatFile is populated when S01-UAT.md exists", async () => {
    tempDir = makeTempDir();
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });

    writeFileSync(join(gsdDir, "STATE.md"), GSD2_STATE_WITH_SLICE);
    writeFileSync(join(gsdDir, "S01-UAT.md"), REALISTIC_UAT_MD);

    const state = await buildFullState(gsdDir);

    expect(state.uatFile).not.toBeNull();
    expect(state.uatFile!.sliceId).toBe("S01");
    expect(state.uatFile!.items.length).toBe(4);
  });

  test("state.uatFile is null when UAT file is missing — does not throw", async () => {
    tempDir = makeTempDir();
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, "STATE.md"), GSD2_STATE_WITH_SLICE);
    // No UAT file

    const state = await buildFullState(gsdDir);

    expect(state.uatFile).toBeNull();
  });

  test("state.gitBranchCommits is a number (0 when not in a real git repo with that branch)", async () => {
    tempDir = makeTempDir();
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, "STATE.md"), GSD2_STATE_WITH_SLICE);

    const state = await buildFullState(gsdDir);

    expect(typeof state.gitBranchCommits).toBe("number");
    expect(state.gitBranchCommits).toBeGreaterThanOrEqual(0);
  });

  test("state.lastCommitMessage is a string (empty when branch not found)", async () => {
    tempDir = makeTempDir();
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, "STATE.md"), GSD2_STATE_WITH_SLICE);

    const state = await buildFullState(gsdDir);

    expect(typeof state.lastCommitMessage).toBe("string");
  });

  test("roadmap field backward compat: state.roadmap still exists with parsed data or null", async () => {
    tempDir = makeTempDir();
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });

    writeFileSync(join(gsdDir, "STATE.md"), GSD2_STATE_WITH_SLICE);
    writeFileSync(join(gsdDir, "M001-ROADMAP.md"), REALISTIC_ROADMAP_MD);

    const state = await buildFullState(gsdDir);

    // roadmap field should still be present (for any existing consumers)
    expect(state.roadmap).not.toBeNull();
  });
});
