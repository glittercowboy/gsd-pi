import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AutoDashboardData } from "./bridge-service.ts";
import { resolveTypeStrippingFlag } from "./ts-subprocess-flags.ts"

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
  };
}

function resolveAutoDashboardModulePath(packageRoot: string, env: NodeJS.ProcessEnv): string {
  return env[TEST_AUTO_DASHBOARD_MODULE_ENV] || join(packageRoot, "src", "resources", "extensions", "gsd", "auto.ts");
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}

export function collectTestOnlyFallbackAutoDashboardData(): AutoDashboardData {
  return fallbackAutoDashboardData();
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
  const autoModulePath = resolveAutoDashboardModulePath(packageRoot, env);

  if (!checkExists(resolveTsLoader) || !checkExists(autoModulePath)) {
    throw new Error(`authoritative auto dashboard provider not found; checked=${resolveTsLoader},${autoModulePath}`);
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${AUTO_DASHBOARD_MODULE_ENV}).href);`,
    'const result = await mod.getAutoDashboardData();',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ");

  return await new Promise<AutoDashboardData>((resolveResult, reject) => {
    execFile(
      options.execPath ?? process.execPath,
      [
        "--import",
        pathToFileURL(resolveTsLoader).href,
        resolveTypeStrippingFlag(packageRoot),
        "--input-type=module",
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
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`authoritative auto dashboard subprocess failed: ${stderr || error.message}`));
          return;
        }

        try {
          resolveResult(JSON.parse(stdout) as AutoDashboardData);
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
