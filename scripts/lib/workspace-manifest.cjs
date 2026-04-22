// GSD-2 + scripts/lib/workspace-manifest.cjs — single source of truth for linkable @gsd/* packages
'use strict'

const { readdirSync, readFileSync, existsSync, statSync } = require('fs')
const { join, resolve } = require('path')

const REPO_ROOT = resolve(__dirname, '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/**
 * Returns the canonical list of linkable workspace packages.
 *
 * A package is "linkable" if its `package.json` contains:
 *   { "gsd": { "linkable": true, "scope": "@gsd" | "@gsd-build", "name": "<pkgname>" } }
 *
 * Each returned entry has:
 *   - dir: directory name under packages/ (e.g. "gsd-agent-core")
 *   - scope: "@gsd" or "@gsd-build"
 *   - name: unscoped package name (e.g. "agent-core")
 *   - packageName: scoped name (e.g. "@gsd/agent-core")
 *   - path: absolute path to package directory
 *   - packageJsonPath: absolute path to its package.json
 *
 * Used by:
 *   - scripts/link-workspace-packages.cjs (node_modules linkage)
 *   - src/loader.ts (via scripts/generate-ws-packages.cjs)
 *   - scripts/validate-pack.js (pack-install smoke checks)
 *   - scripts/verify-workspace-coverage.cjs (CI coverage gate)
 */
function getLinkablePackages() {
	if (!existsSync(PACKAGES_DIR)) return []
	const entries = readdirSync(PACKAGES_DIR)
	const out = []
	for (const dir of entries) {
		const pkgPath = join(PACKAGES_DIR, dir)
		if (!statSync(pkgPath).isDirectory()) continue
		const pkgJsonPath = join(pkgPath, 'package.json')
		if (!existsSync(pkgJsonPath)) continue
		let pkg
		try {
			pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
		} catch (err) {
			throw new Error(`Invalid package.json at ${pkgJsonPath}: ${err.message}`)
		}
		const gsd = pkg.gsd
		if (!gsd || gsd.linkable !== true) continue
		if (!gsd.scope || !gsd.name) {
			throw new Error(
				`${pkgJsonPath}: "gsd.linkable" is true but "gsd.scope" or "gsd.name" is missing.`
			)
		}
		if (gsd.scope !== '@gsd' && gsd.scope !== '@gsd-build') {
			throw new Error(
				`${pkgJsonPath}: "gsd.scope" must be "@gsd" or "@gsd-build" (got "${gsd.scope}").`
			)
		}
		const expectedName = `${gsd.scope}/${gsd.name}`
		if (pkg.name !== expectedName) {
			throw new Error(
				`${pkgJsonPath}: package.json "name" (${pkg.name}) does not match gsd.scope/gsd.name (${expectedName}).`
			)
		}
		out.push({
			dir,
			scope: gsd.scope,
			name: gsd.name,
			packageName: pkg.name,
			path: pkgPath,
			packageJsonPath: pkgJsonPath,
		})
	}
	out.sort((a, b) => a.packageName.localeCompare(b.packageName))
	return out
}

/** Returns only packages in the `@gsd` scope (excludes `@gsd-build`). */
function getCorePackages() {
	return getLinkablePackages().filter((p) => p.scope === '@gsd')
}

module.exports = {
	REPO_ROOT,
	PACKAGES_DIR,
	getLinkablePackages,
	getCorePackages,
}
