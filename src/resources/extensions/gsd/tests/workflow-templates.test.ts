// GSD Workflow Templates — Unit Tests
//
// Tests registry loading, template resolution, auto-detection, and listing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRegistry,
  resolveByName,
  autoDetect,
  listTemplates,
  getTemplateInfo,
  loadWorkflowTemplate,
} from '../workflow-templates.ts';


// ═══════════════════════════════════════════════════════════════════════════
// Registry Loading
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Registry Loading ──');

{
  const registry = loadRegistry();
  assert.ok(registry !== null, 'Registry should load');
  assert.deepStrictEqual(registry.version, 1, 'Registry version should be 1');
  assert.ok(Object.keys(registry.templates).length >= 8, 'Should have at least 8 templates');

  // Verify required template keys exist
  const expectedIds = ['full-project', 'bugfix', 'small-feature', 'refactor', 'spike', 'hotfix', 'security-audit', 'dep-upgrade'];
  for (const id of expectedIds) {
    assert.ok(id in registry.templates, `Template "${id}" should exist in registry`);
  }

  // Verify each template has required fields
  for (const [id, entry] of Object.entries(registry.templates)) {
    assert.ok(typeof entry.name === 'string' && entry.name.length > 0, `${id}: name should be non-empty string`);
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0, `${id}: description should be non-empty`);
    assert.ok(typeof entry.file === 'string' && entry.file.endsWith('.md'), `${id}: file should be a .md path`);
    assert.ok(Array.isArray(entry.phases) && entry.phases.length > 0, `${id}: phases should be non-empty array`);
    assert.ok(Array.isArray(entry.triggers) && entry.triggers.length > 0, `${id}: triggers should be non-empty array`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Resolve by Name
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Resolve by Name ──');

{
  // Exact match
  const bugfix = resolveByName('bugfix');
  assert.ok(bugfix !== null, 'Should resolve "bugfix"');
  assert.deepStrictEqual(bugfix!.id, 'bugfix', 'ID should be "bugfix"');
  assert.deepStrictEqual(bugfix!.confidence, 'exact', 'Exact name should have exact confidence');

  // Case-insensitive name match
  const spike = resolveByName('Research Spike');
  assert.ok(spike !== null, 'Should resolve "Research Spike" by name');
  assert.deepStrictEqual(spike!.id, 'spike', 'Should resolve to spike');

  // Alias match
  const bug = resolveByName('bug');
  assert.ok(bug !== null, 'Should resolve "bug" alias');
  assert.deepStrictEqual(bug!.id, 'bugfix', 'Alias "bug" should map to bugfix');

  const feat = resolveByName('feat');
  assert.ok(feat !== null, 'Should resolve "feat" alias');
  assert.deepStrictEqual(feat!.id, 'small-feature', 'Alias "feat" should map to small-feature');

  const deps = resolveByName('deps');
  assert.ok(deps !== null, 'Should resolve "deps" alias');
  assert.deepStrictEqual(deps!.id, 'dep-upgrade', 'Alias "deps" should map to dep-upgrade');

  // No match
  const missing = resolveByName('nonexistent-template');
  assert.ok(missing === null, 'Should return null for unknown template');
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-Detection
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Auto-Detection ──');

{
  // Should detect bugfix from "fix" keyword
  const fixMatches = autoDetect('fix the login button');
  assert.ok(fixMatches.length > 0, 'Should detect matches for "fix the login button"');
  assert.ok(fixMatches.some(m => m.id === 'bugfix'), 'Should include bugfix in matches');

  // Should detect spike from "research" keyword
  const researchMatches = autoDetect('research authentication libraries');
  assert.ok(researchMatches.length > 0, 'Should detect matches for "research"');
  assert.ok(researchMatches.some(m => m.id === 'spike'), 'Should include spike in matches');

  // Should detect hotfix from "urgent" keyword
  const urgentMatches = autoDetect('urgent production is down');
  assert.ok(urgentMatches.length > 0, 'Should detect matches for "urgent"');
  assert.ok(urgentMatches.some(m => m.id === 'hotfix'), 'Should include hotfix in matches');

  // Should detect dep-upgrade from "upgrade" keyword
  const upgradeMatches = autoDetect('upgrade react to v19');
  assert.ok(upgradeMatches.length > 0, 'Should detect matches for "upgrade"');
  assert.ok(upgradeMatches.some(m => m.id === 'dep-upgrade'), 'Should include dep-upgrade in matches');

  // Multi-word triggers should score higher
  const projectMatches = autoDetect('create a new project from scratch');
  const projectMatch = projectMatches.find(m => m.id === 'full-project');
  assert.ok(projectMatch !== undefined, 'Should detect full-project for "from scratch"');

  // Empty input should return no matches
  const emptyMatches = autoDetect('');
  assert.deepStrictEqual(emptyMatches.length, 0, 'Empty input should return no matches');
}

// ═══════════════════════════════════════════════════════════════════════════
// List Templates
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── List Templates ──');

{
  const output = listTemplates();
  assert.ok(output.includes('Workflow Templates'), 'Should have header');
  assert.ok(output.includes('bugfix'), 'Should list bugfix');
  assert.ok(output.includes('spike'), 'Should list spike');
  assert.ok(output.includes('hotfix'), 'Should list hotfix');
  assert.ok(output.includes('/gsd start'), 'Should include usage hint');
}

// ═══════════════════════════════════════════════════════════════════════════
// Template Info
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Template Info ──');

{
  const info = getTemplateInfo('bugfix');
  assert.ok(info !== null, 'Should return info for bugfix');
  assert.ok(info!.includes('Bug Fix'), 'Should include template name');
  assert.ok(info!.includes('triage'), 'Should include phase names');
  assert.ok(info!.includes('Triggers'), 'Should include triggers section');

  const missing = getTemplateInfo('nonexistent');
  assert.ok(missing === null, 'Should return null for unknown template');
}

// ═══════════════════════════════════════════════════════════════════════════
// Load Workflow Template Content
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Load Workflow Template ──');

{
  const content = loadWorkflowTemplate('bugfix');
  assert.ok(content !== null, 'Should load bugfix template');
  assert.ok(content!.includes('Bugfix Workflow'), 'Should contain workflow title');
  assert.ok(content!.includes('Phase 1: Triage'), 'Should contain triage phase');
  assert.ok(content!.includes('Phase 4: Ship'), 'Should contain ship phase');

  const hotfixContent = loadWorkflowTemplate('hotfix');
  assert.ok(hotfixContent !== null, 'Should load hotfix template');
  assert.ok(hotfixContent!.includes('Hotfix Workflow'), 'Should contain hotfix title');

  const missingContent = loadWorkflowTemplate('nonexistent');
  assert.ok(missingContent === null, 'Should return null for unknown template');
}

// ═══════════════════════════════════════════════════════════════════════════
