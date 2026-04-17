#!/usr/bin/env node
const { mkdirSync, cpSync } = require('fs');
const { resolve } = require('path');
const src = resolve(__dirname, '..', 'packages', 'pi-coding-agent', 'dist', 'core', 'theme');
mkdirSync('pkg/dist/core/theme', { recursive: true });
cpSync(src, 'pkg/dist/core/theme', { recursive: true });
