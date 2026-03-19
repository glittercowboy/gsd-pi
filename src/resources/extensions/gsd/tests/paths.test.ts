import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { gsdRoot, _clearGsdRootCache } from "../paths.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

/** Create a tmp dir and resolve symlinks + 8.3 short names (macOS /var→/private/var, Windows RUNNER~1→runneradmin). */
function tmp(): string {
  const p = mkdtempSync(join(tmpdir(), "gsd-paths-test-"));
  try { return realpathSync.native(p); } catch { return p; }
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function initGit(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

// ── tests ──────────────────────────────────────────────────────────────────

{
  // Case 1: .gsd exists at basePath — fast path
  const root = tmp();
  try {
    mkdirSync(join(root, ".gsd"));
    _clearGsdRootCache();
    const result = gsdRoot(root);
    assertEq(result, join(root, ".gsd"), "fast path: returns basePath/.gsd");
  } finally { cleanup(root); }
}

{
  // Case 2: .gsd exists at git root, cwd is a subdirectory
  const root = tmp();
  try {
    initGit(root);
    mkdirSync(join(root, ".gsd"));
    const sub = join(root, "src", "deep");
    mkdirSync(sub, { recursive: true });
    _clearGsdRootCache();
    const result = gsdRoot(sub);
    assertEq(result, join(root, ".gsd"), "git-root probe: finds .gsd at git root from subdirectory");
  } finally { cleanup(root); }
}

{
  // Case 3: .gsd in an ancestor — walk-up finds it (git repo with no .gsd at root)
  const root = tmp();
  try {
    // Init a git repo so git probe returns root — but put .gsd one level deeper
    // to force the walk-up path: root/project/.gsd, cwd = root/project/src/deep
    initGit(root);
    const project = join(root, "project");
    mkdirSync(join(project, ".gsd"), { recursive: true });
    const deep = join(project, "src", "deep");
    mkdirSync(deep, { recursive: true });
    _clearGsdRootCache();
    // git probe returns root (no .gsd there), so walk-up takes over and finds project/.gsd
    const result = gsdRoot(deep);
    assertEq(result, join(project, ".gsd"), "walk-up: finds .gsd in ancestor when git root has none");
  } finally { cleanup(root); }
}

{
  // Case 4: .gsd nowhere — fallback returns original basePath/.gsd
  // Use an isolated git repo so we fully control the environment above basePath
  const root = tmp();
  try {
    initGit(root);                          // git root = root, no .gsd anywhere
    const sub = join(root, "src");
    mkdirSync(sub, { recursive: true });
    _clearGsdRootCache();
    const result = gsdRoot(sub);
    // git probe finds root (no .gsd), walk-up finds nothing → fallback = sub/.gsd
    assertEq(result, join(sub, ".gsd"), "fallback: returns basePath/.gsd when .gsd not found anywhere");
  } finally { cleanup(root); }
}

{
  // Case 5: cache — second call returns same value without re-probing
  const root = tmp();
  try {
    mkdirSync(join(root, ".gsd"));
    _clearGsdRootCache();
    const first = gsdRoot(root);
    const second = gsdRoot(root);
    assertEq(first, second, "cache: same result returned on second call");
    assertTrue(first === second, "cache: identity check (same string)");
  } finally { cleanup(root); }
}

{
  // Case 6: .gsd at basePath takes precedence over ancestor .gsd
  const outer = tmp();
  try {
    initGit(outer);
    mkdirSync(join(outer, ".gsd"));
    const inner = join(outer, "nested");
    mkdirSync(join(inner, ".gsd"), { recursive: true });
    _clearGsdRootCache();
    const result = gsdRoot(inner);
    assertEq(result, join(inner, ".gsd"), "precedence: nearest .gsd wins over ancestor");
  } finally { cleanup(outer); }
}

report();
