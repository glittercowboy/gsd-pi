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

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  MILESTONE_ID_RE,
  extractMilestoneSeq,
  milestoneIdSort,
} from '../guided-flow.ts';

import { SLICE_BRANCH_RE } from '../worktree.ts';

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('(a) Directory scanning regex', () => {
  const DIR_SCAN_RE = /^(M\d+(?:-[a-z0-9]{6})?)/;

  test('matches M001', () => {
    assert.ok(DIR_SCAN_RE.test('M001'), 'dir scan matches M001');
  });

  test('matches M042', () => {
    assert.ok(DIR_SCAN_RE.test('M042'), 'dir scan matches M042');
  });

  test('matches M999', () => {
    assert.ok(DIR_SCAN_RE.test('M999'), 'dir scan matches M999');
  });

  test('captures M001', () => {
    assert.deepStrictEqual(('M001' as string).match(DIR_SCAN_RE)?.[1], 'M001', 'captures M001');
  });

  test('matches M001-abc123', () => {
    assert.ok(DIR_SCAN_RE.test('M001-abc123'), 'dir scan matches M001-abc123');
  });

  test('matches M042-z9a8b7', () => {
    assert.ok(DIR_SCAN_RE.test('M042-z9a8b7'), 'dir scan matches M042-z9a8b7');
  });

  test('captures M001-abc123 from dir name', () => {
    assert.deepStrictEqual(('M001-abc123' as string).match(DIR_SCAN_RE)?.[1], 'M001-abc123', 'captures M001-abc123 from dir name');
  });

  test('rejects S01', () => {
    assert.ok(!DIR_SCAN_RE.test('S01'), 'dir scan rejects S01');
  });

  test('rejects X001', () => {
    assert.ok(!DIR_SCAN_RE.test('X001'), 'dir scan rejects X001');
  });

  test('rejects .DS_Store', () => {
    assert.ok(!DIR_SCAN_RE.test('.DS_Store'), 'dir scan rejects .DS_Store');
  });

  test('rejects notes', () => {
    assert.ok(!DIR_SCAN_RE.test('notes'), 'dir scan rejects notes');
  });
});

describe('(b) Title-strip regex', () => {
  const TITLE_STRIP_RE = /^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/;

  test('strips M001: Title → Title', () => {
    assert.deepStrictEqual('M001: Title'.replace(TITLE_STRIP_RE, ''), 'Title', 'strips M001: Title → Title');
  });

  test('strips M042: Payment Integration', () => {
    assert.deepStrictEqual('M042: Payment Integration'.replace(TITLE_STRIP_RE, ''), 'Payment Integration', 'strips M042: Payment Integration');
  });

  test('strips M001-abc123: Title → Title', () => {
    assert.deepStrictEqual('M001-abc123: Title'.replace(TITLE_STRIP_RE, ''), 'Title', 'strips M001-abc123: Title → Title');
  });

  test('strips M042-z9a8b7: Dashboard', () => {
    assert.deepStrictEqual('M042-z9a8b7: Dashboard'.replace(TITLE_STRIP_RE, ''), 'Dashboard', 'strips M042-z9a8b7: Dashboard');
  });

  test('strips M001: prefix and preserves em dash in title body', () => {
    assert.deepStrictEqual(
      'M001: Foundation — Build Core'.replace(TITLE_STRIP_RE, ''),
      'Foundation — Build Core',
      'strips M001: prefix and preserves em dash in title body',
    );
  });

  test('strips M001-abc123: prefix and preserves em dash in title body (unique format)', () => {
    assert.deepStrictEqual(
      'M001-abc123: Foundation — Build Core'.replace(TITLE_STRIP_RE, ''),
      'Foundation — Build Core',
      'strips M001-abc123: prefix and preserves em dash in title body (unique format)',
    );
  });

  test('strips M001 — Unique Milestone IDs: Foo → Foo (first colon consumed)', () => {
    assert.deepStrictEqual(
      'M001 — Unique Milestone IDs: Foo'.replace(TITLE_STRIP_RE, ''),
      'Foo',
      'strips M001 — Unique Milestone IDs: Foo → Foo (first colon consumed)',
    );
  });

  test('preserves colons in title body', () => {
    assert.deepStrictEqual(
      'M001: Note: important'.replace(TITLE_STRIP_RE, ''),
      'Note: important',
      'preserves colons in title body',
    );
  });

  test('does not strip S01 prefix', () => {
    assert.deepStrictEqual('S01: Slice Title'.replace(TITLE_STRIP_RE, ''), 'S01: Slice Title', 'does not strip S01 prefix');
  });
});

