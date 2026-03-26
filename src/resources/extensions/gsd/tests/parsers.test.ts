import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoadmap, parsePlan } from '../parsers-legacy.ts';
import { parseTaskPlanFile, parseSummary, parseContinue, parseRequirementCounts, parseSecretsManifest, formatSecretsManifest } from '../files.ts';
// ═══════════════════════════════════════════════════════════════════════════
// parseRoadmap tests
// ═══════════════════════════════════════════════════════════════════════════


describe('parsers', () => {
test('parseRoadmap: full roadmap', () => {
  const content = `# M001: GSD Extension — Hierarchical Planning

**Vision:** Build a structured planning system for coding agents.

**Success Criteria:**
- All parsers have test coverage
- Round-trip formatting preserves data
- State derivation works correctly

---

## Slices

- [x] **S01: Types + File I/O** \`risk:low\` \`depends:[]\`
  > After this: All types defined and parsers work.

- [ ] **S02: State Derivation** \`risk:medium\` \`depends:[S01]\`
  > After this: Dashboard shows real-time state.

- [ ] **S03: Auto Mode** \`risk:high\` \`depends:[S01, S02]\`
  > After this: Agent can execute tasks automatically.

---

## Boundary Map

### S01 → S02
\`\`\`
Produces:
  types.ts — all type definitions
  files.ts — parser and formatter functions

Consumes from S02:
  nothing
\`\`\`

### S02 → S03
\`\`\`
Produces:
  state.ts — deriveState function

Consumes from S03:
  auto-mode entry points
\`\`\`
`;

  const r = parseRoadmap(content);

  assert.deepStrictEqual(r.title, 'M001: GSD Extension — Hierarchical Planning', 'roadmap title');
  assert.deepStrictEqual(r.vision, 'Build a structured planning system for coding agents.', 'roadmap vision');
  assert.deepStrictEqual(r.successCriteria.length, 3, 'success criteria count');
  assert.deepStrictEqual(r.successCriteria[0], 'All parsers have test coverage', 'first success criterion');
  assert.deepStrictEqual(r.successCriteria[2], 'State derivation works correctly', 'third success criterion');

  // Slices
  assert.deepStrictEqual(r.slices.length, 3, 'slice count');

  assert.deepStrictEqual(r.slices[0].id, 'S01', 'S01 id');
  assert.deepStrictEqual(r.slices[0].title, 'Types + File I/O', 'S01 title');
  assert.deepStrictEqual(r.slices[0].risk, 'low', 'S01 risk');
  assert.deepStrictEqual(r.slices[0].depends, [], 'S01 depends');
  assert.deepStrictEqual(r.slices[0].done, true, 'S01 done');
  assert.deepStrictEqual(r.slices[0].demo, 'All types defined and parsers work.', 'S01 demo');

  assert.deepStrictEqual(r.slices[1].id, 'S02', 'S02 id');
  assert.deepStrictEqual(r.slices[1].title, 'State Derivation', 'S02 title');
  assert.deepStrictEqual(r.slices[1].risk, 'medium', 'S02 risk');
  assert.deepStrictEqual(r.slices[1].depends, ['S01'], 'S02 depends');
  assert.deepStrictEqual(r.slices[1].done, false, 'S02 done');

  assert.deepStrictEqual(r.slices[2].id, 'S03', 'S03 id');
  assert.deepStrictEqual(r.slices[2].risk, 'high', 'S03 risk');
  assert.deepStrictEqual(r.slices[2].depends, ['S01', 'S02'], 'S03 depends');
  assert.deepStrictEqual(r.slices[2].done, false, 'S03 done');

  // Boundary map
  assert.deepStrictEqual(r.boundaryMap.length, 2, 'boundary map entry count');
  assert.deepStrictEqual(r.boundaryMap[0].fromSlice, 'S01', 'bm[0] from');
  assert.deepStrictEqual(r.boundaryMap[0].toSlice, 'S02', 'bm[0] to');
  assert.ok(r.boundaryMap[0].produces.includes('types.ts'), 'bm[0] produces mentions types.ts');
  assert.deepStrictEqual(r.boundaryMap[1].fromSlice, 'S02', 'bm[1] from');
  assert.deepStrictEqual(r.boundaryMap[1].toSlice, 'S03', 'bm[1] to');
});

test('parseRoadmap: empty slices section', () => {
  const content = `# M002: Empty Milestone

**Vision:** Nothing yet.

## Slices

## Boundary Map
`;

  const r = parseRoadmap(content);
  assert.deepStrictEqual(r.title, 'M002: Empty Milestone', 'title with empty slices');
  assert.deepStrictEqual(r.slices.length, 0, 'no slices parsed');
  assert.deepStrictEqual(r.boundaryMap.length, 0, 'no boundary map entries');
});

test('parseRoadmap: malformed checkbox lines', () => {
  // Lines that don't match the expected bold pattern should be skipped
  const content = `# M003: Malformed

**Vision:** Test malformed lines.

## Slices

- [ ] S01: Missing bold markers \`risk:low\` \`depends:[]\`
- [x] **S02: Valid Slice** \`risk:medium\` \`depends:[]\`
  > After this: Works.
- [ ] Not a checkbox at all
  Some random text
- [x] **S03: Another Valid** \`risk:high\` \`depends:[S02]\`
  > After this: Also works.
`;

  const r = parseRoadmap(content);
  // Only S02 and S03 should be parsed (malformed lines without bold markers are skipped)
  assert.deepStrictEqual(r.slices.length, 2, 'only valid slices parsed from malformed input');
  assert.deepStrictEqual(r.slices[0].id, 'S02', 'first valid slice is S02');
  assert.deepStrictEqual(r.slices[0].done, true, 'S02 done');
  assert.deepStrictEqual(r.slices[1].id, 'S03', 'second valid slice is S03');
  assert.deepStrictEqual(r.slices[1].depends, ['S02'], 'S03 depends on S02');
});

test('parseRoadmap: lowercase vs uppercase X for done', () => {
  const content = `# M004: Case Test

**Vision:** Test X case sensitivity.

## Slices

- [x] **S01: Lowercase x** \`risk:low\` \`depends:[]\`
  > After this: done.

- [X] **S02: Uppercase X** \`risk:low\` \`depends:[]\`
  > After this: also done.

- [ ] **S03: Not Done** \`risk:low\` \`depends:[]\`
  > After this: not yet.
`;

  const r = parseRoadmap(content);
  assert.deepStrictEqual(r.slices.length, 3, 'all three slices parsed');
  assert.deepStrictEqual(r.slices[0].done, true, 'lowercase x is done');
  assert.deepStrictEqual(r.slices[1].done, true, 'uppercase X is done');
  assert.deepStrictEqual(r.slices[2].done, false, 'space is not done');
});

test('parseRoadmap: missing boundary map', () => {
  const content = `# M005: No Boundary Map

**Vision:** A roadmap without a boundary map section.

**Success Criteria:**
- One criterion

---

## Slices

- [ ] **S01: Only Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;

  const r = parseRoadmap(content);
  assert.deepStrictEqual(r.title, 'M005: No Boundary Map', 'title');
  assert.deepStrictEqual(r.slices.length, 1, 'one slice');
  assert.deepStrictEqual(r.boundaryMap.length, 0, 'empty boundary map when section missing');
  assert.deepStrictEqual(r.successCriteria.length, 1, 'one success criterion');
});

test('parseRoadmap: no sections at all', () => {
  const content = `# M006: Bare Minimum

Just a title and nothing else.
`;

  const r = parseRoadmap(content);
  assert.deepStrictEqual(r.title, 'M006: Bare Minimum', 'title from bare roadmap');
  assert.deepStrictEqual(r.vision, '', 'empty vision');
  assert.deepStrictEqual(r.successCriteria.length, 0, 'no success criteria');
  assert.deepStrictEqual(r.slices.length, 0, 'no slices');
  assert.deepStrictEqual(r.boundaryMap.length, 0, 'no boundary map');
});

test('parseRoadmap: slice with no demo blockquote', () => {
  const content = `# M007: No Demo

**Vision:** Testing slices without demo lines.

## Slices

- [ ] **S01: No Demo Here** \`risk:medium\` \`depends:[]\`
- [ ] **S02: Also No Demo** \`risk:low\` \`depends:[S01]\`
`;

  const r = parseRoadmap(content);
  assert.deepStrictEqual(r.slices.length, 2, 'two slices without demos');
  assert.deepStrictEqual(r.slices[0].demo, '', 'S01 demo empty');
  assert.deepStrictEqual(r.slices[1].demo, '', 'S02 demo empty');
});

test('parseRoadmap: missing risk defaults to low', () => {
  const content = `# M008: Default Risk

**Vision:** Test default risk.

## Slices

- [ ] **S01: No Risk Tag** \`depends:[]\`
  > After this: done.
`;

  const r = parseRoadmap(content);
  assert.deepStrictEqual(r.slices.length, 1, 'one slice');
  assert.deepStrictEqual(r.slices[0].risk, 'low', 'default risk is low');
});

// ═══════════════════════════════════════════════════════════════════════════
// parsePlan tests
// ═══════════════════════════════════════════════════════════════════════════
test('parsePlan: full plan', () => {
  const content = `---
estimated_steps: 6
estimated_files: 3
skills_used:
  - typescript
  - testing
---

# S01: Parser Test Suite

**Goal:** All 5 parsers have test coverage with edge cases.
**Demo:** \`node --test tests/parsers.test.ts\` passes with zero failures.

## Must-Haves

- parseRoadmap tests cover happy path and edge cases
- parsePlan tests cover happy path and edge cases
- All existing tests still pass

## Tasks

- [ ] **T01: Test parseRoadmap and parsePlan** \`est:45m\`
  Create tests/parsers.test.ts with comprehensive tests for the two most complex parsers.

- [x] **T02: Test parseSummary and parseContinue** \`est:35m\`
  Extend tests/parsers.test.ts with tests for the remaining parsers.

## Files Likely Touched

- \`tests/parsers.test.ts\` — new test file
- \`types.ts\` — add observability_surfaces
- \`files.ts\` — update parseSummary
`;

  const taskPlan = parseTaskPlanFile(content);
  assert.deepStrictEqual(taskPlan.frontmatter.estimated_steps, 6, 'task plan frontmatter estimated_steps');
  assert.deepStrictEqual(taskPlan.frontmatter.estimated_files, 3, 'task plan frontmatter estimated_files');
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used.length, 2, 'task plan frontmatter skills_used count');
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used[0], 'typescript', 'first task plan skill');
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used[1], 'testing', 'second task plan skill');

  const p = parsePlan(content);

  assert.deepStrictEqual(p.id, 'S01', 'plan id');
  assert.deepStrictEqual(p.title, 'Parser Test Suite', 'plan title');
  assert.deepStrictEqual(p.goal, 'All 5 parsers have test coverage with edge cases.', 'plan goal');
  assert.deepStrictEqual(p.demo, '`node --test tests/parsers.test.ts` passes with zero failures.', 'plan demo');

  // Must-haves
  assert.deepStrictEqual(p.mustHaves.length, 3, 'must-have count');
  assert.deepStrictEqual(p.mustHaves[0], 'parseRoadmap tests cover happy path and edge cases', 'first must-have');

  // Tasks
  assert.deepStrictEqual(p.tasks.length, 2, 'task count');

  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'T01 id');
  assert.deepStrictEqual(p.tasks[0].title, 'Test parseRoadmap and parsePlan', 'T01 title');
  assert.deepStrictEqual(p.tasks[0].done, false, 'T01 not done');
  assert.ok(p.tasks[0].description.includes('comprehensive tests'), 'T01 description content');

  assert.deepStrictEqual(p.tasks[1].id, 'T02', 'T02 id');
  assert.deepStrictEqual(p.tasks[1].title, 'Test parseSummary and parseContinue', 'T02 title');
  assert.deepStrictEqual(p.tasks[1].done, true, 'T02 done');

  // Files likely touched
  assert.deepStrictEqual(p.filesLikelyTouched.length, 3, 'files likely touched count');
  assert.ok(p.filesLikelyTouched[0].includes('tests/parsers.test.ts'), 'first file');
});

