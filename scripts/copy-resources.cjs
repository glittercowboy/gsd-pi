#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { copyFileSync, mkdirSync, readdirSync, rmSync } = require('fs');
const { dirname, join } = require('path');

function copyNonTsFiles(srcDir, destDir) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
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

rmSync('dist/resources', { recursive: true, force: true });

const tscBin = require.resolve('typescript/bin/tsc');
const compile = spawnSync(process.execPath, [tscBin, '--project', 'tsconfig.resources.json'], {
  stdio: 'inherit',
});

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

copyNonTsFiles('src/resources', 'dist/resources');
