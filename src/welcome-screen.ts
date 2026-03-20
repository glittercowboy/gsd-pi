/**
 * GSD Welcome Screen
 *
 * Rendered to stderr before the TUI takes over. Shows a two-panel layout:
 *   Left  — greeting, GSD logo, model + cwd info
 *   Right — getting-started tips, recent session activity
 */

import os from 'node:os'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { GSD_LOGO } from './logo.js'

export interface WelcomeScreenOptions {
  version: string
  modelName?: string
  provider?: string
  sessionsDir?: string
  hasPriorSessions?: boolean
}

/** Strip ANSI escape codes to get printable character count. */
function visLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

/** Right-pad a string to a given visible width. */
function padTo(s: string, width: number): string {
  const needed = width - visLen(s)
  return needed > 0 ? s + ' '.repeat(needed) : s
}

function getUsername(): string {
  try { return os.userInfo().username } catch { return 'there' }
}

function getShortCwd(): string {
  const cwd = process.cwd()
  const home = os.homedir()
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

interface RecentSession {
  preview: string
  date: string
}

function getRecentSessions(sessionsDir: string, limit = 3): RecentSession[] {
  if (!sessionsDir || !existsSync(sessionsDir)) return []
  try {
    const cwd = process.cwd()
    const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
    const dir = join(sessionsDir, safePath)
    if (!existsSync(dir)) return []

    const files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const p = join(dir, f)
        return { path: p, mtime: statSync(p).mtime }
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, limit)

    return files.map(f => {
      const date = f.mtime.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      try {
        const lines = readFileSync(f.path, 'utf-8').split('\n').filter(l => l.trim())
        for (const line of lines) {
          const msg = JSON.parse(line)
          // Look for human message content
          const text: string =
            msg?.message?.content?.[0]?.text ||
            msg?.content?.[0]?.text ||
            ''
          if (text.trim()) {
            return { preview: text.replace(/\n/g, ' ').slice(0, 42), date }
          }
        }
      } catch { /* ignore */ }
      return { preview: '', date }
    }).filter(s => s.preview || s.date)
  } catch {
    return []
  }
}

export function printWelcomeScreen(opts: WelcomeScreenOptions): void {
  if (!process.stderr.isTTY) return

  const cols = process.stderr.columns || process.stdout.columns || 80
  if (cols < 60) return

  const { version, modelName, provider, sessionsDir } = opts

  const username = getUsername()
  const shortCwd = getShortCwd()
  const sessions = sessionsDir ? getRecentSessions(sessionsDir) : []
  const isReturn = opts.hasPriorSessions ?? sessions.length > 0

  // Layout
  const totalW = Math.min(cols - 2, 92)
  const LEFT_W = 33  // fixed inner width of left column (excluding the │ borders)
  const RIGHT_W = totalW - LEFT_W - 1  // -1 for the centre divider

  // Box-drawing
  const h = '─', v = '│'
  const TL = '┌', TR = '┐', BL = '└', BR = '┘', BT = '┴'

  // Colour helpers
  const a  = (s: string) => chalk.cyan(s)          // accent (cyan, matching logo.ts first-launch)
  const d  = (s: string) => chalk.dim(s)            // dim / secondary
  const b  = (s: string) => chalk.bold(s)           // bold
  const g  = (s: string) => chalk.green(s)          // green (commands)

  // ── Top border ──────────────────────────────────────────────────────────
  const tag     = ` GSD v${version} `
  const tagLen  = tag.length
  const fillLen = totalW - tagLen - 2  // 2 = TL + TR (but they're 1 char each → totalW - tagLen - 0?)
  // totalW is the inner width: TL + inner(totalW) + TR = TL + totalW + TR → strip corners from line
  const topBar = a(TL + h.repeat(2)) + b(tag) + a(h.repeat(fillLen) + TR)
  // Recalculate: total line length = 1 (TL) + 2 + tagLen + fillLen + 1 (TR) = totalW + 2
  // We want total = totalW + 2 → fillLen = totalW + 2 - 1 - 2 - tagLen - 1 = totalW - tagLen - 2
  // Already correct above.

  // ── Left column ─────────────────────────────────────────────────────────
  const L: string[] = []
  L.push('')
  L.push(`  ${b(isReturn ? `Welcome back, ${username}!` : `Welcome, ${username}!`)}`)
  L.push('')
  for (const line of GSD_LOGO) {
    L.push(` ${a(line)}`)
  }
  L.push('')
  if (modelName && provider) {
    const modelStr = `  ${d(modelName)} ${d('·')} ${d(provider)}`
    L.push(visLen(modelStr) <= LEFT_W ? modelStr : `  ${d(modelName.slice(0, LEFT_W - 4))}`)
  } else if (modelName) {
    L.push(`  ${d(modelName)}`)
  }
  const cwdStr = `  ${d(shortCwd.length > LEFT_W - 3 ? '…' + shortCwd.slice(-(LEFT_W - 4)) : shortCwd)}`
  L.push(cwdStr)
  L.push('')

  // ── Right column ─────────────────────────────────────────────────────────
  const R: string[] = []
  R.push('')
  R.push(`  ${b('Tips for getting started')}`)

  const TIPS: [string, string][] = [
    ['/gsd new-project',  'initialize a new project'],
    ['/gsd doctor',       'check environment health'],
    ['/gsd progress',     'see what\'s next'],
    ['/gsd help',         'all commands'],
  ]
  for (const [cmd, desc] of TIPS) {
    R.push(`  ${g(cmd.padEnd(18))}${d(desc)}`)
  }
  R.push('')
  R.push(`  ${b('Recent activity')}`)
  if (sessions.length === 0) {
    R.push(`  ${d('No recent activity')}`)
  } else {
    for (const s of sessions) {
      const preview = s.preview ? `${s.preview.slice(0, RIGHT_W - 10)}` : d('(empty)')
      R.push(`  ${d(s.date + ' ›')} ${preview}`)
    }
  }
  R.push('')

  // ── Merge columns ────────────────────────────────────────────────────────
  const rows = Math.max(L.length, R.length)
  while (L.length < rows) L.push('')
  while (R.length < rows) R.push('')

  // ── Render ────────────────────────────────────────────────────────────────
  const out: string[] = [topBar]
  for (let i = 0; i < rows; i++) {
    const lCell = padTo(L[i], LEFT_W)
    const rCell = padTo(R[i], RIGHT_W)
    out.push(`${a(v)}${lCell}${a(v)}${rCell}${a(v)}`)
  }
  const botBar = a(BL + h.repeat(LEFT_W) + BT + h.repeat(RIGHT_W) + BR)
  out.push(botBar)

  process.stderr.write('\n' + out.join('\n') + '\n\n')
}