test('parseTaskPlanFile: defaults missing frontmatter fields', () => {
  const content = `# T01: Minimal task plan

## Description

No frontmatter here.
`;

  const taskPlan = parseTaskPlanFile(content);
  assert.deepStrictEqual(taskPlan.frontmatter.estimated_steps, undefined, 'estimated_steps defaults undefined');
  assert.deepStrictEqual(taskPlan.frontmatter.estimated_files, undefined, 'estimated_files defaults undefined');
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used.length, 0, 'skills_used defaults empty array');
});

test('parseTaskPlanFile: accepts scalar skills_used and numeric strings', () => {
  const content = `---
estimated_steps: "9"
estimated_files: "4"
skills_used: react-best-practices
---

# T02: Scalar skill handoff
`;

  const taskPlan = parseTaskPlanFile(content);
  assert.deepStrictEqual(taskPlan.frontmatter.estimated_steps, 9, 'string estimated_steps parsed');
  assert.deepStrictEqual(taskPlan.frontmatter.estimated_files, 4, 'string estimated_files parsed');
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used.length, 1, 'scalar skills_used normalized to array');
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used[0], 'react-best-practices', 'scalar skill preserved');
});

test('parseTaskPlanFile: filters blank skills_used items', () => {
  const content = `---
skills_used:
  - react
  -
  - testing
---

# T03: Blank skills filtered
`;

  const taskPlan = parseTaskPlanFile(content);
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used.length, 2, 'blank skill entries removed');
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used[0], 'react', 'first remaining skill');
  assert.deepStrictEqual(taskPlan.frontmatter.skills_used[1], 'testing', 'second remaining skill');
});

test('parseTaskPlanFile: invalid numeric frontmatter ignored', () => {
  const content = `---
estimated_steps: many
estimated_files: unknown
---

# T04: Invalid estimates
`;

  const taskPlan = parseTaskPlanFile(content);
  assert.deepStrictEqual(taskPlan.frontmatter.estimated_steps, undefined, 'invalid estimated_steps ignored');
  assert.deepStrictEqual(taskPlan.frontmatter.estimated_files, undefined, 'invalid estimated_files ignored');
});

test('parseTaskPlanFile: parsePlan ignores task-plan frontmatter', () => {
  const content = `---
estimated_steps: 2
estimated_files: 1
skills_used:
  - react
---

# S11: Frontmatter Compatible

**Goal:** Plan parser ignores task-plan handoff metadata.
**Demo:** Slice content still parses.

## Tasks

- [ ] **T01: Compatible task** \`est:5m\`
  Description.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.id, 'S11', 'plan id still parsed with frontmatter');
  assert.deepStrictEqual(p.tasks.length, 1, 'task still parsed with frontmatter');
});

test('parsePlan: multi-line task description concatenation', () => {
  const content = `# S02: Multi-line Test

**Goal:** Test multi-line descriptions.
**Demo:** Descriptions are concatenated.

## Must-Haves

- Multi-line works

## Tasks

- [ ] **T01: Multi-line Task** \`est:30m\`
  First line of description.
  Second line of description.
  Third line of description.

- [ ] **T02: Single Line** \`est:10m\`
  Just one line.

## Files Likely Touched

- \`foo.ts\`
`;

  const p = parsePlan(content);

  assert.deepStrictEqual(p.tasks.length, 2, 'two tasks');
  assert.ok(p.tasks[0].description.includes('First line'), 'T01 desc has first line');
  assert.ok(p.tasks[0].description.includes('Second line'), 'T01 desc has second line');
  assert.ok(p.tasks[0].description.includes('Third line'), 'T01 desc has third line');
  assert.ok(p.tasks[0].description.includes('description. Second'), 'lines joined with space');
  assert.deepStrictEqual(p.tasks[1].description, 'Just one line.', 'T02 single-line desc');
});

