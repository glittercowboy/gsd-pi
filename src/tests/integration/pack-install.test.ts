/**
 * Integration tests for npm pack and install.
 *
 * These tests spawn child processes (npm pack, node)
 * and are resource-intensive. Run separately from unit tests.
 *
 * Prerequisite: npm run build must be run first.
 *
 * Run with: npm run build && npm run test:integration
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGunzip } from "node:zlib";

const projectRoot = process.cwd();

if (!existsSync(join(projectRoot, "dist"))) {
  throw new Error("dist/ not found — run: npm run build");
}

type NpmSandbox = {
  env: NodeJS.ProcessEnv;
  installPrefix: string;
  rootDir: string;
};

function createNpmSandbox(prefix: string): NpmSandbox {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const cacheDir = join(rootDir, "npm-cache");
  const installPrefix = join(rootDir, "install-prefix");

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(installPrefix, { recursive: true });

  return {
    rootDir,
    installPrefix,
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: cacheDir,
      npm_config_cache: cacheDir,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
  };
}

function packTarball(sandbox: NpmSandbox): string {
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
  const safeName = pkg.name.replace(/^@[^/]+\//, "").replace(/\//g, "-");
  const tarball = `${safeName}-${pkg.version}.tgz`;
  const packDestination = join(sandbox.rootDir, "pack-output");

  mkdirSync(packDestination, { recursive: true });
  execFileSync("npm", ["pack", "--pack-destination", packDestination], {
    cwd: projectRoot,
    env: sandbox.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return join(packDestination, tarball);
}

/** List file paths inside a .tgz using Node built-ins only (no tar CLI or npm package). */
function listTarEntries(tarballPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const files: string[] = [];
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    const input = createReadStream(tarballPath);
    gunzip.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    gunzip.on("end", () => {
      const buf = Buffer.concat(chunks);
      let offset = 0;
      while (offset + 512 <= buf.length) {
        const header = buf.subarray(offset, offset + 512);
        if (header.every(b => b === 0)) break; // end-of-archive sentinel
        const name   = header.subarray(0,   100).toString("utf8").replace(/\0.*/, "");
        const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*/, "");
        const type   = String.fromCharCode(header[156]);
        const size   = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim(), 8) || 0;
        if (name && type !== "5") files.push(prefix ? `${prefix}/${name}` : name);
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      resolve(files);
    });
    input.on("error", reject);
    gunzip.on("error", reject);
    input.pipe(gunzip);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. npm pack produces valid tarball with correct file layout
// ═══════════════════════════════════════════════════════════════════════════

