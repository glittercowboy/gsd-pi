#!/usr/bin/env node
// GSD-2 + scripts/verify-workspace-coverage.cjs — CI gate: every linkable workspace package must have test coverage
'use strict'

const { readdirSync, existsSync, statSync } = require('fs')
const { join } = require('path')
const { getLinkablePackages } = require('./lib/workspace-manifest.cjs')

function hasTestFile(dir) {
	if (!existsSync(dir)) return false
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-test') continue
			if (hasTestFile(full)) return true
		} else if (entry.isFile()) {
			if (/\.test\.(c|m)?(ts|js)x?$/.test(entry.name)) return true
		}
	}
	return false
}

function main() {
	const packages = getLinkablePackages()
	const failures = []

	process.stderr.write(`Verifying test coverage for ${packages.length} linkable workspace package(s)...\n`)

	for (const pkg of packages) {
		const reasons = []

		// Rule 1: package must contain at least one *.test.{ts,js,mjs,cjs} under src/ or at its root
		if (!hasTestFile(pkg.path)) {
			reasons.push('no *.test.{ts,js,mjs,cjs} files found in source tree')
		}

		// Rule 2: package.json must have "name" that matches gsd.scope/gsd.name (already enforced by
		// the manifest loader — but repeat here so CI failures point at the right place).
		const expectedName = `${pkg.scope}/${pkg.name}`
		if (pkg.packageName !== expectedName) {
			reasons.push(`package.json "name" (${pkg.packageName}) must equal gsd.scope/gsd.name (${expectedName})`)
		}

		if (reasons.length > 0) {
			failures.push({ pkg, reasons })
		}
	}

	if (failures.length === 0) {
		process.stderr.write(`  All ${packages.length} linkable packages have test coverage.\n`)
		process.exit(0)
	}

	process.stderr.write(`\nERROR: ${failures.length} linkable package(s) missing required coverage:\n\n`)
	for (const f of failures) {
		process.stderr.write(`  ${f.pkg.packageName}  (packages/${f.pkg.dir})\n`)
		for (const reason of f.reasons) {
			process.stderr.write(`    - ${reason}\n`)
		}
	}
	process.stderr.write(
		'\nEvery package marked "gsd.linkable: true" must ship with tests.\n' +
		'This gate exists because PR #4668 shipped three new @gsd/* packages with zero test\n' +
		'coverage (the test globs silently excluded them), which hid 14 CRITICAL regressions.\n' +
		'See PR #4673 revert notes.\n\n' +
		'To fix: add at least one *.test.ts file to the package, or remove "gsd.linkable" if\n' +
		'the package is not meant to be shipped in the global install.\n'
	)
	process.exit(1)
}

main()