test('parsePlan: frontmatter does not pollute task descriptions', () => {
  const content = `---
estimated_steps: 2
estimated_files: 1
skills_used:
  - react
---

# S12: Frontmatter + multiline

## Tasks

- [ ] **T01: Multi-line Task** \`est:30m\`
  First line of description.
  Second line of description.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 1, 'one task parsed with frontmatter');
  assert.deepStrictEqual(p.tasks[0].description, 'First line of description. Second line of description.', 'frontmatter excluded from description');
});

test('parsePlan: task with missing estimate', () => {
  const content = `# S03: No Estimate

**Goal:** Handle tasks without estimates.
**Demo:** Parser doesn't crash.

## Tasks

- [ ] **T01: No Estimate Task**
  A task without an estimate backtick.

- [ ] **T02: Has Estimate** \`est:20m\`
  This one has an estimate.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 2, 'two tasks parsed');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'T01 id');
  assert.deepStrictEqual(p.tasks[0].title, 'No Estimate Task', 'T01 title without estimate');
  assert.deepStrictEqual(p.tasks[0].done, false, 'T01 not done');
  assert.deepStrictEqual(p.tasks[1].id, 'T02', 'T02 id');
});

test('parsePlan: empty tasks section', () => {
  const content = `# S04: Empty Tasks

**Goal:** No tasks yet.
**Demo:** Nothing.

## Must-Haves

- Something

## Tasks

## Files Likely Touched

- \`nothing.ts\`
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.id, 'S04', 'plan id with empty tasks');
  assert.deepStrictEqual(p.tasks.length, 0, 'no tasks');
  assert.deepStrictEqual(p.mustHaves.length, 1, 'one must-have');
  assert.deepStrictEqual(p.filesLikelyTouched.length, 1, 'one file');
});

test('parsePlan: no H1', () => {
  const content = `**Goal:** A plan without a heading.
**Demo:** Still parses.

## Tasks

- [ ] **T01: Orphan Task** \`est:5m\`
  A task in a headingless plan.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.id, '', 'empty id without H1');
  assert.deepStrictEqual(p.title, '', 'empty title without H1');
  assert.deepStrictEqual(p.goal, 'A plan without a heading.', 'goal still parsed');
  assert.deepStrictEqual(p.tasks.length, 1, 'task still parsed');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'task id');
});

test('parsePlan: task estimate backtick in description', () => {
  const content = `# S05: Estimate Handling

**Goal:** Test estimate text handling.
**Demo:** Works.

## Tasks

- [ ] **T01: With Estimate** \`est:45m\`
  Main description here.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 1, 'one task');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'task id');
  assert.deepStrictEqual(p.tasks[0].title, 'With Estimate', 'title excludes estimate');
  assert.ok(p.tasks[0].description.includes('Main description'), 'description from continuation line');
});

test('parsePlan: uppercase X for done', () => {
  const content = `# S06: Case Test

**Goal:** Test case.
**Demo:** Works.

## Tasks

- [X] **T01: Uppercase Done** \`est:5m\`
  Done with uppercase X.

- [x] **T02: Lowercase Done** \`est:5m\`
  Done with lowercase x.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks[0].done, true, 'uppercase X is done');
  assert.deepStrictEqual(p.tasks[1].done, true, 'lowercase x is done');
});

test('parsePlan: no Must-Haves section', () => {
  const content = `# S07: No Must-Haves

**Goal:** Test missing must-haves.
**Demo:** Parser handles it.

## Tasks

- [ ] **T01: Only Task** \`est:10m\`
  The only task.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.mustHaves.length, 0, 'empty must-haves');
  assert.deepStrictEqual(p.tasks.length, 1, 'task still parsed');
});

test('parsePlan: no Files Likely Touched section', () => {
  const content = `# S08: No Files

**Goal:** Test missing files section.
**Demo:** Parser handles it.

## Tasks

- [ ] **T01: Task** \`est:10m\`
  Description.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.filesLikelyTouched.length, 0, 'empty files likely touched');
});

test('parsePlan: old-format task entries (no sublines)', () => {
  const content = `# S09: Old Format

**Goal:** Test old-format compatibility.
**Demo:** Parser handles entries without sublines.

## Tasks

- [ ] **T01: Classic Task** \`est:10m\`
  Just a plain description with no labeled sublines.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 1, 'one task parsed');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'task id');
  assert.deepStrictEqual(p.tasks[0].title, 'Classic Task', 'task title');
  assert.deepStrictEqual(p.tasks[0].done, false, 'task not done');
  assert.deepStrictEqual(p.tasks[0].files, undefined, 'files is undefined for old-format entry');
  assert.deepStrictEqual(p.tasks[0].verify, undefined, 'verify is undefined for old-format entry');
});

test('parsePlan: new-format task entries with Files and Verify sublines', () => {
  const content = `# S10: New Format

**Goal:** Test new-format subline extraction.
**Demo:** Parser extracts Files and Verify correctly.

## Tasks

- [ ] **T01: Modern Task** \`est:15m\`
  - Why: because we need typed plan entries
  - Files: \`types.ts\`, \`files.ts\`
  - Verify: run the test suite
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 1, 'one task parsed');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'task id');
  assert.ok(Array.isArray(p.tasks[0].files), 'files is an array');
  assert.deepStrictEqual(p.tasks[0].files!.length, 2, 'files array has two entries');
  assert.deepStrictEqual(p.tasks[0].files![0], 'types.ts', 'first file is types.ts');
  assert.deepStrictEqual(p.tasks[0].files![1], 'files.ts', 'second file is files.ts');
  assert.deepStrictEqual(p.tasks[0].verify, 'run the test suite', 'verify string extracted correctly');
  assert.ok(p.tasks[0].description.includes('Why: because we need typed plan entries'), 'Why line accumulates into description');
});

test('parsePlan: heading-style task entries (### T01 -- Title)', () => {
  const content = `# S11: Heading Style

**Goal:** Test heading-style task parsing.
**Demo:** Parser handles heading-style task entries.

## Tasks

### T01 -- Implement feature

- Why: the feature is needed
- Files: \`src/feature.ts\`
- Verify: npm test

### T02 -- Write tests \`est:1h\`

Some description for the second task.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 2, 'heading-style task count');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'heading T01 id');
  assert.deepStrictEqual(p.tasks[0].title, 'Implement feature', 'heading T01 title');
  assert.deepStrictEqual(p.tasks[0].done, false, 'heading T01 not done (headings have no checkbox)');
  assert.deepStrictEqual(p.tasks[0].files![0], 'src/feature.ts', 'heading T01 files extracted');
  assert.deepStrictEqual(p.tasks[0].verify, 'npm test', 'heading T01 verify extracted');
  assert.deepStrictEqual(p.tasks[1].id, 'T02', 'heading T02 id');
  assert.deepStrictEqual(p.tasks[1].title, 'Write tests', 'heading T02 title');
  assert.deepStrictEqual(p.tasks[1].estimate, '1h', 'heading T02 estimate');
  assert.ok(p.tasks[1].description.includes('Some description'), 'heading T02 description');
});

test('parsePlan: heading-style with colon separator (### T01: Title)', () => {
  const content = `# S12: Heading Colon Style

**Goal:** Test colon-separated heading tasks.
**Demo:** Parser handles colon separator.

## Tasks

### T01: Setup project
  Basic project setup steps.

### T02: Add CI pipeline \`est:30m\`
  Configure CI.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 2, 'colon heading task count');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'colon heading T01 id');
  assert.deepStrictEqual(p.tasks[0].title, 'Setup project', 'colon heading T01 title');
  assert.deepStrictEqual(p.tasks[1].id, 'T02', 'colon heading T02 id');
  assert.deepStrictEqual(p.tasks[1].title, 'Add CI pipeline', 'colon heading T02 title');
  assert.deepStrictEqual(p.tasks[1].estimate, '30m', 'colon heading T02 estimate');
});

test('parsePlan: heading-style with em-dash separator (### T01 — Title)', () => {
  const content = `# S13: Em-Dash Style

**Goal:** Test em-dash separated heading tasks.
**Demo:** Parser handles em-dash separator.

## Tasks

### T01 — Build the widget

Widget description.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 1, 'em-dash heading task count');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'em-dash heading T01 id');
  assert.deepStrictEqual(p.tasks[0].title, 'Build the widget', 'em-dash heading T01 title');
});

test('parsePlan: mixed checkbox and heading-style tasks', () => {
  const content = `# S14: Mixed Format

**Goal:** Test mixed formats.
**Demo:** Parser handles both styles in one plan.

## Tasks

- [ ] **T01: Checkbox task** \`est:20m\`
  A checkbox-style task.

### T02 -- Heading task \`est:15m\`

A heading-style task.

- [x] **T03: Done checkbox task** \`est:10m\`
  Already completed.
`;

  const p = parsePlan(content);
  assert.deepStrictEqual(p.tasks.length, 3, 'mixed format task count');
  assert.deepStrictEqual(p.tasks[0].id, 'T01', 'mixed T01 id');
  assert.deepStrictEqual(p.tasks[0].done, false, 'mixed T01 not done');
  assert.deepStrictEqual(p.tasks[1].id, 'T02', 'mixed T02 id');
  assert.deepStrictEqual(p.tasks[1].title, 'Heading task', 'mixed T02 title');
  assert.deepStrictEqual(p.tasks[1].estimate, '15m', 'mixed T02 estimate');
  assert.deepStrictEqual(p.tasks[1].done, false, 'mixed T02 not done (heading style)');
  assert.deepStrictEqual(p.tasks[2].id, 'T03', 'mixed T03 id');
  assert.deepStrictEqual(p.tasks[2].done, true, 'mixed T03 done');
});

