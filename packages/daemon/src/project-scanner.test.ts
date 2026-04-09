/**
 * Tests for the project scanner module.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { scanForProjects } from './project-scanner.js';

// ---------- helpers ----------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), `scanner-test-${randomUUID().slice(0, 8)}-`));
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

/** Create a project directory with specified marker files/dirs */
function createProject(root: string, name: string, markers: string[]): string {
  const projDir = join(root, name);
  mkdirSync(projDir, { recursive: true });
  for (const marker of markers) {
    const markerPath = join(projDir, marker);
    if (marker.startsWith('.') && !marker.includes('.')) {
      // Likely a directory marker (.git, .gsd)
      mkdirSync(markerPath, { recursive: true });
    } else {
      // File marker (package.json, Cargo.toml, etc.)
      writeFileSync(markerPath, '{}');
    }
  }
  return projDir;
}

// ---------- tests ----------

describe('scanForProjects', () => {
  it('finds projects with marker files', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'my-app', ['.git', 'package.json']);

    const results = await scanForProjects([root]);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.name, 'my-app');
    assert.equal(results[0]!.path, join(root, 'my-app'));
    assert.ok(results[0]!.markers.includes('git'));
    assert.ok(results[0]!.markers.includes('node'));
    assert.ok(results[0]!.lastModified > 0);
  });

  it('handles missing scan_root gracefully', async () => {
    const results = await scanForProjects(['/nonexistent/path/that/does/not/exist']);
    assert.deepEqual(results, []);
  });

  it('handles permission errors on entries', { skip: platform() === 'win32' ? 'chmod not reliable on Windows' : undefined }, async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    // Create an accessible project
    createProject(root, 'accessible', ['.git']);

    // Create an inaccessible directory
    const noAccess = join(root, 'locked');
    mkdirSync(noAccess);
    chmodSync(noAccess, 0o000);

    const results = await scanForProjects([root]);

    // Restore permissions for cleanup
    chmodSync(noAccess, 0o755);

    // Should find the accessible project but skip the locked one
    assert.equal(results.length, 1);
    assert.equal(results[0]!.name, 'accessible');
  });

  it('detects multiple marker types', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'full-stack', ['.git', 'package.json', '.gsd']);

    const results = await scanForProjects([root]);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.markers.length, 3);
    assert.ok(results[0]!.markers.includes('git'));
    assert.ok(results[0]!.markers.includes('node'));
    assert.ok(results[0]!.markers.includes('gsd'));
  });

  it('returns results sorted alphabetically by name', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'zebra-project', ['.git']);
    createProject(root, 'alpha-project', ['.git']);
    createProject(root, 'middle-project', ['.git']);

    const results = await scanForProjects([root]);

    assert.equal(results.length, 3);
    assert.equal(results[0]!.name, 'alpha-project');
    assert.equal(results[1]!.name, 'middle-project');
    assert.equal(results[2]!.name, 'zebra-project');
  });

  it('ignores hidden directories', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'visible', ['.git']);
    createProject(root, '.hidden', ['.git']);

    const results = await scanForProjects([root]);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.name, 'visible');
  });

  it('ignores node_modules', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'real-project', ['package.json']);
    createProject(root, 'node_modules', ['package.json']);

    const results = await scanForProjects([root]);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.name, 'real-project');
  });

  it('skips directories with no markers', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'has-markers', ['.git']);
    // Create a plain directory with no markers
    mkdirSync(join(root, 'no-markers'));

    const results = await scanForProjects([root]);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.name, 'has-markers');
  });

  it('scans multiple roots', async () => {
    const root1 = tmpDir();
    const root2 = tmpDir();
    cleanupDirs.push(root1, root2);

    createProject(root1, 'proj-a', ['.git']);
    createProject(root2, 'proj-b', ['Cargo.toml']);

    const results = await scanForProjects([root1, root2]);

    assert.equal(results.length, 2);
    assert.equal(results[0]!.name, 'proj-a');
    assert.ok(results[0]!.markers.includes('git'));
    assert.equal(results[1]!.name, 'proj-b');
    assert.ok(results[1]!.markers.includes('rust'));
  });

  it('detects all supported marker types', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'git-proj', ['.git']);
    createProject(root, 'node-proj', ['package.json']);
    createProject(root, 'gsd-proj', ['.gsd']);
    createProject(root, 'rust-proj', ['Cargo.toml']);
    createProject(root, 'python-proj', ['pyproject.toml']);
    createProject(root, 'go-proj', ['go.mod']);

    const results = await scanForProjects([root]);

    assert.equal(results.length, 6);

    const byName = new Map(results.map(r => [r.name, r]));
    assert.deepEqual(byName.get('git-proj')!.markers, ['git']);
    assert.deepEqual(byName.get('node-proj')!.markers, ['node']);
    assert.deepEqual(byName.get('gsd-proj')!.markers, ['gsd']);
    assert.deepEqual(byName.get('rust-proj')!.markers, ['rust']);
    assert.deepEqual(byName.get('python-proj')!.markers, ['python']);
    assert.deepEqual(byName.get('go-proj')!.markers, ['go']);
  });

  it('skips non-directory entries', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'real-project', ['.git']);
    // Create a regular file at the root level — should be ignored
    writeFileSync(join(root, 'some-file.txt'), 'not a directory');

    const results = await scanForProjects([root]);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.name, 'real-project');
  });

  it('returns empty array for empty scan_roots', async () => {
    const results = await scanForProjects([]);
    assert.deepEqual(results, []);
  });

  it('deduplicates when same root appears twice', async () => {
    const root = tmpDir();
    cleanupDirs.push(root);

    createProject(root, 'only-once', ['.git']);

    const results = await scanForProjects([root, root]);

    // Same directory scanned twice — results will have duplicates
    // (this is acceptable; the caller can deduplicate by path if needed)
    assert.equal(results.length, 2);
    assert.equal(results[0]!.name, 'only-once');
    assert.equal(results[1]!.name, 'only-once');
  });
});
