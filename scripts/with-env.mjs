#!/usr/bin/env node

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const env = { ...process.env };

let separatorIndex = args.indexOf('--');
let commandStart = separatorIndex >= 0 ? separatorIndex + 1 : 0;

for (let i = 0; i < (separatorIndex >= 0 ? separatorIndex : args.length); i++) {
  const arg = args[i];
  const eq = arg.indexOf('=');
  if (eq <= 0) {
    commandStart = i;
    separatorIndex = -1;
    break;
  }
  env[arg.slice(0, eq)] = arg.slice(eq + 1);
}

const commandArgs = args.slice(commandStart);
if (commandArgs.length === 0) {
  process.stderr.write('with-env: expected a command after environment assignments\n');
  process.exit(1);
}

const [command, ...childArgs] = commandArgs;
const child = spawn(command, childArgs, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  process.stderr.write(`with-env: failed to run ${command}: ${error.message}\n`);
  process.exit(1);
});
