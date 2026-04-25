/**
 * Headless Query — `gsd headless query`
 *
 * Single read-only command that returns the full project snapshot as JSON
 * to stdout, without spawning an LLM session. Instant (~50ms).
 *
 * Output: { state, next, cost }
 *   state — deriveState() output (phase, milestones, progress, blockers)
 *   next  — dry-run dispatch preview (what auto-mode would do next)
 *   cost  — aggregated parallel worker costs
 *
 * Note: Extension modules are .ts files loaded via jiti (not compiled to .js).
 * We use createJiti() here because this module is imported directly from cli.ts,
 * bypassing the extension loader's jiti setup (#1137).
 */

import { createJiti } from '@mariozechner/jiti'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { GSDState } from './resources/extensions/gsd/types.js'
import { resolveBundledSourceResource } from './bundled-resource-path.js'

const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false })
const { existsSync } = await import('node:fs')

/**
 * Resolve the GSD extensions root for headless-query. Prefers the synced
 * agent directory (so headless-query loads the same extension copy as
 * interactive/auto modes — #3471) and falls back to the bundled source
 * resource for source-tree dev workflows.
 *
 * Pure on the given inputs (env + fs probe + bundled resolver) so the
 * #3471 contract can be exercised in tests without spawning a subprocess.
 */
export function resolveGsdAgentExtensionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GSD_AGENT_DIR || join(homedir(), '.gsd', 'agent'), 'extensions', 'gsd')
}

/**
 * Decide whether headless-query should load extensions from the agent
 * sync directory (#3471) or fall back to bundled source. Returns the
 * agent dir alongside the decision so a caller can use it directly.
 */
export function shouldUseAgentExtensionsDir(opts: {
  env?: NodeJS.ProcessEnv
  fileExists?: (path: string) => boolean
}): { agentDir: string; useAgentDir: boolean } {
  const env = opts.env ?? process.env
  const fileExists = opts.fileExists ?? existsSync
  const agentDir = resolveGsdAgentExtensionsDir(env)
  return { agentDir, useAgentDir: fileExists(join(agentDir, 'state.ts')) }
}

const agentExtensionsDir = resolveGsdAgentExtensionsDir()
const useAgentDir = existsSync(join(agentExtensionsDir, 'state.ts'))
const gsdExtensionPath = (...segments: string[]) =>
  useAgentDir
    ? join(agentExtensionsDir, ...segments)
    : resolveBundledSourceResource(import.meta.url, 'extensions', 'gsd', ...segments)

async function loadExtensionModules() {
  const stateModule = await jiti.import(gsdExtensionPath('state.ts'), {}) as any
  const dispatchModule = await jiti.import(gsdExtensionPath('auto-dispatch.ts'), {}) as any
  const sessionModule = await jiti.import(gsdExtensionPath('session-status-io.ts'), {}) as any
  const prefsModule = await jiti.import(gsdExtensionPath('preferences.ts'), {}) as any
  const autoStartModule = await jiti.import(gsdExtensionPath('auto-start.ts'), {}) as any
  return {
    openProjectDbIfPresent: autoStartModule.openProjectDbIfPresent as (basePath: string) => Promise<void>,
    deriveState: stateModule.deriveState as (basePath: string) => Promise<GSDState>,
    resolveDispatch: dispatchModule.resolveDispatch as (opts: any) => Promise<any>,
    readAllSessionStatuses: sessionModule.readAllSessionStatuses as (basePath: string) => any[],
    loadEffectiveGSDPreferences: prefsModule.loadEffectiveGSDPreferences as () => any,
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QuerySnapshot {
  state: GSDState
  next: {
    action: 'dispatch' | 'stop' | 'skip'
    unitType?: string
    unitId?: string
    reason?: string
  }
  cost: {
    workers: Array<{
      milestoneId: string
      pid: number
      state: string
      cost: number
      lastHeartbeat: number
    }>
    total: number
  }
}

export interface QueryResult {
  exitCode: number
  data?: QuerySnapshot
}

// ─── Implementation ─────────────────────────────────────────────────────────

export async function handleQuery(basePath: string): Promise<QueryResult> {
  const {
    openProjectDbIfPresent,
    deriveState,
    resolveDispatch,
    readAllSessionStatuses,
    loadEffectiveGSDPreferences,
  } = await loadExtensionModules()
  await openProjectDbIfPresent(basePath)
  const state = await deriveState(basePath)

  // Derive next dispatch action
  let next: QuerySnapshot['next']
  if (!state.activeMilestone?.id) {
    next = {
      action: 'stop',
      reason: state.phase === 'complete' ? 'All milestones complete.' : state.nextAction,
    }
  } else {
    const loaded = loadEffectiveGSDPreferences()
    const dispatch = await resolveDispatch({
      basePath,
      mid: state.activeMilestone.id,
      midTitle: state.activeMilestone.title,
      state,
      prefs: loaded?.preferences,
    })
    next = {
      action: dispatch.action,
      unitType: dispatch.action === 'dispatch' ? dispatch.unitType : undefined,
      unitId: dispatch.action === 'dispatch' ? dispatch.unitId : undefined,
      reason: dispatch.action === 'stop' ? dispatch.reason : undefined,
    }
  }

  // Aggregate parallel worker costs
  const statuses = readAllSessionStatuses(basePath)
  const workers = statuses.map((s) => ({
    milestoneId: s.milestoneId,
    pid: s.pid,
    state: s.state,
    cost: s.cost,
    lastHeartbeat: s.lastHeartbeat,
  }))

  const snapshot: QuerySnapshot = {
    state,
    next,
    cost: { workers, total: workers.reduce((sum, w) => sum + w.cost, 0) },
  }

  process.stdout.write(JSON.stringify(snapshot) + '\n')
  return { exitCode: 0, data: snapshot }
}
