/**
 * Regression test for #3603 — MCP server subpath imports via createRequire
 *
 * The ESM wildcard export map in @modelcontextprotocol/sdk does not resolve
 * subpath imports correctly. The fix uses createRequire from node:module to
 * resolve wildcard subpaths via the CJS resolver which auto-appends .js.
 *
 * Structural verification test — reads source to confirm createRequire import
 * and _require.resolve usage exist.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf-8');

describe('MCP server createRequire subpath resolution (#3603)', () => {
  test('createRequire is imported from node:module', () => {
    assert.match(source, /import\s*\{\s*createRequire\s*\}\s*from\s*['"]node:module['"]/,
      'createRequire should be imported from node:module');
  });

  test('_require is created from import.meta.url', () => {
    assert.match(source, /createRequire\(import\.meta\.url\)/,
      '_require should be created using createRequire(import.meta.url)');
  });

  test('_require.resolve is used for subpath imports', () => {
    assert.match(source, /_require\.resolve\(/,
      '_require.resolve should be used for subpath resolution');
  });

  test('server/stdio subpath uses _require.resolve', () => {
    assert.match(source, /_require\.resolve\(`\$\{MCP_PKG\}\/server\/stdio`\)/,
      'server/stdio import should use _require.resolve');
  });

  test('types subpath uses _require.resolve', () => {
    assert.match(source, /_require\.resolve\(`\$\{MCP_PKG\}\/types`\)/,
      'types import should use _require.resolve');
  });
});
