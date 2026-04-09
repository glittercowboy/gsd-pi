/**
 * Regression test for #3579 — Enter key initiates auth setup in provider manager
 *
 * The provider manager component did not handle the Enter key, leaving users
 * unable to initiate auth setup without knowing the 'd' keyboard shortcut.
 * The fix adds a selectConfirm handler that calls onSetupAuth.
 *
 * Structural verification test — reads source to confirm selectConfirm handler
 * and onSetupAuth callback exist in provider-manager.ts.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(
  join(__dirname, '..', '..', 'packages', 'pi-coding-agent', 'src', 'modes', 'interactive', 'components', 'provider-manager.ts'),
  'utf-8',
);

describe('provider manager Enter key handler (#3579)', () => {
  test('onSetupAuth callback property exists', () => {
    assert.match(source, /onSetupAuth/,
      'onSetupAuth callback should be defined');
  });

  test('selectConfirm key handler exists', () => {
    assert.match(source, /selectConfirm/,
      'selectConfirm key binding should be handled');
  });

  test('onSetupAuth is called with provider name', () => {
    assert.match(source, /this\.onSetupAuth\(provider\.name\)/,
      'onSetupAuth should be called with provider.name');
  });

  test('setup auth hint is shown', () => {
    assert.match(source, /setup auth/,
      'enter key hint should mention "setup auth"');
  });
});
