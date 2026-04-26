#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');

const SKIP_DIRS = new Set(['tests', '__tests__']);
const SKIP_FILE_RE = /(?:^\.DS_Store$|\.test\.(?:cjs|mjs|js|json|md|py)$|\.spec\.(?:cjs|mjs|js|json|md|py)$)/;
const FINGERPRINT_FILE = '.managed-resources-content-hash';

function shouldSkip(entry) {
  if (entry.isDirectory()) {
    return SKIP_DIRS.has(entry.name);
  }
  return SKIP_FILE_RE.test(entry.name);
}

function copyNonTsFiles(srcDir, destDir) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (shouldSkip(entry)) {
      continue;
    }

    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyNonTsFiles(srcPath, destPath);
      continue;
    }

    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      continue;
    }

    mkdirSync(dirname(destPath), { recursive: true });

    // Rewrite pi.extensions paths from .ts to .js in package.json files
    // so they match the compiled output (tsc compiles index.ts → index.js
    // but package.json is copied as-is).
    if (entry.name === 'package.json') {
      try {
        const pkg = JSON.parse(require('fs').readFileSync(srcPath, 'utf-8'));
        if (Array.isArray(pkg?.pi?.extensions)) {
          pkg.pi.extensions = pkg.pi.extensions.map(ext =>
            ext.replace(/\.ts$/, '.js').replace(/\.tsx$/, '.js')
          );
          require('fs').writeFileSync(destPath, JSON.stringify(pkg, null, 2) + '\n');
          continue;
        }
      } catch { /* fall through to plain copy */ }
    }

    copyFileSync(srcPath, destPath);
  }
}

function collectFileEntries(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === FINGERPRINT_FILE) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFileEntries(fullPath, root, out);
      continue;
    }
    const rel = fullPath.slice(root.length + 1).replaceAll('\\', '/');
    const contentHash = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
    out.push(`${rel}:${contentHash}`);
  }
}

function writeResourceFingerprint(rootDir) {
  const entries = [];
  collectFileEntries(rootDir, rootDir, entries);
  entries.sort();
  const hash = createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16);
  writeFileSync(join(rootDir, FINGERPRINT_FILE), `${hash}\n`);
}

rmSync('dist/resources', { recursive: true, force: true });

const tscBin = require.resolve('typescript/bin/tsc');
const compile = spawnSync(process.execPath, [tscBin, '--project', 'tsconfig.resources.json'], {
  stdio: 'inherit',
});

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

copyNonTsFiles('src/resources', 'dist/resources');
writeResourceFingerprint('dist/resources');
