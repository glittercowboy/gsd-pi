/**
 * GSD Worktree CLI — standalone subcommand and -w flag handling.
 *
 * Manages the full worktree lifecycle from the command line:
 *   gsd -w                    Create auto-named worktree, start interactive session
 *   gsd -w my-feature         Create/resume named worktree
 *   gsd worktree list         List worktrees with status
 *   gsd worktree merge [name] Squash-merge a worktree into main
 *   gsd worktree clean        Remove all merged/empty worktrees
 *   gsd worktree remove <n>   Remove a specific worktree
 *
 * On session exit (via session_shutdown event), auto-commits dirty work
 * so nothing is lost. The GSD extension reads GSD_CLI_WORKTREE to know
 * when a session was launched via -w.
 */

import chalk from 'chalk'
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  mergeWorktreeToMain,
  diffWorktreeAll,
  diffWorktreeNumstat,
  worktreeBranchName,
  worktreePath,
} from './resources/extensions/gsd/worktree-manager.js'
import { runWorktreePostCreateHook } from './resources/extensions/gsd/auto-worktree.js'
import { generateWorktreeName } from './worktree-name-gen.js'
import {
  nativeHasChanges,
  nativeWorkingTreeStatus,
  nativeDetectMainBranch,
  nativeCommitCountBetween,
} from './resources/extensions/gsd/native-git-bridge.js'
import { inferCommitType } from './resources/extensions/gsd/git-service.js'
import { existsSync } from 'node:fs'

// ─── Types ──────────────────────────────────────────────────────────────────

interface WorktreeStatus {
  name: string
  path: string
  branch: string
  exists: boolean
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  uncommitted: boolean
  commits: number
}

// ─── Status Helpers ─────────────────────────────────────────────────────────

function getWorktreeStatus(basePath: string, name: string, wtPath: string): WorktreeStatus {
  const diff = diffWorktreeAll(basePath, name)
  const numstat = diffWorktreeNumstat(basePath, name)
  const filesChanged = diff.added.length + diff.modified.length + diff.removed.length
  let linesAdded = 0
  let linesRemoved = 0
  for (const s of numstat) { linesAdded += s.added; linesRemoved += s.removed }

  let uncommitted = false
  try { uncommitted = existsSync(wtPath) && nativeHasChanges(wtPath) } catch { /* */ }

  let commits = 0
  try {
    const mainBranch = nativeDetectMainBranch(basePath)
    commits = nativeCommitCountBetween(basePath, mainBranch, worktreeBranchName(name))
  } catch { /* */ }

  return {
    name,
    path: wtPath,
    branch: worktreeBranchName(name),
    exists: existsSync(wtPath),
    filesChanged,
    linesAdded,
    linesRemoved,
    uncommitted,
    commits,
  }
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatStatus(s: WorktreeStatus): string {
  const lines: string[] = []
  const badge = s.uncommitted
    ? chalk.yellow(' (uncommitted)')
    : s.filesChanged > 0
      ? chalk.cyan(' (unmerged)')
      : chalk.green(' (clean)')

  lines.push(`  ${chalk.bold.cyan(s.name)}${badge}`)
  lines.push(`    ${chalk.dim('branch')}  ${chalk.magenta(s.branch)}`)
  lines.push(`    ${chalk.dim('path')}    ${chalk.dim(s.path)}`)

  if (s.filesChanged > 0) {
    lines.push(`    ${chalk.dim('diff')}    ${s.filesChanged} files, ${chalk.green(`+${s.linesAdded}`)} ${chalk.red(`-${s.linesRemoved}`)}, ${s.commits} commit${s.commits === 1 ? '' : 's'}`)
  }

  return lines.join('\n')
}

// ─── Subcommand: list ───────────────────────────────────────────────────────

function handleList(basePath: string): void {
  const worktrees = listWorktrees(basePath)

  if (worktrees.length === 0) {
    process.stderr.write(chalk.dim('No worktrees. Create one with: gsd -w <name>\n'))
    return
  }

  process.stderr.write(chalk.bold('\nWorktrees\n\n'))
  for (const wt of worktrees) {
    const status = getWorktreeStatus(basePath, wt.name, wt.path)
    process.stderr.write(formatStatus(status) + '\n\n')
  }
}

// ─── Subcommand: merge ──────────────────────────────────────────────────────

async function handleMerge(basePath: string, args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    // If only one worktree exists, merge it
    const worktrees = listWorktrees(basePath)
    if (worktrees.length === 1) {
      await doMerge(basePath, worktrees[0].name)
      return
    }
    process.stderr.write(chalk.red('Usage: gsd worktree merge <name>\n'))
    process.stderr.write(chalk.dim('Run gsd worktree list to see worktrees.\n'))
    process.exit(1)
  }
  await doMerge(basePath, name)
}

