import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";

// Secret scanner requires bash + POSIX grep — skip on Windows
const isWindows = platform() === "win32";

const projectRoot = join(
  new URL(".", import.meta.url).pathname,
  "..",
  "..",
);
const scanScript = join(projectRoot, "scripts", "secret-scan.sh");

/**
 * Helper: create a temp git repo, stage a file with given content,
 * then run the secret scanner in pre-commit mode.
 */
function scanContent(
  content: string,
  filename = "test-file.ts",
): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-test-"));
  try {
    // Initialize a git repo so `git diff --cached` works
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });

  // Write and stage the file
  const filePath = join(dir, filename);
  const parentDir = join(dir, ...filename.split("/").slice(0, -1));
  if (filename.includes("/")) {
    mkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(filePath, content);
  spawnSync("git", ["add", filename], { cwd: dir });

  const result = spawnSync("bash", [scanScript], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, TERM: "dumb" },
  });

    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Detection tests ──────────────────────────────────────────────────

test("detects AWS access key", { skip: isWindows }, () => {
  const result = scanContent('const key = "AKIAIOSFODNN7EXAMPLE";');
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /AWS Access Key/);
});

test("detects generic API key assignment", { skip: isWindows }, () => {
  const result = scanContent(
    'const api_key = "sk-abc123def456ghi789jkl012mno345pqr678";',
  );
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /Generic API Key/i);
});

test("detects generic secret/password assignment", { skip: isWindows }, () => {
  const result = scanContent('password = "SuperSecretP@ssw0rd!2024"');
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /SECRET DETECTED/);
});

test("detects private key header", { skip: isWindows }, () => {
  const result = scanContent("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /Private Key/);
});

test("detects GitHub personal access token", { skip: isWindows }, () => {
  const result = scanContent(
    'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";',
  );
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /GitHub Token/);
});

test("detects Stripe test key", { skip: isWindows }, () => {
  // Use sk_test_ prefix to avoid GitHub push protection on sk_live_
  const stripeKey = ["sk", "test", "aAbBcCdDeFgHiJkLmNoPqRsT"].join("_");
  const result = scanContent(`const stripe = "${stripeKey}";`);
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /Stripe Key/);
});

test("detects database connection string", { skip: isWindows }, () => {
  const result = scanContent(
    'const db = "postgres://user:pass@host:5432/mydb";',
  );
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /Database URL/);
});

test("detects Slack token", { skip: isWindows }, () => {
  // Build token dynamically to avoid GitHub push protection
  const slackToken = ["xoxb", "000000000000", "0000000000000", "testfakevalue000"].join("-");
  const result = scanContent(`const token = "${slackToken}";`);
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /Slack Token/);
});

test("detects Google API key", { skip: isWindows }, () => {
  const result = scanContent(
    'const key = "AIzaSyA1234567890abcdefghijklmnopqrstuvwx";',
  );
  assert.equal(result.status, 1, `should fail: ${result.stdout}`);
  assert.match(result.stdout, /Google API Key|SECRET DETECTED/);
});

// ── Non-detection tests (should pass clean) ──────────────────────────

test("allows environment variable references", { skip: isWindows }, () => {
  const result = scanContent("const key = process.env.API_KEY;");
  assert.equal(result.status, 0, `should pass: ${result.stdout}`);
});

test("allows empty strings", { skip: isWindows }, () => {
  const result = scanContent('const password = "";');
  assert.equal(result.status, 0, `should pass: ${result.stdout}`);
});

test("allows placeholder values", { skip: isWindows }, () => {
  const result = scanContent('const api_key = "your-api-key-here";');
  assert.equal(result.status, 0, `should pass: ${result.stdout}`);
});

test("skips binary file extensions", { skip: isWindows }, () => {
  const result = scanContent("AKIAIOSFODNN7EXAMPLE", "image.png");
  assert.equal(result.status, 0, `should pass (binary skip): ${result.stdout}`);
});

test("skips package-lock.json", { skip: isWindows }, () => {
  const result = scanContent(
    '{"integrity": "sha512-AKIAIOSFODNN7EXAMPLE"}',
    "package-lock.json",
  );
  assert.equal(result.status, 0, `should pass (lockfile skip): ${result.stdout}`);
});

test("reports no files cleanly", { skip: isWindows }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-empty-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });

  spawnSync("git", ["init"], { cwd: dir });
  const result = spawnSync("bash", [scanScript], {
    cwd: dir,
    encoding: "utf-8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no files to scan/);
});

// ── Multiple findings ────────────────────────────────────────────────

test("reports multiple secrets in one file", { skip: isWindows }, () => {
  const stripeKey = ["sk", "test", "aAbBcCdDeFgHiJkLmNoPqRsT"].join("_");
  const content = [
    'const aws = "AKIAIOSFODNN7EXAMPLE";',
    `const stripe = "${stripeKey}";`,
    'const db = "postgres://admin:secret@db.prod:5432/app";',
  ].join("\n");
  const result = scanContent(content);
  assert.equal(result.status, 1);
  // Should find at least 3 findings
  const count = (result.stdout.match(/SECRET DETECTED/g) || []).length;
  assert.ok(count >= 3, `expected >=3 findings, got ${count}`);
});

// ── CI mode (--diff) ─────────────────────────────────────────────────

test("CI mode scans diff against ref", { skip: isWindows }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-ci-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });

  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });

  // Create initial commit
  writeFileSync(join(dir, "clean.ts"), "const x = 1;");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });

  // Add a file with a secret on a new commit
  writeFileSync(
    join(dir, "leaked.ts"),
    'const key = "AKIAIOSFODNN7EXAMPLE";',
  );
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "add leak"], { cwd: dir });

  const result = spawnSync("bash", [scanScript, "--diff", "HEAD~1"], {
    cwd: dir,
    encoding: "utf-8",
  });

  assert.equal(result.status, 1, `CI mode should detect: ${result.stdout}`);
  assert.match(result.stdout, /AWS Access Key/);
});