// ═══════════════════════════════════════════════════════════════════════════
// parseSummary tests
// ═══════════════════════════════════════════════════════════════════════════
test('parseSummary: full summary with all frontmatter fields', () => {
  const content = `---
id: T01
parent: S01
milestone: M001
provides:
  - parseRoadmap test coverage
  - parsePlan test coverage
requires:
  - slice: S00
    provides: type definitions
  - slice: S02
    provides: state derivation
affects:
  - auto-mode dispatch
key_files:
  - tests/parsers.test.ts
  - files.ts
key_decisions:
  - Use manual assert pattern
patterns_established:
  - parsers.test.ts is the canonical test location
drill_down_paths:
  - tests/parsers.test.ts for assertion details
observability_surfaces:
  - test pass/fail output from node --test
  - exit code 1 on failure
duration: 23min
verification_result: pass
retries: 0
completed_at: 2025-03-10T08:00:00Z
---

# T01: Test parseRoadmap and parsePlan

**Created parsers.test.ts with 98 assertions across 16 test groups.**

## What Happened

Added comprehensive tests for parseRoadmap and parsePlan.

## Deviations

None.

## Files Created/Modified

- \`tests/parsers.test.ts\` — new test file with 98 assertions
- \`types.ts\` — added observability_surfaces field
- \`files.ts\` — updated parseSummary extraction
`;

  const s = parseSummary(content);

  // Frontmatter fields
  assert.deepStrictEqual(s.frontmatter.id, 'T01', 'summary id');
  assert.deepStrictEqual(s.frontmatter.parent, 'S01', 'summary parent');
  assert.deepStrictEqual(s.frontmatter.milestone, 'M001', 'summary milestone');
  assert.deepStrictEqual(s.frontmatter.provides.length, 2, 'provides count');
  assert.deepStrictEqual(s.frontmatter.provides[0], 'parseRoadmap test coverage', 'first provides');
  assert.deepStrictEqual(s.frontmatter.provides[1], 'parsePlan test coverage', 'second provides');

  // requires (nested objects)
  assert.deepStrictEqual(s.frontmatter.requires.length, 2, 'requires count');
  assert.deepStrictEqual(s.frontmatter.requires[0].slice, 'S00', 'first requires slice');
  assert.deepStrictEqual(s.frontmatter.requires[0].provides, 'type definitions', 'first requires provides');
  assert.deepStrictEqual(s.frontmatter.requires[1].slice, 'S02', 'second requires slice');
  assert.deepStrictEqual(s.frontmatter.requires[1].provides, 'state derivation', 'second requires provides');

  assert.deepStrictEqual(s.frontmatter.affects.length, 1, 'affects count');
  assert.deepStrictEqual(s.frontmatter.affects[0], 'auto-mode dispatch', 'affects value');
  assert.deepStrictEqual(s.frontmatter.key_files.length, 2, 'key_files count');
  assert.deepStrictEqual(s.frontmatter.key_decisions.length, 1, 'key_decisions count');
  assert.deepStrictEqual(s.frontmatter.patterns_established.length, 1, 'patterns_established count');
  assert.deepStrictEqual(s.frontmatter.drill_down_paths.length, 1, 'drill_down_paths count');

  // observability_surfaces extraction
  assert.deepStrictEqual(s.frontmatter.observability_surfaces.length, 2, 'observability_surfaces count');
  assert.deepStrictEqual(s.frontmatter.observability_surfaces[0], 'test pass/fail output from node --test', 'first observability surface');
  assert.deepStrictEqual(s.frontmatter.observability_surfaces[1], 'exit code 1 on failure', 'second observability surface');

  assert.deepStrictEqual(s.frontmatter.duration, '23min', 'duration');
  assert.deepStrictEqual(s.frontmatter.verification_result, 'pass', 'verification_result');
  assert.deepStrictEqual(s.frontmatter.completed_at, '2025-03-10T08:00:00Z', 'completed_at');

  // Body fields
  assert.deepStrictEqual(s.title, 'T01: Test parseRoadmap and parsePlan', 'summary title');
  assert.deepStrictEqual(s.oneLiner, 'Created parsers.test.ts with 98 assertions across 16 test groups.', 'one-liner');
  assert.ok(s.whatHappened.includes('comprehensive tests'), 'whatHappened content');
  assert.deepStrictEqual(s.deviations, 'None.', 'deviations');

  // Files modified
  assert.deepStrictEqual(s.filesModified.length, 3, 'filesModified count');
  assert.deepStrictEqual(s.filesModified[0].path, 'tests/parsers.test.ts', 'first file path');
  assert.ok(s.filesModified[0].description.includes('98 assertions'), 'first file description');
  assert.deepStrictEqual(s.filesModified[1].path, 'types.ts', 'second file path');
  assert.deepStrictEqual(s.filesModified[2].path, 'files.ts', 'third file path');
});

test('parseSummary: one-liner extraction (bold-wrapped line after H1)', () => {
  const content = `# S01: Parser Test Suite

**All 5 parsers have test coverage with edge cases.**

## What Happened

Things happened.
`;

  const s = parseSummary(content);
  assert.deepStrictEqual(s.title, 'S01: Parser Test Suite', 'title');
  assert.deepStrictEqual(s.oneLiner, 'All 5 parsers have test coverage with edge cases.', 'bold one-liner');
});

test('parseSummary: non-bold paragraph after H1 (empty one-liner)', () => {
  const content = `# T02: Some Task

This is just a regular paragraph, not bold.

## What Happened

Did stuff.
`;

  const s = parseSummary(content);
  assert.deepStrictEqual(s.title, 'T02: Some Task', 'title');
  assert.deepStrictEqual(s.oneLiner, '', 'non-bold line results in empty one-liner');
});

test('parseSummary: files-modified parsing (backtick path — description format)', () => {
  const content = `# T03: File Changes

**One-liner.**

## Files Created/Modified

- \`src/index.ts\` — main entry point
- \`src/utils.ts\` — utility functions
- \`README.md\` — updated docs
`;

  const s = parseSummary(content);
  assert.deepStrictEqual(s.filesModified.length, 3, 'three files');
  assert.deepStrictEqual(s.filesModified[0].path, 'src/index.ts', 'first path');
  assert.deepStrictEqual(s.filesModified[0].description, 'main entry point', 'first description');
  assert.deepStrictEqual(s.filesModified[1].path, 'src/utils.ts', 'second path');
  assert.deepStrictEqual(s.filesModified[2].path, 'README.md', 'third path');
});

test('parseSummary: missing frontmatter (safe defaults)', () => {
  const content = `# T04: No Frontmatter

**Did something.**

## What Happened

No frontmatter at all.
`;

  const s = parseSummary(content);
  assert.deepStrictEqual(s.frontmatter.id, '', 'default id empty');
  assert.deepStrictEqual(s.frontmatter.parent, '', 'default parent empty');
  assert.deepStrictEqual(s.frontmatter.milestone, '', 'default milestone empty');
  assert.deepStrictEqual(s.frontmatter.provides.length, 0, 'default provides empty');
  assert.deepStrictEqual(s.frontmatter.requires.length, 0, 'default requires empty');
  assert.deepStrictEqual(s.frontmatter.affects.length, 0, 'default affects empty');
  assert.deepStrictEqual(s.frontmatter.key_files.length, 0, 'default key_files empty');
  assert.deepStrictEqual(s.frontmatter.key_decisions.length, 0, 'default key_decisions empty');
  assert.deepStrictEqual(s.frontmatter.patterns_established.length, 0, 'default patterns_established empty');
  assert.deepStrictEqual(s.frontmatter.drill_down_paths.length, 0, 'default drill_down_paths empty');
  assert.deepStrictEqual(s.frontmatter.observability_surfaces.length, 0, 'default observability_surfaces empty');
  assert.deepStrictEqual(s.frontmatter.duration, '', 'default duration empty');
  assert.deepStrictEqual(s.frontmatter.verification_result, 'untested', 'default verification_result');
  assert.deepStrictEqual(s.frontmatter.completed_at, '', 'default completed_at empty');
  assert.deepStrictEqual(s.title, 'T04: No Frontmatter', 'title still parsed');
  assert.deepStrictEqual(s.oneLiner, 'Did something.', 'one-liner still parsed');
});

