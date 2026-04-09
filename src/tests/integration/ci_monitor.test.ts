// Tests for ci_monitor.cjs — cross-platform CI monitoring tool
//
// Sections:
//   (a) Script exists and is executable
//   (b) --help shows all commands
//   (c) list-workflows finds workflow files
//   (d) check-actions parses actions from workflow
//   (e) Commands validate required arguments

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT_PATH = join(ROOT, 'scripts', 'ci_monitor.cjs');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function runScript(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

console.log('# === (a) Script exists and is executable ===');
assert(existsSync(SCRIPT_PATH), 'ci_monitor.cjs exists');
const scriptStat = spawnSync('node', ['--check', SCRIPT_PATH], { encoding: 'utf-8' });
assert(scriptStat.status === 0, 'ci_monitor.cjs has valid JavaScript syntax');

console.log('\n# === (b) --help shows all commands ===');
const help = runScript(['--help']);
assert(help.status === 0, '--help exits with code 0');
assert(help.stdout.includes('runs'), 'help shows runs command');
assert(help.stdout.includes('watch'), 'help shows watch command');
assert(help.stdout.includes('fail-fast'), 'help shows fail-fast command');
assert(help.stdout.includes('log-failed'), 'help shows log-failed command');
assert(help.stdout.includes('test-summary'), 'help shows test-summary command');
assert(help.stdout.includes('check-actions'), 'help shows check-actions command');
assert(help.stdout.includes('grep'), 'help shows grep command');
assert(help.stdout.includes('wait-for'), 'help shows wait-for command');

console.log('\n# === (c) list-workflows finds workflow files ===');
const workflows = runScript(['list-workflows']);
// May fail if no .github/workflows exists, that's OK
if (workflows.status === 0) {
  assert(workflows.stdout.includes('.yml') || workflows.stdout.includes('No workflow files') || workflows.stdout.includes('No .github'), 'list-workflows output mentions yml files or none found');
} else {
  // If it fails, should be due to missing directory
  assert(workflows.stderr.includes('No .github/workflows'), 'list-workflows fails gracefully when no workflows dir');
}

console.log('\n# === (d) check-actions validates workflow file ===');
const checkMissing = runScript(['check-actions', '.github/workflows/nonexistent.yml']);
assert(checkMissing.status !== 0, 'check-actions fails for missing file');
assert(checkMissing.stderr.includes('not found') || checkMissing.stderr.includes('File not found'), 'check-actions reports missing file');

console.log('\n# === (e) Commands validate required arguments ===');
const grepNoPattern = runScript(['grep', '12345']);
assert(grepNoPattern.status !== 0, 'grep fails without --pattern');
assert(grepNoPattern.stderr.includes('--pattern') || grepNoPattern.stderr.includes('required'), 'grep reports missing pattern');

const waitNoKeyword = runScript(['wait-for', '12345', 'build']);
assert(waitNoKeyword.status !== 0, 'wait-for fails without --keyword');
assert(waitNoKeyword.stderr.includes('--keyword') || waitNoKeyword.stderr.includes('required'), 'wait-for reports missing keyword');

const compareMissing = runScript(['compare', '12345']);
assert(compareMissing.status !== 0, 'compare fails with only one run-id');

// ─── Summary ───────────────────────────────────────────────────────────────

console.log('\n# ========================================');
console.log(`# Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('# All tests passed ✓');
