/**
 * Regression test suite for save_gate_result renderResult.
 *
 * Verifies that renderResult does not print "undefined: undefined" when
 * `details` is empty, and that the error fallback does not produce a
 * duplicated `Error: Error:` prefix when `content[0].text` already starts
 * with `Error:`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDbTools } from '../bootstrap/db-tools.ts';

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function getSaveGateResultTool() {
  const pi = makeMockPi();
  registerDbTools(pi);
  const tool = pi.tools.find((t: any) => t.name === 'gsd_save_gate_result');
  assert.ok(tool, 'gsd_save_gate_result should be registered');
  return tool;
}

test('save_gate_result renderResult falls back to content text when details is empty', () => {
  const tool = getSaveGateResultTool();
  const result = {
    content: [{ type: 'text', text: 'Gate Q3 result saved: verdict=pass' }],
    details: {},
    isError: false,
  };
  const rendered = tool.renderResult(result, {}, fakeTheme);
  const text = String(rendered.content ?? rendered.text ?? rendered);
  assert.ok(!text.includes('undefined'), `got: ${text}`);
  assert.ok(
    text.includes('Gate Q3') || text.includes('verdict=pass'),
    `expected content summary — got: ${text}`,
  );
});

test('save_gate_result renderResult uses structured details when present', () => {
  const tool = getSaveGateResultTool();
  const result = {
    content: [{ type: 'text', text: 'Gate Q3 result saved: verdict=flag' }],
    details: { operation: 'save_gate_result', gateId: 'Q3', verdict: 'flag' },
    isError: false,
  };
  const rendered = tool.renderResult(result, {}, fakeTheme);
  const text = String(rendered.content ?? rendered.text ?? rendered);
  assert.ok(text.includes('Q3'), `got: ${text}`);
  assert.ok(text.includes('flag'), `got: ${text}`);
  assert.ok(!text.includes('undefined'), `got: ${text}`);
});

test('save_gate_result renderResult shows error from content when details.error is missing', () => {
  const tool = getSaveGateResultTool();
  const result = {
    content: [{ type: 'text', text: 'Error: Invalid gateId "Z1"' }],
    details: {},
    isError: true,
  };
  const rendered = tool.renderResult(result, {}, fakeTheme);
  const text = String(rendered.content ?? rendered.text ?? rendered);
  assert.ok(
    text.includes('Invalid gateId') || text.includes('Error'),
    `got: ${text}`,
  );
  assert.ok(!text.includes('undefined'), `got: ${text}`);
});

test('save_gate_result renderResult does not duplicate Error: prefix', () => {
  const tool = getSaveGateResultTool();
  const result = {
    content: [{ type: 'text', text: 'Error: Invalid gateId "Z1"' }],
    details: {},
    isError: true,
  };
  const rendered = tool.renderResult(result, {}, fakeTheme);
  const text = String(rendered.content ?? rendered.text ?? rendered);
  assert.ok(
    !/Error:\s*Error:/i.test(text),
    `expected a single Error: prefix — got: ${text}`,
  );
  assert.ok(text.includes('Invalid gateId'), `got: ${text}`);
});