describe('(c) SLICE_BRANCH_RE', () => {
  test('matches gsd/M001/S01 (classic, no worktree prefix)', () => {
    const m = 'gsd/M001/S01'.match(SLICE_BRANCH_RE);
    assert.ok(m !== null, 'matches gsd/M001/S01');
    assert.deepStrictEqual(m?.[1], undefined, 'no worktree prefix for gsd/M001/S01');
    assert.deepStrictEqual(m?.[2], 'M001', 'captures M001');
    assert.deepStrictEqual(m?.[3], 'S01', 'captures S01');
  });

  test('matches gsd/M001-abc123/S01 (unique, no worktree prefix)', () => {
    const m = 'gsd/M001-abc123/S01'.match(SLICE_BRANCH_RE);
    assert.ok(m !== null, 'matches gsd/M001-abc123/S01');
    assert.deepStrictEqual(m?.[1], undefined, 'no worktree prefix for unique format');
    assert.deepStrictEqual(m?.[2], 'M001-abc123', 'captures M001-abc123');
    assert.deepStrictEqual(m?.[3], 'S01', 'captures S01');
  });

  test('matches gsd/worktree/M001/S01 (classic, with worktree prefix)', () => {
    const m = 'gsd/worktree/M001/S01'.match(SLICE_BRANCH_RE);
    assert.ok(m !== null, 'matches gsd/worktree/M001/S01');
    assert.deepStrictEqual(m?.[1], 'worktree', 'captures worktree prefix');
    assert.deepStrictEqual(m?.[2], 'M001', 'captures M001 with worktree');
    assert.deepStrictEqual(m?.[3], 'S01', 'captures S01 with worktree');
  });

  test('matches gsd/worktree/M001-abc123/S01 (unique, with worktree prefix)', () => {
    const m = 'gsd/worktree/M001-abc123/S01'.match(SLICE_BRANCH_RE);
    assert.ok(m !== null, 'matches gsd/worktree/M001-abc123/S01');
    assert.deepStrictEqual(m?.[1], 'worktree', 'captures worktree prefix with unique format');
    assert.deepStrictEqual(m?.[2], 'M001-abc123', 'captures M001-abc123 with worktree');
    assert.deepStrictEqual(m?.[3], 'S01', 'captures S01 with worktree and unique format');
  });

  test('rejects gsd/S01 (no milestone)', () => {
    assert.ok(!SLICE_BRANCH_RE.test('gsd/S01'), 'rejects gsd/S01 (no milestone)');
  });

  test('rejects main', () => {
    assert.ok(!SLICE_BRANCH_RE.test('main'), 'rejects main');
  });

  test('rejects gsd/M001 (no slice)', () => {
    assert.ok(!SLICE_BRANCH_RE.test('gsd/M001'), 'rejects gsd/M001 (no slice)');
  });

  test('rejects feature/ prefix', () => {
    assert.ok(!SLICE_BRANCH_RE.test('feature/M001/S01'), 'rejects feature/ prefix');
  });
});

