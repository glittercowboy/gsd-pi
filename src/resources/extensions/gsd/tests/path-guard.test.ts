// Unit tests for the filesystem perimeter guard. Tests cover:
//   - the pure isWithinPerimeter predicate (relative, absolute, escape hatches)
//   - classifyFilePath wrapper for Write/Edit
//   - classifyBashPath wrapper for bash redirect/cp/mv/rm/dd/sed/tee patterns

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyBashPath,
  classifyFilePath,
  isWithinPerimeter,
} from "../safety/path-guard.ts";

// ─── isWithinPerimeter ──────────────────────────────────────────────────────

test("isWithinPerimeter allows relative paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const p of ["src/foo.ts", "./bar.md", "../sibling/baz.txt", "scripts/dev.js"]) {
    assert.equal(isWithinPerimeter(p, base), true, p);
  }
});

test("isWithinPerimeter allows absolute paths inside the base", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const p of [base, join(base, "foo.ts"), join(base, "deep", "nested", "file.md")]) {
    assert.equal(isWithinPerimeter(p, base), true, p);
  }
});

test("isWithinPerimeter blocks absolute paths outside the base", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const p of ["/etc/passwd", "/usr/local/bin/something", "/var/log/system.log"]) {
    assert.equal(isWithinPerimeter(p, base), false, p);
  }
});

test("isWithinPerimeter does not produce false positives via prefix collisions", () => {
  // Use non-existent paths outside tmpdir so the escape hatch doesn't mask
  // the prefix check. canonicalize() falls back to resolve() for missing paths.
  const base = "/projects/myapp";
  assert.equal(isWithinPerimeter("/projects/myapp-sibling/x.txt", base), false);
  assert.equal(isWithinPerimeter("/projects/myappextra", base), false);
});

test("isWithinPerimeter allows the system tmp dir as an escape hatch", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const scratch = join(tmpdir(), "gsd-perim-scratch.txt");
  assert.equal(isWithinPerimeter(scratch, base), true);
});

test("isWithinPerimeter follows in-tree symlinks", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // Create a file inside base, then a symlink elsewhere pointing into base.
  // The symlink's target is in-tree, so it should be allowed.
  const target = join(base, "real.txt");
  writeFileSync(target, "ok");
  const linkDir = mkdtempSync(join(tmpdir(), "gsd-perim-link-"));
  t.after(() => rmSync(linkDir, { recursive: true, force: true }));
  const link = join(linkDir, "alias.txt");
  try {
    symlinkSync(target, link);
  } catch {
    // Some sandboxes disallow symlinks; skip this assertion in that case.
    return;
  }
  // The symlink itself lives outside base, but its realpath is inside.
  assert.equal(isWithinPerimeter(link, base), true);
});

test("isWithinPerimeter handles non-existent target paths (realpath fallback)", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // New file inside the perimeter — does not exist yet, must still be allowed.
  assert.equal(isWithinPerimeter(join(base, "does-not-exist.txt"), base), true);
  // New file outside — does not exist yet, must still be blocked. Use a path
  // that won't collide with $TMPDIR on macOS.
  assert.equal(isWithinPerimeter("/etc/does-not-exist-yet", base), false);
});

test("isWithinPerimeter fails closed when basePath is missing", () => {
  assert.equal(isWithinPerimeter("/etc/passwd", ""), false);
});

// ─── classifyFilePath ───────────────────────────────────────────────────────

test("classifyFilePath: pass for in-tree paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const p of ["src/foo.ts", join(base, "bar.md"), "./scripts/x.sh"]) {
    assert.equal(classifyFilePath(p, base).block, false, p);
  }
});

test("classifyFilePath: block for out-of-tree absolute paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const p of ["/etc/passwd", "/root/.ssh/authorized_keys", "/usr/local/bin/x"]) {
    const r = classifyFilePath(p, base);
    assert.equal(r.block, true, p);
    assert.match(r.reason, /outside session perimeter/, p);
    assert.equal(r.matchedPath, p);
  }
});

// ─── classifyBashPath ───────────────────────────────────────────────────────

test("classifyBashPath: block redirect to absolute out-of-tree paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const cmd of [
    "echo malicious > /etc/passwd",
    "cat foo >> /etc/hosts",
    "echo x >| /var/log/messages",
    "echo y > /usr/local/bin/inject",
  ]) {
    assert.equal(classifyBashPath(cmd, base).block, true, cmd);
  }
});

test("classifyBashPath: pass for redirects to in-tree relative paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const cmd of [
    "echo hi > out.txt",
    "echo hi >> ./logs/run.log",
    "cat foo > ../sibling.txt",
  ]) {
    assert.equal(classifyBashPath(cmd, base).block, false, cmd);
  }
});

test("classifyBashPath: pass for redirects to in-tree absolute paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const target = join(base, "out.txt");
  assert.equal(classifyBashPath(`echo hi > ${target}`, base).block, false);
});

test("classifyBashPath: pass for redirects to system tmpdir", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const scratch = join(tmpdir(), "gsd-bash-scratch.txt");
  assert.equal(classifyBashPath(`echo hi > ${scratch}`, base).block, false);
});

test("classifyBashPath: block tee/cp/mv/sed/dd/rm to out-of-tree absolute paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const cmd of [
    "echo bad | tee /etc/cron.daily/evil",
    "cp ./malicious.so /usr/local/lib/x.so",
    "mv ./bad /etc/init.d/bad",
    "sed -i 's/x/y/' /etc/hosts",
    "dd if=./payload of=/dev/sda1",
    "rm /etc/passwd",
  ]) {
    assert.equal(classifyBashPath(cmd, base).block, true, cmd);
  }
});

test("classifyBashPath: pass for innocuous bash commands", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-perim-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const cmd of [
    "ls -la",
    "git status",
    "npm test",
    "echo hello",
    "cat README.md",
    "find . -name '*.ts'",
    "rm tmpfile.txt",
    "cp ./a.txt ./b.txt",
  ]) {
    assert.equal(classifyBashPath(cmd, base).block, false, cmd);
  }
});

test("classifyBashPath: ~/ paths are expanded and checked", (t) => {
  // Use a non-tmpdir base and a fake HOME also outside tmpdir so neither
  // the perimeter nor the tmpdir escape hatch lets ~/.ssh through.
  const base = "/projects/myapp";
  const originalHome = process.env.HOME;
  process.env.HOME = "/nonexistent/fake-home";
  t.after(() => {
    process.env.HOME = originalHome;
  });

  assert.equal(classifyBashPath("echo bad > ~/.ssh/authorized_keys", base).block, true);
});
