/**
 * Regression tests for the default package root fallback in bridge-service.
 *
 * Issue: gsd-build/gsd-2#1881
 * The standalone Next.js bundle bakes import.meta.url at build time with the
 * CI runner's absolute path.  On Windows, fileURLToPath() rejects the Unix
 * file:// URL at module load time, 500-ing all API routes.
 *
 * The fix makes the fallback lazy and catch-guarded so the module loads safely
 * on any OS regardless of what import.meta.url resolved to at build time.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const bridge = await import("../web/bridge-service.ts");

test("resolveBridgeRuntimeConfig uses GSD_WEB_PACKAGE_ROOT when set", () => {
  const env = {
    GSD_WEB_PACKAGE_ROOT: "/custom/package/root",
    GSD_WEB_PROJECT_CWD: "/some/project",
  } as unknown as NodeJS.ProcessEnv;

  const config = bridge.resolveBridgeRuntimeConfig(env);
  assert.equal(config.packageRoot, "/custom/package/root");
});

test("resolveBridgeRuntimeConfig falls back to lazy default when GSD_WEB_PACKAGE_ROOT is absent", () => {
  // Reset the memoized value so we exercise the lazy computation path.
  bridge.resetDefaultPackageRootForTests();

  const env = {
    GSD_WEB_PROJECT_CWD: "/some/project",
  } as unknown as NodeJS.ProcessEnv;

  // Should not throw — the lazy getter catches cross-platform failures.
  const config = bridge.resolveBridgeRuntimeConfig(env);
  assert.equal(typeof config.packageRoot, "string");
  assert.ok(config.packageRoot.length > 0, "packageRoot must be a non-empty string");
});

test("lazy default package root is an absolute path", () => {
  bridge.resetDefaultPackageRootForTests();

  const env = {
    GSD_WEB_PROJECT_CWD: "/some/project",
  } as unknown as NodeJS.ProcessEnv;

  const config = bridge.resolveBridgeRuntimeConfig(env);
  // resolve() returns the same path if already absolute.
  assert.equal(config.packageRoot, resolve(config.packageRoot));
});

test("lazy default package root is memoized across calls", () => {
  bridge.resetDefaultPackageRootForTests();

  const env = {} as unknown as NodeJS.ProcessEnv;

  const first = bridge.resolveBridgeRuntimeConfig(env).packageRoot;
  const second = bridge.resolveBridgeRuntimeConfig(env).packageRoot;
  assert.equal(first, second, "memoized value should be stable across calls");
});

test("module loads without throwing (regression: eager fileURLToPath crash)", () => {
  // The fact that we can import bridge-service at the top of this file without
  // an unhandled exception is itself the primary regression gate.  This test
  // makes that contract explicit.
  assert.ok(typeof bridge.resolveBridgeRuntimeConfig === "function");
});
