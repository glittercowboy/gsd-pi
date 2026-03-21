import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"
import type { SettingsData } from "../../web/lib/settings-types.ts"

const SETTINGS_MAX_BUFFER = 2 * 1024 * 1024

/**
 * Loads settings data via a child process. Calls upstream extension modules
 * for preferences, routing config, budget allocation, routing history, and
 * project totals, then combines results into a single SettingsData payload.
 *
 * Uses the same child-process pattern as forensics-service.ts — Turbopack
 * cannot resolve the .js extension imports these upstream modules use, so
 * execFile + resolve-ts.mjs is required.
 */
export async function collectSettingsData(projectCwdOverride?: string): Promise<SettingsData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [
      { envKey: "GSD_SETTINGS_PREFS_MODULE", relativePath: "src/resources/extensions/gsd/preferences.ts" },
      { envKey: "GSD_SETTINGS_ROUTER_MODULE", relativePath: "src/resources/extensions/gsd/model-router.ts" },
      { envKey: "GSD_SETTINGS_BUDGET_MODULE", relativePath: "src/resources/extensions/gsd/context-budget.ts" },
      { envKey: "GSD_SETTINGS_HISTORY_MODULE", relativePath: "src/resources/extensions/gsd/routing-history.ts" },
      { envKey: "GSD_SETTINGS_METRICS_MODULE", relativePath: "src/resources/extensions/gsd/metrics.ts" },
    ],
    label: "settings",
  })

  // The child script loads all upstream modules, calls the 5 data functions,
  // and writes a combined JSON payload to stdout.
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    'const prefsMod = await import(pathToFileURL(process.env.GSD_SETTINGS_PREFS_MODULE).href);',
    'const routerMod = await import(pathToFileURL(process.env.GSD_SETTINGS_ROUTER_MODULE).href);',
    'const budgetMod = await import(pathToFileURL(process.env.GSD_SETTINGS_BUDGET_MODULE).href);',
    'const historyMod = await import(pathToFileURL(process.env.GSD_SETTINGS_HISTORY_MODULE).href);',
    'const metricsMod = await import(pathToFileURL(process.env.GSD_SETTINGS_METRICS_MODULE).href);',

    // 1. Effective preferences (may be null if no preferences files exist)
    'const loaded = prefsMod.loadEffectiveGSDPreferences();',
    'let preferences = null;',
    'if (loaded) {',
    '  const p = loaded.preferences;',
    '  preferences = {',
    '    mode: p.mode,',
    '    budgetCeiling: p.budget_ceiling,',
    '    budgetEnforcement: p.budget_enforcement,',
    '    tokenProfile: p.token_profile,',
    '    dynamicRouting: p.dynamic_routing,',
    '    customInstructions: p.custom_instructions,',
    '    alwaysUseSkills: p.always_use_skills,',
    '    preferSkills: p.prefer_skills,',
    '    avoidSkills: p.avoid_skills,',
    '    autoSupervisor: p.auto_supervisor ? {',
    '      enabled: true,',
    '      softTimeoutMinutes: p.auto_supervisor.soft_timeout_minutes,',
    '    } : undefined,',
    '    uatDispatch: p.uat_dispatch,',
    '    autoVisualize: p.auto_visualize,',
    '    remoteQuestions: p.remote_questions ? {',
    '      channel: p.remote_questions.channel,',
    '      channelId: String(p.remote_questions.channel_id),',
    '      timeoutMinutes: p.remote_questions.timeout_minutes,',
    '      pollIntervalSeconds: p.remote_questions.poll_interval_seconds,',
    '    } : undefined,',
    '    scope: loaded.scope,',
    '    path: loaded.path,',
    '    warnings: loaded.warnings,',
    '  };',
    '}',

    // 2. Resolved dynamic routing config (always returns a config with defaults)
    'const routingConfig = prefsMod.resolveDynamicRoutingConfig();',

    // 3. Budget allocation (use 200K as default context window)
    'const budgetAllocation = budgetMod.computeBudgets(200000);',

    // 4. Routing history (must init before reading)
    'historyMod.initRoutingHistory(process.env.GSD_SETTINGS_BASE);',
    'const routingHistory = historyMod.getRoutingHistory();',

    // 5. Project totals (null if no metrics ledger exists)
    'const ledger = metricsMod.loadLedgerFromDisk(process.env.GSD_SETTINGS_BASE);',
    'const projectTotals = ledger ? metricsMod.getProjectTotals(ledger.units) : null;',

    // Write combined payload
    'process.stdout.write(JSON.stringify({ preferences, routingConfig, budgetAllocation, routingHistory, projectTotals }));',
  ].join(" ")

  return await runSubprocess<SettingsData>({
    packageRoot,
    script,
    env: { ...resolved.env, GSD_SETTINGS_BASE: projectCwd },
    label: "settings data",
    tsLoaderPath: resolved.tsLoaderPath,
    maxBuffer: SETTINGS_MAX_BUFFER,
  })
}
