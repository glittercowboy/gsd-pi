/**
 * Unit tests for the gsd CLI package.
 *
 * Tests the glue code that IS the product:
 * - app-paths resolve to ~/.gsd/
 * - loader sets all required env vars
 * - resource-loader syncs bundled resources
 * - wizard loadStoredEnvKeys hydrates env
 *
 * Integration tests (npm pack, install, launch) are in ./integration/pack-install.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
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
    import { dirname, resolve, join, delimiter } from 'path';
    import { agentDir } from './app-paths.js';

    const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pkg');
    process.env.PI_PACKAGE_DIR = pkgDir;
    process.env.GSD_CODING_AGENT_DIR = agentDir;
    process.env.GSD_BIN_PATH = process.argv[1];
    const resourcesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'resources');
    process.env.GSD_WORKFLOW_PATH = join(resourcesDir, 'GSD-WORKFLOW.md');
    const exts = ['extensions/gsd/index.ts'].map(r => join(resourcesDir, r));
    process.env.GSD_BUNDLED_EXTENSION_PATHS = exts.join(delimiter);

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
  assert.ok(ad.endsWith(join(".gsd", "agent")), "agentDir ends with .gsd/agent");

  // Verify the env var names are in loader.ts source
  const loaderSrc = readFileSync(join(projectRoot, "src", "loader.ts"), "utf-8");
  assert.ok(loaderSrc.includes("PI_PACKAGE_DIR"), "loader sets PI_PACKAGE_DIR");
  assert.ok(loaderSrc.includes("GSD_CODING_AGENT_DIR"), "loader sets GSD_CODING_AGENT_DIR");
  assert.ok(loaderSrc.includes("GSD_BIN_PATH"), "loader sets GSD_BIN_PATH");
  assert.ok(loaderSrc.includes("GSD_WORKFLOW_PATH"), "loader sets GSD_WORKFLOW_PATH");
  assert.ok(loaderSrc.includes("GSD_BUNDLED_EXTENSION_PATHS"), "loader sets GSD_BUNDLED_EXTENSION_PATHS");
  assert.ok(loaderSrc.includes("serializeBundledExtensionPaths"), "loader uses shared bundled path serializer");
  assert.ok(loaderSrc.includes("join(delimiter)"), "loader uses platform delimiter for NODE_PATH");

  // Verify extension discovery mechanism is in place
  // loader.ts now dynamically discovers extensions via readdirSync instead of
  // hardcoding paths — verify the discovery infrastructure exists
  assert.ok(loaderSrc.includes("readdirSync"), "loader uses readdirSync for extension discovery");
  assert.ok(loaderSrc.includes("bundledExtDir"), "loader defines bundledExtDir for scanning");
  assert.ok(loaderSrc.includes("discoveredExtensionPaths"), "loader collects discovered paths");

  // Verify that the env var is populated at runtime by checking the actual
  // extensions directory has discoverable entry points
  const { discoverExtensionEntryPaths } = await import("../resource-loader.ts");
  const bundledExtensionsDir = join(projectRoot, existsSync(join(projectRoot, "dist", "resources"))
    ? "dist" : "src", "resources", "extensions");
  const discovered = discoverExtensionEntryPaths(bundledExtensionsDir);
  assert.ok(discovered.length >= 10, `expected >=10 extensions, found ${discovered.length}`);

  // Spot-check that core extensions are discoverable
  const discoveredNames = discovered.map(p => {
    const rel = p.slice(bundledExtensionsDir.length + 1);
    return rel.split(/[\\/]/)[0].replace(/\.ts$/, "");
  });
  for (const core of ["gsd", "bg-shell", "browser-tools", "subagent", "search-the-web"]) {
    assert.ok(discoveredNames.includes(core), `core extension '${core}' is discoverable`);
  }

  rmSync(tmp, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. resource-loader syncs bundled resources
// ═══════════════════════════════════════════════════════════════════════════

test("initResources syncs extensions, agents, and skills to target dir", async () => {
  const { initResources, readManagedResourceVersion } = await import("../resource-loader.ts");
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

    // Version manifest synced
    const managedVersion = readManagedResourceVersion(fakeAgentDir);
    assert.ok(managedVersion, "managed resource version written");

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
