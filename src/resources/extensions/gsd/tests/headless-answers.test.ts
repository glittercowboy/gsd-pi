/**
 * Tests for the headless-answers module.
 *
 * Covers loadAndValidateAnswerFile (file loading + schema validation) and
 * AnswerInjector (event observation, answer matching, deferred resolution,
 * secrets, stats, and unused warnings).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAndValidateAnswerFile, AnswerInjector } from '../../../../headless-answers.ts';

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// loadAndValidateAnswerFile
// ---------------------------------------------------------------------------

test('loadAndValidateAnswerFile — valid file', (t) => {
  const tmp = makeTempDir('answers-valid');
  try {
    const data = {
      questions: { deploy_target: 'GCP', features: ['auth', 'payments'] },
      secrets: { API_KEY: 'sk-123' },
      defaults: { strategy: 'first_option' },
    };
    const filePath = join(tmp, 'answers.json');
    writeFileSync(filePath, JSON.stringify(data));

    const result = loadAndValidateAnswerFile(filePath);
    assert.deepStrictEqual(result.questions, data.questions);
    assert.deepStrictEqual(result.secrets, data.secrets);
    assert.deepStrictEqual(result.defaults, data.defaults);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadAndValidateAnswerFile — invalid JSON', (t) => {
  const tmp = makeTempDir('answers-bad-json');
  try {
    const filePath = join(tmp, 'answers.json');
    writeFileSync(filePath, '{not valid json!!!');

    assert.throws(
      () => loadAndValidateAnswerFile(filePath),
      (err: Error) => err.message.includes('JSON'),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadAndValidateAnswerFile — wrong types (non-string question value)', (t) => {
  const tmp = makeTempDir('answers-bad-q');
  try {
    const filePath = join(tmp, 'answers.json');
    writeFileSync(filePath, JSON.stringify({ questions: { q1: 42 } }));

    assert.throws(
      () => loadAndValidateAnswerFile(filePath),
      (err: Error) => err.message.includes('questions.q1'),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadAndValidateAnswerFile — wrong types (non-string secret value)', (t) => {
  const tmp = makeTempDir('answers-bad-secret');
  try {
    const filePath = join(tmp, 'answers.json');
    writeFileSync(filePath, JSON.stringify({ secrets: { KEY: 42 } }));

    assert.throws(
      () => loadAndValidateAnswerFile(filePath),
      (err: Error) => err.message.includes('secrets.KEY'),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AnswerInjector — observeEvent + tryHandle
// ---------------------------------------------------------------------------

function makeToolExecutionStart(questions: Record<string, unknown>[]) {
  return {
    type: 'tool_execution_start',
    toolName: 'ask_user_questions',
    input: { questions },
  };
}

function makeSelectEvent(
  id: string,
  title: string,
  options: string[],
  extra?: Record<string, unknown>,
) {
  return {
    type: 'extension_ui_request',
    id,
    method: 'select',
    title,
    options,
    ...extra,
  };
}

test('observeEvent stores metadata', (t) => {
  const injector = new AnswerInjector({});

  injector.observeEvent(makeToolExecutionStart([{
    id: 'deploy_target',
    header: 'Deploy',
    question: 'Where to deploy?',
    options: [{ label: 'AWS' }, { label: 'GCP' }],
  }]));

  // Verify metadata was stored: tryHandle with a matching select event should
  // go through processWithMeta. With no answer in the file, first_option
  // strategy returns false (falls through to auto-responder).
  const captured: string[] = [];
  const captureStdin = (data: string) => { captured.push(data); };
  const event = makeSelectEvent('req-1', 'Deploy: Where to deploy?', ['AWS', 'GCP']);
  const handled = injector.tryHandle(event, captureStdin);

  // No answer file entry → first_option strategy → returns false (let auto-responder handle)
  assert.strictEqual(handled, false);
  // But questionsDefaulted should be incremented because processWithMeta was reached
  assert.strictEqual(injector.getStats().questionsDefaulted, 1);
});

test('tryHandle matches by question ID — single select', (t) => {
  const injector = new AnswerInjector({ questions: { deploy_target: 'GCP' } });

  injector.observeEvent(makeToolExecutionStart([{
    id: 'deploy_target',
    header: 'Deploy',
    question: 'Where to deploy?',
    options: [{ label: 'AWS' }, { label: 'GCP' }],
  }]));

  const captured: string[] = [];
  const captureStdin = (data: string) => { captured.push(data); };
  const event = makeSelectEvent('req-1', 'Deploy: Where to deploy?', ['AWS', 'GCP']);
  const handled = injector.tryHandle(event, captureStdin);

  assert.strictEqual(handled, true);
  assert.strictEqual(captured.length, 1);
  const response = JSON.parse(captured[0].trim());
  assert.strictEqual(response.type, 'extension_ui_response');
  assert.strictEqual(response.id, 'req-1');
  assert.strictEqual(response.value, 'GCP');
  assert.strictEqual(injector.getStats().questionsAnswered, 1);
});

test('tryHandle unknown question deferred — first_option timeout', async (t) => {
  const injector = new AnswerInjector({ defaults: { strategy: 'first_option' } });

  const captured: string[] = [];
  const captureStdin = (data: string) => { captured.push(data); };
  // No observeEvent call — no metadata exists
  const event = makeSelectEvent('req-d', 'Unknown: Unknown question?', ['OptionA', 'OptionB']);
  const handled = injector.tryHandle(event, captureStdin);

  // Should be deferred (returns true)
  assert.strictEqual(handled, true);
  assert.strictEqual(captured.length, 0, 'nothing sent immediately');

  // Wait for the 500ms deferred timeout to fire
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.strictEqual(captured.length, 1);
  const response = JSON.parse(captured[0].trim());
  assert.strictEqual(response.type, 'extension_ui_response');
  assert.strictEqual(response.id, 'req-d');
  assert.strictEqual(response.value, 'OptionA');
  assert.strictEqual(injector.getStats().questionsDefaulted, 1);
});

test('tryHandle multi-select', (t) => {
  const injector = new AnswerInjector({ questions: { features: ['auth', 'payments'] } });

  injector.observeEvent(makeToolExecutionStart([{
    id: 'features',
    header: 'Features',
    question: 'Which features?',
    options: [{ label: 'auth' }, { label: 'payments' }, { label: 'analytics' }],
    allowMultiple: true,
  }]));

  const captured: string[] = [];
  const captureStdin = (data: string) => { captured.push(data); };
  const event = makeSelectEvent(
    'req-2',
    'Features: Which features?',
    ['auth', 'payments', 'analytics'],
    { allowMultiple: true },
  );
  const handled = injector.tryHandle(event, captureStdin);

  assert.strictEqual(handled, true);
  assert.strictEqual(captured.length, 1);
  const response = JSON.parse(captured[0].trim());
  assert.strictEqual(response.type, 'extension_ui_response');
  assert.strictEqual(response.id, 'req-2');
  assert.deepStrictEqual(response.values, ['auth', 'payments']);
  assert.strictEqual(injector.getStats().questionsAnswered, 1);
});

test('tryHandle answer not in options — first_option strategy returns false', (t) => {
  const injector = new AnswerInjector({ questions: { deploy_target: 'Azure' } });

  injector.observeEvent(makeToolExecutionStart([{
    id: 'deploy_target',
    header: 'Deploy',
    question: 'Where to deploy?',
    options: [{ label: 'AWS' }, { label: 'GCP' }],
  }]));

  const captured: string[] = [];
  const captureStdin = (data: string) => { captured.push(data); };
  const event = makeSelectEvent('req-3', 'Deploy: Where to deploy?', ['AWS', 'GCP']);
  const handled = injector.tryHandle(event, captureStdin);

  // first_option strategy with invalid answer: returns false (auto-responder handles it)
  assert.strictEqual(handled, false);
  assert.strictEqual(captured.length, 0);
  assert.strictEqual(injector.getStats().questionsDefaulted, 1);
  assert.strictEqual(injector.getStats().questionsAnswered, 0);
});

test('tryHandle deferred resolution — observeEvent after tryHandle', async (t) => {
  const injector = new AnswerInjector({ questions: { deploy_target: 'GCP' } });

  const captured: string[] = [];
  const captureStdin = (data: string) => { captured.push(data); };

  // Call tryHandle BEFORE observeEvent (out-of-order)
  const event = makeSelectEvent('req-4', 'Deploy: Where to deploy?', ['AWS', 'GCP']);
  const handled = injector.tryHandle(event, captureStdin);
  assert.strictEqual(handled, true, 'event should be deferred');
  assert.strictEqual(captured.length, 0, 'nothing sent yet');

  // Now deliver the metadata — deferred event should be resolved immediately
  injector.observeEvent(makeToolExecutionStart([{
    id: 'deploy_target',
    header: 'Deploy',
    question: 'Where to deploy?',
    options: [{ label: 'AWS' }, { label: 'GCP' }],
  }]));

  assert.strictEqual(captured.length, 1, 'deferred event resolved synchronously');
  const response = JSON.parse(captured[0].trim());
  assert.strictEqual(response.type, 'extension_ui_response');
  assert.strictEqual(response.id, 'req-4');
  assert.strictEqual(response.value, 'GCP');
  assert.strictEqual(injector.getStats().questionsAnswered, 1);
});

// ---------------------------------------------------------------------------
// AnswerInjector — getSecretEnvVars
// ---------------------------------------------------------------------------

test('getSecretEnvVars returns secrets map', (t) => {
  const secrets = { API_KEY: 'sk-123', DB_URL: 'postgres://localhost/db' };
  const injector = new AnswerInjector({ secrets });

  assert.deepStrictEqual(injector.getSecretEnvVars(), secrets);
});

// ---------------------------------------------------------------------------
// AnswerInjector — getUnusedWarnings
// ---------------------------------------------------------------------------

test('getUnusedWarnings reports unused question IDs and secret keys', (t) => {
  const injector = new AnswerInjector({
    questions: { q1: 'val1', q2: 'val2' },
    secrets: { KEY1: 'v1' },
  });

  // Set up and use q1, but leave q2 and KEY1 unused
  injector.observeEvent(makeToolExecutionStart([{
    id: 'q1',
    header: 'H1',
    question: 'Question 1?',
    options: [{ label: 'val1' }, { label: 'other' }],
  }]));

  const captured: string[] = [];
  const captureStdin = (data: string) => { captured.push(data); };
  injector.tryHandle(
    makeSelectEvent('req-u1', 'H1: Question 1?', ['val1', 'other']),
    captureStdin,
  );

  const warnings = injector.getUnusedWarnings();
  assert.ok(warnings.some((w) => w.includes('q2')), 'should warn about unused question q2');
  assert.ok(warnings.some((w) => w.includes('KEY1')), 'should warn about unused secret KEY1');
  assert.ok(!warnings.some((w) => w.includes('q1')), 'should not warn about used question q1');
});

// ---------------------------------------------------------------------------
// AnswerInjector — defaults.strategy cancel
// ---------------------------------------------------------------------------

test('defaults.strategy cancel — sends cancelled response', (t) => {
  const injector = new AnswerInjector({ defaults: { strategy: 'cancel' } });

  injector.observeEvent(makeToolExecutionStart([{
    id: 'deploy_target',
    header: 'Deploy',
    question: 'Where to deploy?',
    options: [{ label: 'AWS' }, { label: 'GCP' }],
  }]));

  const captured: string[] = [];
  const captureStdin = (data: string) => { captured.push(data); };
  const event = makeSelectEvent('req-c', 'Deploy: Where to deploy?', ['AWS', 'GCP']);
  const handled = injector.tryHandle(event, captureStdin);

  // No answer in file + cancel strategy → sends cancelled response
  assert.strictEqual(handled, true);
  assert.strictEqual(captured.length, 1);
  const response = JSON.parse(captured[0].trim());
  assert.strictEqual(response.type, 'extension_ui_response');
  assert.strictEqual(response.id, 'req-c');
  assert.strictEqual(response.cancelled, true);
  assert.strictEqual(injector.getStats().questionsDefaulted, 1);
});
