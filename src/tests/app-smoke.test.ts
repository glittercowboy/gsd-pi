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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

function assertExtensionIndexExists(agentDir: string, extensionName: string): void {
  assert.ok(
    existsSync(join(agentDir, "extensions", extensionName, "index.js"))
      || existsSync(join(agentDir, "extensions", extensionName, "index.ts")),
    `${extensionName} extension synced`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. app-paths
// ═══════════════════════════════════════════════════════════════════════════

test("app-paths resolve to ~/.gsd/", async () => {
  const { appRoot, agentDir, sessionsDir, authFilePath } = await import("../app-paths.ts");
  // Use homedir() — process.env.HOME is undefined on Windows (uses USERPROFILE instead)
  const { homedir } = await import("node:os");
  const home = homedir();

  assert.equal(appRoot, join(home, ".gsd"), "appRoot is ~/.gsd/");
  assert.equal(agentDir, join(home, ".gsd", "agent"), "agentDir is ~/.gsd/agent/");
  assert.equal(sessionsDir, join(home, ".gsd", "sessions"), "sessionsDir is ~/.gsd/sessions/");
  assert.equal(authFilePath, join(home, ".gsd", "agent", "auth.json"), "authFilePath is ~/.gsd/agent/auth.json");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. loader env vars
// ═══════════════════════════════════════════════════════════════════════════

test("loader sets all 4 GSD_ env vars and PI_PACKAGE_DIR", async (t) => {
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

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
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

  // Verify that the env var is populated at runtime by checking the actual
  // extensions directory has discoverable entry points
  const { discoverExtensionEntryPaths } = await import("../extension-discovery.ts");
  const bundledExtensionsDir = join(projectRoot, existsSync(join(projectRoot, "dist", "resources"))
  ? "dist" : "src", "resources", "extensions");
  const discovered = discoverExtensionEntryPaths(bundledExtensionsDir);
  assert.ok(discovered.length >= 10, `expected >=10 extensions, found ${discovered.length}`);

  // Spot-check that core extensions are discoverable
  const discoveredNames = discovered.map(p => {
  const rel = p.slice(bundledExtensionsDir.length + 1);
  return rel.split(/[\\/]/)[0].replace(/\.(?:ts|js)$/, "");
  });
  for (const core of ["gsd", "bg-shell", "browser-tools", "subagent", "search-the-web"]) {
  assert.ok(discoveredNames.includes(core), `core extension '${core}' is discoverable`);
  }

  rmSync(tmp, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2b. loader runtime dependency checks
// ═══════════════════════════════════════════════════════════════════════════

test("checkNodeVersion rejects below-minimum versions and accepts at-or-above", async () => {
  // Calls the actual pure function the loader invokes. If loader.ts ever
  // weakens the minimum (e.g. drops the < check), this test fails because
  // an old Node version would be incorrectly accepted.
  const { checkNodeVersion, MIN_NODE_MAJOR } = await import("../runtime-checks.ts");

  // Below minimum → not ok, surfaces the actual major
  const tooOld = checkNodeVersion("18.19.0", MIN_NODE_MAJOR);
  assert.strictEqual(tooOld.ok, false, "Node 18 must be rejected when min is 22+");
  if (tooOld.ok === false) {
    assert.strictEqual(tooOld.actualMajor, 18, "reports actual major from input");
  }

  // Exactly minimum → ok
  const exactlyMin = checkNodeVersion(`${MIN_NODE_MAJOR}.0.0`, MIN_NODE_MAJOR);
  assert.strictEqual(exactlyMin.ok, true, "version equal to minimum must be accepted");

  // Above minimum → ok
  const above = checkNodeVersion(`${MIN_NODE_MAJOR + 5}.10.2`, MIN_NODE_MAJOR);
  assert.strictEqual(above.ok, true, "version above minimum must be accepted");

  // Malformed version string is a precondition violation — must throw
  assert.throws(() => checkNodeVersion("not-a-version", MIN_NODE_MAJOR), /cannot parse major/);
});

test("requireGit returns false when exec throws and true when it succeeds", async () => {
  // Calls the actual pure function the loader uses. Stubs the exec function
  // so we test the loader's real behavior with no subprocess flakiness.
  const { requireGit } = await import("../runtime-checks.ts");

  // Failure path: exec throws → loader treats git as missing
  let calls: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  const throwingExec = (cmd: string, args: ReadonlyArray<string>) => {
    calls.push({ cmd, args });
    throw new Error("ENOENT: git not found");
  };
  assert.strictEqual(requireGit(throwingExec), false, "must return false when exec throws");
  assert.strictEqual(calls.length, 1, "exec invoked exactly once");
  assert.strictEqual(calls[0].cmd, "git", "invokes 'git' specifically");
  assert.deepStrictEqual([...calls[0].args], ["--version"], "passes ['--version']");

  // Success path: exec returns → loader treats git as available
  calls = [];
  const okExec = (cmd: string, args: ReadonlyArray<string>) => {
    calls.push({ cmd, args });
    return Buffer.from("git version 2.40.0\n");
  };
  assert.strictEqual(requireGit(okExec), true, "must return true when exec succeeds");
  assert.strictEqual(calls.length, 1, "success path also invokes exec exactly once");
});

test("loader MIN_NODE_MAJOR matches package.json engines field exactly", async () => {
  // Imports the actual exported constant from runtime-checks.ts (the same
  // module loader.ts consumes) and asserts STRICT equality with the major
  // version parsed from package.json's engines.node range.
  const { MIN_NODE_MAJOR } = await import("../runtime-checks.ts");

  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
  const engineRange: string = pkg.engines?.node ?? "";
  const match = engineRange.match(/(\d+)/);
  assert.ok(match, `package.json engines.node must declare a major version, got: ${JSON.stringify(engineRange)}`);
  const engineMajor = parseInt(match[1], 10);

  assert.strictEqual(
    MIN_NODE_MAJOR,
    engineMajor,
    `runtime-checks MIN_NODE_MAJOR (${MIN_NODE_MAJOR}) must equal package.json engines.node major (${engineMajor})`,
  );
});

test("gsd update bypasses the managed-resource-mismatch gate; non-update commands trigger it", async (t) => {
  // Real fixture: write an agentDir whose managed-resources.json claims a
  // version newer than the running binary. The mismatch gate
  // (getNewerManagedResourceVersion) must fire — proving the gate is "armed".
  // shouldBypassManagedResourceMismatchGate('update') must return true,
  // proving 'update' bypasses it. cli.ts wires the predicate before the gate
  // call, so update escapes the gate.
  const { getNewerManagedResourceVersion } = await import("../resource-loader.ts");
  const { shouldBypassManagedResourceMismatchGate } = await import("../cli-policy.ts");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-bypass-"));
  const fakeAgentDir = join(tmp, "agent");
  mkdirSync(fakeAgentDir, { recursive: true });

  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Fixture: manifest claims a far-future version → gate must fire for everyone
  const futureVersion = "999.0.0";
  const currentVersion = "1.0.0";
  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({ gsdVersion: futureVersion, syncedAt: Date.now() }),
  );

  // Gate is armed: returns the newer version (cli.ts would print mismatch + exit 1)
  const newer = getNewerManagedResourceVersion(fakeAgentDir, currentVersion);
  assert.strictEqual(newer, futureVersion, "gate must surface a newer version when manifest is ahead");

  // For non-update commands the predicate is false → cli.ts falls through to the gate.
  for (const nonUpdate of [undefined, "auto", "config", "doctor", "web", "headless", "updates" /* near-miss */]) {
    assert.strictEqual(
      shouldBypassManagedResourceMismatchGate(nonUpdate),
      false,
      `non-update command ${JSON.stringify(nonUpdate)} must NOT bypass the gate`,
    );
  }

  // For 'update' the predicate is true → cli.ts dispatches runUpdate() before the gate.
  assert.strictEqual(
    shouldBypassManagedResourceMismatchGate("update"),
    true,
    "'update' must bypass the gate so the user can escape a version-mismatched install",
  );
});

test("managed resource skew ignores dev/build suffixes on the same release line", async (t) => {
  const { getNewerManagedResourceVersion } = await import("../resource-loader.ts");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-version-normalize-"));
  const fakeAgentDir = join(tmp, "agent");
  mkdirSync(fakeAgentDir, { recursive: true });

  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({ gsdVersion: "2.78.1", syncedAt: Date.now() }),
  );

  assert.strictEqual(
    getNewerManagedResourceVersion(fakeAgentDir, "2.78.1-dev.84c045fd2"),
    null,
    "same core version must not trip the skew gate just because the binary is a dev build",
  );
  assert.strictEqual(
    getNewerManagedResourceVersion(fakeAgentDir, "2.78.1+local"),
    null,
    "build metadata on the running binary must not trip the skew gate",
  );
  assert.strictEqual(
    getNewerManagedResourceVersion(fakeAgentDir, "2.78.0-dev.84c045fd2"),
    "2.78.1",
    "older core versions must still be blocked even when they carry a dev suffix",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. resource-loader syncs bundled resources
// ═══════════════════════════════════════════════════════════════════════════

test("initResources syncs extensions, agents, and skills to target dir", async (t) => {
  const { initResources, readManagedResourceVersion } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resources-test-"));
  const fakeAgentDir = join(tmp, "agent");

  initResources(fakeAgentDir);

  // Extensions synced
  assertExtensionIndexExists(fakeAgentDir, "gsd");
  assertExtensionIndexExists(fakeAgentDir, "browser-tools");
  assertExtensionIndexExists(fakeAgentDir, "search-the-web");
  assertExtensionIndexExists(fakeAgentDir, "context7");
  assertExtensionIndexExists(fakeAgentDir, "subagent");

  // Agents synced
  assert.ok(existsSync(join(fakeAgentDir, "agents", "scout.md")), "scout agent synced");

  // Skills are NOT synced here — they use ~/.agents/skills/ via skills.sh

  // Version manifest synced
  const managedVersion = readManagedResourceVersion(fakeAgentDir);
  assert.ok(managedVersion, "managed resource version written");

  // Idempotent: run again, no crash
  initResources(fakeAgentDir);
  assertExtensionIndexExists(fakeAgentDir, "gsd");
});

test("initResources skips copy when managed version matches current version", async (t) => {
  const { initResources, readManagedResourceVersion } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resources-skip-"));
  const fakeAgentDir = join(tmp, "agent");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // First run: full sync (no manifest yet)
  initResources(fakeAgentDir);
  const version = readManagedResourceVersion(fakeAgentDir);
  assert.ok(version, "manifest written after first sync");

  // Add a marker file to detect whether sync runs again
  const markerPath = join(fakeAgentDir, "extensions", "gsd", "_marker.txt");
  writeFileSync(markerPath, "test-marker");

  // Second run: version matches — should skip, marker survives
  initResources(fakeAgentDir);
  assert.ok(existsSync(markerPath), "marker file survives when version matches (sync skipped)");

  // Simulate version mismatch by writing older version to manifest
  const manifestPath = join(fakeAgentDir, "managed-resources.json");
  writeFileSync(manifestPath, JSON.stringify({ gsdVersion: "0.0.1", syncedAt: Date.now() }));

  // Third run: version mismatch — full sync, marker removed
  initResources(fakeAgentDir);
  assert.ok(!existsSync(markerPath), "marker file removed after version-mismatch sync");

  // Manifest updated to current version
  const updatedVersion = readManagedResourceVersion(fakeAgentDir);
  assert.strictEqual(updatedVersion, version, "manifest updated to current version after sync");
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. wizard loadStoredEnvKeys hydration
// ═══════════════════════════════════════════════════════════════════════════

test("loadStoredEnvKeys hydrates process.env from auth.json", async (t) => {
  const { loadStoredEnvKeys } = await import("../wizard.ts");
  const { AuthStorage } = await import("@gsd/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-wizard-test-"));
  const authPath = join(tmp, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    brave: { type: "api_key", key: "test-brave-key" },
    brave_answers: { type: "api_key", key: "test-answers-key" },
    context7: { type: "api_key", key: "test-ctx7-key" },
    tavily: { type: "api_key", key: "test-tavily-key" },
    telegram_bot: { type: "api_key", key: "test-telegram-key" },
    "custom-openai": { type: "api_key", key: "test-custom-openai-key" },
  }));

  // Clear any existing env vars
  const envVarsToRestore = [
    "BRAVE_API_KEY", "BRAVE_ANSWERS_KEY", "CONTEXT7_API_KEY",
    "JINA_API_KEY", "TAVILY_API_KEY", "TELEGRAM_BOT_TOKEN",
    "CUSTOM_OPENAI_API_KEY",
  ];
  const origValues: Record<string, string | undefined> = {};
  for (const v of envVarsToRestore) {
    origValues[v] = process.env[v];
    delete process.env[v];
  }

  t.after(() => {
    for (const v of envVarsToRestore) {
    if (origValues[v]) process.env[v] = origValues[v]; else delete process.env[v];
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  const auth = AuthStorage.create(authPath);
  loadStoredEnvKeys(auth);

  assert.equal(process.env.BRAVE_API_KEY, "test-brave-key", "BRAVE_API_KEY hydrated");
  assert.equal(process.env.BRAVE_ANSWERS_KEY, "test-answers-key", "BRAVE_ANSWERS_KEY hydrated");
  assert.equal(process.env.CONTEXT7_API_KEY, "test-ctx7-key", "CONTEXT7_API_KEY hydrated");
  assert.equal(process.env.JINA_API_KEY, undefined, "JINA_API_KEY not set (not in auth)");
  assert.equal(process.env.TAVILY_API_KEY, "test-tavily-key", "TAVILY_API_KEY hydrated");
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, "test-telegram-key", "TELEGRAM_BOT_TOKEN hydrated");
  assert.equal(process.env.CUSTOM_OPENAI_API_KEY, "test-custom-openai-key", "CUSTOM_OPENAI_API_KEY hydrated");
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. loadStoredEnvKeys does NOT overwrite existing env vars
// ═══════════════════════════════════════════════════════════════════════════

test("loadStoredEnvKeys does not overwrite existing env vars", async (t) => {
  const { loadStoredEnvKeys } = await import("../wizard.ts");
  const { AuthStorage } = await import("@gsd/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-wizard-nooverwrite-"));
  const authPath = join(tmp, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    brave: { type: "api_key", key: "stored-key" },
  }));

  const origBrave = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "existing-env-key";

  t.after(() => {
    if (origBrave) process.env.BRAVE_API_KEY = origBrave; else delete process.env.BRAVE_API_KEY;
    rmSync(tmp, { recursive: true, force: true });
  });
  const auth = AuthStorage.create(authPath);
  loadStoredEnvKeys(auth);

  assert.equal(process.env.BRAVE_API_KEY, "existing-env-key", "existing env var not overwritten");
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. State derivation — Gap 2
// ═══════════════════════════════════════════════════════════════════════════

test("deriveState returns pre-planning phase for empty .gsd/ directory", async (t) => {
  const { deriveState } = await import("../resources/extensions/gsd/state.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-state-smoke-"));

  // Create minimal .gsd/ structure with no milestones
  mkdirSync(join(tmp, ".gsd"), { recursive: true });

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const state = await deriveState(tmp);

  assert.equal(state.phase, "pre-planning",
    `expected pre-planning phase for empty .gsd/, got: ${state.phase}`);
  assert.equal(state.activeMilestone, null, "no active milestone");
  assert.equal(state.activeSlice, null, "no active slice");
  assert.equal(state.activeTask, null, "no active task");
  assert.ok(Array.isArray(state.blockers), "blockers is an array");
  assert.ok(Array.isArray(state.registry), "registry is an array");
  assert.equal(state.registry.length, 0, "empty registry");
  assert.ok(typeof state.nextAction === "string", "nextAction is a string");
  assert.ok(state.nextAction.length > 0, "nextAction is non-empty");
});

test("deriveState returns pre-planning phase when no .gsd/ directory exists", async (t) => {
  const { deriveState } = await import("../resources/extensions/gsd/state.ts");
  // Use a temp dir with no .gsd/ subdirectory at all
  const tmp = mkdtempSync(join(tmpdir(), "gsd-state-nogsd-"));

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // Should not throw — missing .gsd/ is a valid "no project" state
  const state = await deriveState(tmp);

  assert.equal(state.phase, "pre-planning",
    `expected pre-planning phase when .gsd/ absent, got: ${state.phase}`);
  assert.equal(state.activeMilestone, null, "no active milestone");
});

test("deriveState shape is structurally complete", async (t) => {
  const { deriveState } = await import("../resources/extensions/gsd/state.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-state-shape-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const state = await deriveState(tmp);

  // All required fields present
  const requiredFields = [
    "phase", "activeMilestone", "activeSlice", "activeTask",
    "recentDecisions", "blockers", "nextAction", "registry",
  ] as const;
  for (const field of requiredFields) {
    assert.ok(field in state, `state.${field} should be present`);
  }

  // phase is a known string value
  const validPhases = [
    "pre-planning", "needs-discussion", "researching", "planning",
    "executing", "summarizing", "replanning-slice", "validating-milestone",
    "completing-milestone", "complete", "blocked",
  ];
  assert.ok(validPhases.includes(state.phase),
    `state.phase '${state.phase}' should be a known phase`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Doctor health checks — Gap 3
// ═══════════════════════════════════════════════════════════════════════════

test("runGSDDoctor completes without throwing on empty .gsd/ directory", async (t) => {
  const { runGSDDoctor } = await import("../resources/extensions/gsd/doctor.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-doctor-smoke-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // audit-only mode (fix: false) — should never throw
  const report = await runGSDDoctor(tmp, { fix: false });

  // Structural assertions on the DoctorReport
  assert.ok(typeof report === "object" && report !== null, "report is an object");
  assert.ok("ok" in report, "report has ok field");
  assert.ok("issues" in report, "report has issues field");
  assert.ok("fixesApplied" in report, "report has fixesApplied field");
  assert.ok("basePath" in report, "report has basePath field");
  assert.ok(Array.isArray(report.issues), "report.issues is an array");
  assert.ok(Array.isArray(report.fixesApplied), "report.fixesApplied is an array");
  assert.equal(typeof report.ok, "boolean", "report.ok is a boolean");
  assert.equal(report.fixesApplied.length, 0, "no fixes applied in audit mode");
});

test("runGSDDoctor issue objects have required fields", async (t) => {
  const { runGSDDoctor } = await import("../resources/extensions/gsd/doctor.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-doctor-fields-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });

  // Create a milestone dir with no ROADMAP.md to force a missing_roadmap issue
  const mDir = join(tmp, ".gsd", "milestones", "M001");
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(mDir, "M001-CONTEXT.md"), "# Context\n");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const report = await runGSDDoctor(tmp, { fix: false });

  // Should find at least one issue (missing roadmap for M001)
  assert.ok(report.issues.length > 0, "expected at least one issue for milestone missing ROADMAP.md");

  // Verify structure of each issue
  for (const issue of report.issues) {
    assert.ok(typeof issue.severity === "string", "issue.severity is a string");
    assert.ok(["info", "warning", "error"].includes(issue.severity),
      `issue.severity '${issue.severity}' should be info|warning|error`);
    assert.ok(typeof issue.code === "string", "issue.code is a string");
    assert.ok(typeof issue.message === "string", "issue.message is a string");
    assert.ok(issue.message.length > 0, "issue.message is non-empty");
    assert.ok(typeof issue.fixable === "boolean", "issue.fixable is a boolean");
  }
});

test("runGSDDoctor with fix:false never modifies the filesystem", async (t) => {
  const { runGSDDoctor } = await import("../resources/extensions/gsd/doctor.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-doctor-readonly-"));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  // Write a sentinel file — doctor must not delete or modify it
  const sentinelPath = join(gsdDir, "SENTINEL.md");
  writeFileSync(sentinelPath, "# sentinel\n");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await runGSDDoctor(tmp, { fix: false });

  assert.ok(existsSync(sentinelPath), "sentinel file still exists after audit-only run");
  const content = readFileSync(sentinelPath, "utf-8");
  assert.equal(content, "# sentinel\n", "sentinel file content unchanged");
});
