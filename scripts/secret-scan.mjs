#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const RED = '\x1b[0;31m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';
const IGNORE_FILE = '.secretscanignore';

const PATTERNS = [
  { label: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
  { label: 'Generic API Key', regex: /(api[_-]?key|apikey|api[_-]?secret)[ \t]*[:=][ \t]*['"][0-9a-zA-Z_./-]{20,}['"]/gi },
  { label: 'Generic Secret', regex: /(secret|token|password|passwd|pwd|credential)[ \t]*[:=][ \t]*['"][^\s'"]{8,}['"]/gi },
  { label: 'Authorization Header', regex: /(authorization|bearer)[ \t]*[:=][ \t]*['"][^\s'"]{8,}['"]/gi },
  { label: 'Private Key', regex: /-----BEGIN\s+(RSA|DSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY-----/g },
  { label: 'Database URL', regex: /(mysql|postgres|postgresql|mongodb|redis|amqp|mssql):\/\/[^\s'"]{8,}/gi },
  { label: 'GitHub Token', regex: /gh[pousr]_[0-9a-zA-Z]{36,}/g },
  { label: 'GitLab Token', regex: /glpat-[0-9a-zA-Z-]{20,}/g },
  { label: 'Slack Token', regex: /xox[baprs]-[0-9a-zA-Z-]{10,}/g },
  { label: 'Slack Webhook', regex: /hooks\.slack\.com\/services\/T[0-9A-Z]{8,}\/B[0-9A-Z]{8,}\/[0-9a-zA-Z]{20,}/g },
  { label: 'Google API Key', regex: /AIza[0-9A-Za-z_-]{35}/g },
  { label: 'Stripe Key', regex: /[sr]k_(live|test)_[0-9a-zA-Z]{20,}/g },
  { label: 'npm Token', regex: /npm_[0-9a-zA-Z]{36,}/g },
  { label: 'Hex Secret', regex: /(secret|key|token|password)[ \t]*[:=][ \t]*['"]?[0-9a-f]{32,}['"]?/gi },
  { label: 'Hardcoded Password', regex: /password[ \t]*[:=][ \t]*['"][^'"]{4,}['"]/gi },
];

function runGit(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  if (argv[0] === '--diff') {
    return { mode: 'diff', ref: argv[1] || 'HEAD' };
  }
  if (argv[0] === '--file') {
    return { mode: 'file', file: argv[1] || '' };
  }
  return { mode: 'staged' };
}

function getFiles(options) {
  if (options.mode === 'diff') {
    return runGit(['diff', '--name-only', '--diff-filter=ACMR', options.ref]);
  }
  if (options.mode === 'file') {
    return options.file;
  }
  return runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
}

function shouldScan(file) {
  const lower = file.toLowerCase();
  const skippedExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
    '.o', '.a', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.lock', '.map', '.node', '.wasm',
  ];
  if (skippedExtensions.some((ext) => lower.endsWith(ext))) return false;
  if (
    lower === '.secretscanignore' ||
    lower === '.gitignore' ||
    lower === '.gitattributes' ||
    lower.startsWith('license') ||
    lower.startsWith('changelog') ||
    lower.endsWith('.md') ||
    lower === 'package-lock.json' ||
    lower === 'pnpm-lock.yaml' ||
    lower === 'bun.lock'
  ) {
    return false;
  }
  if (
    lower.startsWith('node_modules/') ||
    lower.startsWith('dist/') ||
    lower.startsWith('coverage/') ||
    lower.startsWith('.gsd/')
  ) {
    return false;
  }
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return false;
  return true;
}

function getContent(file, mode) {
  if (mode === 'staged') {
    const staged = runGit(['show', `:${file}`]);
    if (staged) return staged;
  }
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function loadIgnorePatterns() {
  if (!existsSync(IGNORE_FILE)) return [];
  return readFileSync(IGNORE_FILE, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function isIgnored(file, lineContent, ignorePatterns) {
  return ignorePatterns.some((pattern) => {
    const splitIndex = pattern.indexOf(':');
    if (splitIndex > 0) {
      const ignoreFile = pattern.slice(0, splitIndex);
      const ignoreRegex = pattern.slice(splitIndex + 1);
      if (file !== ignoreFile) return false;
      try {
        return new RegExp(ignoreRegex, 'i').test(lineContent);
      } catch {
        return false;
      }
    }

    try {
      return new RegExp(pattern, 'i').test(lineContent);
    } catch {
      return false;
    }
  });
}

function resetRegex(regex) {
  regex.lastIndex = 0;
  return regex;
}

const options = parseArgs(process.argv.slice(2));
const files = getFiles(options)
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter(Boolean);

if (files.length === 0) {
  process.stdout.write('secret-scan: no files to scan\n');
  process.exit(0);
}

const ignorePatterns = loadIgnorePatterns();
let findings = 0;

for (const file of files) {
  if (!shouldScan(file)) continue;
  const content = getContent(file, options.mode);
  if (!content) continue;

  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (const pattern of PATTERNS) {
      if (!resetRegex(pattern.regex).test(line)) continue;
      if (isIgnored(file, line, ignorePatterns)) continue;

      process.stdout.write(`${RED}[SECRET DETECTED]${NC} ${YELLOW}${pattern.label}${NC}\n`);
      process.stdout.write(`  File: ${file}:${lineIndex + 1}\n`);
      process.stdout.write(`  Line: ${line.slice(0, 120)}...\n\n`);
      findings++;
    }
  }
}

if (findings > 0) {
  process.stdout.write(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n`);
  process.stdout.write(`${RED}Found ${findings} potential secret(s) in scanned files.${NC}\n`);
  process.stdout.write(`${RED}Commit blocked. Remove the secrets or add exceptions${NC}\n`);
  process.stdout.write(`${RED}to .secretscanignore if these are false positives.${NC}\n`);
  process.stdout.write(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n`);
  process.exit(1);
}

process.stdout.write('secret-scan: no secrets detected ✓\n');
