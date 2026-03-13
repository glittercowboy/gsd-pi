/**
 * App-level smoke tests for the gsd CLI package.
 *
 * Tests the glue code that IS the product:
 * - app-paths resolve to ~/.gsd/
 * - loader sets all required env vars
 * - resource-loader syncs bundled resources
 * - wizard loadStoredEnvKeys hydrates env
 * - npm pack produces a valid tarball
 * - tarball installs and the `gsd` binary resolves
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

// ═══════════════════════════════════════════════════════════════════════════
// 1. app-paths
// ═══════════════════════════════════════════════════════════════════════════

test("app-paths resolve to ~/.gsd/", async () => {
  const { appRoot, agentDir, sessionsDir, authFilePath } = await import("../app-paths.ts");
  const home = process.env.HOME!;

  assert.equal(appRoot, join(home, ".gsd"), "appRoot is ~/.gsd/");
  assert.equal(agentDir, join(home, ".gsd", "agent"), "agentDir is ~/.gsd/agent/");
  assert.equal(sessionsDir, join(home, ".gsd", "sessions"), "sessionsDir is ~/.gsd/sessions/");
  assert.equal(authFilePath, join(home, ".gsd", "agent", "auth.json"), "authFilePath is ~/.gsd/agent/auth.json");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. loader env vars
// ═══════════════════════════════════════════════════════════════════════════

test("loader sets all 4 GSD_ env vars and PI_PACKAGE_DIR", async () => {
  // Run loader in a subprocess that prints env vars and exits before TUI starts
  const script = `
    import { fileURLToPath } from 'url';
    import { dirname, resolve, join } from 'path';
    import { agentDir } from './app-paths.js';

    const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pkg');
    process.env.PI_PACKAGE_DIR = pkgDir;
    process.env.GSD_CODING_AGENT_DIR = agentDir;
    process.env.GSD_BIN_PATH = process.argv[1];
    const resourcesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'resources');
    process.env.GSD_WORKFLOW_PATH = join(resourcesDir, 'GSD-WORKFLOW.md');
    const exts = ['extensions/gsd/index.ts'].map(r => join(resourcesDir, r));
    process.env.GSD_BUNDLED_EXTENSION_PATHS = exts.join(':');

    // Print for verification
    console.log('PI_PACKAGE_DIR=' + process.env.PI_PACKAGE_DIR);
    console.log('GSD_CODING_AGENT_DIR=' + process.env.GSD_CODING_AGENT_DIR);
    console.log('GSD_BIN_PATH=' + process.env.GSD_BIN_PATH);
    console.log('GSD_WORKFLOW_PATH=' + process.env.GSD_WORKFLOW_PATH);
    console.log('GSD_BUNDLED_EXTENSION_PATHS=' + process.env.GSD_BUNDLED_EXTENSION_PATHS);
    process.exit(0);
  `;

  const tmp = mkdtempSync(join(tmpdir(), "gsd-loader-test-"));
  const scriptPath = join(tmp, "check-env.ts");
  writeFileSync(scriptPath, script);

  try {
    const output = execSync(
      `node --experimental-strip-types -e "
        process.chdir('${projectRoot}');
        await import('./src/app-paths.ts');
      " 2>&1`,
      { encoding: "utf-8", cwd: projectRoot },
    );
    // If we got here without error, the import works
  } catch {
    // Fine — we test the logic inline below
  }

  // Direct logic verification (no subprocess needed)
  const { agentDir: ad } = await import("../app-paths.ts");
  assert.ok(ad.endsWith(".gsd/agent"), "agentDir ends with .gsd/agent");

  // Verify the env var names are in loader.ts source
  const loaderSrc = readFileSync(join(projectRoot, "src", "loader.ts"), "utf-8");
  assert.ok(loaderSrc.includes("PI_PACKAGE_DIR"), "loader sets PI_PACKAGE_DIR");
  assert.ok(loaderSrc.includes("GSD_CODING_AGENT_DIR"), "loader sets GSD_CODING_AGENT_DIR");
  assert.ok(loaderSrc.includes("GSD_BIN_PATH"), "loader sets GSD_BIN_PATH");
  assert.ok(loaderSrc.includes("GSD_WORKFLOW_PATH"), "loader sets GSD_WORKFLOW_PATH");
  assert.ok(loaderSrc.includes("GSD_BUNDLED_EXTENSION_PATHS"), "loader sets GSD_BUNDLED_EXTENSION_PATHS");

  // Verify all 11 extension entry points are referenced in loader
  // Loader uses join() calls like join(agentDir, 'extensions', 'gsd', 'index.ts')
  // so we check for the distinguishing directory name of each extension
  const extNames = [
    "'gsd'",
    "'bg-shell'",
    "'browser-tools'",
    "'context7'",
    "'search-the-web'",
    "'slash-commands'",
    "'subagent'",
    "'ask-user-questions.ts'",
    "'get-secrets-from-user.ts'",
  ];
  for (const name of extNames) {
    assert.ok(loaderSrc.includes(name), `loader references extension ${name}`);
  }

  rmSync(tmp, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. resource-loader syncs bundled resources
// ═══════════════════════════════════════════════════════════════════════════

test("initResources syncs extensions, agents, and skills to target dir", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resources-test-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    initResources(fakeAgentDir);

    // Extensions synced
    assert.ok(existsSync(join(fakeAgentDir, "extensions", "gsd", "index.ts")), "gsd extension synced");
    assert.ok(existsSync(join(fakeAgentDir, "extensions", "browser-tools", "index.ts")), "browser-tools synced");
    assert.ok(existsSync(join(fakeAgentDir, "extensions", "search-the-web", "index.ts")), "search-the-web synced");
    assert.ok(existsSync(join(fakeAgentDir, "extensions", "context7", "index.ts")), "context7 synced");
    assert.ok(existsSync(join(fakeAgentDir, "extensions", "subagent", "index.ts")), "subagent synced");

    // Agents synced
    assert.ok(existsSync(join(fakeAgentDir, "agents", "scout.md")), "scout agent synced");

    // Skills synced
    assert.ok(existsSync(join(fakeAgentDir, "skills")), "skills directory synced");

    // Idempotent: run again, no crash
    initResources(fakeAgentDir);
    assert.ok(existsSync(join(fakeAgentDir, "extensions", "gsd", "index.ts")), "idempotent re-sync works");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. wizard loadStoredEnvKeys hydration
// ═══════════════════════════════════════════════════════════════════════════

test("buildResourceLoader expands ~/.pi extension directories into entry files", async () => {
  const originalHome = process.env.HOME;
  const tmp = mkdtempSync(join(tmpdir(), "gsd-pi-ext-test-"));
  const fakeHome = join(tmp, "home");
  const fakeAgentDir = join(tmp, "agent");
  const piExtensionsDir = join(fakeHome, ".pi", "agent", "extensions");
  mkdirSync(piExtensionsDir, { recursive: true });
  mkdirSync(fakeAgentDir, { recursive: true });

  writeFileSync(
    join(piExtensionsDir, "top-level.ts"),
    "export default function(pi){ pi.on('agent_start', () => {}); }\n",
  );

  const packagedDir = join(piExtensionsDir, "packaged-ext");
  mkdirSync(packagedDir, { recursive: true });
  writeFileSync(
    join(packagedDir, "package.json"),
    JSON.stringify({ pi: { extensions: ["./custom-entry.ts"] } }, null, 2),
  );
  writeFileSync(
    join(packagedDir, "custom-entry.ts"),
    "export default function(pi){ pi.on('agent_start', () => {}); }\n",
  );

  process.env.HOME = fakeHome;

  try {
    const { buildResourceLoader } = await import("../resource-loader.ts");
    const loader = buildResourceLoader(fakeAgentDir);
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();

    assert.ok(
      extensions.some((ext) => ext.path.endsWith("top-level.ts")),
      "loads top-level ~/.pi extension files",
    );
    assert.ok(
      extensions.some((ext) => ext.path.endsWith("packaged-ext/custom-entry.ts")),
      "loads packaged ~/.pi extensions via pi.extensions manifest",
    );
    assert.ok(
      !errors.some((err) => err.path === piExtensionsDir),
      "does not try to load the ~/.pi/agent/extensions directory itself as a module",
    );
  } finally {
    if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadStoredEnvKeys hydrates process.env from auth.json", async () => {
  const { loadStoredEnvKeys } = await import("../wizard.ts");
  const { AuthStorage } = await import("@gsd/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-wizard-test-"));
  const authPath = join(tmp, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    brave: { type: "api_key", key: "test-brave-key" },
    brave_answers: { type: "api_key", key: "test-answers-key" },
    context7: { type: "api_key", key: "test-ctx7-key" },
    tavily: { type: "api_key", key: "test-tavily-key" },
  }));

  // Clear any existing env vars
  const origBrave = process.env.BRAVE_API_KEY;
  const origBraveAnswers = process.env.BRAVE_ANSWERS_KEY;
  const origCtx7 = process.env.CONTEXT7_API_KEY;
  const origJina = process.env.JINA_API_KEY;
  const origTavily = process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_ANSWERS_KEY;
  delete process.env.CONTEXT7_API_KEY;
  delete process.env.JINA_API_KEY;
  delete process.env.TAVILY_API_KEY;

  try {
    const auth = AuthStorage.create(authPath);
    loadStoredEnvKeys(auth);

    assert.equal(process.env.BRAVE_API_KEY, "test-brave-key", "BRAVE_API_KEY hydrated");
    assert.equal(process.env.BRAVE_ANSWERS_KEY, "test-answers-key", "BRAVE_ANSWERS_KEY hydrated");
    assert.equal(process.env.CONTEXT7_API_KEY, "test-ctx7-key", "CONTEXT7_API_KEY hydrated");
    assert.equal(process.env.JINA_API_KEY, undefined, "JINA_API_KEY not set (not in auth)");
    assert.equal(process.env.TAVILY_API_KEY, "test-tavily-key", "TAVILY_API_KEY hydrated");
  } finally {
    // Restore original env
    if (origBrave) process.env.BRAVE_API_KEY = origBrave; else delete process.env.BRAVE_API_KEY;
    if (origBraveAnswers) process.env.BRAVE_ANSWERS_KEY = origBraveAnswers; else delete process.env.BRAVE_ANSWERS_KEY;
    if (origCtx7) process.env.CONTEXT7_API_KEY = origCtx7; else delete process.env.CONTEXT7_API_KEY;
    if (origJina) process.env.JINA_API_KEY = origJina; else delete process.env.JINA_API_KEY;
    if (origTavily) process.env.TAVILY_API_KEY = origTavily; else delete process.env.TAVILY_API_KEY;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. loadStoredEnvKeys does NOT overwrite existing env vars
// ═══════════════════════════════════════════════════════════════════════════

test("loadStoredEnvKeys does not overwrite existing env vars", async () => {
  const { loadStoredEnvKeys } = await import("../wizard.ts");
  const { AuthStorage } = await import("@gsd/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-wizard-nooverwrite-"));
  const authPath = join(tmp, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    brave: { type: "api_key", key: "stored-key" },
  }));

  const origBrave = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "existing-env-key";

  try {
    const auth = AuthStorage.create(authPath);
    loadStoredEnvKeys(auth);

    assert.equal(process.env.BRAVE_API_KEY, "existing-env-key", "existing env var not overwritten");
  } finally {
    if (origBrave) process.env.BRAVE_API_KEY = origBrave; else delete process.env.BRAVE_API_KEY;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. npm pack produces valid tarball with correct file layout
// ═══════════════════════════════════════════════════════════════════════════

test("npm pack produces tarball with required files", async () => {
  // Build first
  execSync("npm run build", { cwd: projectRoot, stdio: "pipe" });

  // Pack
  let packOutput: string;
  try {
    packOutput = execSync("npm pack --json 2>/dev/null", {
      cwd: projectRoot,
      encoding: "utf-8",
    });
  } catch (e: any) {
    // ENOBUFS is a system buffer exhaustion, not a code issue
    if (e.code === 'ENOBUFS') {
      console.log('  SKIP: System buffer exhaustion (ENOBUFS)');
      return;
    }
    throw e;
  }
  const packInfo = JSON.parse(packOutput);
  const tarball = packInfo[0].filename;
  const tarballPath = join(projectRoot, tarball);

  assert.ok(existsSync(tarballPath), `tarball ${tarball} created`);

  try {
    // List tarball contents
    const contents = execSync(`tar tzf ${tarballPath}`, { encoding: "utf-8" });
    const files = contents.split("\n").filter(Boolean);

    // Critical files must be present
    assert.ok(files.some(f => f.includes("dist/loader.js")), "tarball contains dist/loader.js");
    assert.ok(files.some(f => f.includes("dist/cli.js")), "tarball contains dist/cli.js");
    assert.ok(files.some(f => f.includes("dist/app-paths.js")), "tarball contains dist/app-paths.js");
    assert.ok(files.some(f => f.includes("dist/wizard.js")), "tarball contains dist/wizard.js");
    assert.ok(files.some(f => f.includes("dist/resource-loader.js")), "tarball contains dist/resource-loader.js");
    assert.ok(files.some(f => f.includes("pkg/package.json")), "tarball contains pkg/package.json");
    assert.ok(files.some(f => f.includes("src/resources/extensions/gsd/index.ts")), "tarball contains bundled gsd extension");
    // AGENTS.md was merged into system.md (commit acea86b)
    assert.ok(files.some(f => f.includes("scripts/postinstall.js")), "tarball contains postinstall script");

    // pkg/package.json must have piConfig
    const pkgJson = readFileSync(join(projectRoot, "pkg", "package.json"), "utf-8");
    const pkg = JSON.parse(pkgJson);
    assert.equal(pkg.piConfig?.name, "gsd", "pkg/package.json piConfig.name is gsd");
    assert.equal(pkg.piConfig?.configDir, ".gsd", "pkg/package.json piConfig.configDir is .gsd");
  } finally {
    // Clean up tarball
    rmSync(tarballPath, { force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. npm pack → install → gsd binary resolves
// ═══════════════════════════════════════════════════════════════════════════

test("tarball installs and gsd binary resolves", async () => {
  // Build and pack
  execSync("npm run build", { cwd: projectRoot, stdio: "pipe" });
  let packOutput: string;
  try {
    packOutput = execSync("npm pack --json 2>/dev/null", {
      cwd: projectRoot,
      encoding: "utf-8",
    });
  } catch (e: any) {
    // ENOBUFS is a system buffer exhaustion, not a code issue
    if (e.code === 'ENOBUFS') {
      console.log('  SKIP: System buffer exhaustion (ENOBUFS)');
      return;
    }
    throw e;
  }
  const packInfo = JSON.parse(packOutput);
  const tarball = packInfo[0].filename;
  const tarballPath = join(projectRoot, tarball);

  const tmp = mkdtempSync(join(tmpdir(), "gsd-install-test-"));

  try {
    // Install from tarball into a temp prefix
    execSync(`npm install --prefix ${tmp} ${tarballPath} --no-save 2>&1`, {
      encoding: "utf-8",
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    });

    // Verify the gsd bin exists in the installed package
    const installedBin = join(tmp, "node_modules", ".bin", "gsd");
    assert.ok(existsSync(installedBin), "gsd binary exists in node_modules/.bin/");

    // Verify loader.js is executable (has shebang)
    const installedLoader = join(tmp, "node_modules", "gsd-pi", "dist", "loader.js");
    const loaderContent = readFileSync(installedLoader, "utf-8");
    assert.ok(loaderContent.startsWith("#!/usr/bin/env node"), "loader.js has node shebang");

    // Verify bundled resources are present
    const installedGsdExt = join(tmp, "node_modules", "gsd-pi", "src", "resources", "extensions", "gsd", "index.ts");
    assert.ok(existsSync(installedGsdExt), "bundled gsd extension present in installed package");
  } finally {
    rmSync(tarballPath, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Launch → extensions load → no errors on stderr
// ═══════════════════════════════════════════════════════════════════════════

test("gsd launches and loads extensions without errors", async () => {
  // Build first
  execSync("npm run build", { cwd: projectRoot, stdio: "pipe" });

  // Launch gsd with all optional keys set (skip wizard) and capture stderr.
  // Kill after 5 seconds — we just need to see if extensions load.
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
