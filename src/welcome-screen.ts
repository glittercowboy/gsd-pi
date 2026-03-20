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

  // Hint line — dim, aligned under the info text
  const logoWidth = 28  // visible width of logo block
  lines.push(chalk.dim(' '.repeat(logoWidth) + '  /gsd to begin  ·  /gsd help for all commands'))
  lines.push('')

  process.stderr.write(lines.join('\n') + '\n')
}
