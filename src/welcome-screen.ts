/**
 * GSD Welcome Screen
 *
 * Two-panel bar layout: full-width accent bars at top/bottom (matching the
 * auto-mode progress widget style), logo left (fixed width), info right.
 * Falls back to simple text on narrow terminals (<70 cols) or non-TTY.
 */

import { execFileSync } from 'node:child_process'
import os from 'node:os'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { GSD_LOGO } from './logo.js'

export interface WelcomeScreenOptions {
  version: string
  modelName?: string
  provider?: string
  remoteChannel?: string
}

function getShortCwd(): string {
  const cwd = process.cwd()
  const home = os.homedir()
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

/** Visible length — strips ANSI escape codes before measuring. */
function visLen(s: string): number {
  return stripAnsi(s).length
}

/** Right-pad a string to the given visible width. */
function rpad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - visLen(s)))
}

/** Read the current git branch name. Returns undefined on failure. */
function getGitBranch(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined
  } catch {
    return undefined
  }
}

export function printWelcomeScreen(opts: WelcomeScreenOptions): void {
  if (!process.stderr.isTTY) return

  const { version, modelName, provider, remoteChannel } = opts
  const shortCwd = getShortCwd()
  const branch = getGitBranch()
  const termWidth = (process.stderr.columns || 80) - 1

  // Narrow terminal fallback
  if (termWidth < 70) {
    process.stderr.write(`\n  Get Shit Done v${version}\n  ${shortCwd}\n\n`)
    return
  }

  // ── Panel widths ────────────────────────────────────────────────────────────
  // Layout: 1 leading space + LEFT_INNER logo content + 1 inner divider + RIGHT_INNER info
  // Total: 1 + LEFT_INNER + 1 + RIGHT_INNER = termWidth
  const LEFT_INNER = 34
  const RIGHT_INNER = termWidth - LEFT_INNER - 2  // 2 = leading space + inner divider

  // ── Bar/divider chars (matching GLYPH.separator + widget ui.bar() style) ────
  const H = '─', DV = '│', DS = '├'

  // ── Left rows: blank + 6 logo lines + blank (8 total) ───────────────────────
  const leftRows = ['', ...GSD_LOGO, '']

  // ── Right rows (8 total, null = divider) ────────────────────────────────────
  const titleLeft  = `  ${chalk.bold('Get Shit Done')}`
  const titleRight = chalk.dim(`v${version}`)
  const titleFill  = RIGHT_INNER - visLen(titleLeft) - visLen(titleRight)
  const titleRow   = titleLeft + ' '.repeat(Math.max(1, titleFill)) + titleRight

  const toolParts: string[] = []
  if (process.env.BRAVE_API_KEY)      toolParts.push('Brave ✓')
  if (process.env.BRAVE_ANSWERS_KEY)  toolParts.push('Answers ✓')
  if (process.env.JINA_API_KEY)       toolParts.push('Jina ✓')
  if (process.env.TAVILY_API_KEY)     toolParts.push('Tavily ✓')
  if (process.env.CONTEXT7_API_KEY)   toolParts.push('Context7 ✓')
  if (remoteChannel)                  toolParts.push(`${remoteChannel.charAt(0).toUpperCase() + remoteChannel.slice(1)} ✓`)

  // Tools left, hint right-aligned on the same row
  const toolsLeft  = toolParts.length > 0 ? chalk.dim('  ' + toolParts.join('  ·  ')) : ''
  const hintRight  = chalk.dim('/gsd to begin  ·  /gsd help')
  const footerFill = RIGHT_INNER - visLen(toolsLeft) - visLen(hintRight)
  const footerRow  = toolsLeft + ' '.repeat(Math.max(1, footerFill)) + hintRight

  // Combined session line: "provider / model" or just model or just provider
  const sessionParts = [provider, modelName].filter(Boolean)
  const sessionLine = sessionParts.length > 0
    ? `  Session    ${chalk.dim(sessionParts.join(' / '))}`
    : ''

  // Combined project line: "~/path [branch]"
  const branchSuffix = branch ? ` [${branch}]` : ''
  const projectLine = `  Project    ${chalk.dim(shortCwd + branchSuffix)}`

  const DIVIDER = null
  const rightRows: (string | null)[] = [
    titleRow,
    DIVIDER,
    '',
    sessionLine,
    projectLine,
    '',
    DIVIDER,
    footerRow,
  ]

  // ── Render ──────────────────────────────────────────────────────────────────
  const out: string[] = ['']

  // Top bar — full-width accent separator, matches auto-mode widget ui.bar()
  out.push(chalk.cyan(H.repeat(termWidth)))

  for (let i = 0; i < 8; i++) {
    const row      = leftRows[i] ?? ''
    const lContent = rpad(row ? chalk.cyan(row) : '', LEFT_INNER)
    const rRow     = rightRows[i]

    if (rRow === null) {
      // Section divider: left logo area + dim ├────... extending right
      out.push(' ' + lContent + chalk.dim(DS + H.repeat(RIGHT_INNER)))
    } else {
      // Content row: 1 space + logo │ info (no outer vertical borders)
      out.push(' ' + lContent + chalk.dim(DV) + rpad(rRow, RIGHT_INNER))
    }
  }

  // Bottom bar — full-width accent separator
  out.push(chalk.cyan(H.repeat(termWidth)))
  out.push('')

  process.stderr.write(out.join('\n') + '\n')
}
