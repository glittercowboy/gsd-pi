import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AutoDashboardData } from "./bridge-service.ts";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts";

const AUTO_DASHBOARD_MAX_BUFFER = 1024 * 1024;
const TEST_AUTO_DASHBOARD_MODULE_ENV = "GSD_WEB_TEST_AUTO_DASHBOARD_MODULE";
const TEST_AUTO_DASHBOARD_FALLBACK_ENV = "GSD_WEB_TEST_USE_FALLBACK_AUTO_DASHBOARD";
const AUTO_DASHBOARD_MODULE_ENV = "GSD_AUTO_DASHBOARD_MODULE";

export interface AutoDashboardServiceOptions {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
}

function fallbackAutoDashboardData(): AutoDashboardData {
  return {
    active: false,
    paused: false,
    stepMode: false,
    startTime: 0,
    elapsed: 0,
    currentUnit: null,
    completedUnits: [],
    basePath: "",
    totalCost: 0,
    totalTokens: 0,
    rtkSavings: null,
    rtkEnabled: false,
  };
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}

export function collectTestOnlyFallbackAutoDashboardData(): AutoDashboardData {
  return fallbackAutoDashboardData();
}

/**
 * Check if a PID is alive by sending signal 0.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile subprocess auto dashboard data with on-disk session state.
 *
 * The subprocess always starts with fresh module state (s.active === false),
 * so it can never report active/paused correctly. We check:
 *   1. .gsd/auto.lock — if present and its PID is alive, auto IS running.
 *   2. .gsd/runtime/paused-session.json — if present, auto IS paused.
 *
 * See #2705.
 */
function reconcileWithDiskState(
  data: AutoDashboardData,
  projectCwd: string,
  checkExists: (path: string) => boolean,
): AutoDashboardData {
  // If the subprocess already reports active or paused, trust it.
  if (data.active || data.paused) return data;

  // Check for paused-session.json first (paused takes precedence).
  const pausedPath = join(projectCwd, ".gsd", "runtime", "paused-session.json");
  if (checkExists(pausedPath)) {
    try {
      // Validate the file is readable JSON (not corrupt).
      JSON.parse(readFileSync(pausedPath, "utf-8"));
      return { ...data, paused: true };
    } catch {
      // Corrupt or unreadable — ignore.
    }
  }

  // Check for session lock with a live PID.
  const lockPath = join(projectCwd, ".gsd", "auto.lock");
  if (checkExists(lockPath)) {
    try {
      const lockData = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid?: number };
      if (typeof lockData.pid === "number" && isPidAlive(lockData.pid)) {
        return { ...data, active: true };
      }
    } catch {
      // Corrupt or unreadable — ignore.
    }
  }

  return data;
}

export async function collectAuthoritativeAutoDashboardData(
  packageRoot: string,
  options: AutoDashboardServiceOptions = {},
): Promise<AutoDashboardData> {
  const env = options.env ?? process.env;
  if (env[TEST_AUTO_DASHBOARD_FALLBACK_ENV] === "1") {
    return fallbackAutoDashboardData();
  }

  const checkExists = options.existsSync ?? existsSync;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);

  const testModulePath = env[TEST_AUTO_DASHBOARD_MODULE_ENV];
  const moduleResolution = testModulePath
    ? { modulePath: testModulePath, useCompiledJs: false }
    : resolveSubprocessModule(packageRoot, "resources/extensions/gsd/auto.ts", checkExists);
  const autoModulePath = moduleResolution.modulePath;

  if (!moduleResolution.useCompiledJs && (!checkExists(resolveTsLoader) || !checkExists(autoModulePath))) {
    throw new Error(`authoritative auto dashboard provider not found; checked=${resolveTsLoader},${autoModulePath}`);
  }
  if (moduleResolution.useCompiledJs && !checkExists(autoModulePath)) {
    throw new Error(`authoritative auto dashboard provider not found; checked=${autoModulePath}`);
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${AUTO_DASHBOARD_MODULE_ENV}).href);`,
    'const result = await mod.getAutoDashboardData();',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ");

  const prefixArgs = buildSubprocessPrefixArgs(
    packageRoot,
    moduleResolution,
    pathToFileURL(resolveTsLoader).href,
  );

  return await new Promise<AutoDashboardData>((resolveResult, reject) => {
    execFile(
      options.execPath ?? process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script,
      ],
      {
        cwd: packageRoot,
        env: {
          ...env,
          [AUTO_DASHBOARD_MODULE_ENV]: autoModulePath,
        },
        maxBuffer: AUTO_DASHBOARD_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`authoritative auto dashboard subprocess failed: ${stderr || error.message}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as AutoDashboardData;
          const projectCwd = env.GSD_WEB_PROJECT_CWD || "";
          const reconciled = projectCwd
            ? reconcileWithDiskState(parsed, projectCwd, checkExists)
            : parsed;
          resolveResult(reconciled);
        } catch (parseError) {
          reject(
            new Error(
              `authoritative auto dashboard subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          );
        }
      },
    );
  });
}
