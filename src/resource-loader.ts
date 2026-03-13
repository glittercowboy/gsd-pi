import { DefaultResourceLoader } from '@mariozechner/pi-coding-agent'
import { homedir } from 'node:os'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolves to the bundled src/resources/ inside the npm package at runtime:
//   dist/resource-loader.js → .. → package root → src/resources/
const resourcesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'resources')
const bundledExtensionsDir = join(resourcesDir, 'extensions')

/**
 * Syncs all bundled resources to agentDir (~/.gsd/agent/) on every launch.
 *
 * - extensions/ → ~/.gsd/agent/extensions/   (always overwrite — ensures updates ship on next launch)
 * - agents/     → ~/.gsd/agent/agents/        (always overwrite)
 * - GSD-WORKFLOW.md is read directly from bundled path via GSD_WORKFLOW_PATH env var
 *
 * Always-overwrite ensures `npm update -g @glittercowboy/gsd` takes effect immediately.
 * User customizations should go in ~/.gsd/agent/extensions/ subdirs with unique names,
 * not by editing the gsd-managed files.
 *
 * Inspectable: `ls ~/.gsd/agent/extensions/`
 */
export function initResources(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })

  // Sync extensions — always overwrite so updates land on next launch
  const destExtensions = join(agentDir, 'extensions')
  cpSync(bundledExtensionsDir, destExtensions, { recursive: true, force: true })

  // Sync agents
  const destAgents = join(agentDir, 'agents')
  const srcAgents = join(resourcesDir, 'agents')
  if (existsSync(srcAgents)) {
    cpSync(srcAgents, destAgents, { recursive: true, force: true })
  }

  // Sync skills — always overwrite so updates land on next launch
  const destSkills = join(agentDir, 'skills')
  const srcSkills = join(resourcesDir, 'skills')
  if (existsSync(srcSkills)) {
    cpSync(srcSkills, destSkills, { recursive: true, force: true })
  }

  // Sync AGENTS.md
  const srcAgentsMd = join(resourcesDir, 'AGENTS.md')
  const destAgentsMd = join(agentDir, 'AGENTS.md')
  if (existsSync(srcAgentsMd)) {
    writeFileSync(destAgentsMd, readFileSync(srcAgentsMd))
  }
}

/**
 * Constructs a DefaultResourceLoader that loads extensions from both
 * ~/.gsd/agent/extensions/ (GSD's default) and ~/.pi/agent/extensions/ (pi's default).
 * This allows users to use extensions from either location.
 */
export function buildResourceLoader(agentDir: string): DefaultResourceLoader {
  const piAgentDir = join(homedir(), '.pi', 'agent')
  const piExtensionsDir = join(piAgentDir, 'extensions')
  
  return new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths: [piExtensionsDir],
  })
}
