import { createTestContext } from './test-helpers.ts';
import { parseMemoryResponse, _resetExtractionState } from '../memory-extractor.ts';
import {
  openDatabase,
  closeDatabase,
} from '../gsd-db.ts';
import {
  getActiveMemories,
  applyMemoryActions,
  getActiveMemoriesRanked,
} from '../memory-store.ts';
import type { MemoryAction } from '../memory-store.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: parse valid JSON response
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== memory-extractor: parse valid JSON ===');
{
  const response = JSON.stringify([
    { action: 'CREATE', category: 'gotcha', content: 'esbuild drops binaries', confidence: 0.85 },
    { action: 'REINFORCE', id: 'MEM001' },
    { action: 'UPDATE', id: 'MEM002', content: 'revised content' },
    { action: 'SUPERSEDE', id: 'MEM003', superseded_by: 'MEM004' },
  ]);

  const actions = parseMemoryResponse(response);
  assertEq(actions.length, 4, 'should parse 4 actions');
  assertEq(actions[0].action, 'CREATE', 'first action should be CREATE');
  assertEq((actions[0] as any).category, 'gotcha', 'CREATE category');
  assertEq((actions[0] as any).confidence, 0.85, 'CREATE confidence');
  assertEq(actions[1].action, 'REINFORCE', 'second action should be REINFORCE');
  assertEq(actions[2].action, 'UPDATE', 'third action should be UPDATE');
  assertEq(actions[3].action, 'SUPERSEDE', 'fourth action should be SUPERSEDE');
}

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: parse fenced JSON response
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== memory-extractor: parse fenced JSON ===');
{
  const response = '```json\n[\n  {"action": "CREATE", "category": "convention", "content": "test memory"}\n]\n```';

  const actions = parseMemoryResponse(response);
  assertEq(actions.length, 1, 'should parse 1 action from fenced JSON');
  assertEq(actions[0].action, 'CREATE', 'action should be CREATE');
}

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: parse empty array response
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== memory-extractor: parse empty array ===');
{
  const actions = parseMemoryResponse('[]');
  assertEq(actions.length, 0, 'empty array should parse to empty actions');
}

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: parse malformed response
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== memory-extractor: malformed responses ===');
{
  assertEq(parseMemoryResponse('not json at all'), [], 'garbage text should return []');
  assertEq(parseMemoryResponse('{"action": "CREATE"}'), [], 'non-array should return []');
  assertEq(parseMemoryResponse(''), [], 'empty string should return []');
  assertEq(parseMemoryResponse('```\nbroken\n```'), [], 'fenced non-JSON should return []');
}

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: validation of required fields
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== memory-extractor: field validation ===');
{
  const response = JSON.stringify([
    // Valid CREATE
    { action: 'CREATE', category: 'gotcha', content: 'valid' },
    // Invalid CREATE — missing content
    { action: 'CREATE', category: 'gotcha' },
    // Invalid CREATE — missing category
    { action: 'CREATE', content: 'no category' },
    // Valid REINFORCE
    { action: 'REINFORCE', id: 'MEM001' },
    // Invalid REINFORCE — missing id
    { action: 'REINFORCE' },
    // Valid UPDATE
    { action: 'UPDATE', id: 'MEM002', content: 'new content' },
    // Invalid UPDATE — missing content
    { action: 'UPDATE', id: 'MEM002' },
    // Valid SUPERSEDE
    { action: 'SUPERSEDE', id: 'MEM001', superseded_by: 'MEM002' },
    // Invalid SUPERSEDE — missing superseded_by
    { action: 'SUPERSEDE', id: 'MEM001' },
    // Unknown action
    { action: 'DELETE', id: 'MEM001' },
    // Null entry
    null,
  ]);

  const actions = parseMemoryResponse(response);
  assertEq(actions.length, 4, 'should only accept 4 valid actions');
  assertEq(actions[0].action, 'CREATE', 'first valid is CREATE');
  assertEq(actions[1].action, 'REINFORCE', 'second valid is REINFORCE');
  assertEq(actions[2].action, 'UPDATE', 'third valid is UPDATE');
  assertEq(actions[3].action, 'SUPERSEDE', 'fourth valid is SUPERSEDE');
}

// ═══════════════════════════════════════════════════════════════════════════
// Integration: applyMemoryActions with mixed actions
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== integration: mixed action lifecycle ===');
{
  openDatabase(':memory:');

  // Phase 1: Create initial memories
  applyMemoryActions([
    { action: 'CREATE', category: 'gotcha', content: 'npm run build needs tsc first', confidence: 0.7 },
    { action: 'CREATE', category: 'convention', content: 'all DB queries use named params', confidence: 0.8 },
    { action: 'CREATE', category: 'architecture', content: 'extensions loaded from two paths', confidence: 0.85 },
  ], 'plan-slice', 'M001/S01');

  let active = getActiveMemoriesRanked(30);
  assertEq(active.length, 3, 'phase 1: 3 active memories');

  // Phase 2: Reinforce one, update another, create new
  applyMemoryActions([
    { action: 'REINFORCE', id: 'MEM002' },
    { action: 'UPDATE', id: 'MEM001', content: 'npm run build requires tsc --noEmit first' },
    { action: 'CREATE', category: 'pattern', content: 'use INSERT OR IGNORE for idempotency', confidence: 0.75 },
  ], 'execute-task', 'M001/S01/T01');

  active = getActiveMemoriesRanked(30);
  assertEq(active.length, 4, 'phase 2: 4 active memories');
  assertEq(
    active.find(m => m.id === 'MEM001')?.content,
    'npm run build requires tsc --noEmit first',
    'MEM001 content should be updated',
  );
  assertEq(active.find(m => m.id === 'MEM002')?.hit_count, 1, 'MEM002 should be reinforced');

  // Phase 3: Supersede MEM001 with MEM005
  applyMemoryActions([
    { action: 'CREATE', category: 'gotcha', content: 'build script handles tsc automatically now', confidence: 0.9 },
    { action: 'SUPERSEDE', id: 'MEM001', superseded_by: 'MEM005' },
  ], 'execute-task', 'M001/S01/T02');

  active = getActiveMemoriesRanked(30);
  assertEq(active.length, 4, 'phase 3: 4 active (1 superseded, 1 created)');
  assertTrue(!active.find(m => m.id === 'MEM001'), 'MEM001 should be superseded');
  assertTrue(!!active.find(m => m.id === 'MEM005'), 'MEM005 should be active');

  // Verify ranking: MEM003 (0.85) > MEM005 (0.9) but MEM002 has 1 hit
  // MEM002: 0.8 * (1 + 1*0.1) = 0.88
  // MEM003: 0.85 * 1.0 = 0.85
  // MEM005: 0.9 * 1.0 = 0.9
  // MEM004: 0.75 * 1.0 = 0.75
  assertEq(active[0].id, 'MEM005', 'MEM005 should rank first (0.9)');
  assertEq(active[1].id, 'MEM002', 'MEM002 should rank second (0.88)');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: _resetExtractionState
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== memory-extractor: reset extraction state ===');
{
  // Just verify it doesn't throw
  _resetExtractionState();
  assertTrue(true, '_resetExtractionState should not throw');
}

report();