test('parseSummary: empty body', () => {
  const content = `---
id: T05
parent: S01
milestone: M001
---
`;

  const s = parseSummary(content);
  assert.deepStrictEqual(s.frontmatter.id, 'T05', 'id from frontmatter');
  assert.deepStrictEqual(s.title, '', 'empty title');
  assert.deepStrictEqual(s.oneLiner, '', 'empty one-liner');
  assert.deepStrictEqual(s.whatHappened, '', 'empty whatHappened');
  assert.deepStrictEqual(s.deviations, '', 'empty deviations');
  assert.deepStrictEqual(s.filesModified.length, 0, 'no files modified');
});

test('parseSummary: summary with requires array (nested objects)', () => {
  const content = `---
id: T06
parent: S02
milestone: M001
requires:
  - slice: S01
    provides: parser functions
  - slice: S00
    provides: core types
  - slice: S03
    provides: state engine
provides: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
drill_down_paths: []
observability_surfaces: []
duration: 10min
verification_result: pass
retries: 1
completed_at: 2025-03-10T09:00:00Z
---

# T06: Nested Requires

**Test nested requires parsing.**

## What Happened

Tested.
`;

  const s = parseSummary(content);
  assert.deepStrictEqual(s.frontmatter.requires.length, 3, 'three requires entries');
  assert.deepStrictEqual(s.frontmatter.requires[0].slice, 'S01', 'first requires slice');
  assert.deepStrictEqual(s.frontmatter.requires[0].provides, 'parser functions', 'first requires provides');
  assert.deepStrictEqual(s.frontmatter.requires[1].slice, 'S00', 'second requires slice');
  assert.deepStrictEqual(s.frontmatter.requires[2].slice, 'S03', 'third requires slice');
  assert.deepStrictEqual(s.frontmatter.requires[2].provides, 'state engine', 'third requires provides');
});

// ═══════════════════════════════════════════════════════════════════════════
// parseContinue tests
// ═══════════════════════════════════════════════════════════════════════════
test('parseContinue: full continue file with all frontmatter fields', () => {
  const content = `---
milestone: M001
slice: S01
task: T02
step: 3
total_steps: 5
status: in_progress
saved_at: 2025-03-10T08:30:00Z
---

## Completed Work

Steps 1-3 are done. Created test file and wrote assertions.

## Remaining Work

Steps 4-5: run tests and check regressions.

## Decisions Made

Used manual assert pattern instead of node:assert.

## Context

Working in the gsd-s01 worktree. All imports use .ts extensions.

## Next Action

Run the full test suite with node --test.
`;

  const c = parseContinue(content);

  // Frontmatter
  assert.deepStrictEqual(c.frontmatter.milestone, 'M001', 'continue milestone');
  assert.deepStrictEqual(c.frontmatter.slice, 'S01', 'continue slice');
  assert.deepStrictEqual(c.frontmatter.task, 'T02', 'continue task');
  assert.deepStrictEqual(c.frontmatter.step, 3, 'continue step');
  assert.deepStrictEqual(c.frontmatter.totalSteps, 5, 'continue totalSteps');
  assert.deepStrictEqual(c.frontmatter.status, 'in_progress', 'continue status');
  assert.deepStrictEqual(c.frontmatter.savedAt, '2025-03-10T08:30:00Z', 'continue savedAt');

  // Body sections
  assert.ok(c.completedWork.includes('Steps 1-3 are done'), 'completedWork content');
  assert.ok(c.remainingWork.includes('Steps 4-5'), 'remainingWork content');
  assert.ok(c.decisions.includes('manual assert pattern'), 'decisions content');
  assert.ok(c.context.includes('gsd-s01 worktree'), 'context content');
  assert.ok(c.nextAction.includes('node --test'), 'nextAction content');
});

test('parseContinue: string step/totalSteps parsed as integers', () => {
  const content = `---
milestone: M002
slice: S03
task: T01
step: 7
total_steps: 12
status: in_progress
saved_at: 2025-03-10T10:00:00Z
---

## Completed Work

Some work.

## Remaining Work

More work.

## Decisions Made

None.

## Context

None.

## Next Action

Continue.
`;

  const c = parseContinue(content);
  assert.deepStrictEqual(c.frontmatter.step, 7, 'step parsed as integer 7');
  assert.deepStrictEqual(c.frontmatter.totalSteps, 12, 'totalSteps parsed as integer 12');
  assert.deepStrictEqual(typeof c.frontmatter.step, 'number', 'step is number type');
  assert.deepStrictEqual(typeof c.frontmatter.totalSteps, 'number', 'totalSteps is number type');
});

test('parseContinue: NaN step values (non-numeric strings)', () => {
  const content = `---
milestone: M001
slice: S01
task: T01
step: abc
total_steps: xyz
status: in_progress
saved_at: 2025-03-10T10:00:00Z
---

## Completed Work

Work.

## Remaining Work

Work.

## Decisions Made

None.

## Context

None.

## Next Action

Do things.
`;

  const c = parseContinue(content);
  // parseInt("abc") returns NaN; the parser || 0 fallback should give 0
  // Actually, looking at parser: typeof fm.step === 'string' ? parseInt(fm.step) : ...
  // parseInt("abc") = NaN, and NaN || 0 doesn't work because NaN is falsy only in boolean context
  // But the parser uses: typeof fm.step === 'string' ? parseInt(fm.step) : (fm.step as number) || 0
  // parseInt returns NaN which is a number, not 0 — let's verify
  const stepIsNaN = Number.isNaN(c.frontmatter.step);
  const totalIsNaN = Number.isNaN(c.frontmatter.totalSteps);
  // The parser does parseInt which returns NaN for non-numeric strings
  // There's no || 0 fallback on the parseInt path, so NaN is expected
  assert.ok(stepIsNaN, 'NaN step when non-numeric string');
  assert.ok(totalIsNaN, 'NaN totalSteps when non-numeric string');
});

test('parseContinue: all three status variants', () => {
  for (const status of ['in_progress', 'interrupted', 'compacted'] as const) {
    const content = `---
milestone: M001
slice: S01
task: T01
step: 1
total_steps: 3
status: ${status}
saved_at: 2025-03-10T10:00:00Z
---

## Completed Work

Work.
`;

    const c = parseContinue(content);
    assert.deepStrictEqual(c.frontmatter.status, status, `status variant: ${status}`);
  }
});

test('parseContinue: missing frontmatter', () => {
  const content = `## Completed Work

Some work done.

## Remaining Work

More to do.

## Decisions Made

A decision.

## Context

Some context.

## Next Action

Next thing.
`;

  const c = parseContinue(content);
  assert.deepStrictEqual(c.frontmatter.milestone, '', 'default milestone empty');
  assert.deepStrictEqual(c.frontmatter.slice, '', 'default slice empty');
  assert.deepStrictEqual(c.frontmatter.task, '', 'default task empty');
  assert.deepStrictEqual(c.frontmatter.step, 0, 'default step 0');
  assert.deepStrictEqual(c.frontmatter.totalSteps, 0, 'default totalSteps 0');
  assert.deepStrictEqual(c.frontmatter.status, 'in_progress', 'default status in_progress');
  assert.deepStrictEqual(c.frontmatter.savedAt, '', 'default savedAt empty');

  // Body sections still parse
  assert.ok(c.completedWork.includes('Some work done'), 'completedWork without frontmatter');
  assert.ok(c.remainingWork.includes('More to do'), 'remainingWork without frontmatter');
  assert.ok(c.decisions.includes('A decision'), 'decisions without frontmatter');
  assert.ok(c.context.includes('Some context'), 'context without frontmatter');
  assert.ok(c.nextAction.includes('Next thing'), 'nextAction without frontmatter');
});

