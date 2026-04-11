// GSD Extension — formatShortcut tests
// Verifies OS-specific keyboard shortcut rendering.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatShortcut } from '../files.ts';

// ─── formatShortcut renders per-platform shortcuts ──────────────────────

test('formatShortcut: converts Ctrl+Alt combo on macOS', () => {
  // formatShortcut uses process.platform at module load time.
  // We can only test the current platform's behavior.
  const result = formatShortcut('Ctrl+Alt+G');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌃⌥G', 'macOS should use ⌃⌥ symbols');
  } else {
    assert.strictEqual(result, 'Ctrl+Alt+G', 'non-macOS should pass through unchanged');
  }
});

test('formatShortcut: converts Ctrl+Alt+N', () => {
  const result = formatShortcut('Ctrl+Alt+N');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌃⌥N');
  } else {
    assert.strictEqual(result, 'Ctrl+Alt+N');
  }
});

test('formatShortcut: converts Ctrl+Alt+B', () => {
  const result = formatShortcut('Ctrl+Alt+B');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌃⌥B');
  } else {
    assert.strictEqual(result, 'Ctrl+Alt+B');
  }
});

test('formatShortcut: converts standalone Ctrl modifier', () => {
  const result = formatShortcut('Ctrl+C');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌃C');
  } else {
    assert.strictEqual(result, 'Ctrl+C');
  }
});

test('formatShortcut: converts Shift modifier', () => {
  const result = formatShortcut('Shift+Tab');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⇧Tab');
  } else {
    assert.strictEqual(result, 'Shift+Tab');
  }
});

test('formatShortcut: converts Cmd modifier', () => {
  const result = formatShortcut('Cmd+S');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌘S');
  } else {
    assert.strictEqual(result, 'Cmd+S');
  }
});

test('formatShortcut: passes through plain key names', () => {
  assert.strictEqual(formatShortcut('Escape'), 'Escape');
  assert.strictEqual(formatShortcut('Enter'), 'Enter');
});
