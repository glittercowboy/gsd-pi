/**
 * Tests for getManifestStatus() — the S01→S02 boundary contract.
 *
 * Verifies that manifest entries are correctly categorized into
 * pending, collected, skipped, and existing arrays based on
 * manifest status and environment presence.
 *
 * Uses temp directories with real .gsd/milestones/M001/ structure.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getManifestStatus } from '../files.ts';

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

// ─── Mixed statuses ──────────────────────────────────────────────────────────

describe('getManifestStatus: mixed statuses', () => {
  let tmp: string;
  let savedVal: string | undefined;
  beforeEach(() => {
    tmp = makeTempDir('manifest-mixed');
    savedVal = process.env.GSD_TEST_EXISTING_KEY_001;
    process.env.GSD_TEST_EXISTING_KEY_001 = 'some-value';
  });
  afterEach(() => {
    delete process.env.GSD_TEST_EXISTING_KEY_001;
    if (savedVal !== undefined) process.env.GSD_TEST_EXISTING_KEY_001 = savedVal;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('categorizes entries correctly', async () => {
    writeManifest(tmp, `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-20T10:00:00Z

### PENDING_KEY

**Service:** SomeService
**Status:** pending
**Destination:** dotenv

1. Get the key

### COLLECTED_KEY

**Service:** AnotherService
**Status:** collected
**Destination:** dotenv

1. Already collected

### SKIPPED_KEY

**Service:** OptionalService
**Status:** skipped
**Destination:** dotenv

1. Not needed

### GSD_TEST_EXISTING_KEY_001

**Service:** EnvService
**Status:** pending
**Destination:** dotenv

1. Already in env
`);

    const result = await getManifestStatus(tmp, 'M001');
    assert.notStrictEqual(result, null, 'should not be null');
    assert.deepStrictEqual(result!.pending, ['PENDING_KEY']);
    assert.deepStrictEqual(result!.collected, ['COLLECTED_KEY']);
    assert.deepStrictEqual(result!.skipped, ['SKIPPED_KEY']);
    assert.deepStrictEqual(result!.existing, ['GSD_TEST_EXISTING_KEY_001']);
  });
});

// ─── All pending ─────────────────────────────────────────────────────────────

describe('getManifestStatus: simple temp dir tests', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir('manifest-test'); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('all pending — 3 pending entries, none in env', async () => {
    // Ensure none of these are in process.env
    delete process.env.PEND_A;
    delete process.env.PEND_B;
    delete process.env.PEND_C;

    writeManifest(tmp, `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-20T10:00:00Z

### PEND_A

**Service:** A
**Status:** pending
**Destination:** dotenv

1. Step one

### PEND_B

**Service:** B
**Status:** pending
**Destination:** dotenv

1. Step one

### PEND_C

**Service:** C
**Status:** pending
**Destination:** dotenv

1. Step one
`);

    const result = await getManifestStatus(tmp, 'M001');
    assert.notStrictEqual(result, null);
    assert.deepStrictEqual(result!.pending, ['PEND_A', 'PEND_B', 'PEND_C']);
    assert.deepStrictEqual(result!.collected, []);
    assert.deepStrictEqual(result!.skipped, []);
    assert.deepStrictEqual(result!.existing, []);
  });

  // ─── All collected ───────────────────────────────────────────────────────────

  test('all collected — 2 collected entries, none in env', async () => {
    delete process.env.COLL_X;
    delete process.env.COLL_Y;

    writeManifest(tmp, `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-20T10:00:00Z

### COLL_X

**Service:** X
**Status:** collected
**Destination:** dotenv

1. Done

### COLL_Y

**Service:** Y
**Status:** collected
**Destination:** dotenv

1. Done
`);

    const result = await getManifestStatus(tmp, 'M001');
    assert.notStrictEqual(result, null);
    assert.deepStrictEqual(result!.pending, []);
    assert.deepStrictEqual(result!.collected, ['COLL_X', 'COLL_Y']);
    assert.deepStrictEqual(result!.skipped, []);
    assert.deepStrictEqual(result!.existing, []);
  });

  // ─── Missing manifest ────────────────────────────────────────────────────────

  test('missing manifest — returns null', async () => {
    // No .gsd directory at all
    const result = await getManifestStatus(tmp, 'M001');
    assert.strictEqual(result, null);
  });

  // ─── Empty manifest (no entries) ─────────────────────────────────────────────

  test('empty manifest — exists but no H3 sections', async () => {
    writeManifest(tmp, `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-20T10:00:00Z
`);

    const result = await getManifestStatus(tmp, 'M001');
    assert.notStrictEqual(result, null);
    assert.deepStrictEqual(result!.pending, []);
    assert.deepStrictEqual(result!.collected, []);
    assert.deepStrictEqual(result!.skipped, []);
    assert.deepStrictEqual(result!.existing, []);
  });

  // ─── Env via .env file (not just process.env) ────────────────────────────────

  test('key in .env file counts as existing', async () => {
    delete process.env.DOTENV_ONLY_KEY;

    writeManifest(tmp, `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-20T10:00:00Z

### DOTENV_ONLY_KEY

**Service:** DotenvService
**Status:** pending
**Destination:** dotenv

1. Get key
`);

    // Write a .env file at the project root with the key
    writeFileSync(join(tmp, '.env'), 'DOTENV_ONLY_KEY=from-dotenv-file\n');

    const result = await getManifestStatus(tmp, 'M001');
    assert.notStrictEqual(result, null);
    assert.deepStrictEqual(result!.existing, ['DOTENV_ONLY_KEY']);
    assert.deepStrictEqual(result!.pending, []);
  });
});

// ─── Key in env overrides manifest status ────────────────────────────────────

describe('getManifestStatus: key in env overrides manifest status', () => {
  let tmp: string;
  let savedVal: string | undefined;
  beforeEach(() => {
    tmp = makeTempDir('manifest-override');
    savedVal = process.env.GSD_TEST_OVERRIDE_KEY;
    process.env.GSD_TEST_OVERRIDE_KEY = 'already-here';
  });
  afterEach(() => {
    delete process.env.GSD_TEST_OVERRIDE_KEY;
    if (savedVal !== undefined) process.env.GSD_TEST_OVERRIDE_KEY = savedVal;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('collected key in env goes to existing', async () => {
    writeManifest(tmp, `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-20T10:00:00Z

### GSD_TEST_OVERRIDE_KEY

**Service:** Override
**Status:** collected
**Destination:** dotenv

1. Was collected but now in env
`);

    const result = await getManifestStatus(tmp, 'M001');
    assert.notStrictEqual(result, null);
    assert.deepStrictEqual(result!.pending, []);
    assert.deepStrictEqual(result!.collected, []);
    assert.deepStrictEqual(result!.skipped, []);
    assert.deepStrictEqual(result!.existing, ['GSD_TEST_OVERRIDE_KEY']);
  });
});