test('parseContinue: body section extraction', () => {
  const content = `---
milestone: M001
slice: S01
task: T03
step: 2
total_steps: 4
status: interrupted
saved_at: 2025-03-10T11:00:00Z
---

## Completed Work

First paragraph of completed work.
Second paragraph continuing the explanation.

## Remaining Work

Need to finish step 3 and step 4.

## Decisions Made

Decided to use approach A over approach B because of performance.

## Context

Running in worktree. Node 22 required. TypeScript strict mode.

## Next Action

Pick up at step 3: run the integration tests.
`;

  const c = parseContinue(content);
  assert.ok(c.completedWork.includes('First paragraph'), 'completedWork first paragraph');
  assert.ok(c.completedWork.includes('Second paragraph'), 'completedWork second paragraph');
  assert.ok(c.remainingWork.includes('step 3 and step 4'), 'remainingWork detail');
  assert.ok(c.decisions.includes('approach A over approach B'), 'decisions detail');
  assert.ok(c.context.includes('Node 22 required'), 'context detail');
  assert.ok(c.nextAction.includes('step 3: run the integration tests'), 'nextAction detail');
});

test('parseContinue: total_steps vs totalSteps key support', () => {
  // Test total_steps (snake_case) — the primary format
  const content1 = `---
milestone: M001
slice: S01
task: T01
step: 2
total_steps: 8
status: in_progress
saved_at: 2025-03-10T12:00:00Z
---

## Completed Work

Work.
`;

  const c1 = parseContinue(content1);
  assert.deepStrictEqual(c1.frontmatter.totalSteps, 8, 'total_steps snake_case works');

  // Test totalSteps (camelCase) — the fallback
  const content2 = `---
milestone: M001
slice: S01
task: T01
step: 2
totalSteps: 6
status: in_progress
saved_at: 2025-03-10T12:00:00Z
---

## Completed Work

Work.
`;

  const c2 = parseContinue(content2);
  assert.deepStrictEqual(c2.frontmatter.totalSteps, 6, 'totalSteps camelCase works');
});

// ═══════════════════════════════════════════════════════════════════════════
// parseRequirementCounts tests
// ═══════════════════════════════════════════════════════════════════════════
test('parseRequirementCounts: full requirements file', () => {
  const content = `# Requirements

## Active

### R001 — User authentication
- Status: active

### R002 — Dashboard rendering
- Status: blocked

### R003 — API rate limiting
- Status: active

## Validated

### R010 — Parser test coverage
- Status: validated

### R011 — Type system
- Status: validated

## Deferred

### R020 — Admin panel
- Status: deferred

## Out of Scope

### R030 — Mobile app
- Status: out-of-scope

### R031 — Desktop app
- Status: out-of-scope
`;

  const counts = parseRequirementCounts(content);
  assert.deepStrictEqual(counts.active, 3, 'active count');
  assert.deepStrictEqual(counts.validated, 2, 'validated count');
  assert.deepStrictEqual(counts.deferred, 1, 'deferred count');
  assert.deepStrictEqual(counts.outOfScope, 2, 'outOfScope count');
  assert.deepStrictEqual(counts.blocked, 1, 'blocked count');
  assert.deepStrictEqual(counts.total, 8, 'total is sum of active+validated+deferred+outOfScope');
});

test('parseRequirementCounts: null input returns all zeros', () => {
  const counts = parseRequirementCounts(null);
  assert.deepStrictEqual(counts.active, 0, 'null active');
  assert.deepStrictEqual(counts.validated, 0, 'null validated');
  assert.deepStrictEqual(counts.deferred, 0, 'null deferred');
  assert.deepStrictEqual(counts.outOfScope, 0, 'null outOfScope');
  assert.deepStrictEqual(counts.blocked, 0, 'null blocked');
  assert.deepStrictEqual(counts.total, 0, 'null total');
});

test('parseRequirementCounts: empty sections return zero counts', () => {
  const content = `# Requirements

## Active

## Validated

## Deferred

## Out of Scope
`;

  const counts = parseRequirementCounts(content);
  assert.deepStrictEqual(counts.active, 0, 'empty active');
  assert.deepStrictEqual(counts.validated, 0, 'empty validated');
  assert.deepStrictEqual(counts.deferred, 0, 'empty deferred');
  assert.deepStrictEqual(counts.outOfScope, 0, 'empty outOfScope');
  assert.deepStrictEqual(counts.blocked, 0, 'empty blocked');
  assert.deepStrictEqual(counts.total, 0, 'empty total');
});

test('parseRequirementCounts: blocked status counting', () => {
  const content = `# Requirements

## Active

### R001 — Blocked thing
- Status: blocked

### R002 — Another blocked thing
- Status: blocked

### R003 — Active thing
- Status: active

## Validated

## Deferred

### R020 — Blocked deferred
- Status: blocked

## Out of Scope
`;

  const counts = parseRequirementCounts(content);
  assert.deepStrictEqual(counts.active, 3, 'active includes blocked items in Active section');
  assert.deepStrictEqual(counts.blocked, 3, 'blocked counts all blocked statuses across sections');
  assert.deepStrictEqual(counts.deferred, 1, 'deferred section count');
});

test('parseRequirementCounts: total is sum of all section counts', () => {
  const content = `# Requirements

## Active

### R001 — One
- Status: active

## Validated

### R010 — Two
- Status: validated

### R011 — Three
- Status: validated

## Deferred

### R020 — Four
- Status: deferred

### R021 — Five
- Status: deferred

### R022 — Six
- Status: deferred

## Out of Scope

### R030 — Seven
- Status: out-of-scope
`;

  const counts = parseRequirementCounts(content);
  assert.deepStrictEqual(counts.active, 1, 'one active');
  assert.deepStrictEqual(counts.validated, 2, 'two validated');
  assert.deepStrictEqual(counts.deferred, 3, 'three deferred');
  assert.deepStrictEqual(counts.outOfScope, 1, 'one outOfScope');
  assert.deepStrictEqual(counts.total, 7, 'total = 1 + 2 + 3 + 1');
  assert.deepStrictEqual(counts.total, counts.active + counts.validated + counts.deferred + counts.outOfScope, 'total is exact sum');
});

// ═══════════════════════════════════════════════════════════════════════════
// parseSecretsManifest / formatSecretsManifest tests
// ═══════════════════════════════════════════════════════════════════════════
test('parseSecretsManifest: full manifest with 3 keys', () => {
  const content = `# Secrets Manifest

**Milestone:** M003
**Generated:** 2025-06-15T10:00:00Z

### OPENAI_API_KEY

**Service:** OpenAI
**Dashboard:** https://platform.openai.com/api-keys
**Format hint:** starts with sk-
**Status:** pending
**Destination:** dotenv

1. Go to https://platform.openai.com/api-keys
2. Click "Create new secret key"
3. Copy the key immediately — it won't be shown again

### STRIPE_SECRET_KEY

**Service:** Stripe
**Dashboard:** https://dashboard.stripe.com/apikeys
**Format hint:** starts with sk_test_ or sk_live_
**Status:** collected
**Destination:** dotenv

1. Go to https://dashboard.stripe.com/apikeys
2. Reveal the secret key
3. Copy it

### SUPABASE_URL

**Service:** Supabase
**Dashboard:** https://app.supabase.com/project/settings/api
**Format hint:** https://<project-ref>.supabase.co
**Status:** skipped
**Destination:** vercel

1. Go to project settings in Supabase
2. Copy the URL from the API section
`;

  const m = parseSecretsManifest(content);

  assert.deepStrictEqual(m.milestone, 'M003', 'manifest milestone');
  assert.deepStrictEqual(m.generatedAt, '2025-06-15T10:00:00Z', 'manifest generatedAt');
  assert.deepStrictEqual(m.entries.length, 3, 'three entries');

  // First entry
  assert.deepStrictEqual(m.entries[0].key, 'OPENAI_API_KEY', 'entry 0 key');
  assert.deepStrictEqual(m.entries[0].service, 'OpenAI', 'entry 0 service');
  assert.deepStrictEqual(m.entries[0].dashboardUrl, 'https://platform.openai.com/api-keys', 'entry 0 dashboardUrl');
  assert.deepStrictEqual(m.entries[0].formatHint, 'starts with sk-', 'entry 0 formatHint');
  assert.deepStrictEqual(m.entries[0].status, 'pending', 'entry 0 status');
  assert.deepStrictEqual(m.entries[0].destination, 'dotenv', 'entry 0 destination');
  assert.deepStrictEqual(m.entries[0].guidance.length, 3, 'entry 0 guidance count');
  assert.deepStrictEqual(m.entries[0].guidance[0], 'Go to https://platform.openai.com/api-keys', 'entry 0 guidance[0]');
  assert.deepStrictEqual(m.entries[0].guidance[2], 'Copy the key immediately — it won\'t be shown again', 'entry 0 guidance[2]');

  // Second entry
  assert.deepStrictEqual(m.entries[1].key, 'STRIPE_SECRET_KEY', 'entry 1 key');
  assert.deepStrictEqual(m.entries[1].service, 'Stripe', 'entry 1 service');
  assert.deepStrictEqual(m.entries[1].status, 'collected', 'entry 1 status');
  assert.deepStrictEqual(m.entries[1].formatHint, 'starts with sk_test_ or sk_live_', 'entry 1 formatHint');
  assert.deepStrictEqual(m.entries[1].guidance.length, 3, 'entry 1 guidance count');

  // Third entry
  assert.deepStrictEqual(m.entries[2].key, 'SUPABASE_URL', 'entry 2 key');
  assert.deepStrictEqual(m.entries[2].status, 'skipped', 'entry 2 status');
  assert.deepStrictEqual(m.entries[2].destination, 'vercel', 'entry 2 destination');
  assert.deepStrictEqual(m.entries[2].guidance.length, 2, 'entry 2 guidance count');
});

