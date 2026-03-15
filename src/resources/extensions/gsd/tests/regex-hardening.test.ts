// Regex-hardening tests for S02/T02 — proves all 12 regex/parser sites
// accept both M001 (classic) and M001-abc123 (unique) milestone ID formats.
//
// Sections:
//   (a) Directory scanning regex — findMilestoneIds pattern
//   (b) Title-strip regex — milestone title cleanup
//   (c) SLICE_BRANCH_RE — branch name parsing (with/without worktree prefix)
//   (d) Milestone detection regex — hasExistingMilestones pattern
//   (e) MILESTONE_CONTEXT_RE — context write-gate filename match
//   (f) Prompt dispatch regexes — executeMatch and resumeMatch capture
//   (g) milestoneIdSort — mixed-format ordering
//   (h) extractMilestoneSeq — numeric extraction from both formats

import { test } from 'node:test';

import {
  MILESTONE_ID_RE,
  extractMilestoneSeq,
  milestoneIdSort,
} from '../guided-flow.ts';

import { SLICE_BRANCH_RE } from '../worktree.ts';
import { createTestContext } from './test-helpers.ts';


const { assertEq, assertTrue, report } = createTestContext();
// ─── Tests ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('regex-hardening tests');

  // (a) Directory scanning regex — used in state.ts, workspace-index.ts, files.ts
  //     Pattern: /^(M\d+(?:-[a-z0-9]{6})?)/
  {
    console.log('  (a) Directory scanning regex');
    const DIR_SCAN_RE = /^(M\d+(?:-[a-z0-9]{6})?)/;

    // Classic format matches
    assertTrue(DIR_SCAN_RE.test('M001'), 'dir scan matches M001');
    assertTrue(DIR_SCAN_RE.test('M042'), 'dir scan matches M042');
    assertTrue(DIR_SCAN_RE.test('M999'), 'dir scan matches M999');
    assertEq(('M001' as string).match(DIR_SCAN_RE)?.[1], 'M001', 'captures M001');

    // Unique format matches
    assertTrue(DIR_SCAN_RE.test('M001-abc123'), 'dir scan matches M001-abc123');
    assertTrue(DIR_SCAN_RE.test('M042-z9a8b7'), 'dir scan matches M042-z9a8b7');
    assertEq(('M001-abc123' as string).match(DIR_SCAN_RE)?.[1], 'M001-abc123', 'captures M001-abc123 from dir name');

    // Rejects
    assertTrue(!DIR_SCAN_RE.test('S01'), 'dir scan rejects S01');
    assertTrue(!DIR_SCAN_RE.test('X001'), 'dir scan rejects X001');
    assertTrue(!DIR_SCAN_RE.test('.DS_Store'), 'dir scan rejects .DS_Store');
    assertTrue(!DIR_SCAN_RE.test('notes'), 'dir scan rejects notes');
  }

  // (b) Title-strip regex — used in state.ts, workspace-index.ts
  //     Pattern: /^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/
  {
    console.log('  (b) Title-strip regex');
    const TITLE_STRIP_RE = /^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/;

    // Classic format strip
    assertEq('M001: Title'.replace(TITLE_STRIP_RE, ''), 'Title', 'strips M001: Title → Title');
    assertEq('M042: Payment Integration'.replace(TITLE_STRIP_RE, ''), 'Payment Integration', 'strips M042: Payment Integration');

    // Unique format strip
    assertEq('M001-abc123: Title'.replace(TITLE_STRIP_RE, ''), 'Title', 'strips M001-abc123: Title → Title');
    assertEq('M042-z9a8b7: Dashboard'.replace(TITLE_STRIP_RE, ''), 'Dashboard', 'strips M042-z9a8b7: Dashboard');

    // Em dash in title — current format (M001: Title) correctly preserves em dash in title body
    assertEq(
      'M001: Foundation — Build Core'.replace(TITLE_STRIP_RE, ''),
      'Foundation — Build Core',
      'strips M001: prefix and preserves em dash in title body',
    );
    assertEq(
      'M001-abc123: Foundation — Build Core'.replace(TITLE_STRIP_RE, ''),
      'Foundation — Build Core',
      'strips M001-abc123: prefix and preserves em dash in title body (unique format)',
    );

    // Edge case: dash-style separator (M001 — Title: Subtitle preserves colon in body)
    assertEq(
      'M001 — Unique Milestone IDs: Foo'.replace(TITLE_STRIP_RE, ''),
      'Foo',
      'strips M001 — Unique Milestone IDs: Foo → Foo (first colon consumed)',
    );

    // Edge case: colon inside title body preserved
    assertEq(
      'M001: Note: important'.replace(TITLE_STRIP_RE, ''),
      'Note: important',
      'preserves colons in title body',
    );

    // No match — leaves non-milestone strings alone
    assertEq('S01: Slice Title'.replace(TITLE_STRIP_RE, ''), 'S01: Slice Title', 'does not strip S01 prefix');
  }

  // (c) SLICE_BRANCH_RE — from worktree.ts
  //     Pattern: /^gsd\/(?:([a-zA-Z0-9_-]+)\/)?(M\d+(?:-[a-z0-9]{6})?)\/(S\d+)$/
  {
    console.log('  (c) SLICE_BRANCH_RE');

    // Classic format — no worktree prefix
    {
      const m = 'gsd/M001/S01'.match(SLICE_BRANCH_RE);
      assertTrue(m !== null, 'matches gsd/M001/S01');
      assertEq(m?.[1], undefined, 'no worktree prefix for gsd/M001/S01');
      assertEq(m?.[2], 'M001', 'captures M001');
      assertEq(m?.[3], 'S01', 'captures S01');
    }

    // Unique format — no worktree prefix
    {
      const m = 'gsd/M001-abc123/S01'.match(SLICE_BRANCH_RE);
      assertTrue(m !== null, 'matches gsd/M001-abc123/S01');
      assertEq(m?.[1], undefined, 'no worktree prefix for unique format');
      assertEq(m?.[2], 'M001-abc123', 'captures M001-abc123');
      assertEq(m?.[3], 'S01', 'captures S01');
    }

    // Classic format — with worktree prefix
    {
      const m = 'gsd/worktree/M001/S01'.match(SLICE_BRANCH_RE);
      assertTrue(m !== null, 'matches gsd/worktree/M001/S01');
      assertEq(m?.[1], 'worktree', 'captures worktree prefix');
      assertEq(m?.[2], 'M001', 'captures M001 with worktree');
      assertEq(m?.[3], 'S01', 'captures S01 with worktree');
    }

    // Unique format — with worktree prefix
    {
      const m = 'gsd/worktree/M001-abc123/S01'.match(SLICE_BRANCH_RE);
      assertTrue(m !== null, 'matches gsd/worktree/M001-abc123/S01');
      assertEq(m?.[1], 'worktree', 'captures worktree prefix with unique format');
      assertEq(m?.[2], 'M001-abc123', 'captures M001-abc123 with worktree');
      assertEq(m?.[3], 'S01', 'captures S01 with worktree and unique format');
    }

    // Rejects
    assertTrue(!SLICE_BRANCH_RE.test('gsd/S01'), 'rejects gsd/S01 (no milestone)');
    assertTrue(!SLICE_BRANCH_RE.test('main'), 'rejects main');
    assertTrue(!SLICE_BRANCH_RE.test('gsd/M001'), 'rejects gsd/M001 (no slice)');
    assertTrue(!SLICE_BRANCH_RE.test('feature/M001/S01'), 'rejects feature/ prefix');
  }

  // (d) Milestone detection regex — used in worktree-command.ts (hasExistingMilestones)
  //     Pattern: /^M\d+(?:-[a-z0-9]{6})?/
  {
    console.log('  (d) Milestone detection regex');
    const MILESTONE_DETECT_RE = /^M\d+(?:-[a-z0-9]{6})?/;

    // Classic format matches
    assertTrue(MILESTONE_DETECT_RE.test('M001'), 'detect matches M001');
    assertTrue(MILESTONE_DETECT_RE.test('M042'), 'detect matches M042');

    // Unique format matches
    assertTrue(MILESTONE_DETECT_RE.test('M001-abc123'), 'detect matches M001-abc123');
    assertTrue(MILESTONE_DETECT_RE.test('M042-z9a8b7'), 'detect matches M042-z9a8b7');

    // Rejects
    assertTrue(!MILESTONE_DETECT_RE.test('S01'), 'detect rejects S01');
    assertTrue(!MILESTONE_DETECT_RE.test('notes'), 'detect rejects notes');
    assertTrue(!MILESTONE_DETECT_RE.test('.DS_Store'), 'detect rejects .DS_Store');
  }

  // (e) MILESTONE_CONTEXT_RE — used in index.ts (write-gate)
  //     Pattern: /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/
  {
    console.log('  (e) MILESTONE_CONTEXT_RE');
    const CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;

    // Classic format matches
    assertTrue(CONTEXT_RE.test('M001-CONTEXT.md'), 'context matches M001-CONTEXT.md');
    assertTrue(CONTEXT_RE.test('.gsd/milestones/M001/M001-CONTEXT.md'), 'context matches full path classic format');

    // Unique format matches
    assertTrue(CONTEXT_RE.test('M001-abc123-CONTEXT.md'), 'context matches M001-abc123-CONTEXT.md');
    assertTrue(CONTEXT_RE.test('.gsd/milestones/M001-abc123/M001-abc123-CONTEXT.md'), 'context matches full path unique format');

    // Rejects
    assertTrue(!CONTEXT_RE.test('M001-ROADMAP.md'), 'context rejects M001-ROADMAP.md');
    assertTrue(!CONTEXT_RE.test('M001-SUMMARY.md'), 'context rejects M001-SUMMARY.md');
    assertTrue(!CONTEXT_RE.test('CONTEXT.md'), 'context rejects bare CONTEXT.md');
  }

  // (f) Prompt dispatch regexes — used in index.ts (executeMatch, resumeMatch)
  {
    console.log('  (f) Prompt dispatch regexes');
    const EXECUTE_RE = /Execute the next task:\s+(T\d+)\s+\("([^"]+)"\)\s+in slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i;
    const RESUME_RE = /Resume interrupted work\.[\s\S]*?slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i;

    // Execute — classic format
    {
      const prompt = 'Execute the next task: T01 ("Write tests") in slice S01 of milestone M001';
      const m = prompt.match(EXECUTE_RE);
      assertTrue(m !== null, 'execute matches classic format');
      assertEq(m?.[1], 'T01', 'execute captures T01');
      assertEq(m?.[3], 'S01', 'execute captures S01');
      assertEq(m?.[4], 'M001', 'execute captures M001');
    }

    // Execute — unique format
    {
      const prompt = 'Execute the next task: T02 ("Build feature") in slice S03 of milestone M001-abc123';
      const m = prompt.match(EXECUTE_RE);
      assertTrue(m !== null, 'execute matches unique format');
      assertEq(m?.[1], 'T02', 'execute captures T02 (unique format)');
      assertEq(m?.[3], 'S03', 'execute captures S03 (unique format)');
      assertEq(m?.[4], 'M001-abc123', 'execute captures M001-abc123');
    }

    // Resume — classic format
    {
      const prompt = 'Resume interrupted work.\nContinuing slice S02 of milestone M001';
      const m = prompt.match(RESUME_RE);
      assertTrue(m !== null, 'resume matches classic format');
      assertEq(m?.[1], 'S02', 'resume captures S02');
      assertEq(m?.[2], 'M001', 'resume captures M001');
    }

    // Resume — unique format
    {
      const prompt = 'Resume interrupted work.\nContinuing slice S01 of milestone M042-z9a8b7';
      const m = prompt.match(RESUME_RE);
      assertTrue(m !== null, 'resume matches unique format');
      assertEq(m?.[1], 'S01', 'resume captures S01 (unique format)');
      assertEq(m?.[2], 'M042-z9a8b7', 'resume captures M042-z9a8b7');
    }
  }

  // (g) milestoneIdSort — mixed-format ordering
  {
    console.log('  (g) milestoneIdSort');
    const mixed = ['M002-abc123', 'M001', 'M001-xyz789'];
    const sorted = [...mixed].sort(milestoneIdSort);
    assertEq(sorted, ['M001', 'M001-xyz789', 'M002-abc123'], 'sorts mixed IDs by sequence number');

    // Stable within same seq — preserves insertion order
    const sameSorted = ['M001-abc123', 'M001'].sort(milestoneIdSort);
    assertEq(sameSorted[0], 'M001-abc123', 'same seq preserves order (first)');
    assertEq(sameSorted[1], 'M001', 'same seq preserves order (second)');

    // Classic format only
    const oldOnly = ['M003', 'M001', 'M002'];
    assertEq([...oldOnly].sort(milestoneIdSort), ['M001', 'M002', 'M003'], 'sorts classic-format IDs');

    // Unique format only
    const newOnly = ['M003-abc123', 'M001-def456', 'M002-ghi789'];
    assertEq([...newOnly].sort(milestoneIdSort), ['M001-def456', 'M002-ghi789', 'M003-abc123'], 'sorts unique-format IDs');
  }

  // (h) extractMilestoneSeq — numeric extraction from both formats
  {
    console.log('  (h) extractMilestoneSeq');

    // Classic format
    assertEq(extractMilestoneSeq('M001'), 1, 'M001 → 1');
    assertEq(extractMilestoneSeq('M042'), 42, 'M042 → 42');
    assertEq(extractMilestoneSeq('M999'), 999, 'M999 → 999');

    // Unique format — confirms dispatch-guard refactor correctness
    assertEq(extractMilestoneSeq('M001-abc123'), 1, 'M001-abc123 → 1');
    assertEq(extractMilestoneSeq('M042-z9a8b7'), 42, 'M042-z9a8b7 → 42');
    assertEq(extractMilestoneSeq('M100-xyz789'), 100, 'M100-xyz789 → 100');

    // Invalid → 0 (not NaN — the old parseInt(slice(1)) bug)
    assertEq(extractMilestoneSeq(''), 0, 'empty → 0');
    assertEq(extractMilestoneSeq('notes'), 0, 'notes → 0');
    assertEq(extractMilestoneSeq('S01'), 0, 'S01 → 0');
    assertTrue(!Number.isNaN(extractMilestoneSeq('M001-abc123')), 'unique format does not return NaN');
    assertTrue(!Number.isNaN(extractMilestoneSeq('M001-ABCDEF')), 'invalid format does not return NaN');
  }

  report();
}

test('regex-hardening: all 12 sites accept both formats', async () => {
  await main();
});
