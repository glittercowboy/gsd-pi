
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

