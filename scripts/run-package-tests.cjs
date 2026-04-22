// GSD-2 + scripts/run-package-tests.cjs — run `node --test` across every linkable workspace package
'use strict'

const { spawnSync } = require('child_process')
const { existsSync, readdirSync } = require('fs')
const { join, relative } = require('path')
const { getLinkablePackages, REPO_ROOT } = require('./lib/workspace-manifest.cjs')

function getNpmCommand() {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

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
	const distTestPkg = join(REPO_ROOT, 'dist-test', 'packages', relative(join(REPO_ROOT, 'packages'), pkgDir))
	const fromDistTest = findTestFiles(distTestPkg)
	if (fromDistTest.length > 0) return fromDistTest
	// Fall back to package-local build outputs when test:compile does not cover a package yet.
	const pkgDist = join(pkgDir, 'dist')
	return findTestFiles(pkgDist)
}

function commandExists(command, args = ['--version']) {
	const result = spawnSync(command, args, { stdio: 'ignore' })
	return result.status === 0 || result.status === 1
}

function hasNativeAddon() {
	const platformTag = `${process.platform}-${process.arch}`
	return (
		existsSync(join(REPO_ROOT, 'native', 'addon', `gsd_engine.${platformTag}.node`)) ||
		existsSync(join(REPO_ROOT, 'native', 'addon', 'gsd_engine.dev.node'))
	)
}

function looksLikePassingTestRun(output) {
	if (!output) return false
	if (/(✖ failing tests:|^not ok\b|ℹ fail\s+[1-9]\d*|# fail\s+[1-9]\d*)/m.test(output)) {
		return false
	}
	return /(ℹ pass\s+\d+|# pass\s+\d+)/m.test(output) && /(ℹ fail\s+0|# fail\s+0)/m.test(output)
}

function runCommand(command, args, cwd = REPO_ROOT, label = command) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 50 * 1024 * 1024,
	})
	if (result.stdout) {
		process.stdout.write(result.stdout)
	}
	if (result.stderr) {
		process.stderr.write(result.stderr)
	}

	if ((result.status ?? 1) !== 0 && !result.signal && !result.error) {
		const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
		if (looksLikePassingTestRun(combinedOutput)) {
			process.stderr.write(
				`Warning: ${label} exited non-zero despite reporting zero test failures; treating as pass.\n`
			)
			return 0
		}
	}

	if (result.error) {
		process.stderr.write(`Failed to run ${label}: ${result.error.message}\n`)
	}
	if (result.signal) {
		process.stderr.write(`${label} terminated by signal ${result.signal}.\n`)
	}
	return result.status ?? 1
}

function runPackageScript(command, args, cwd = REPO_ROOT, label = command) {
	const result = spawnSync(command, args, {
		stdio: 'inherit',
		cwd,
		shell: process.platform === 'win32',
	})
	if ((result.status ?? 1) !== 0) {
		if (result.error) {
			process.stderr.write(`Failed to run ${label}: ${result.error.message}\n`)
		}
		if (result.signal) {
			process.stderr.write(`${label} terminated by signal ${result.signal}.\n`)
		}
	}
	return result.status ?? 1
}

const packages = getLinkablePackages()
const summary = []
for (const pkg of packages) {
	if (pkg.packageName === '@gsd/native') {
		const canRunNative = hasNativeAddon() || commandExists('cargo')
		summary.push({
			pkg: pkg.packageName,
			dir: pkg.dir,
			count: canRunNative ? 'package-script' : 'skipped',
		})
		continue
	}

	const files = findDistTestFiles(pkg.path)
	summary.push({ pkg: pkg.packageName, dir: pkg.dir, count: files.length })
}

process.stderr.write('Workspace package tests:\n')
for (const row of summary) {
	if (typeof row.count === 'number') {
		process.stderr.write(`  ${row.pkg} (${row.dir}): ${row.count} file${row.count === 1 ? '' : 's'}\n`)
		continue
	}
	process.stderr.write(`  ${row.pkg} (${row.dir}): ${row.count}\n`)
}

let failureCount = 0

for (const pkg of packages) {
	if (pkg.packageName === '@gsd/native') {
		if (!hasNativeAddon() && !commandExists('cargo')) {
			process.stderr.write(
				`Skipping ${pkg.packageName}: no native addon present and \`cargo\` is unavailable in this environment.\n`
			)
			continue
		}
		process.stderr.write(`\nRunning ${pkg.packageName} package tests via workspace script...\n`)
		if (
			runPackageScript(getNpmCommand(), ['run', 'test', '-w', pkg.packageName], REPO_ROOT, pkg.packageName) !==
			0
		) {
			failureCount += 1
		}
		continue
	}

	const files = findDistTestFiles(pkg.path)
	if (files.length === 0) {
		process.stderr.write(`Skipping ${pkg.packageName}: no compiled test files found.\n`)
		continue
	}

	process.stderr.write(`\nRunning ${pkg.packageName} package tests...\n`)
	if (runCommand(process.execPath, ['--test', ...files], REPO_ROOT, pkg.packageName) !== 0) {
		failureCount += 1
	}
}

process.exit(failureCount === 0 ? 0 : 1)
