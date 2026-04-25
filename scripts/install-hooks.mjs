#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = '# gsd-secret-scan';

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
}

const gitDir = git(['rev-parse', '--git-dir']);
const repoRoot = git(['rev-parse', '--show-toplevel']);
const hookDir = join(gitDir, 'hooks');
const hookFile = join(hookDir, 'pre-commit');
const hookCommand = `node "${join(repoRoot, 'scripts', 'secret-scan.mjs')}"`;

mkdirSync(hookDir, { recursive: true });

if (existsSync(hookFile)) {
  const current = readFileSync(hookFile, 'utf8');
  if (current.includes(MARKER)) {
    process.stdout.write('secret-scan pre-commit hook already installed.\n');
    process.exit(0);
  }

  const next = `${current.replace(/\s*$/, '\n')}${MARKER}\n${hookCommand}\n`;
  writeFileSync(hookFile, next, 'utf8');
  process.stdout.write('secret-scan appended to existing pre-commit hook.\n');
  process.exit(0);
}

const hookBody = [
  '#!/usr/bin/env sh',
  '# gsd-secret-scan',
  '# Pre-commit hook: scan staged files for hardcoded secrets',
  hookCommand,
  '',
].join('\n');

writeFileSync(hookFile, hookBody, 'utf8');
try {
  chmodSync(hookFile, 0o755);
} catch {
  // Best effort on Windows filesystems that do not honor chmod.
}

process.stdout.write('secret-scan pre-commit hook installed.\n');
