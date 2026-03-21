import test from "node:test";
import assert from "node:assert/strict";
import { parseRoadmap } from "../files.ts";
import { parseRoadmapSlices, expandDependencies } from "../roadmap-slices.ts";

const content = `# M003: Current

**Vision:** Build the thing.

## Slices
- [x] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: First demo works.
- [ ] **S02: Second Slice** \`risk:medium\` \`depends:[S01]\`
- [x] **S03: Third Slice** \`depends:[S01, S02]\`
  > After this: Third demo works.

## Boundary Map
### S01 → S02
Produces:
  foo.ts
`;

test("parseRoadmapSlices extracts slices with dependencies and risk", () => {
  const slices = parseRoadmapSlices(content);
  assert.equal(slices.length, 3);
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[0]?.demo, "First demo works.");
  assert.deepEqual(slices[1]?.depends, ["S01"]);
  assert.equal(slices[1]?.risk, "medium");
  assert.equal(slices[2]?.risk, "low");
  assert.deepEqual(slices[2]?.depends, ["S01", "S02"]);
});

test("parseRoadmap integration: uses extracted slice parser", () => {
  const roadmap = parseRoadmap(content);
  assert.equal(roadmap.title, "M003: Current");
  assert.equal(roadmap.vision, "Build the thing.");
  assert.equal(roadmap.slices.length, 3);
  assert.equal(roadmap.boundaryMap.length, 1);
});

test("expandDependencies: plain IDs, ranges, and edge cases", () => {
  assert.deepEqual(expandDependencies([]), []);
  assert.deepEqual(expandDependencies(["S01"]), ["S01"]);
  assert.deepEqual(expandDependencies(["S01", "S03"]), ["S01", "S03"]);
  assert.deepEqual(expandDependencies(["S01-S04"]), ["S01", "S02", "S03", "S04"]);
  assert.deepEqual(expandDependencies(["S01-S01"]), ["S01"]);
  assert.deepEqual(expandDependencies(["S01..S03"]), ["S01", "S02", "S03"]);
  assert.deepEqual(expandDependencies(["S01-S03", "S05"]), ["S01", "S02", "S03", "S05"]);
  assert.deepEqual(expandDependencies(["S04-S01"]), ["S04-S01"]);
  assert.deepEqual(expandDependencies(["S01-T04"]), ["S01-T04"]);
});

test("parseRoadmapSlices: range syntax in depends expanded", () => {
  const rangeContent = `# M016: Test\n\n## Slices\n- [x] **S01: A** \`risk:low\` \`depends:[]\`\n- [x] **S02: B** \`risk:low\` \`depends:[]\`\n- [x] **S03: C** \`risk:low\` \`depends:[]\`\n- [x] **S04: D** \`risk:low\` \`depends:[]\`\n- [ ] **S05: E** \`risk:low\` \`depends:[S01-S04]\`\n  > After this: all done\n`;
  const slices = parseRoadmapSlices(rangeContent);
  assert.equal(slices.length, 5);
  assert.deepEqual(slices[4]?.depends, ["S01", "S02", "S03", "S04"]);
});

test("parseRoadmapSlices: comma-separated depends still works", () => {
  const commaContent = `# M001: Test\n\n## Slices\n- [ ] **S05: E** \`risk:low\` \`depends:[S01,S02,S03,S04]\`\n  > After this: done\n`;
  const slices = parseRoadmapSlices(commaContent);
  assert.deepEqual(slices[0]?.depends, ["S01", "S02", "S03", "S04"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression #1736: Table format parsing
// ═══════════════════════════════════════════════════════════════════════════

test("parseRoadmapSlices: table format under ## Slices heading (#1736)", () => {
  const tableContent = [
    "# M001: Test Project",
    "",
    "## Slices",
    "",
    "| Slice | Title | Risk | Status |",
    "| --- | --- | --- | --- |",
    "| S01 | Setup Foundation | Low | [x] Done |",
    "| S02 | Core Features | High | [ ] Pending |",
    "| S03 | Polish | Medium | [x] Done |",
    "",
    "## Boundary Map",
  ].join("\n");

  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 3, "should parse 3 slices from table");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.title, "Setup Foundation");
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[0]?.risk, "low");
  assert.equal(slices[1]?.id, "S02");
  assert.equal(slices[1]?.done, false);
  assert.equal(slices[1]?.risk, "high");
  assert.equal(slices[2]?.id, "S03");
  assert.equal(slices[2]?.done, true);
  assert.equal(slices[2]?.risk, "medium");
});

test("parseRoadmapSlices: table format under ## Slice Overview heading (#1736)", () => {
  const tableContent = [
    "# M002: Another Project",
    "",
    "## Slice Overview",
    "",
    "| ID | Description | Risk | Done |",
    "|---|---|---|---|",
    "| S01 | Foundation Work | High | [x] |",
    "| S02 | API Layer | Medium | [ ] |",
    "",
  ].join("\n");

  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 2, "should parse slices from Slice Overview table");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.title, "Foundation Work");
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[0]?.risk, "high");
  assert.equal(slices[1]?.id, "S02");
  assert.equal(slices[1]?.done, false);
});

test("parseRoadmapSlices: table with Status Done/Complete text (#1736)", () => {
  const tableContent = [
    "# M003: Status Text",
    "",
    "## Slices",
    "",
    "| Slice | Title | Risk | Status |",
    "|---|---|---|---|",
    "| S01 | First | Low | Done |",
    "| S02 | Second | High | Pending |",
    "| S03 | Third | Medium | Completed |",
    "",
  ].join("\n");

  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 3);
  assert.equal(slices[0]?.done, true, "Done text marks slice as done");
  assert.equal(slices[1]?.done, false, "Pending text marks slice as not done");
  assert.equal(slices[2]?.done, true, "Completed text marks slice as done");
});

test("parseRoadmapSlices: table with dependencies column (#1736)", () => {
  const tableContent = [
    "# M004: Deps",
    "",
    "## Slices",
    "",
    "| Slice | Title | Risk | Depends | Status |",
    "|---|---|---|---|---|",
    "| S01 | First | Low | None | Done |",
    "| S02 | Second | High | S01 | Pending |",
    "| S03 | Third | Medium | S01, S02 | [ ] |",
    "",
  ].join("\n");

  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 3);
  assert.deepEqual(slices[0]?.depends, [], "None deps parsed as empty");
  assert.deepEqual(slices[1]?.depends, ["S01"], "Single dep parsed");
  assert.deepEqual(slices[2]?.depends, ["S01", "S02"], "Multiple deps parsed");
});

test("parseRoadmapSlices: standard checkbox format still works after table support (#1736)", () => {
  // Verify the existing checkbox format is not broken by the table parsing addition
  const checkboxContent = [
    "# M005: Unchanged",
    "",
    "## Slices",
    "",
    "- [x] **S01: First Slice** `risk:low` `depends:[]`",
    "  > After this: First demo works.",
    "- [ ] **S02: Second Slice** `risk:medium` `depends:[S01]`",
    "",
  ].join("\n");

  const slices = parseRoadmapSlices(checkboxContent);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[0]?.demo, "First demo works.");
  assert.equal(slices[1]?.id, "S02");
  assert.equal(slices[1]?.done, false);
  assert.deepEqual(slices[1]?.depends, ["S01"]);
});
