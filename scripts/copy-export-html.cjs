#!/usr/bin/env node
const { mkdirSync, cpSync } = require('fs');
const { resolve } = require('path');
const src = resolve(__dirname, '..', 'packages', 'gsd-agent-core', 'dist', 'export-html');
mkdirSync('pkg/dist/core/export-html', { recursive: true });
cpSync(src, 'pkg/dist/core/export-html', { recursive: true });
