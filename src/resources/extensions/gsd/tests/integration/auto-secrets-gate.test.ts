/**
 * Integration tests for the secrets collection gate in startAuto().
 *
 * Exercises getManifestStatus() → collectSecretsFromManifest() composition
 * end-to-end using real filesystem state. Proves the three gate paths:
 *   1. No manifest exists — gate skips silently
 *   2. Pending keys exist — gate triggers collection
 *   3. No pending keys — gate skips silently
 *
 * Uses temp directories with real .gsd/milestones/M001/ structure, mirroring
 * the pattern from manifest-status.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getManifestStatus } from '../../files.ts';
import { collectSecretsFromManifest } from '../../../get-secrets-from-user.ts';

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create the .gsd/milestones/M001/ directory structure and write a secrets manifest. */
function writeManifest(base: string, content: string): void {
  const mDir = join(base, '.gsd', 'milestones', 'M001');
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(mDir, 'M001-SECRETS.md'), content);
}

/** Stub ctx with hasUI: false — collectOneSecret returns null (skip), showSecretsSummary is a no-op. */
function makeNoUICtx(cwd: string) {
  return {
    ui: {},
    hasUI: false,
    cwd,
  };
}

// ─── Scenario 1: No manifest exists ──────────────────────────────────────────

test('secrets gate: no manifest exists — getManifestStatus returns null', async (t) => {
  const tmp = makeTempDir('gate-no-manifest');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // No .gsd directory at all
  const result = await getManifestStatus(tmp, 'M001');
  assert.strictEqual(result, null, 'should return null when no manifest file exists');
});

// ─── Scenario 2: Pending keys exist ─────────────────────────────────────────

test('secrets gate: pending keys exist — gate triggers collection, manifest updated on disk', async (t) => {
  const tmp = makeTempDir('gate-pending');
  const savedA = process.env.GSD_GATE_TEST_EXISTING;
  t.after(() => {
    delete process.env.GSD_GATE_TEST_EXISTING;
    if (savedA !== undefined) process.env.GSD_GATE_TEST_EXISTING = savedA;
    delete process.env.GSD_GATE_TEST_PEND_A;
    delete process.env.GSD_GATE_TEST_PEND_B;
    rmSync(tmp, { recursive: true, force: true });
  });

  // Simulate one key already in env
  process.env.GSD_GATE_TEST_EXISTING = 'already-here';

  // Ensure pending keys are NOT in env
  delete process.env.GSD_GATE_TEST_PEND_A;
  delete process.env.GSD_GATE_TEST_PEND_B;

  writeManifest(tmp, `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-20T10:00:00Z

### GSD_GATE_TEST_PEND_A

**Service:** ServiceA
**Status:** pending
**Destination:** dotenv

1. Get key A from dashboard

### GSD_GATE_TEST_PEND_B

**Service:** ServiceB
**Status:** pending
**Destination:** dotenv

1. Get key B from dashboard

### GSD_GATE_TEST_EXISTING

**Service:** ServiceC
**Status:** pending
**Destination:** dotenv

1. Already in env
`);

  // (a) Verify getManifestStatus shows pending keys
  const status = await getManifestStatus(tmp, 'M001');
  assert.notStrictEqual(status, null, 'manifest should exist');
  assert.ok(status!.pending.length > 0, 'should have pending keys');
  assert.deepStrictEqual(status!.pending, ['GSD_GATE_TEST_PEND_A', 'GSD_GATE_TEST_PEND_B'], 'pending keys');
  assert.deepStrictEqual(status!.existing, ['GSD_GATE_TEST_EXISTING'], 'existing keys');

  // (b) Call collectSecretsFromManifest with no-UI context
  // With hasUI: false, collectOneSecret returns null → pending keys become "skipped"
  const result = await collectSecretsFromManifest(tmp, 'M001', makeNoUICtx(tmp));

  // (c) Verify return shape
  assert.deepStrictEqual(result.applied, [], 'no keys applied (no UI to enter values)');
  assert.ok(result.skipped.includes('GSD_GATE_TEST_PEND_A'), 'PEND_A should be skipped');
  assert.ok(result.skipped.includes('GSD_GATE_TEST_PEND_B'), 'PEND_B should be skipped');
  assert.deepStrictEqual(result.existingSkipped, ['GSD_GATE_TEST_EXISTING']);

  // (d) Verify manifest on disk was updated — pending entries that went through
  // collection are now "skipped". The existing-in-env entry retains its manifest
  // status ("pending") because collectSecretsFromManifest only updates entries
  // that flow through collectOneSecret. At runtime, getManifestStatus overrides
  // env-present entries to "existing" regardless of manifest status.
  const manifestPath = join(tmp, '.gsd', 'milestones', 'M001', 'M001-SECRETS.md');
  const updatedContent = readFileSync(manifestPath, 'utf8');
  assert.ok(
    updatedContent.includes('**Status:** skipped'),
    'formerly-pending entries should now have status "skipped" in the manifest file',
  );
  // Count: PEND_A → skipped, PEND_B → skipped, EXISTING stays pending on disk
  const skippedMatches = updatedContent.match(/\*\*Status:\*\* skipped/g);
  assert.strictEqual(skippedMatches?.length, 2, 'two entries should have status "skipped"');
  const pendingMatches = updatedContent.match(/\*\*Status:\*\* pending/g);
  assert.strictEqual(pendingMatches?.length, 1, 'one entry (existing-in-env) retains pending on disk');

  // (e) Verify getManifestStatus now shows no pending
  const statusAfter = await getManifestStatus(tmp, 'M001');
  assert.notStrictEqual(statusAfter, null);
  assert.deepStrictEqual(statusAfter!.pending, [], 'no pending keys after collection');
});

// ─── Scenario 3: No pending keys — all collected or in env ──────────────────

test('secrets gate: no pending keys — getManifestStatus shows pending.length === 0', async (t) => {
  const tmp = makeTempDir('gate-no-pending');
  const savedKey = process.env.GSD_GATE_TEST_ENVKEY;
  t.after(() => {
    delete process.env.GSD_GATE_TEST_ENVKEY;
    if (savedKey !== undefined) process.env.GSD_GATE_TEST_ENVKEY = savedKey;
    rmSync(tmp, { recursive: true, force: true });
  });

  process.env.GSD_GATE_TEST_ENVKEY = 'some-value';

  writeManifest(tmp, `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-20T10:00:00Z

### ALREADY_COLLECTED

**Service:** ServiceX
**Status:** collected
**Destination:** dotenv

1. Was collected previously

### ALREADY_SKIPPED

**Service:** ServiceY
**Status:** skipped
**Destination:** dotenv

1. Not needed

### GSD_GATE_TEST_ENVKEY

**Service:** ServiceZ
**Status:** pending
**Destination:** dotenv

1. In env already
`);

  const result = await getManifestStatus(tmp, 'M001');
  assert.notStrictEqual(result, null, 'manifest should exist');
  assert.deepStrictEqual(result!.pending, [], 'no pending keys — gate would skip');
  assert.deepStrictEqual(result!.collected, ['ALREADY_COLLECTED']);
  assert.deepStrictEqual(result!.skipped, ['ALREADY_SKIPPED']);
  assert.deepStrictEqual(result!.existing, ['GSD_GATE_TEST_ENVKEY']);
});
