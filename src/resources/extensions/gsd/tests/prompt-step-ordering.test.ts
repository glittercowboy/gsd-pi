/**
 * Regression test for #3696 — prompt step ordering and runtime fixes
 *
 * 1. complete-milestone.md: gsd_requirement_update (step 9) before
 *    gsd_complete_milestone (step 10)
 * 2. complete-slice.md: uses gsd_requirement_update
 * 3. register-extension.ts: _gsdEpipeGuard logs instead of re-throwing
 * 4. register-hooks.ts: session_before_compact only checks isAutoActive
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractSourceRegion } from "./test-helpers.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const completeMilestoneMd = readFileSync(
  join(__dirname, '..', 'prompts', 'complete-milestone.md'),
  'utf-8',
);
const completeSliceMd = readFileSync(
  join(__dirname, '..', 'prompts', 'complete-slice.md'),
  'utf-8',
);
const registerExtSrc = readFileSync(
  join(__dirname, '..', 'bootstrap', 'register-extension.ts'),
  'utf-8',
);
const registerHooksSrc = readFileSync(
  join(__dirname, '..', 'bootstrap', 'register-hooks.ts'),
  'utf-8',
);

describe('prompt step ordering (#3696)', () => {
  test('gsd_requirement_update step appears before gsd_complete_milestone step', () => {
    // Search for the numbered step definitions, not early "Do NOT call" warnings
    const reqUpdateMatch = completeMilestoneMd.match(/^\d+\.\s.*gsd_requirement_update/m);
    const completeMilestoneMatch = completeMilestoneMd.match(/^\d+\.\s.*gsd_complete_milestone/m);
    assert.ok(reqUpdateMatch, 'gsd_requirement_update should appear in a numbered step');
    assert.ok(completeMilestoneMatch, 'gsd_complete_milestone should appear in a numbered step');
    const reqUpdateIdx = completeMilestoneMd.indexOf(reqUpdateMatch![0]);
    const completeMilestoneIdx = completeMilestoneMd.indexOf(completeMilestoneMatch![0]);
    assert.ok(
      reqUpdateIdx < completeMilestoneIdx,
      'gsd_requirement_update step must come before gsd_complete_milestone step',
    );
  });

  test('complete-slice.md uses gsd_requirement_update', () => {
    assert.match(completeSliceMd, /gsd_requirement_update/,
      'complete-slice.md should reference gsd_requirement_update');
  });
});

describe('register-extension _gsdEpipeGuard (#3696)', () => {
  test('_gsdEpipeGuard exists and does not re-throw', () => {
    assert.match(registerExtSrc, /_gsdEpipeGuard/,
      '_gsdEpipeGuard should be defined in register-extension.ts');
    // After the fix, the handler logs instead of throwing
    assert.ok(
      !registerExtSrc.includes('throw err'),
      '_gsdEpipeGuard should NOT contain "throw err"',
    );
  });
});

describe('register-hooks session_before_compact (#3696)', () => {
  test('session_before_compact only checks isAutoActive', () => {
    // Anchor on the full registration token rather than the bare event name —
    // prevents matching unrelated substring occurrences.
    const compactIdx = registerHooksSrc.indexOf('pi.on("session_before_compact"');
    assert.ok(compactIdx > -1, 'session_before_compact hook should exist');
    // The first check in the handler should be isAutoActive(), not isAutoPaused().
    // Bound the region to this single handler — register-hooks.ts contains
    // multiple pi.on("session_before_compact") handlers and a later handler
    // legitimately references isAutoPaused.
    const afterCompact = extractSourceRegion(
      registerHooksSrc,
      'pi.on("session_before_compact"',
      'pi.on("',
      // NB: endAnchor search starts AFTER the startAnchor, so the next
      // pi.on("... matches the subsequent handler rather than this one.
    );
    assert.match(afterCompact, /isAutoActive\(\)/,
      'session_before_compact should check isAutoActive()');
    // Should NOT block compaction when paused
    assert.ok(
      !afterCompact.includes('isAutoPaused()'),
      'session_before_compact should not check isAutoPaused',
    );
  });
});
