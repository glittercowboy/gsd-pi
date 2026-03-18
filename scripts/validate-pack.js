// validate-pack.js — Verify the npm tarball is installable before publishing.
//
// Usage: npm run validate-pack (or node scripts/validate-pack.js)
// Exit 0 = safe to publish, Exit 1 = broken package.

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

let tarball = null;
let installDir = null;

try {
  // --- Guard: workspace packages must not have @gsd/* cross-deps ---
  console.log('==> Checking workspace packages for @gsd/* cross-deps...');
  const workspaces = ['native', 'pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui'];
  let crossFailed = false;

  for (const ws of workspaces) {
    const pkgPath = join(ROOT, 'packages', ws, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {}).filter(d => d.startsWith('@gsd/'));
    if (deps.length) {
      console.log(`    LEAKED in ${ws}: ${deps.join(', ')}`);
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
  const packOutput = execSync('npm pack --ignore-scripts', {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const tarballName = packOutput.trim().split('\n').pop();
  tarball = join(ROOT, tarballName);

  if (!existsSync(tarball)) {
    console.log('ERROR: npm pack produced no tarball');
    process.exit(1);
  }

  const stats = execSync(`du -h "${tarball}"`, { encoding: 'utf8' }).split('\t')[0].trim();
  console.log(`==> Tarball: ${tarballName} (${stats} compressed)`);

  // --- Check critical files using tar listing ---
  console.log('==> Checking critical files...');
  const tarList = execSync(`tar tzf "${tarball}"`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

  const requiredFiles = [
    'dist/loader.js',
    'packages/pi-coding-agent/dist/index.js',
    'scripts/link-workspace-packages.cjs',
    'dist/web/standalone/server.js',
    'dist/web/standalone/public/manifest.json',
    'dist/web/standalone/public/sw.js',
  ];

  let missing = false;
  for (const required of requiredFiles) {
    if (!tarList.includes(`package/${required}`)) {
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
    const installOutput = execSync(`npm install "${tarball}"`, {
      cwd: installDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
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
}
