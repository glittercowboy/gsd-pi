/**
 * Regression test for #3603 / #3914 — MCP server subpath imports.
 *
 * @modelcontextprotocol/sdk's package.json exports map uses a wildcard
 * `./*` → `./dist/cjs/*` with no `.js` suffix, so bare subpath specifiers
 * like `@modelcontextprotocol/sdk/server/stdio` resolve to a file that
 * doesn't exist. Historically the workaround used `createRequire` so the
 * CJS resolver auto-appended `.js`; that no longer works with current
 * Node + SDK versions (#3914).
 *
 * The reliable convention (used in packages/mcp-server/{server,cli}.ts)
 * is to write the `.js` suffix explicitly on every subpath import. This
 * test locks that convention in so regressions can't silently reintroduce
 * the bare subpath form or the broken createRequire-based resolution.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf-8');

describe('MCP server SDK subpath imports (#3603 / #3914)', () => {
  test('server/index.js subpath is imported with explicit .js suffix', () => {
    assert.match(source, /await import\(`\$\{MCP_PKG\}\/server\/index\.js`\)/,
      'server import must use `${MCP_PKG}/server/index.js` to satisfy the wildcard export map');
  });

  test('server/stdio.js subpath is imported with explicit .js suffix', () => {
    assert.match(source, /await import\(`\$\{MCP_PKG\}\/server\/stdio\.js`\)/,
      'stdio import must use `${MCP_PKG}/server/stdio.js`');
  });

  test('types.js subpath is imported with explicit .js suffix', () => {
    assert.match(source, /await import\(`\$\{MCP_PKG\}\/types\.js`\)/,
      'types import must use `${MCP_PKG}/types.js`');
  });

  test('legacy createRequire-based resolution is gone', () => {
    // Only flag actual code, not the comment that explains the history.
    // The import statement, variable declaration, and `_require.resolve(` call
    // sites are the real regression surfaces.
    assert.doesNotMatch(source, /^\s*import\s*\{\s*createRequire\s*\}\s*from/m,
      'createRequire should not be imported from node:module');
    assert.doesNotMatch(source, /^\s*const\s+_require\s*=\s*createRequire/m,
      '_require helper should not be created');
    assert.doesNotMatch(source, /_require\.resolve\(/,
      '_require.resolve should not be used for subpath resolution');
  });
});
