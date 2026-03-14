#!/usr/bin/env node
/**
 * Install or update the GitHub CLI (gh) from GitHub Releases.
 *
 * Downloads the latest gh binary for the current platform, verifies its
 * SHA256 checksum, and installs it to an existing system PATH directory.
 * Uses GITHUB_TOKEN for authenticated API requests when available,
 * falling back to anonymous requests on authentication failure.
 *
 * Usage:
 *   node setup_gh.cjs [--force] [--dry-run] [--bin-dir <path>]
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawn } = require('child_process');
const os = require('os');
const { pipeline } = require('stream');
const { createGunzip } = require('zlib');
const tar = require('tar');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GITHUB_API_URL = 'https://api.github.com/repos/cli/cli/releases/latest';
const BINARY_NAME = 'gh';
const DOWNLOAD_CHUNK_SIZE = 8192;

const ARCH_MAP = {
  x86_64: 'amd64',
  amd64: 'amd64',
  aarch64: 'arm64',
  arm64: 'arm64',
  armv7l: 'armv6',
  i386: '386',
  i686: '386',
};

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------
function detectPlatform() {
  const system = os.type().toLowerCase();
  const machine = os.machine ? os.machine().toLowerCase() : process.arch.toLowerCase();

  const arch = ARCH_MAP[machine] || ARCH_MAP[process.arch];
  if (!arch) {
    throw new Error(`Unsupported architecture: ${machine}`);
  }

  switch (system) {
    case 'linux':
      return { os: 'linux', arch };
    case 'darwin':
      return { os: 'macOS', arch }; // gh uses "macOS" with capital S
    case 'windows_nt':
      return { os: 'windows', arch };
    default:
      throw new Error(`Unsupported operating system: ${system}`);
  }
}

function getArchiveFormat(osKey) {
  return osKey === 'linux' ? 'tar.gz' : 'zip';
}

// ---------------------------------------------------------------------------
// Install directory resolution
// ---------------------------------------------------------------------------
function findInstallDir() {
  const home = os.homedir();
  const preferred = process.platform !== 'win32'
    ? [path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin']
    : [path.join(home, 'AppData', 'Local', 'Programs', 'gh')];

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  // Check preferred dirs first, then all PATH dirs
  for (const candidate of [...preferred, ...pathDirs]) {
    try {
      if (canWrite(candidate)) {
        return candidate;
      }
    } catch (e) {
      // Ignore errors
    }
  }

  // Last resort: create ~/.local/bin
  const fallback = path.join(home, '.local', 'bin');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function canWrite(dir) {
  const testFile = path.join(dir, `.write-test-${Date.now()}`);
  try {
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        httpsGet(res.headers.location, headers).then(resolve).catch(reject);
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    httpsGet(url, headers)
      .then((res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
      })
      .catch(reject);
  });
}

function downloadFile(url, destPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    httpsGet(url, headers)
      .then((res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .catch((e) => {
        fs.unlinkSync(destPath);
        reject(e);
      });
  });
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------
function buildHeaders(authenticated) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'setup-gh-script',
  };
  if (authenticated && process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchLatestRelease() {
  const token = process.env.GITHUB_TOKEN;
  const useAuth = !!token;

  if (useAuth) {
    console.log('🔑 Using GITHUB_TOKEN for authenticated request');
    try {
      const data = await httpsGetJson(GITHUB_API_URL, buildHeaders(true));
      return data;
    } catch (e) {
      if (e.message.includes('401') || e.message.includes('403')) {
        console.log('⚠️  Authenticated request failed, retrying anonymously');
      } else {
        throw e;
      }
    }
  }

  return httpsGetJson(GITHUB_API_URL, buildHeaders(false));
}

function findAsset(assets, osKey, arch) {
  const fmt = getArchiveFormat(osKey);
  return assets.find((asset) => {
    // Match pattern: gh_{version}_{os}_{arch}.{format}
    return (
      asset.name.startsWith('gh_') &&
      asset.name.endsWith(`_${osKey}_${arch}.${fmt}`)
    );
  });
}

function findChecksumsAsset(assets) {
  return assets.find((asset) => asset.name.endsWith('_checksums.txt'));
}

async function fetchChecksums(url) {
  return new Promise((resolve, reject) => {
    httpsGet(url, buildHeaders(!!process.env.GITHUB_TOKEN))
      .then((res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const checksums = {};
          for (const line of data.trim().split('\n')) {
            const parts = line.split(/\s+/);
            if (parts.length === 2) {
              checksums[parts[1]] = parts[0];
            }
          }
          resolve(checksums);
        });
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------
function parseVersion(versionStr) {
  const cleaned = versionStr.replace(/^v/, '');
  return cleaned.split('.').map((part) => parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function getInstalledVersion() {
  try {
    const result = execFileSync('gh', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    // Expected: "gh version 2.87.0 (2025-02-18)"
    const match = result.match(/gh version (\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SHA256 verification
// ---------------------------------------------------------------------------
function verifySha256(filePath, expectedHex) {
  const content = fs.readFileSync(filePath);
  const actual = crypto.createHash('sha256').update(content).digest('hex');
  if (actual !== expectedHex) {
    throw new Error(`SHA256 mismatch: expected ${expectedHex}, got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------
async function extractBinary(archivePath, osKey) {
  const extractDir = fs.mkdtempSync(path.join(path.dirname(archivePath), '_gh_extract_'));
  const binaryName = osKey === 'windows' ? 'gh.exe' : 'gh';

  if (process.platform === 'linux') {
    // Extract tar.gz
    await tar.x({
      file: archivePath,
      cwd: extractDir,
      stripComponents: 1,
    });
  } else if (process.platform === 'darwin') {
    // macOS ships with unzip — use execFileSync to avoid shell parsing
    execFileSync('unzip', ['-q', archivePath, '-d', extractDir], { stdio: 'pipe' });
  } else if (process.platform === 'win32') {
    // Windows: use PowerShell's built-in Expand-Archive (no external tools required)
    const escapedArchive = archivePath.replace(/'/g, "''");
    const escapedDest = extractDir.replace(/'/g, "''");
    execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDest}' -Force`,
    ], { stdio: 'pipe' });
  } else {
    throw new Error(`Unsupported platform for ZIP extraction: ${process.platform}`);
  }

  // Find the binary
  function findBinary(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findBinary(fullPath);
        if (found) return found;
      } else if (entry.name === binaryName || entry.name === 'gh') {
        return fullPath;
      }
    }
    return null;
  }

  const binary = findBinary(extractDir);
  if (!binary) {
    throw new Error(`Binary '${binaryName}' not found in archive`);
  }

  return { binary, extractDir };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const binDirIdx = args.indexOf('--bin-dir');
  const binDir = binDirIdx >= 0 ? args[binDirIdx + 1] : null;

  // 1. Check if gh is already installed
  let ghWhich = null;
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    ghWhich = execFileSync(whichCmd, ['gh'], { encoding: 'utf-8', timeout: 5000 }).trim().split(/\r?\n/)[0];
  } catch {
    // gh not found
  }

  const installedVersion = getInstalledVersion();

  if (ghWhich) {
    console.log(`💾 gh found at ${ghWhich}${installedVersion ? ` (v${installedVersion})` : ''}`);
  } else {
    console.log('💾 gh is not currently installed');
  }

  // 2. Detect platform
  let platform;
  try {
    platform = detectPlatform();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  console.log(`🔍 Detected platform: ${platform.os}/${platform.arch}`);

  // 3. Resolve install directory
  const installDir = binDir || findInstallDir();
  console.log(`📁 Install directory: ${installDir}`);

  // 4. Fetch latest release
  console.log('🌐 Fetching latest gh release...');
  let release;
  try {
    release = await fetchLatestRelease();
  } catch (e) {
    console.error(`❌ Failed to fetch release info: ${e.message}`);
    process.exit(1);
  }

  const tag = release.tag_name;
  const latestVersion = tag.replace(/^v/, '');
  console.log(`📦 Latest version: v${latestVersion}`);

  // 5. Find matching asset
  const asset = findAsset(release.assets, platform.os, platform.arch);
  if (!asset) {
    console.error(`❌ No binary found for ${platform.os}_${platform.arch} in release ${tag}`);
    process.exit(1);
  }

  // 6. Fetch checksums
  let expectedSha256 = null;
  const checksumsAsset = findChecksumsAsset(release.assets);
  if (checksumsAsset) {
    try {
      const checksums = await fetchChecksums(checksumsAsset.browser_download_url);
      expectedSha256 = checksums[asset.name];
      if (expectedSha256) {
        console.log('🔒 SHA256 checksum available for verification');
      } else {
        console.log(`⚠️  No checksum found for ${asset.name}`);
      }
    } catch (e) {
      console.log(`⚠️  Could not fetch checksums: ${e.message}`);
    }
  }

  // 7. Check if update is needed
  const needsUpdate =
    !installedVersion ||
    compareVersions(installedVersion, latestVersion) < 0;

  if (!needsUpdate && !force) {
    console.log('✅ gh is already up to date');
    process.exit(0);
  }

  if (!needsUpdate && force) {
    console.log('🔄 Force-reinstalling latest version');
  }

  // 8. Dry-run or install
  if (dryRun) {
    const binaryName = platform.os === 'windows' ? 'gh.exe' : 'gh';
    console.log('\n[bold]Dry-run summary:');
    console.log(`  Asset:       ${asset.name}`);
    console.log(`  URL:         ${asset.browser_download_url}`);
    console.log(`  SHA256:      ${expectedSha256 || 'not available'}`);
    console.log(`  Size:        ${asset.size.toLocaleString()} bytes`);
    console.log(`  Install dir: ${installDir}`);
    console.log(`  Binary path: ${path.join(installDir, binaryName)}`);
    process.exit(0);
  }

  // 9. Download and install
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh_setup_'));
  const archivePath = path.join(tmpDir, asset.name);
  const binaryName = platform.os === 'windows' ? 'gh.exe' : 'gh';
  const installPath = path.join(installDir, binaryName);

  try {
    // Download
    console.log(`⬇️  Downloading ${asset.name} (${asset.size.toLocaleString()} bytes)...`);
    try {
      await downloadFile(asset.browser_download_url, archivePath, buildHeaders(!!process.env.GITHUB_TOKEN));
    } catch (e) {
      console.error(`❌ Download failed: ${e.message}`);
      process.exit(1);
    }

    // Verify SHA256
    if (expectedSha256) {
      console.log('🔒 Verifying SHA256 checksum...');
      try {
        verifySha256(archivePath, expectedSha256);
        console.log('✅ SHA256 verified');
      } catch (e) {
        console.error(`❌ ${e.message}`);
        process.exit(1);
      }
    } else {
      console.log('⚠️  Skipping SHA256 verification (no checksum available)');
    }

    // Extract
    console.log('📂 Extracting binary...');
    let extracted;
    try {
      extracted = await extractBinary(archivePath, platform.os);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }

    // Install
    fs.mkdirSync(installDir, { recursive: true });
    fs.copyFileSync(extracted.binary, installPath);

    // Set executable bit (non-Windows)
    if (platform.os !== 'windows') {
      fs.chmodSync(installPath, 0o755);
    }

    console.log(`✅ gh v${latestVersion} installed to ${installPath}`);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (extracted.extractDir) {
      fs.rmSync(extracted.extractDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`❌ Installation failed: ${e.message}`);
    process.exit(1);
  }

  // Verify installation
  console.log('\n🧪 Verifying installation...');
  try {
    const result = execFileSync(installPath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
    console.log(`  ${result.trim()}`);
  } catch (e) {
    console.log(`⚠️  Could not verify installation: ${e.message}`);
  }

  // PATH suggestion
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  if (!pathDirs.includes(installDir)) {
    console.log(`\n⚠️  ${installDir} is not in your PATH.`);
    console.log('  Add it to your shell profile:');
    if (process.platform === 'win32') {
      console.log(`  Add ${installDir} to your Windows PATH via System Properties or:`);
      console.log(`  $env:PATH += ";${installDir}"`);
    } else {
      console.log(`  export PATH="${installDir}:$PATH"  (add to ~/.bashrc or ~/.zshrc)`);
    }
  }
}

main().catch((e) => {
  console.error(`❌ Unexpected error: ${e.message}`);
  process.exit(1);
});
