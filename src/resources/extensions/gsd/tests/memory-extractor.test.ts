import {
  buildMemoryLLMCall,
  extractMemoriesFromUnit,
  extractTranscriptFromActivity,
  parseMemoryResponse,
  resolveMemoryExtractionApiKey,
  _resetExtractionState,
  _setCompleteSimpleForTests,
} from '../memory-extractor.ts';
import {
  openDatabase,
  closeDatabase,
} from '../gsd-db.ts';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getActiveMemories,
  applyMemoryActions,
  getActiveMemoriesRanked,
  isUnitProcessed,
} from '../memory-store.ts';
import { _resetLogs, peekLogs, setStderrLoggingEnabled } from '../workflow-logger.ts';
import type { MemoryAction } from '../memory-store.ts';
import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: parse valid JSON response
// ═══════════════════════════════════════════════════════════════════════════

test('memory-extractor: parse valid JSON', () => {
  const response = JSON.stringify([
    { action: 'CREATE', category: 'gotcha', content: 'esbuild drops binaries', confidence: 0.85 },
    { action: 'REINFORCE', id: 'MEM001' },
    { action: 'UPDATE', id: 'MEM002', content: 'revised content' },
    { action: 'SUPERSEDE', id: 'MEM003', superseded_by: 'MEM004' },
  ]);

  const actions = parseMemoryResponse(response);
  assert.deepStrictEqual(actions.length, 4, 'should parse 4 actions');
  assert.deepStrictEqual(actions[0].action, 'CREATE', 'first action should be CREATE');
  assert.deepStrictEqual((actions[0] as any).category, 'gotcha', 'CREATE category');
  assert.deepStrictEqual((actions[0] as any).confidence, 0.85, 'CREATE confidence');
  assert.deepStrictEqual(actions[1].action, 'REINFORCE', 'second action should be REINFORCE');
  assert.deepStrictEqual(actions[2].action, 'UPDATE', 'third action should be UPDATE');
  assert.deepStrictEqual(actions[3].action, 'SUPERSEDE', 'fourth action should be SUPERSEDE');
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: parse fenced JSON response
// ═══════════════════════════════════════════════════════════════════════════

test('memory-extractor: parse fenced JSON', () => {
  const response = '```json\n[\n  {"action": "CREATE", "category": "convention", "content": "test memory"}\n]\n```';

  const actions = parseMemoryResponse(response);
  assert.deepStrictEqual(actions.length, 1, 'should parse 1 action from fenced JSON');
  assert.deepStrictEqual(actions[0].action, 'CREATE', 'action should be CREATE');
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: parse empty array response
// ═══════════════════════════════════════════════════════════════════════════

test('memory-extractor: parse empty array', () => {
  const actions = parseMemoryResponse('[]');
  assert.deepStrictEqual(actions.length, 0, 'empty array should parse to empty actions');
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: parse malformed response
// ═══════════════════════════════════════════════════════════════════════════

test('memory-extractor: malformed responses', () => {
  assert.deepStrictEqual(parseMemoryResponse('not json at all'), [], 'garbage text should return []');
  assert.deepStrictEqual(parseMemoryResponse('{"action": "CREATE"}'), [], 'non-array should return []');
  assert.deepStrictEqual(parseMemoryResponse(''), [], 'empty string should return []');
  assert.deepStrictEqual(parseMemoryResponse('```\nbroken\n```'), [], 'fenced non-JSON should return []');
});

test('memory-extractor: extractTranscriptFromActivity handles wrapped session entries', () => {
  const raw = [
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'ignore me' } }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first block' },
          { type: 'text', text: 'second block' },
        ],
      },
    }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'third block' } }),
  ].join('\n');

  assert.equal(
    extractTranscriptFromActivity(raw),
    'first block\n\nsecond block\n\nthird block',
  );
});

test('memory-extractor: extractTranscriptFromActivity skips malformed content blocks individually', () => {
  const raw = JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [
        null,
        'bad block',
        42,
        ['bad array'],
        { type: 'image', text: 'ignored image text' },
        { type: 'text', text: 'kept block' },
        { type: 'text', text: 'also kept' },
      ],
    },
  });

  assert.equal(
    extractTranscriptFromActivity(raw),
    'kept block\n\nalso kept',
  );
});

