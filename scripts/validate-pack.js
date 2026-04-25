// validate-pack.js — Verify the npm tarball is installable before publishing.
//
// Usage: npm run validate-pack (or node scripts/validate-pack.js)
// Exit 0 = safe to publish, Exit 1 = broken package.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { getLinkablePackages, getCorePackages } = require('./lib/workspace-manifest.cjs');

let tarball = null;
let installDir = null;
let npmCacheDir = null;
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpm(args, options = {}) {
  return execFileSync(getNpmCommand(), args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: {
      ...process.env,
      npm_config_cache: npmCacheDir ?? process.env.npm_config_cache,
    },
    ...options,
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

try {
  npmCacheDir = mkdtempSync(join(tmpdir(), 'validate-pack-npm-cache-'));
  mkdirSync(npmCacheDir, { recursive: true });

  // --- Guard: @gsd/* workspace packages must not have @gsd/* cross-deps ---
  // (@gsd-build/* packages CAN depend on each other — e.g., mcp-server depends
  // on rpc-client — because they are both published to the registry.)
  console.log('==> Checking workspace packages for @gsd/* cross-deps...');
  let crossFailed = false;

  for (const ws of getCorePackages()) {
    const pkg = JSON.parse(readFileSync(ws.packageJsonPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {}).filter(d => d.startsWith('@gsd/'));
    if (deps.length) {
      console.log(`    LEAKED in ${ws.dir}: ${deps.join(', ')}`);
      crossFailed = true;
    }
  }

  if (crossFailed) {
    console.log('ERROR: Workspace packages have @gsd/* cross-dependencies.');
    console.log('    These cause 404s when npm resolves them from the registry.');
    process.exit(1);
  }
  console.log('    No @gsd/* cross-dependencies.');

  // --- Pack tarball ---
  console.log('==> Packing tarball...');
  const packOutput = runNpm(['pack', '--json', '--ignore-scripts']);
  const packEntries = JSON.parse(packOutput);
  const packEntry = Array.isArray(packEntries) ? packEntries[0] : null;
  const tarballName = packEntry?.filename;
  tarball = join(ROOT, tarballName);

  if (!existsSync(tarball)) {
    console.log('ERROR: npm pack produced no tarball');
    process.exit(1);
  }

  const stats = statSync(tarball);
  console.log(`==> Tarball: ${tarballName} (${formatBytes(stats.size)} compressed)`);

  // --- Check critical files using npm pack metadata ---
  console.log('==> Checking critical files...');
  const packedFiles = new Set(
    Array.isArray(packEntry?.files)
      ? packEntry.files.map((entry) => entry?.path).filter(Boolean)
      : [],
  );

  const requiredFiles = [
    'dist/loader.js',
    'packages/pi-coding-agent/dist/index.js',
    'packages/rpc-client/dist/index.js',
    'packages/mcp-server/dist/cli.js',
    'scripts/link-workspace-packages.cjs',
    'dist/web/standalone/server.js',
  ];

  let missing = false;
  for (const required of requiredFiles) {
    if (!packedFiles.has(required)) {
      console.log(`    MISSING: ${required}`);
      missing = true;
    }
  }

  if (missing) {
    console.log('ERROR: Critical files missing from tarball.');
    process.exit(1);
  }
  console.log('    Critical files present.');

  // --- Install test ---
  console.log('==> Testing install in isolated directory...');
  installDir = mkdtempSync(join(tmpdir(), 'validate-pack-'));
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'test-install', version: '1.0.0', private: true }, null, 2));

  try {
    const installOutput = execFileSync(getNpmCommand(), ['install', tarball], {
      cwd: installDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: DEFAULT_MAX_BUFFER,
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
      },
    });
    console.log(installOutput);
    console.log('==> Install succeeded.');
  } catch (err) {
    console.log('');
    console.log('ERROR: npm install of tarball failed.');
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.log(err.stderr);
    process.exit(1);
  }

  // --- Verify every linkable workspace package resolved correctly post-install ---
  // This catches the Windows-style failure where symlinkSync fails silently and
  // node_modules/@gsd/ is never populated, causing ERR_MODULE_NOT_FOUND at runtime.
  // Checks every package with `gsd.linkable: true` — not just a hand-picked subset —
  // so any future addition is automatically covered.
  console.log('==> Verifying workspace package resolution (every linkable package)...');
  const installedRoot = join(installDir, 'node_modules', 'gsd-pi');
  let resolutionFailed = false;
  for (const pkg of getLinkablePackages()) {
    const pkgPath = join(installedRoot, 'node_modules', pkg.scope, pkg.name);
    const fallbackPath = join(installedRoot, 'packages', pkg.dir);
    if (!existsSync(pkgPath)) {
      if (existsSync(fallbackPath)) {
        console.log(`    MISSING symlink/copy: node_modules/${pkg.scope}/${pkg.name} (packages/${pkg.dir} exists — postinstall may not have run)`);
      } else {
        console.log(`    MISSING: node_modules/${pkg.scope}/${pkg.name} (packages/${pkg.dir} also absent — package is broken)`);
      }
      resolutionFailed = true;
    }
  }
  if (resolutionFailed) {
    console.log('ERROR: Linkable workspace packages are not resolvable after install.');
    console.log('    This will cause ERR_MODULE_NOT_FOUND on first run (especially on Windows).');
    process.exit(1);
  }
  console.log(`    All ${getLinkablePackages().length} linkable packages are resolvable.`);

  // --- Run the binary to confirm end-to-end resolution ---
  console.log('==> Running installed binary (gsd -v)...');
  const loaderPath = join(installedRoot, 'dist', 'loader.js');
  const bundledWorkflowMcpCliPath = join(installedRoot, 'packages', 'mcp-server', 'dist', 'cli.js');
  if (!existsSync(bundledWorkflowMcpCliPath)) {
    console.log('ERROR: Bundled workflow MCP CLI missing after install.');
    console.log(`    Expected: ${bundledWorkflowMcpCliPath}`);
    process.exit(1);
  }
  try {
    const versionOutput = execFileSync(process.execPath, [loaderPath, '-v'], {
      cwd: installDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
      maxBuffer: DEFAULT_MAX_BUFFER,
    }).trim();
    console.log(`    gsd -v => ${versionOutput}`);
    if (!versionOutput.match(/^\d+\.\d+\.\d+/)) {
      console.log('ERROR: gsd -v returned unexpected output (expected a version string).');
      process.exit(1);
    }
  } catch (err) {
    console.log('ERROR: Running gsd -v failed after install.');
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.log(err.stderr);
    process.exit(1);
  }

  console.log('');
  console.log('Package is installable. Safe to publish.');
  process.exit(0);
} finally {
  if (installDir && existsSync(installDir)) {
    rmSync(installDir, { recursive: true, force: true });
  }
  if (tarball && existsSync(tarball)) {
    rmSync(tarball, { force: true });
  }
  if (npmCacheDir && existsSync(npmCacheDir)) {
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
}
