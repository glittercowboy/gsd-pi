#!/usr/bin/env node

/**
 * GSD Postinstall
 *
 * Thin wrapper that delegates to install.js in postinstall mode
 * (workspace linking + deps only, no global/local npm install).
 */

process.env.npm_lifecycle_event = process.env.npm_lifecycle_event || 'postinstall'
import('./install.js')
