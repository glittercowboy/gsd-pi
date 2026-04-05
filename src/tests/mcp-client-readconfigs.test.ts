import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfigs } from '../resources/extensions/mcp-client/index.js';
import {
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('readConfigs', async (t) => {
  /**
   * Create isolated temp directory per subtest so that config paths (and thus
   * the module's internal mtime cache) don't leak between tests.
   */
  function withTempDir(fn: (baseDir: string) => Promise<void> | void) {
    const tmp = mkdtempSync(join(tmpdir(), 'mcp-readconfigs-test-'));
    const cleanup = () => rmSync(tmp, { recursive: true, force: true });
    t.after(cleanup);

    return fn(tmp).finally(cleanup);
  }

  await t.test('returns cached configs when no refresh and no changes', async () => {
    await withTempDir(async (baseDir) => {
      const mcpPath = join(baseDir, '.mcp.json');

      mkdirSync(join(baseDir, '.gsd'), { recursive: true });

      const config = JSON.stringify({
        mcpServers: {
          test: { url: 'http://test.example.com' }
        }
      });
      writeFileSync(mcpPath, config);

      // First call (with refresh) populates cache
      const first = readConfigs(true, baseDir);
      assert.deepStrictEqual(first, [{
        name: 'test',
        transport: 'http',
        url: 'http://test.example.com'
      }]);

      // Remove file - cached result should still be returned on subsequent non-refresh call
      rmSync(mcpPath, { force: true });

      const cached = readConfigs(false, baseDir);
      assert.deepStrictEqual(cached, first);
    });
  });

  await t.test('refreshes when file changes (mtime)', async () => {
    await withTempDir(async (baseDir) => {
      const mcpPath = join(baseDir, '.mcp.json');

      mkdirSync(join(baseDir, '.gsd'), { recursive: true });

      const config1 = JSON.stringify({
        mcpServers: { test: { url: 'http://v1.example.com' } }
      });
      const config2 = JSON.stringify({
        mcpServers: { test: { url: 'http://v2.example.com' } }
      });

      writeFileSync(mcpPath, config1);

      const result1 = readConfigs(false, baseDir);
      assert.deepStrictEqual(result1[0]?.url, 'http://v1.example.com');

      // Update file (changes mtime)
      writeFileSync(mcpPath, config2);

      const result2 = readConfigs(false, baseDir);
      assert.deepStrictEqual(result2[0]?.url, 'http://v2.example.com');
    });
  });

  await t.test('handles missing config files gracefully', async () => {
    // Force cache clear with a dummy path (cache is global)
    readConfigs(true, '/tmp/dummy-clear-' + Date.now());

    await withTempDir(async (baseDir) => {
      const result = readConfigs(false, baseDir);
      assert.deepStrictEqual(result, []);
    });
  });

  await t.test('warns on read errors and continues with other files', async (t) => {
    await withTempDir(async (baseDir) => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: unknown, ...args: unknown[]) => {
        warnings.push(String(msg));
      };
      t.after(() => {
        console.warn = originalWarn;
      });

      const mcpPath = join(baseDir, '.mcp.json');
      const gsdPath = join(baseDir, '.gsd', 'mcp.json');

      mkdirSync(join(baseDir, '.gsd'), { recursive: true });

      // Create one good file and one bad file
      writeFileSync(mcpPath, JSON.stringify({
        mcpServers: { good: { url: 'http://good.example.com' } }
      }));
      writeFileSync(gsdPath, 'invalid json {'); // malformed JSON

      const result = readConfigs(true, baseDir);
      assert.deepStrictEqual(result, [{
        name: 'good',
        transport: 'http',
        url: 'http://good.example.com'
      }]);

      assert.ok(
        warnings.some(w => w.includes('Failed to read')),
        'should warn about the bad config file'
      );
    });
  });
});
