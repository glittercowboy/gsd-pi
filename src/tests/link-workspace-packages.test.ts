import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("link-workspace-packages creates relocatable links and repairs broken symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-link-workspace-"));
  const scriptsDir = join(root, "scripts");
  const packagesDir = join(root, "packages");
  const scopeDir = join(root, "node_modules", "@gsd");
  const packageNames = ["native", "pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"];

  try {
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(scopeDir, { recursive: true });

    copyFileSync(
      join(process.cwd(), "scripts", "link-workspace-packages.cjs"),
      join(scriptsDir, "link-workspace-packages.cjs"),
    );

    for (const name of packageNames) {
      const pkgDir = join(packagesDir, name);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: `@gsd/${name}` }) + "\n", "utf-8");
    }

    const staleTarget = join(root, "stale-install", "packages", "native");
    symlinkSync(staleTarget, join(scopeDir, "native"));

    const result = spawnSync("node", ["scripts/link-workspace-packages.cjs"], {
      cwd: root,
      encoding: "utf-8",
    });

    assert.equal(result.status, 0, `link script exits cleanly: ${result.stderr}`);

    const nativeTarget = join(scopeDir, "native");
    const stat = lstatSync(nativeTarget);
    assert.equal(stat.isSymbolicLink(), true, "native target should be a symlink on POSIX");

    const linkTarget = readlinkSync(nativeTarget);
    if (process.platform !== "win32") {
      assert.equal(isAbsolute(linkTarget), false, "POSIX install links should be relative and relocatable");
    }
    assert.equal(
      resolve(dirname(nativeTarget), linkTarget),
      join(packagesDir, "native"),
      "broken symlink should be repaired to the packaged workspace path",
    );
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
