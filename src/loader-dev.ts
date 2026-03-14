#!/usr/bin/env node
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// This is the development loader for gsd-dev.
// It sets up environment variables to use ~/.gsd-dev instead of ~/.gsd,
// then delegates to the main loader.

const thisDir = dirname(fileURLToPath(import.meta.url))

// GSD_CONFIG_DIR — tells app-paths.ts to use ~/.gsd-dev instead of ~/.gsd
process.env.GSD_CONFIG_DIR = '~/.gsd-dev'

// PI_PACKAGE_DIR — point to pkg-dev/ which has piConfig.configDir = ".gsd-dev"
// This ensures pi-coding-agent also uses the correct config directory name
const pkgDevDir = resolve(thisDir, '..', 'pkg-dev')
process.env.PI_PACKAGE_DIR = pkgDevDir

// Delegate to the main loader
await import('./loader.js')