async function doMerge(basePath: string, name: string): Promise<void> {
  const worktrees = listWorktrees(basePath)
  const wt = worktrees.find(w => w.name === name)
  if (!wt) {
    process.stderr.write(chalk.red(`Worktree "${name}" not found.\n`))
    process.exit(1)
  }

  const status = getWorktreeStatus(basePath, name, wt.path)
  if (status.filesChanged === 0 && !status.uncommitted) {
    process.stderr.write(chalk.dim(`Worktree "${name}" has no changes to merge.\n`))
    // Clean up empty worktree
    removeWorktree(basePath, name, { deleteBranch: true })
    process.stderr.write(chalk.green(`Removed empty worktree ${chalk.bold(name)}.\n`))
    return
  }

  // Auto-commit dirty work before merge
  if (status.uncommitted) {
    try {
      const { autoCommitCurrentBranch } = await import('./resources/extensions/gsd/worktree.js')
      autoCommitCurrentBranch(wt.path, 'worktree-merge', name)
      process.stderr.write(chalk.dim('  Auto-committed dirty work before merge.\n'))
    } catch { /* best-effort */ }
  }

  const commitType = inferCommitType(name)
  const commitMessage = `${commitType}(${name}): merge worktree ${name}`

  process.stderr.write(`\nMerging ${chalk.bold.cyan(name)} → ${chalk.magenta(nativeDetectMainBranch(basePath))}\n`)
  process.stderr.write(chalk.dim(`  ${status.filesChanged} files, ${chalk.green(`+${status.linesAdded}`)} ${chalk.red(`-${status.linesRemoved}`)}\n\n`))

  try {
    mergeWorktreeToMain(basePath, name, commitMessage)
    removeWorktree(basePath, name, { deleteBranch: true })
    process.stderr.write(chalk.green(`✓ Merged and cleaned up ${chalk.bold(name)}\n`))
    process.stderr.write(chalk.dim(`  commit: ${commitMessage}\n`))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(chalk.red(`✗ Merge failed: ${msg}\n`))
    process.stderr.write(chalk.dim('  Resolve conflicts manually, then run gsd worktree merge again.\n'))
    process.exit(1)
  }
}

// ─── Subcommand: clean ──────────────────────────────────────────────────────

function handleClean(basePath: string): void {
  const worktrees = listWorktrees(basePath)
  if (worktrees.length === 0) {
    process.stderr.write(chalk.dim('No worktrees to clean.\n'))
    return
  }

  let cleaned = 0
  for (const wt of worktrees) {
    const status = getWorktreeStatus(basePath, wt.name, wt.path)
    if (status.filesChanged === 0 && !status.uncommitted) {
      try {
        removeWorktree(basePath, wt.name, { deleteBranch: true })
        process.stderr.write(chalk.green(`  ✓ Removed ${chalk.bold(wt.name)} (clean)\n`))
        cleaned++
      } catch {
        process.stderr.write(chalk.yellow(`  ✗ Failed to remove ${wt.name}\n`))
      }
    } else {
      process.stderr.write(chalk.dim(`  ─ Kept ${chalk.bold(wt.name)} (${status.filesChanged} changed files)\n`))
    }
  }

  process.stderr.write(chalk.dim(`\nCleaned ${cleaned} worktree${cleaned === 1 ? '' : 's'}.\n`))
}

// ─── Subcommand: remove ─────────────────────────────────────────────────────

function handleRemove(basePath: string, args: string[]): void {
  const name = args[0]
  if (!name) {
    process.stderr.write(chalk.red('Usage: gsd worktree remove <name>\n'))
    process.exit(1)
  }

  const worktrees = listWorktrees(basePath)
  const wt = worktrees.find(w => w.name === name)
  if (!wt) {
    process.stderr.write(chalk.red(`Worktree "${name}" not found.\n`))
    process.exit(1)
  }

  const status = getWorktreeStatus(basePath, name, wt.path)
  if (status.filesChanged > 0 || status.uncommitted) {
    process.stderr.write(chalk.yellow(`⚠ Worktree "${name}" has unmerged changes (${status.filesChanged} files).\n`))
    process.stderr.write(chalk.yellow('  Use --force to remove anyway, or merge first: gsd worktree merge ' + name + '\n'))
    if (!process.argv.includes('--force')) {
      process.exit(1)
    }
  }

  removeWorktree(basePath, name, { deleteBranch: true })
  process.stderr.write(chalk.green(`✓ Removed worktree ${chalk.bold(name)}\n`))
}

