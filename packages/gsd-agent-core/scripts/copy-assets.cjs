#!/usr/bin/env node
const { mkdirSync, cpSync, copyFileSync, readdirSync } = require('fs');
const { join } = require('path');

/**
 * Recursive directory copy using copyFileSync — workaround for cpSync failures
 * on Windows paths containing non-ASCII characters.
 */
function safeCpSync(src, dest, options) {
  try {
    cpSync(src, dest, options);
  } catch {
    if (options && options.recursive) {
      copyDirRecursive(src, dest, options && options.filter);
    } else {
      copyFileSync(src, dest);
    }
  }
}

function copyDirRecursive(src, dest, filter) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (filter && !filter(srcPath)) continue;
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, filter);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// Export HTML templates and vendor files (moved from pi-coding-agent in CORE-01)
mkdirSync('dist/export-html/vendor', { recursive: true });
safeCpSync('src/export-html/template.html', 'dist/export-html/template.html');
safeCpSync('src/export-html/template.css', 'dist/export-html/template.css');
safeCpSync('src/export-html/template.js', 'dist/export-html/template.js');
safeCpSync('src/export-html/vendor', 'dist/export-html/vendor', {
  recursive: true,
  filter: (s) => !s.endsWith('.ts'),
});
