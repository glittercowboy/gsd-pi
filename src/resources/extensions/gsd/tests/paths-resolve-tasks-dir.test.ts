// Regression test for issue #3183:
// resolveTasksDir must return the expected path string even when tasks/ does not
// exist on disk. Returning null caused verifyExpectedArtifact to silently pass
// verification when it should have detected a missing directory.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { resolveTasksDir } from '../paths.js';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeSliceFixture(createTasksDir: boolean): { base: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-paths-test-'));
  const sliceDir = path.join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01');
  fs.mkdirSync(sliceDir, { recursive: true });
  if (createTasksDir) {
    fs.mkdirSync(path.join(sliceDir, 'tasks'), { recursive: true });
  }
  return {
    base,
    cleanup: () => {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveTasksDir (#3183)', () => {

  // Test A: must FAIL before the fix — resolveTasksDir currently returns null
  // when the tasks/ directory does not exist on disk.
  test('A: returns non-null path when tasks/ directory does NOT exist on disk', (t) => {
    const { base, cleanup } = makeSliceFixture(false);
    t.after(cleanup);

    const result = resolveTasksDir(base, 'M001', 'S01');

    assert.notEqual(result, null, 'resolveTasksDir must return a path, not null, when tasks/ is absent');
  });

  // Test B: baseline — should pass before and after the fix.
  test('B: returns non-null path when tasks/ directory DOES exist on disk', (t) => {
    const { base, cleanup } = makeSliceFixture(true);
    t.after(cleanup);

    const result = resolveTasksDir(base, 'M001', 'S01');

    assert.notEqual(result, null, 'resolveTasksDir must return a path when tasks/ exists');
  });

  // Test C: null is still correct when the slice directory itself cannot be resolved.
  test('C: returns null when the slice directory does not exist', (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-paths-no-slice-'));
    // Only create the milestone dir — NO slice dir.
    fs.mkdirSync(path.join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
    t.after(() => {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
    });

    const result = resolveTasksDir(base, 'M001', 'S01');

    assert.equal(result, null, 'resolveTasksDir must return null when slice dir is unresolvable');
  });

  // Test D: the returned path ends with 'tasks' in both existence scenarios.
  test('D: returned path ends with /tasks in both existence cases', (t) => {
    const withTasks = makeSliceFixture(true);
    const withoutTasks = makeSliceFixture(false);
    t.after(() => { withTasks.cleanup(); withoutTasks.cleanup(); });

    const resultWith = resolveTasksDir(withTasks.base, 'M001', 'S01');
    const resultWithout = resolveTasksDir(withoutTasks.base, 'M001', 'S01');

    assert.notEqual(resultWith, null);
    assert.notEqual(resultWithout, null);
    assert.match(resultWith!, /[/\\]tasks$/);
    assert.match(resultWithout!, /[/\\]tasks$/);
  });

});