test('parseSecretsManifest: single-key manifest', () => {
  const content = `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-15T12:00:00Z

### DATABASE_URL

**Service:** PostgreSQL
**Dashboard:** https://console.neon.tech
**Format hint:** postgresql://...
**Status:** pending
**Destination:** dotenv

1. Create a database on Neon
2. Copy the connection string
`;

  const m = parseSecretsManifest(content);
  assert.deepStrictEqual(m.milestone, 'M001', 'single-key milestone');
  assert.deepStrictEqual(m.entries.length, 1, 'single entry');
  assert.deepStrictEqual(m.entries[0].key, 'DATABASE_URL', 'single entry key');
  assert.deepStrictEqual(m.entries[0].service, 'PostgreSQL', 'single entry service');
  assert.deepStrictEqual(m.entries[0].guidance.length, 2, 'single entry guidance count');
});

test('parseSecretsManifest: empty/no-secrets manifest', () => {
  const content = `# Secrets Manifest

**Milestone:** M002
**Generated:** 2025-06-15T14:00:00Z
`;

  const m = parseSecretsManifest(content);
  assert.deepStrictEqual(m.milestone, 'M002', 'empty manifest milestone');
  assert.deepStrictEqual(m.generatedAt, '2025-06-15T14:00:00Z', 'empty manifest generatedAt');
  assert.deepStrictEqual(m.entries.length, 0, 'no entries in empty manifest');
});

test('parseSecretsManifest: missing optional fields default correctly', () => {
  const content = `# Secrets Manifest

**Milestone:** M004
**Generated:** 2025-06-15T16:00:00Z

### SOME_API_KEY

**Service:** SomeService

1. Get the key from the dashboard
`;

  const m = parseSecretsManifest(content);
  assert.deepStrictEqual(m.entries.length, 1, 'one entry with missing fields');
  assert.deepStrictEqual(m.entries[0].key, 'SOME_API_KEY', 'key parsed');
  assert.deepStrictEqual(m.entries[0].service, 'SomeService', 'service parsed');
  assert.deepStrictEqual(m.entries[0].dashboardUrl, '', 'missing dashboardUrl defaults to empty string');
  assert.deepStrictEqual(m.entries[0].formatHint, '', 'missing formatHint defaults to empty string');
  assert.deepStrictEqual(m.entries[0].status, 'pending', 'missing status defaults to pending');
  assert.deepStrictEqual(m.entries[0].destination, 'dotenv', 'missing destination defaults to dotenv');
  assert.deepStrictEqual(m.entries[0].guidance.length, 1, 'guidance still parsed');
});

test('parseSecretsManifest: all three status values parse', () => {
  for (const status of ['pending', 'collected', 'skipped'] as const) {
    const content = `# Secrets Manifest

**Milestone:** M005
**Generated:** 2025-06-15T18:00:00Z

### TEST_KEY

**Service:** TestService
**Status:** ${status}

1. Do something
`;

    const m = parseSecretsManifest(content);
    assert.deepStrictEqual(m.entries[0].status, status, `status variant: ${status}`);
  }
});

test('parseSecretsManifest: invalid status defaults to pending', () => {
  const content = `# Secrets Manifest

**Milestone:** M006
**Generated:** 2025-06-15T20:00:00Z

### BAD_STATUS_KEY

**Service:** TestService
**Status:** invalid_value

1. Some step
`;

  const m = parseSecretsManifest(content);
  assert.deepStrictEqual(m.entries[0].status, 'pending', 'invalid status defaults to pending');
});

