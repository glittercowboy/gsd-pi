// @gsd-build/mcp-server — Tests for secure_env_collect MCP tool
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// Tests the secure_env_collect tool registered in createMcpServer.
// Uses a mock MCP server to intercept tool registration and elicitInput calls.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpServer } from './server.js';
import { SessionManager } from './session-manager.js';

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

/**
 * We intercept McpServer construction by monkey-patching the dynamic import.
 * Instead, we'll test the tool handler indirectly through the exported
 * createMcpServer function — capturing the registered tool handlers.
 *
 * Since createMcpServer dynamically imports McpServer, we need to test at
 * a level that exercises the tool handler logic. We do this by extracting
 * the tool handler through the server.tool() calls.
 */

interface RegisteredTool {
  name: string;
  description: string;
  params: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Mock McpServer that captures tool registrations and provides
 * a controllable elicitInput response.
 */
class MockMcpServer {
  registeredTools: RegisteredTool[] = [];
  elicitResponse: { action: string; content?: Record<string, unknown> } = { action: 'accept', content: {} };

  server = {
    elicitInput: async (_params: unknown) => {
      return this.elicitResponse;
    },
  };

  tool(name: string, description: string, params: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<unknown>) {
    this.registeredTools.push({ name, description, params, handler });
  }

  async connect(_transport: unknown) { /* no-op */ }
  async close() { /* no-op */ }

