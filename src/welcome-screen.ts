/**
 * GSD Welcome Screen
 *
 * Two-panel bar layout: full-width accent bars at top/bottom (matching the
 * auto-mode progress widget style), logo left (fixed width), info right.
 * Falls back to simple text on narrow terminals (<70 cols) or non-TTY.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { GSD_LOGO } from './logo.js'

interface GsdState {
  milestone?: string
  phase?: string
  slice?: string
  nextAction?: string
}

function readGsdState(): GsdState | undefined {
  try {
    const raw = readFileSync(join(process.cwd(), '.gsd', 'STATE.md'), 'utf-8')
    const state: GsdState = {}
    const milestone = raw.match(/^\*\*Active Milestone:\*\*\s*(.+)$/m)
    if (milestone) state.milestone = milestone[1].trim()
    const slice = raw.match(/^\*\*Active Slice:\*\*\s*(.+)$/m)
    if (slice) state.slice = slice[1].trim()
    const phase = raw.match(/^\*\*Phase:\*\*\s*(.+)$/m)
    if (phase) state.phase = phase[1].trim()
    // Accept both template shapes: inline "**Next Action:** ..." and the
    // "## Next Action\n<line>" heading format. Prefer the inline match.
    const nextInline = raw.match(/^\*\*Next Action:\*\*\s*(.+)$/m)
    const nextHeading = raw.match(/^##\s*Next Action\s*\n+([^\n]+)/m)
    const nextMatch = nextInline ?? nextHeading
    if (nextMatch) state.nextAction = nextMatch[1].trim()
    return state
  } catch {
    return undefined
  }
}

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

export function printWelcomeScreen(opts: WelcomeScreenOptions): void {
  if (!process.stderr.isTTY) return

  const { version, remoteChannel } = opts
  const shortCwd = getShortCwd()
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

  // "Welcome back" context lines — GSD state if available, else hint.
  // Intentionally avoids data already shown in the footer (model, provider,
  // pwd, branch).
  const state = readGsdState()
  let line1 = ''
  let line2 = ''
  if (state?.milestone) {
    const statusParts = [state.milestone, state.phase, state.slice].filter(Boolean)
    const activePrefix = '  Active     '
    const maxActiveLen = RIGHT_INNER - activePrefix.length - 1
    let activeText = statusParts.join(' · ')
    if (activeText.length > maxActiveLen) activeText = activeText.slice(0, maxActiveLen - 1) + '…'
    line1 = `${activePrefix}${chalk.dim(activeText)}`
    line2 = state.nextAction
      ? `  Next       ${chalk.dim(state.nextAction)}`
      : ''
  } else {
    line1 = `  Status     ${chalk.dim('No active GSD project')}`
    line2 = `             ${chalk.dim('/gsd to begin')}`
  }
  const sessionLine = line1
  const projectLine = line2

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
