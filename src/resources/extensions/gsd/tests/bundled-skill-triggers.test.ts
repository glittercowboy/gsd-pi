// GSD-2 — BUNDLED_SKILL_TRIGGERS regression test
//
// Guards the skill-trigger table in system-context.ts against accidental
// regression. Every entry must have a non-empty trigger + skill, and the
// skills added in PR #4505 must remain present.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BUNDLED_SKILL_TRIGGERS } from '../bootstrap/system-context.ts';

test('BUNDLED_SKILL_TRIGGERS: every entry has a non-empty trigger and skill', () => {
  assert.ok(BUNDLED_SKILL_TRIGGERS.length > 0, 'table should not be empty');
  for (const { trigger, skill } of BUNDLED_SKILL_TRIGGERS) {
    assert.ok(trigger && trigger.trim().length > 0, `trigger missing for skill="${skill}"`);
    assert.ok(skill && skill.trim().length > 0, `skill missing for trigger="${trigger}"`);
  }
});

test('BUNDLED_SKILL_TRIGGERS: PR #4505 bundled skills are present', () => {
  const expected = [
    'review',
    'test',
    'lint',
    'make-interfaces-feel-better',
    'accessibility',
    'grill-me',
    'design-an-interface',
    'tdd',
    'write-milestone-brief',
    'decompose-into-slices',
    'spike-wrap-up',
    'verify-before-complete',
    'create-mcp-server',
    'write-docs',
    'forensics',
    'handoff',
    'security-review',
    'api-design',
    'dependency-upgrade',
    'observability',
  ];
  const registered = new Set(BUNDLED_SKILL_TRIGGERS.map(e => e.skill));
  for (const skill of expected) {
    assert.ok(registered.has(skill), `expected bundled skill "${skill}" to be registered`);
  }
});

test('BUNDLED_SKILL_TRIGGERS: skill ids are unique', () => {
  const seen = new Set<string>();
  for (const { skill } of BUNDLED_SKILL_TRIGGERS) {
    assert.ok(!seen.has(skill), `duplicate skill registration: ${skill}`);
    seen.add(skill);
  }
});