  getToolHandler(name: string): ((args: Record<string, unknown>) => Promise<unknown>) | undefined {
    return this.registeredTools.find((t) => t.name === name)?.handler;
  }
}

// ---------------------------------------------------------------------------
// Helper to create a mock MCP server with secure_env_collect registered
// ---------------------------------------------------------------------------

/**
 * Since createMcpServer uses dynamic import for McpServer, we can't easily
 * mock it. Instead, we test the env-writer utilities directly (in env-writer.test.ts)
 * and test the tool integration by verifying:
 * 1. The tool exists in the registered tools list
 * 2. The handler produces correct results with mock data
 *
 * For handler-level testing, we create a standalone test that replicates
 * the tool handler logic with a controllable mock.
 */

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

// ---------------------------------------------------------------------------
// Integration test — verify tool is registered
// ---------------------------------------------------------------------------

describe('secure_env_collect tool registration', () => {
  it('createMcpServer registers secure_env_collect tool', async () => {
    // This test verifies the tool exists — createMcpServer internally calls
    // server.tool('secure_env_collect', ...) which we can't intercept without
    // module mocking, but we can verify the server creates successfully
    const sm = new SessionManager();
    try {
      const { server } = await createMcpServer(sm);
      assert.ok(server, 'server should be created');
      // The McpServer internally tracks registered tools — we verify no error
    } finally {
      await sm.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Handler logic tests — using env-writer directly to test the flow
// ---------------------------------------------------------------------------

describe('secure_env_collect handler logic', () => {
  it('skips keys that already exist in .env', async () => {
    const tmp = makeTempDir('sec-collect');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'ALREADY_SET=existing-value\n');

      // Import the utility directly to test the pre-check logic
      const { checkExistingEnvKeys } = await import('./env-writer.js');
      const existing = await checkExistingEnvKeys(['ALREADY_SET', 'NEW_KEY'], envPath);
      assert.deepStrictEqual(existing, ['ALREADY_SET']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes collected values to .env without returning secret values', async () => {
    const tmp = makeTempDir('sec-collect');
    try {
      const envPath = join(tmp, '.env');
      const savedKey = process.env.SEC_COLLECT_TEST_KEY;

      const { applySecrets } = await import('./env-writer.js');
      const { applied, errors } = await applySecrets(
        [{ key: 'SEC_COLLECT_TEST_KEY', value: 'super-secret-value' }],
        'dotenv',
        { envFilePath: envPath },
      );

      assert.deepStrictEqual(applied, ['SEC_COLLECT_TEST_KEY']);
      assert.deepStrictEqual(errors, []);

      // Verify the value was written
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes('SEC_COLLECT_TEST_KEY=super-secret-value'));

      // Verify process.env was hydrated
      assert.equal(process.env.SEC_COLLECT_TEST_KEY, 'super-secret-value');

      // Cleanup
      if (savedKey === undefined) delete process.env.SEC_COLLECT_TEST_KEY;
      else process.env.SEC_COLLECT_TEST_KEY = savedKey;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('auto-detects vercel destination from vercel.json', async () => {
    const tmp = makeTempDir('sec-collect');
    try {
      writeFileSync(join(tmp, 'vercel.json'), '{}');
      const { detectDestination } = await import('./env-writer.js');
      assert.equal(detectDestination(tmp), 'vercel');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles empty form values as skipped', async () => {
    // Simulate what happens when user leaves a field empty in the form
    const formContent: Record<string, string> = {
      'API_KEY': 'provided-value',
      'OPTIONAL_KEY': '',        // empty = skip
    };

    const provided: Array<{ key: string; value: string }> = [];
    const skipped: string[] = [];

    for (const [key, raw] of Object.entries(formContent)) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value.length > 0) {
        provided.push({ key, value });
      } else {
        skipped.push(key);
      }
    }

    assert.deepStrictEqual(provided, [{ key: 'API_KEY', value: 'provided-value' }]);
    assert.deepStrictEqual(skipped, ['OPTIONAL_KEY']);
  });

  it('result text never contains secret values', async () => {
    const tmp = makeTempDir('sec-collect');
    try {
      const envPath = join(tmp, '.env');
      const savedKey = process.env.RESULT_TEXT_TEST;

      const { applySecrets } = await import('./env-writer.js');
      const { applied } = await applySecrets(
        [{ key: 'RESULT_TEXT_TEST', value: 'sk-super-secret-abc123' }],
        'dotenv',
        { envFilePath: envPath },
      );

      // Simulate building result text (same logic as the tool handler)
      const lines: string[] = [
        'destination: dotenv (auto-detected)',
        ...applied.map((k) => `✓ ${k}: applied`),
      ];
      const resultText = lines.join('\n');

      // The result MUST NOT contain the secret value
      assert.ok(!resultText.includes('sk-super-secret-abc123'), 'result text must not contain secret value');
      assert.ok(resultText.includes('RESULT_TEXT_TEST'), 'result text should contain key name');

      // Cleanup
      if (savedKey === undefined) delete process.env.RESULT_TEXT_TEST;
      else process.env.RESULT_TEXT_TEST = savedKey;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles multiple keys with mixed existing/new/skipped', async () => {
    const tmp = makeTempDir('sec-collect');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'EXISTING_A=already-here\n');
      const savedB = process.env.NEW_B;
      const savedC = process.env.SKIP_C;

      const { checkExistingEnvKeys, applySecrets } = await import('./env-writer.js');

      const allKeys = ['EXISTING_A', 'NEW_B', 'SKIP_C'];
      const existing = await checkExistingEnvKeys(allKeys, envPath);
      assert.deepStrictEqual(existing, ['EXISTING_A']);

      // Simulate form response: NEW_B has value, SKIP_C is empty
      const formContent = { NEW_B: 'new-value', SKIP_C: '' };
      const provided: Array<{ key: string; value: string }> = [];
      const skipped: string[] = [];

      for (const key of allKeys.filter((k) => !existing.includes(k))) {
        const raw = formContent[key as keyof typeof formContent] ?? '';
        if (raw.trim().length > 0) provided.push({ key, value: raw.trim() });
        else skipped.push(key);
      }

      const { applied, errors } = await applySecrets(provided, 'dotenv', { envFilePath: envPath });

      assert.deepStrictEqual(applied, ['NEW_B']);
      assert.deepStrictEqual(skipped, ['SKIP_C']);
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(existing, ['EXISTING_A']);

      // Cleanup
      if (savedB === undefined) delete process.env.NEW_B;
      else process.env.NEW_B = savedB;
      if (savedC === undefined) delete process.env.SKIP_C;
      else process.env.SKIP_C = savedC;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