test('parseSecretsManifest + formatSecretsManifest: round-trip', () => {
  const original = `# Secrets Manifest

**Milestone:** M007
**Generated:** 2025-06-16T10:00:00Z

### OPENAI_API_KEY

**Service:** OpenAI
**Dashboard:** https://platform.openai.com/api-keys
**Format hint:** starts with sk-
**Status:** pending
**Destination:** dotenv

1. Go to the API keys page
2. Create a new key
3. Copy it

### REDIS_URL

**Service:** Upstash
**Dashboard:** https://console.upstash.com
**Format hint:** redis://...
**Status:** collected
**Destination:** vercel

1. Open Upstash console
2. Copy the Redis URL
`;

  const parsed1 = parseSecretsManifest(original);
  const formatted = formatSecretsManifest(parsed1);
  const parsed2 = parseSecretsManifest(formatted);

  // Verify semantic equality after round-trip
  assert.deepStrictEqual(parsed2.milestone, parsed1.milestone, 'round-trip milestone');
  assert.deepStrictEqual(parsed2.generatedAt, parsed1.generatedAt, 'round-trip generatedAt');
  assert.deepStrictEqual(parsed2.entries.length, parsed1.entries.length, 'round-trip entry count');

  for (let i = 0; i < parsed1.entries.length; i++) {
    const e1 = parsed1.entries[i];
    const e2 = parsed2.entries[i];
    assert.deepStrictEqual(e2.key, e1.key, `round-trip entry ${i} key`);
    assert.deepStrictEqual(e2.service, e1.service, `round-trip entry ${i} service`);
    assert.deepStrictEqual(e2.dashboardUrl, e1.dashboardUrl, `round-trip entry ${i} dashboardUrl`);
    assert.deepStrictEqual(e2.formatHint, e1.formatHint, `round-trip entry ${i} formatHint`);
    assert.deepStrictEqual(e2.status, e1.status, `round-trip entry ${i} status`);
    assert.deepStrictEqual(e2.destination, e1.destination, `round-trip entry ${i} destination`);
    assert.deepStrictEqual(e2.guidance.length, e1.guidance.length, `round-trip entry ${i} guidance length`);
    for (let j = 0; j < e1.guidance.length; j++) {
      assert.deepStrictEqual(e2.guidance[j], e1.guidance[j], `round-trip entry ${i} guidance[${j}]`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LLM-style round-trip tests — realistic manifest variations
// ═══════════════════════════════════════════════════════════════════════════
test('LLM round-trip: extra whitespace', () => {
  // LLMs often produce inconsistent indentation and trailing spaces
  const messy = `# Secrets Manifest

**Milestone:**   M010  
**Generated:**   2025-07-01T12:00:00Z  

###   OPENAI_API_KEY  

**Service:**   OpenAI  
**Dashboard:**   https://platform.openai.com/api-keys  
**Format hint:**   starts with sk-  
**Status:**   pending  
**Destination:**   dotenv  

1.   Go to the API keys page  
2.   Create a new key  

###   REDIS_URL  

**Service:**   Upstash  
**Status:**   collected  
**Destination:**   vercel  

1.   Open console  
`;

  const parsed1 = parseSecretsManifest(messy);
  const formatted = formatSecretsManifest(parsed1);
  const parsed2 = parseSecretsManifest(formatted);

  assert.deepStrictEqual(parsed2.milestone, parsed1.milestone, 'whitespace round-trip milestone');
  assert.deepStrictEqual(parsed2.generatedAt, parsed1.generatedAt, 'whitespace round-trip generatedAt');
  assert.deepStrictEqual(parsed2.entries.length, parsed1.entries.length, 'whitespace round-trip entry count');
  assert.deepStrictEqual(parsed2.entries.length, 2, 'whitespace: two entries parsed');

  for (let i = 0; i < parsed1.entries.length; i++) {
    const e1 = parsed1.entries[i];
    const e2 = parsed2.entries[i];
    assert.deepStrictEqual(e2.key, e1.key, `whitespace round-trip entry ${i} key`);
    assert.deepStrictEqual(e2.service, e1.service, `whitespace round-trip entry ${i} service`);
    assert.deepStrictEqual(e2.dashboardUrl, e1.dashboardUrl, `whitespace round-trip entry ${i} dashboardUrl`);
    assert.deepStrictEqual(e2.formatHint, e1.formatHint, `whitespace round-trip entry ${i} formatHint`);
    assert.deepStrictEqual(e2.status, e1.status, `whitespace round-trip entry ${i} status`);
    assert.deepStrictEqual(e2.destination, e1.destination, `whitespace round-trip entry ${i} destination`);
    assert.deepStrictEqual(e2.guidance.length, e1.guidance.length, `whitespace round-trip entry ${i} guidance length`);
    for (let j = 0; j < e1.guidance.length; j++) {
      assert.deepStrictEqual(e2.guidance[j], e1.guidance[j], `whitespace round-trip entry ${i} guidance[${j}]`);
    }
  }

  // Verify the parser correctly stripped trailing whitespace
  assert.deepStrictEqual(parsed1.milestone, 'M010', 'whitespace: milestone trimmed');
  assert.deepStrictEqual(parsed1.entries[0].key, 'OPENAI_API_KEY', 'whitespace: key trimmed');
  assert.deepStrictEqual(parsed1.entries[0].service, 'OpenAI', 'whitespace: service trimmed');
});

test('LLM round-trip: missing optional fields', () => {
  // LLMs may omit Dashboard and Format hint lines entirely
  const minimal = `# Secrets Manifest

**Milestone:** M011
**Generated:** 2025-07-02T08:00:00Z

### DATABASE_URL

**Service:** Neon
**Status:** pending
**Destination:** dotenv

1. Create a Neon project
2. Copy connection string

### WEBHOOK_SECRET

**Service:** Stripe
**Status:** collected
**Destination:** dotenv

1. Go to webhooks
`;

  const parsed1 = parseSecretsManifest(minimal);

  // Verify missing optional fields get defaults
  assert.deepStrictEqual(parsed1.entries[0].dashboardUrl, '', 'missing-optional: no dashboard → empty string');
  assert.deepStrictEqual(parsed1.entries[0].formatHint, '', 'missing-optional: no format hint → empty string');
  assert.deepStrictEqual(parsed1.entries[1].dashboardUrl, '', 'missing-optional: entry 2 no dashboard → empty string');
  assert.deepStrictEqual(parsed1.entries[1].formatHint, '', 'missing-optional: entry 2 no format hint → empty string');

  // Round-trip: formatter omits empty optional fields, re-parse preserves defaults
  const formatted = formatSecretsManifest(parsed1);
  const parsed2 = parseSecretsManifest(formatted);

  assert.deepStrictEqual(parsed2.entries.length, parsed1.entries.length, 'missing-optional round-trip entry count');

  for (let i = 0; i < parsed1.entries.length; i++) {
    const e1 = parsed1.entries[i];
    const e2 = parsed2.entries[i];
    assert.deepStrictEqual(e2.key, e1.key, `missing-optional round-trip entry ${i} key`);
    assert.deepStrictEqual(e2.service, e1.service, `missing-optional round-trip entry ${i} service`);
    assert.deepStrictEqual(e2.dashboardUrl, e1.dashboardUrl, `missing-optional round-trip entry ${i} dashboardUrl`);
    assert.deepStrictEqual(e2.formatHint, e1.formatHint, `missing-optional round-trip entry ${i} formatHint`);
    assert.deepStrictEqual(e2.status, e1.status, `missing-optional round-trip entry ${i} status`);
    assert.deepStrictEqual(e2.destination, e1.destination, `missing-optional round-trip entry ${i} destination`);
    assert.deepStrictEqual(e2.guidance.length, e1.guidance.length, `missing-optional round-trip entry ${i} guidance length`);
  }
});

test('LLM round-trip: extra blank lines', () => {
  // LLMs sometimes insert excessive blank lines between sections
  const blanky = `# Secrets Manifest


**Milestone:** M012
**Generated:** 2025-07-03T14:00:00Z



### API_KEY_ONE


**Service:** ServiceOne
**Dashboard:** https://one.example.com


**Format hint:** key_...
**Status:** pending
**Destination:** dotenv



1. Go to settings


2. Generate key



### API_KEY_TWO



**Service:** ServiceTwo
**Status:** skipped
**Destination:** dotenv


1. Not needed
`;

  const parsed1 = parseSecretsManifest(blanky);

  assert.deepStrictEqual(parsed1.entries.length, 2, 'blank-lines: two entries parsed');
  assert.deepStrictEqual(parsed1.milestone, 'M012', 'blank-lines: milestone parsed');
  assert.deepStrictEqual(parsed1.entries[0].key, 'API_KEY_ONE', 'blank-lines: first key');
  assert.deepStrictEqual(parsed1.entries[0].guidance.length, 2, 'blank-lines: first entry guidance count');
  assert.deepStrictEqual(parsed1.entries[1].key, 'API_KEY_TWO', 'blank-lines: second key');
  assert.deepStrictEqual(parsed1.entries[1].status, 'skipped', 'blank-lines: second entry status');

  // Round-trip produces clean output
  const formatted = formatSecretsManifest(parsed1);
  const parsed2 = parseSecretsManifest(formatted);

  assert.deepStrictEqual(parsed2.entries.length, parsed1.entries.length, 'blank-lines round-trip entry count');

  for (let i = 0; i < parsed1.entries.length; i++) {
    const e1 = parsed1.entries[i];
    const e2 = parsed2.entries[i];
    assert.deepStrictEqual(e2.key, e1.key, `blank-lines round-trip entry ${i} key`);
    assert.deepStrictEqual(e2.service, e1.service, `blank-lines round-trip entry ${i} service`);
    assert.deepStrictEqual(e2.dashboardUrl, e1.dashboardUrl, `blank-lines round-trip entry ${i} dashboardUrl`);
    assert.deepStrictEqual(e2.formatHint, e1.formatHint, `blank-lines round-trip entry ${i} formatHint`);
    assert.deepStrictEqual(e2.status, e1.status, `blank-lines round-trip entry ${i} status`);
    assert.deepStrictEqual(e2.destination, e1.destination, `blank-lines round-trip entry ${i} destination`);
    assert.deepStrictEqual(e2.guidance.length, e1.guidance.length, `blank-lines round-trip entry ${i} guidance length`);
  }

  // Verify the formatted output is cleaner (fewer consecutive blank lines)
  const consecutiveBlanks = formatted.match(/\n{4,}/g);
  assert.ok(consecutiveBlanks === null, 'blank-lines: formatted output has no 4+ consecutive newlines');
});

// ═══════════════════════════════════════════════════════════════════════════
// parseRoadmap: boundary map with embedded code fences (#468)
// ═══════════════════════════════════════════════════════════════════════════
test('parseRoadmap: boundary map with code fences (#468)', () => {
  const content = `# M001: Test

**Vision:** Test

## Slices

- [ ] **S01: Core** \`risk:low\` \`depends:[]\`
- [ ] **S02: API** \`risk:low\` \`depends:[S01]\`

## Boundary Map

### S01 → S02

Produces:
  types.ts — all types
  \`\`\`
  const x = 1;
  \`\`\`

Consumes: nothing
`;

  // This test ensures the boundary map parser does not hang or
  // catastrophically backtrack when content contains code fences.
  const start = Date.now();
  const r = parseRoadmap(content);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1000, `boundary map with code fences parsed in ${elapsed}ms (should be < 1s)`);
  assert.deepStrictEqual(r.slices.length, 2, 'code-fence roadmap: slice count');
  // Boundary map should still parse (may not capture perfectly with code fences, but must not hang)
  assert.ok(r.boundaryMap.length >= 0, 'code-fence roadmap: boundary map parsed without hanging');
});

});
