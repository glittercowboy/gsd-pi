/**
 * GSD Welcome Screen
 *
 * Rendered to stderr before the TUI takes over.
 * No box, no panels — logo with metadata alongside, dim hint below.
 */

import os from 'node:os'
import chalk from 'chalk'
import { GSD_LOGO } from './logo.js'

export interface WelcomeScreenOptions {
  version: string
  modelName?: string
  provider?: string
}

function getShortCwd(): string {
  const cwd = process.cwd()
  const home = os.homedir()
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

export function printWelcomeScreen(opts: WelcomeScreenOptions): void {
  if (!process.stderr.isTTY) return

  const { version, modelName, provider } = opts
  const shortCwd = getShortCwd()

  // Info lines to sit alongside the logo (one per logo row)
  const modelLine = [modelName, provider].filter(Boolean).join('  ·  ')
  const INFO: (string | undefined)[] = [
    `  ${chalk.bold('Get Shit Done')}  ${chalk.dim('v' + version)}`,
    undefined,
    modelLine ? `  ${chalk.dim(modelLine)}` : undefined,
    `  ${chalk.dim(shortCwd)}`,
    undefined,
    undefined,
  ]

  const lines: string[] = ['']
  for (let i = 0; i < GSD_LOGO.length; i++) {
    lines.push(chalk.cyan(GSD_LOGO[i]) + (INFO[i] ?? ''))
  }

  // Tool status + hint — dim, aligned under the info text
  const pad = ' '.repeat(28) + '  '  // aligns with the info text column

  const toolParts: string[] = []
  if (process.env.BRAVE_API_KEY)    toolParts.push('Brave ✓')
  if (process.env.BRAVE_ANSWERS_KEY) toolParts.push('Answers ✓')
  if (process.env.JINA_API_KEY)     toolParts.push('Jina ✓')
  if (process.env.TAVILY_API_KEY)   toolParts.push('Tavily ✓')
  if (process.env.CONTEXT7_API_KEY) toolParts.push('Context7 ✓')

  if (toolParts.length > 0) {
    lines.push(chalk.dim(pad + ['Web search loaded', ...toolParts].join('  ·  ')))
  }

  lines.push(chalk.dim(pad + '/gsd to begin  ·  /gsd help for all commands'))
  lines.push('')

  process.stderr.write(lines.join('\n') + '\n')
}
