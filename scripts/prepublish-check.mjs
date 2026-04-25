#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

if (process.env.CI === 'true' || process.env.CI === '1') {
  process.exit(0);
}

const result = spawnSync('git', ['diff', '--exit-code'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status === 0) {
  process.exit(0);
}

process.stderr.write('ERROR: version sync changed files — commit them before publishing\n');
process.exit(result.status ?? 1);
