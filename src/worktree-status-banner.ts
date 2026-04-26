// GSD worktree startup banner
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import chalk from 'chalk'

interface WorktreeEntry {
  path: string
  branch: string
  isBare: boolean
}

interface GsdWorktree {
  name: string
  branch: string
}

function normalizePath(path: string): string {
  const normalized = path
    .replaceAll('\\', '/')
    .replace(/^\/\/\?\//, '')
    .replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function gitExec(basePath: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: basePath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    }).trim()
  } catch {
    return ''
  }
}

function parseWorktreeList(output: string): WorktreeEntry[] {
  if (!output) return []
  const entries: WorktreeEntry[] = []
  const blocks = output.replaceAll('\r\n', '\n').split('\n\n').filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    const wtLine = lines.find((line) => line.startsWith('worktree '))
    const branchLine = lines.find((line) => line.startsWith('branch '))
    if (!wtLine) continue
    entries.push({
      path: wtLine.replace('worktree ', ''),
      branch: branchLine ? branchLine.replace('branch refs/heads/', '') : '',
      isBare: lines.some((line) => line === 'bare'),
    })
  }
  return entries
}

function existingPathVariants(path: string): string[] {
  const variants = [resolve(path)]
  if (existsSync(path)) {
    try {
      variants.push(realpathSync(path))
    } catch {
      // Best effort only; the unresolved path is still useful for matching.
    }
  }
  return [...new Set(variants.map(normalizePath))]
}

function findGsdWorktrees(basePath: string, entries: WorktreeEntry[]): GsdWorktree[] {
  const roots = existingPathVariants(join(basePath, '.gsd', 'worktrees'))
  const worktrees: GsdWorktree[] = []

  for (const entry of entries) {
    if (entry.isBare || !entry.branch) continue

    const branchWorktreeName = entry.branch.startsWith('worktree/')
      ? entry.branch.slice('worktree/'.length)
      : entry.branch.startsWith('milestone/')
        ? entry.branch.slice('milestone/'.length)
        : null
    const entryVariants = existingPathVariants(entry.path)
    const matchedRoot = roots.find((root) =>
      entryVariants.some((variant) => variant.startsWith(`${root}/`) || variant.startsWith(`${root}${sep}`)),
    )
    const matchesBranchLeaf = branchWorktreeName
      ? entryVariants.some((variant) => variant.split('/').pop() === branchWorktreeName)
      : false

    if (!matchedRoot && !matchesBranchLeaf) continue

    const matchedPath = matchedRoot
      ? entryVariants.find((variant) => variant.startsWith(`${matchedRoot}/`) || variant.startsWith(`${matchedRoot}${sep}`))
      : undefined
    let name = matchedRoot && matchedPath ? matchedPath.slice(matchedRoot.length + 1) : ''
    if ((!name || name.includes('/')) && branchWorktreeName && matchesBranchLeaf) {
      name = branchWorktreeName
    }
    if (!name || name.includes('/')) continue

    worktrees.push({ name, branch: entry.branch })
  }

  return worktrees
}

function detectMainBranch(basePath: string): string {
  const symbolic = gitExec(basePath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  const remoteMatch = symbolic.match(/refs\/remotes\/origin\/(.+)$/)
  if (remoteMatch?.[1]) return remoteMatch[1]
  if (gitExec(basePath, ['show-ref', '--verify', 'refs/heads/main'])) return 'main'
  if (gitExec(basePath, ['show-ref', '--verify', 'refs/heads/master'])) return 'master'
  return gitExec(basePath, ['branch', '--show-current'])
}

function branchHasChanges(basePath: string, mainBranch: string, branch: string): boolean {
  try {
    execFileSync('git', ['diff', '--quiet', mainBranch, branch], {
      cwd: basePath,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    })
    return false
  } catch {
    return true
  }
}

export function showWorktreeStatusBanner(basePath: string): void {
  const worktreesDir = join(basePath, '.gsd', 'worktrees')
  if (!existsSync(worktreesDir)) return

  const entries = parseWorktreeList(gitExec(basePath, ['worktree', 'list', '--porcelain']))
  const worktrees = findGsdWorktrees(basePath, entries)
  if (worktrees.length === 0) return

  const mainBranch = detectMainBranch(basePath)
  if (!mainBranch) return

  const withChanges = worktrees.filter((worktree) => branchHasChanges(basePath, mainBranch, worktree.branch))
  if (withChanges.length === 0) return

  const names = withChanges.map((worktree) => chalk.cyan(worktree.name)).join(', ')
  process.stderr.write(
    chalk.dim('[gsd] ') +
    chalk.yellow(`${withChanges.length} worktree${withChanges.length === 1 ? '' : 's'} with unmerged changes: `) +
    names + '\n' +
    chalk.dim('[gsd] ') +
    chalk.dim('Resume: gsd -w <name>  |  Merge: gsd worktree merge <name>  |  List: gsd worktree list\n\n'),
  )
}