describe('(d) Milestone detection regex', () => {
  const MILESTONE_DETECT_RE = /^M\d+(?:-[a-z0-9]{6})?/;

  test('matches M001', () => {
    assert.ok(MILESTONE_DETECT_RE.test('M001'), 'detect matches M001');
  });

  test('matches M042', () => {
    assert.ok(MILESTONE_DETECT_RE.test('M042'), 'detect matches M042');
  });

  test('matches M001-abc123', () => {
    assert.ok(MILESTONE_DETECT_RE.test('M001-abc123'), 'detect matches M001-abc123');
  });

  test('matches M042-z9a8b7', () => {
    assert.ok(MILESTONE_DETECT_RE.test('M042-z9a8b7'), 'detect matches M042-z9a8b7');
  });

  test('rejects S01', () => {
    assert.ok(!MILESTONE_DETECT_RE.test('S01'), 'detect rejects S01');
  });

  test('rejects notes', () => {
    assert.ok(!MILESTONE_DETECT_RE.test('notes'), 'detect rejects notes');
  });

  test('rejects .DS_Store', () => {
    assert.ok(!MILESTONE_DETECT_RE.test('.DS_Store'), 'detect rejects .DS_Store');
  });
});

describe('(e) MILESTONE_CONTEXT_RE', () => {
  const CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;

  test('matches M001-CONTEXT.md', () => {
    assert.ok(CONTEXT_RE.test('M001-CONTEXT.md'), 'context matches M001-CONTEXT.md');
  });

  test('matches full path classic format', () => {
    assert.ok(CONTEXT_RE.test('.gsd/milestones/M001/M001-CONTEXT.md'), 'context matches full path classic format');
  });

  test('matches M001-abc123-CONTEXT.md', () => {
    assert.ok(CONTEXT_RE.test('M001-abc123-CONTEXT.md'), 'context matches M001-abc123-CONTEXT.md');
  });

  test('matches full path unique format', () => {
    assert.ok(CONTEXT_RE.test('.gsd/milestones/M001-abc123/M001-abc123-CONTEXT.md'), 'context matches full path unique format');
  });

  test('rejects M001-ROADMAP.md', () => {
    assert.ok(!CONTEXT_RE.test('M001-ROADMAP.md'), 'context rejects M001-ROADMAP.md');
  });

  test('rejects M001-SUMMARY.md', () => {
    assert.ok(!CONTEXT_RE.test('M001-SUMMARY.md'), 'context rejects M001-SUMMARY.md');
  });

  test('rejects bare CONTEXT.md', () => {
    assert.ok(!CONTEXT_RE.test('CONTEXT.md'), 'context rejects bare CONTEXT.md');
  });
});

describe('(f) Prompt dispatch regexes', () => {
  const EXECUTE_RE = /Execute the next task:\s+(T\d+)\s+\("([^"]+)"\)\s+in slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i;
  const RESUME_RE = /Resume interrupted work\.[\s\S]*?slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i;

  test('execute matches classic format', () => {
    const prompt = 'Execute the next task: T01 ("Write tests") in slice S01 of milestone M001';
    const m = prompt.match(EXECUTE_RE);
    assert.ok(m !== null, 'execute matches classic format');
    assert.deepStrictEqual(m?.[1], 'T01', 'execute captures T01');
    assert.deepStrictEqual(m?.[3], 'S01', 'execute captures S01');
    assert.deepStrictEqual(m?.[4], 'M001', 'execute captures M001');
  });

  test('execute matches unique format', () => {
    const prompt = 'Execute the next task: T02 ("Build feature") in slice S03 of milestone M001-abc123';
    const m = prompt.match(EXECUTE_RE);
    assert.ok(m !== null, 'execute matches unique format');
    assert.deepStrictEqual(m?.[1], 'T02', 'execute captures T02 (unique format)');
    assert.deepStrictEqual(m?.[3], 'S03', 'execute captures S03 (unique format)');
    assert.deepStrictEqual(m?.[4], 'M001-abc123', 'execute captures M001-abc123');
  });

  test('resume matches classic format', () => {
    const prompt = 'Resume interrupted work.\nContinuing slice S02 of milestone M001';
    const m = prompt.match(RESUME_RE);
    assert.ok(m !== null, 'resume matches classic format');
    assert.deepStrictEqual(m?.[1], 'S02', 'resume captures S02');
    assert.deepStrictEqual(m?.[2], 'M001', 'resume captures M001');
  });

  test('resume matches unique format', () => {
    const prompt = 'Resume interrupted work.\nContinuing slice S01 of milestone M042-z9a8b7';
    const m = prompt.match(RESUME_RE);
    assert.ok(m !== null, 'resume matches unique format');
    assert.deepStrictEqual(m?.[1], 'S01', 'resume captures S01 (unique format)');
    assert.deepStrictEqual(m?.[2], 'M042-z9a8b7', 'resume captures M042-z9a8b7');
  });
});