test("npm pack produces tarball with required files", async () => {
  const sandbox = createNpmSandbox("gsd-pack-test-");
  const tarballPath = packTarball(sandbox);

  assert.ok(existsSync(tarballPath), "tarball created");

  try {
    const files = await listTarEntries(tarballPath);

    // Critical files must be present
    assert.ok(files.some(f => f.includes("dist/loader.js")), "tarball contains dist/loader.js");
    assert.ok(files.some(f => f.includes("dist/cli.js")), "tarball contains dist/cli.js");
    assert.ok(files.some(f => f.includes("dist/app-paths.js")), "tarball contains dist/app-paths.js");
    assert.ok(files.some(f => f.includes("dist/wizard.js")), "tarball contains dist/wizard.js");
    assert.ok(files.some(f => f.includes("dist/resource-loader.js")), "tarball contains dist/resource-loader.js");
    assert.ok(files.some(f => f.includes("pkg/package.json")), "tarball contains pkg/package.json");
    assert.ok(files.some(f => f.includes("src/resources/extensions/gsd/index.ts")), "tarball contains bundled gsd extension");
    assert.ok(files.some(f => f.includes("scripts/postinstall.js")), "tarball contains postinstall script");

    // pkg/package.json must have piConfig
    const pkgJson = readFileSync(join(projectRoot, "pkg", "package.json"), "utf-8");
    const pkg = JSON.parse(pkgJson);
    assert.equal(pkg.piConfig?.name, "gsd", "pkg/package.json piConfig.name is gsd");
    assert.equal(pkg.piConfig?.configDir, ".gsd", "pkg/package.json piConfig.configDir is .gsd");
  } finally {
    rmSync(tarballPath, { force: true });
    rmSync(sandbox.rootDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. npm pack → install → gsd binary resolves
// ═══════════════════════════════════════════════════════════════════════════

test("tarball installs and gsd binary resolves", async () => {
  const sandbox = createNpmSandbox("gsd-install-test-");
  const tarballPath = packTarball(sandbox);

  try {
    // Install from tarball into a temp prefix
    execFileSync("npm", ["install", "--prefix", sandbox.installPrefix, tarballPath, "--no-save"], {
      env: sandbox.env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Verify the gsd bin exists in the installed package
    const binName = process.platform === "win32" ? "gsd.cmd" : "gsd";
    const installedBin = join(sandbox.installPrefix, "node_modules", ".bin", binName);
    assert.ok(existsSync(installedBin), `gsd binary exists in node_modules/.bin/ (${binName})`);

    // Verify loader.js is executable (has shebang)
    const installedLoader = join(sandbox.installPrefix, "node_modules", "gsd-pi", "dist", "loader.js");
    const loaderContent = readFileSync(installedLoader, "utf-8");
    if (process.platform !== "win32") {
      assert.ok(loaderContent.startsWith("#!/usr/bin/env node"), "loader.js has node shebang");
    }

    // Verify bundled resources are present
    const installedGsdExt = join(
      sandbox.installPrefix,
      "node_modules",
      "gsd-pi",
      "src",
      "resources",
      "extensions",
      "gsd",
      "index.ts",
    );
    assert.ok(existsSync(installedGsdExt), "bundled gsd extension present in installed package");
  } finally {
    rmSync(tarballPath, { force: true });
    rmSync(sandbox.rootDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Launch → extensions load → no errors on stderr
// ═══════════════════════════════════════════════════════════════════════════

test("gsd launches and loads extensions without errors", async () => {
  // Launch gsd with all optional keys set (skip wizard) and capture stderr.
  // Kill after 5 seconds — we just need to see if extensions load.
  // Assumes build already done.
  const output = await new Promise<string>((resolve) => {
    let stderr = "";
    const child = spawn("node", ["dist/loader.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        BRAVE_API_KEY: "test",
        BRAVE_ANSWERS_KEY: "test",
        CONTEXT7_API_KEY: "test",
        JINA_API_KEY: "test",
        TAVILY_API_KEY: "test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Close stdin immediately so it's non-TTY
    child.stdin.end();

    // Give it 5s to start up
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 5000);

    child.on("close", () => {
      clearTimeout(timer);
      resolve(stderr);
    });
  });

  // No extension load errors
  assert.ok(
    !output.includes("[gsd] Extension load error"),
    `no extension load errors on stderr (got: ${output.slice(0, 500)})`,
  );

  // No crash / unhandled errors
  assert.ok(
    !output.includes("Error: Cannot find module"),
    "no missing module errors",
  );
  assert.ok(
    !output.includes("ERR_MODULE_NOT_FOUND"),
    "no ERR_MODULE_NOT_FOUND",
  );
});

test("gsd exits early with a clear message when synced resources are newer than the binary", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "gsd-version-skew-"));
  const fakeAgentDir = join(fakeHome, ".gsd", "agent");
  mkdirSync(fakeAgentDir, { recursive: true });
  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({ gsdVersion: "999.0.0" }),
  );

  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      const child = spawn("node", ["dist/loader.js"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: fakeHome,
          BRAVE_API_KEY: "test",
          BRAVE_ANSWERS_KEY: "test",
          CONTEXT7_API_KEY: "test",
          JINA_API_KEY: "test",
          TAVILY_API_KEY: "test",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.stdin.end();
      child.on("close", (code) => {
        resolve({ code, stderr });
      });
    });

    assert.equal(result.code, 1, "startup exits with code 1 on version skew");
    assert.match(result.stderr, /Version mismatch detected/, "prints a friendly skew header");
    assert.match(result.stderr, /npm install -g gsd-pi@latest|gsd update/, "prints upgrade guidance");
    assert.doesNotMatch(result.stderr, /\[gsd\] Extension load error/, "fails before extension loading");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
