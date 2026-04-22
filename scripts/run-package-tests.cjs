// GSD-2 + scripts/run-package-tests.cjs — run `node --test` across every linkable workspace package
'use strict'

const { spawnSync } = require('child_process')
const { existsSync, readdirSync, statSync } = require('fs')
const { join, relative } = require('path')
const { getLinkablePackages, REPO_ROOT } = require('./lib/workspace-manifest.cjs')

function findTestFiles(dir) {
	const out = []
	if (!existsSync(dir)) return out
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue
			out.push(...findTestFiles(full))
		} else if (entry.isFile()) {
			if (/\.test\.(c|m)?js$/.test(entry.name)) out.push(full)
		}
	}
	return out
}

function findDistTestFiles(pkgDir) {
	// Prefer compiled outputs under packages/<dir>/dist/, fall back to dist-test/packages/<dir>/.
	const pkgDist = join(pkgDir, 'dist')
	const fromPkgDist = findTestFiles(pkgDist)
	if (fromPkgDist.length > 0) return fromPkgDist
	const distTestPkg = join(REPO_ROOT, 'dist-test', 'packages', relative(join(REPO_ROOT, 'packages'), pkgDir))
	return findTestFiles(distTestPkg)
}

const packages = getLinkablePackages()
const allTestFiles = []
const summary = []
for (const pkg of packages) {
	const files = findDistTestFiles(pkg.path)
	summary.push({ pkg: pkg.packageName, dir: pkg.dir, count: files.length })
	allTestFiles.push(...files)
}

process.stderr.write('Workspace package tests:\n')
for (const row of summary) {
	process.stderr.write(`  ${row.pkg} (${row.dir}): ${row.count} file${row.count === 1 ? '' : 's'}\n`)
}

if (allTestFiles.length === 0) {
	process.stderr.write('No workspace package tests found — did you run `npm run build` first?\n')
	process.exit(0)
}

const result = spawnSync(process.execPath, ['--test', ...allTestFiles], {
	stdio: 'inherit',
	cwd: REPO_ROOT,
})
process.exit(result.status ?? 1)