describe('(g) milestoneIdSort', () => {
  test('sorts mixed IDs by sequence number', () => {
    const mixed = ['M002-abc123', 'M001', 'M001-xyz789'];
    const sorted = [...mixed].sort(milestoneIdSort);
    assert.deepStrictEqual(sorted, ['M001', 'M001-xyz789', 'M002-abc123'], 'sorts mixed IDs by sequence number');
  });

  test('same seq preserves order (first)', () => {
    const sameSorted = ['M001-abc123', 'M001'].sort(milestoneIdSort);
    assert.deepStrictEqual(sameSorted[0], 'M001-abc123', 'same seq preserves order (first)');
  });

  test('same seq preserves order (second)', () => {
    const sameSorted = ['M001-abc123', 'M001'].sort(milestoneIdSort);
    assert.deepStrictEqual(sameSorted[1], 'M001', 'same seq preserves order (second)');
  });

  test('sorts classic-format IDs', () => {
    const oldOnly = ['M003', 'M001', 'M002'];
    assert.deepStrictEqual([...oldOnly].sort(milestoneIdSort), ['M001', 'M002', 'M003'], 'sorts classic-format IDs');
  });

  test('sorts unique-format IDs', () => {
    const newOnly = ['M003-abc123', 'M001-def456', 'M002-ghi789'];
    assert.deepStrictEqual([...newOnly].sort(milestoneIdSort), ['M001-def456', 'M002-ghi789', 'M003-abc123'], 'sorts unique-format IDs');
  });
});

describe('(h) extractMilestoneSeq', () => {
  test('M001 → 1', () => {
    assert.deepStrictEqual(extractMilestoneSeq('M001'), 1, 'M001 → 1');
  });

  test('M042 → 42', () => {
    assert.deepStrictEqual(extractMilestoneSeq('M042'), 42, 'M042 → 42');
  });

  test('M999 → 999', () => {
    assert.deepStrictEqual(extractMilestoneSeq('M999'), 999, 'M999 → 999');
  });

  test('M001-abc123 → 1', () => {
    assert.deepStrictEqual(extractMilestoneSeq('M001-abc123'), 1, 'M001-abc123 → 1');
  });

  test('M042-z9a8b7 → 42', () => {
    assert.deepStrictEqual(extractMilestoneSeq('M042-z9a8b7'), 42, 'M042-z9a8b7 → 42');
  });

  test('M100-xyz789 → 100', () => {
    assert.deepStrictEqual(extractMilestoneSeq('M100-xyz789'), 100, 'M100-xyz789 → 100');
  });

  test('empty → 0', () => {
    assert.deepStrictEqual(extractMilestoneSeq(''), 0, 'empty → 0');
  });

  test('notes → 0', () => {
    assert.deepStrictEqual(extractMilestoneSeq('notes'), 0, 'notes → 0');
  });

  test('S01 → 0', () => {
    assert.deepStrictEqual(extractMilestoneSeq('S01'), 0, 'S01 → 0');
  });

  test('unique format does not return NaN', () => {
    assert.ok(!Number.isNaN(extractMilestoneSeq('M001-abc123')), 'unique format does not return NaN');
  });

  test('invalid format does not return NaN', () => {
    assert.ok(!Number.isNaN(extractMilestoneSeq('M001-ABCDEF')), 'invalid format does not return NaN');
  });
});