test('memory-extractor: extractTranscriptFromActivity still supports raw assistant entries', () => {
  const raw = [
    JSON.stringify({ role: 'assistant', content: 'legacy format works' }),
  ].join('\n');

  assert.equal(extractTranscriptFromActivity(raw), 'legacy format works');
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: validation of required fields
// ═══════════════════════════════════════════════════════════════════════════

test('memory-extractor: field validation', () => {
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
  assert.deepStrictEqual(actions.length, 4, 'should only accept 4 valid actions');
  assert.deepStrictEqual(actions[0].action, 'CREATE', 'first valid is CREATE');
  assert.deepStrictEqual(actions[1].action, 'REINFORCE', 'second valid is REINFORCE');
  assert.deepStrictEqual(actions[2].action, 'UPDATE', 'third valid is UPDATE');
  assert.deepStrictEqual(actions[3].action, 'SUPERSEDE', 'fourth valid is SUPERSEDE');
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: applyMemoryActions with mixed actions
// ═══════════════════════════════════════════════════════════════════════════

test('integration: mixed action lifecycle', () => {
  openDatabase(':memory:');

  // Phase 1: Create initial memories
  applyMemoryActions([
    { action: 'CREATE', category: 'gotcha', content: 'npm run build needs tsc first', confidence: 0.7 },
    { action: 'CREATE', category: 'convention', content: 'all DB queries use named params', confidence: 0.8 },
    { action: 'CREATE', category: 'architecture', content: 'extensions loaded from two paths', confidence: 0.85 },
  ], 'plan-slice', 'M001/S01');

  let active = getActiveMemoriesRanked(30);
  assert.deepStrictEqual(active.length, 3, 'phase 1: 3 active memories');

  // Phase 2: Reinforce one, update another, create new
  applyMemoryActions([
    { action: 'REINFORCE', id: 'MEM002' },
    { action: 'UPDATE', id: 'MEM001', content: 'npm run build requires tsc --noEmit first' },
    { action: 'CREATE', category: 'pattern', content: 'use INSERT OR IGNORE for idempotency', confidence: 0.75 },
  ], 'execute-task', 'M001/S01/T01');

  active = getActiveMemoriesRanked(30);
  assert.deepStrictEqual(active.length, 4, 'phase 2: 4 active memories');
  assert.deepStrictEqual(
    active.find(m => m.id === 'MEM001')?.content,
    'npm run build requires tsc --noEmit first',
    'MEM001 content should be updated',
  );
  assert.deepStrictEqual(active.find(m => m.id === 'MEM002')?.hit_count, 1, 'MEM002 should be reinforced');

  // Phase 3: Supersede MEM001 with MEM005
  applyMemoryActions([
    { action: 'CREATE', category: 'gotcha', content: 'build script handles tsc automatically now', confidence: 0.9 },
    { action: 'SUPERSEDE', id: 'MEM001', superseded_by: 'MEM005' },
  ], 'execute-task', 'M001/S01/T02');

  active = getActiveMemoriesRanked(30);
  assert.deepStrictEqual(active.length, 4, 'phase 3: 4 active (1 superseded, 1 created)');
  assert.ok(!active.find(m => m.id === 'MEM001'), 'MEM001 should be superseded');
  assert.ok(!!active.find(m => m.id === 'MEM005'), 'MEM005 should be active');

  // Verify ranking: MEM003 (0.85) > MEM005 (0.9) but MEM002 has 1 hit
  // MEM002: 0.8 * (1 + 1*0.1) = 0.88
  // MEM003: 0.85 * 1.0 = 0.85
  // MEM005: 0.9 * 1.0 = 0.9
  // MEM004: 0.75 * 1.0 = 0.75
  assert.deepStrictEqual(active[0].id, 'MEM005', 'MEM005 should rank first (0.9)');
  assert.deepStrictEqual(active[1].id, 'MEM002', 'MEM002 should rank second (0.88)');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-extractor: buildMemoryLLMCall resolves OAuth API key via modelRegistry
// Regression test for #2959 — OAuth users had broken memory extraction
// because streamSimpleAnthropic only checked env vars, not auth.json.
// ═══════════════════════════════════════════════════════════════════════════

test('memory-extractor: buildMemoryLLMCall resolves API key from modelRegistry for OAuth users', async () => {
  const OAUTH_TOKEN = 'sk-ant-oat-test-oauth-token-12345';
  let getApiKeyCalled = false;

  const fakeModel = {
    id: 'claude-haiku-test',
    provider: 'anthropic',
    api: 'anthropic-messages',
    cost: { input: 0.25, output: 1.25 },
  };

  const ctx = {
    modelRegistry: {
      getAvailable: () => [fakeModel],
      getApiKey: async (_model: any) => {
        getApiKeyCalled = true;
        return OAUTH_TOKEN;
      },
    },
  } as any;

  const llmCallFn = buildMemoryLLMCall(ctx);
  assert.ok(llmCallFn !== null, 'buildMemoryLLMCall should return a function when models are available');

  // The function should have resolved the API key eagerly via modelRegistry.getApiKey.
  // Await the exposed promise deterministically instead of polling via setTimeout.
  await llmCallFn!.apiKeyReady;
  assert.ok(getApiKeyCalled, 'buildMemoryLLMCall must call modelRegistry.getApiKey() to resolve OAuth tokens');
});

test('memory-extractor: buildMemoryLLMCall returns null when no models available', () => {
  const ctx = {
    modelRegistry: {
      getAvailable: () => [],
      getApiKey: async () => undefined,
    },
  } as any;

  const llmCallFn = buildMemoryLLMCall(ctx);
  assert.strictEqual(llmCallFn, null, 'should return null when no models available');
});

test('memory-extractor: buildMemoryLLMCall prefers haiku model', async () => {
  let resolvedModelId: string | undefined;

  const haikuModel = {
    id: 'claude-3-5-haiku-20241022',
    provider: 'anthropic',
    api: 'anthropic-messages',
    cost: { input: 0.25, output: 1.25 },
  };
  const sonnetModel = {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    api: 'anthropic-messages',
    cost: { input: 3, output: 15 },
  };

  const ctx = {
    modelRegistry: {
      getAvailable: () => [sonnetModel, haikuModel],
      getApiKey: async (model: any) => {
        resolvedModelId = model.id;
        return 'sk-ant-oat-test-token';
      },
    },
  } as any;

  const llmCallFn = buildMemoryLLMCall(ctx);
  assert.ok(llmCallFn !== null, 'should return a function');

  // Await the exposed API-key-ready promise deterministically.
  await llmCallFn!.apiKeyReady;
  assert.strictEqual(resolvedModelId, 'claude-3-5-haiku-20241022',
    'should resolve API key for haiku model, not sonnet');
});

test('memory-extractor: resolveMemoryExtractionApiKey uses modelRegistry credentials and logs lookup failures', async () => {
  const model = {
    provider: 'anthropic',
    id: 'claude-haiku-4-5',
  } as any;

  const ok = await resolveMemoryExtractionApiKey({
    modelRegistry: {
      getApiKey: async (arg: unknown) => {
        assert.equal(arg, model, 'passes the selected model to modelRegistry.getApiKey');
        return 'oauth-token';
      },
    },
  } as any, model);
  assert.equal(ok, 'oauth-token');

  // Lookup failures must be surfaced via workflow-logger so an expired OAuth
  // token isn't silently masked as a missing-key error downstream.
  _resetLogs();
  const restoreStderr = setStderrLoggingEnabled(false);
  try {
    const failed = await resolveMemoryExtractionApiKey({
      modelRegistry: {
        getApiKey: async () => {
          throw new Error('lookup failed');
        },
      },
    } as any, model);
    assert.equal(failed, undefined, 'falls back to undefined so the outer flow can continue');
    const warnings = peekLogs().filter((entry) => entry.severity === 'warn');
    assert.ok(
      warnings.some((entry) =>
        entry.component === 'memory-extractor' &&
        entry.message.includes('modelRegistry.getApiKey failed') &&
        entry.message.includes('lookup failed')
      ),
      'must log a diagnostic warning when the registry throws',
    );
  } finally {
    setStderrLoggingEnabled(restoreStderr);
    _resetLogs();
  }
});

test('memory-extractor: buildMemoryLLMCall passes resolved OAuth token to completeSimple', async () => {
  const OAUTH_TOKEN = 'sk-ant-oat-end-to-end-test-token';
  let receivedOptions: any = null;

  const fakeModel = {
    id: 'claude-haiku-test',
    provider: 'anthropic',
    api: 'anthropic-messages',
    cost: { input: 0.25, output: 1.25 },
  };

  const ctx = {
    modelRegistry: {
      getAvailable: () => [fakeModel],
      getApiKey: async () => OAUTH_TOKEN,
    },
  } as any;

  _setCompleteSimpleForTests(async (_model, _params, options) => {
    receivedOptions = options;
    return {
      role: 'assistant',
      content: [{ type: 'text', text: '[]' }],
      timestamp: Date.now(),
    } as any;
  });

  try {
    const llmCallFn = buildMemoryLLMCall(ctx);
    assert.ok(llmCallFn !== null, 'should return a function');
    const result = await llmCallFn!('system', 'user');
    assert.equal(result, '[]');
    assert.ok(receivedOptions, 'completeSimple must be invoked');
    assert.equal(receivedOptions!.apiKey, OAUTH_TOKEN,
      'completeSimple must receive the OAuth token resolved via modelRegistry');
    assert.equal(receivedOptions!.maxTokens, 2048);
    assert.equal(receivedOptions!.temperature, 0);
  } finally {
    _setCompleteSimpleForTests(null);
  }
});

test('memory-extractor: buildMemoryLLMCall omits apiKey when registry has no credentials', async () => {
  let receivedOptions: any = null;
  const fakeModel = {
    id: 'claude-haiku-test',
    provider: 'anthropic',
    api: 'anthropic-messages',
    cost: { input: 0.25, output: 1.25 },
  };
  const ctx = {
    modelRegistry: {
      getAvailable: () => [fakeModel],
      getApiKey: async () => undefined,
    },
  } as any;

  _setCompleteSimpleForTests(async (_model, _params, options) => {
    receivedOptions = options;
    return {
      role: 'assistant',
      content: [{ type: 'text', text: '[]' }],
      timestamp: Date.now(),
    } as any;
  });

  try {
    const llmCallFn = buildMemoryLLMCall(ctx);
    await llmCallFn!('s', 'u');
    assert.ok(receivedOptions, 'completeSimple must be invoked');
    assert.equal('apiKey' in receivedOptions!, false,
      'apiKey must be omitted entirely when no credentials resolved (env-var fallback path)');
  } finally {
    _setCompleteSimpleForTests(null);
  }
});

test('memory-extractor: extractMemoriesFromUnit processes wrapped activity-log entries end to end', async () => {
  _resetExtractionState();
  openDatabase(':memory:');

  const dir = mkdtempSync(join(tmpdir(), 'gsd-memory-extractor-'));
  const activityFile = join(dir, '001-execute-task-M001-S01-T01.jsonl');
  const repeated = 'Wrapped assistant transcript proves extraction works. '.repeat(30);
  writeFileSync(
    activityFile,
    [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'ignored user content' } }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: repeated },
          ],
        },
      }),
    ].join('\n'),
    'utf-8',
  );

  try {
    let llmPrompt = '';
    await extractMemoriesFromUnit(
      activityFile,
      'execute-task',
      'M001/S01/T01',
      async (_system, user) => {
        llmPrompt = user;
        return JSON.stringify([
          { action: 'CREATE', category: 'gotcha', content: 'wrapped logs are parsed', confidence: 0.9 },
        ]);
      },
    );

    assert.match(llmPrompt, /Wrapped assistant transcript proves extraction works\./);
    assert.equal(isUnitProcessed('execute-task/M001/S01/T01'), true);
    assert.ok(getActiveMemories().some((m) => m.content === 'wrapped logs are parsed'));
  } finally {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    _resetExtractionState();
  }
});