// ─── Subcommand: status (default when no args) ─────────────────────────────

function handleStatusBanner(basePath: string): void {
  const worktrees = listWorktrees(basePath)
  if (worktrees.length === 0) return

  const withChanges = worktrees.filter(wt => {
    try {
      const diff = diffWorktreeAll(basePath, wt.name)
      return diff.added.length + diff.modified.length + diff.removed.length > 0
    } catch { return false }
  })

  if (withChanges.length === 0) return

  const names = withChanges.map(w => chalk.cyan(w.name)).join(', ')
  process.stderr.write(
    chalk.dim('[gsd] ') +
    chalk.yellow(`${withChanges.length} worktree${withChanges.length === 1 ? '' : 's'} with unmerged changes: `) +
    names + '\n' +
    chalk.dim('[gsd] ') +
    chalk.dim('Resume: gsd -w <name>  |  Merge: gsd worktree merge <name>  |  List: gsd worktree list\n\n'),
  )
}

// ─── -w flag: create/resume worktree for interactive session ────────────────

function handleWorktreeFlag(worktreeFlag: boolean | string): void {
  const basePath = process.cwd()

  // gsd -w (no name) — resume most recent worktree with changes, or create new
  if (worktreeFlag === true) {
    const existing = listWorktrees(basePath)
    const withChanges = existing.filter(wt => {
      try {
        const diff = diffWorktreeAll(basePath, wt.name)
        return diff.added.length + diff.modified.length + diff.removed.length > 0
      } catch { return false }
    })

    if (withChanges.length === 1) {
      // Single active worktree — resume it
      const wt = withChanges[0]
      process.chdir(wt.path)
      process.env.GSD_CLI_WORKTREE = wt.name
      process.env.GSD_CLI_WORKTREE_BASE = basePath
      process.stderr.write(chalk.green(`✓ Resumed worktree ${chalk.bold(wt.name)}\n`))
      process.stderr.write(chalk.dim(`  path   ${wt.path}\n`))
      process.stderr.write(chalk.dim(`  branch ${wt.branch}\n\n`))
      return
    }

    if (withChanges.length > 1) {
      // Multiple active worktrees — show them and ask user to pick
      process.stderr.write(chalk.yellow(`${withChanges.length} worktrees have unmerged changes:\n\n`))
      for (const wt of withChanges) {
        const status = getWorktreeStatus(basePath, wt.name, wt.path)
        process.stderr.write(formatStatus(status) + '\n\n')
      }
      process.stderr.write(chalk.dim('Specify which one: gsd -w <name>\n'))
      process.exit(0)
    }

    // No active worktrees — create a new one
    const name = generateWorktreeName()
    createAndEnter(basePath, name)
    return
  }

  // gsd -w <name> — create or resume named worktree
  const name = worktreeFlag as string
  const existing = listWorktrees(basePath)
  const found = existing.find(wt => wt.name === name)

  if (found) {
    process.chdir(found.path)
    process.env.GSD_CLI_WORKTREE = name
    process.env.GSD_CLI_WORKTREE_BASE = basePath
    process.stderr.write(chalk.green(`✓ Resumed worktree ${chalk.bold(name)}\n`))
    process.stderr.write(chalk.dim(`  path   ${found.path}\n`))
    process.stderr.write(chalk.dim(`  branch ${found.branch}\n\n`))
  } else {
    createAndEnter(basePath, name)
  }
}

function createAndEnter(basePath: string, name: string): void {
  try {
    const info = createWorktree(basePath, name)

    const hookError = runWorktreePostCreateHook(basePath, info.path)
    if (hookError) {
      process.stderr.write(chalk.yellow(`[gsd] ${hookError}\n`))
    }

    process.chdir(info.path)
    process.env.GSD_CLI_WORKTREE = name
    process.env.GSD_CLI_WORKTREE_BASE = basePath
    process.stderr.write(chalk.green(`✓ Created worktree ${chalk.bold(name)}\n`))
    process.stderr.write(chalk.dim(`  path   ${info.path}\n`))
    process.stderr.write(chalk.dim(`  branch ${info.branch}\n\n`))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(chalk.red(`[gsd] Failed to create worktree: ${msg}\n`))
    process.exit(1)
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  handleList,
  handleMerge,
  handleClean,
  handleRemove,
  handleStatusBanner,
  handleWorktreeFlag,
  getWorktreeStatus,
}
