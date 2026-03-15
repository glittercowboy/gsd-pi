import { execFileSync } from "node:child_process"
import { relative, resolve, sep } from "node:path"

import {
  nativeDetectMainBranch,
  nativeHasChanges,
  nativeHasMergeConflicts,
  nativeGetCurrentBranch,
} from "../resources/extensions/gsd/native-git-bridge.ts"
import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import {
  GIT_SUMMARY_SCOPE,
  type GitSummaryCounts,
  type GitSummaryFile,
  type GitSummaryResponse,
} from "../../web/lib/git-summary-contract.ts"

const MAX_CHANGED_FILES = 25
const CONFLICT_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])

function sanitizeGitError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/\s+/g, " ").trim()
}

function gitExecTrim(basePath: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GIT_SVN_ID: "",
      },
    }).trim()
  } catch {
    if (allowFailure) return ""
    throw new Error(`git ${args.join(" ")} failed in ${basePath}`)
  }
}

function readGitStatusPorcelain(basePath: string): string {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: basePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GIT_SVN_ID: "",
      },
    })
  } catch {
    return ""
  }
}

function toGitPath(value: string): string {
  return value.split(sep).join("/")
}

function repoRelativeProjectPath(projectCwd: string, repoRoot: string): string | null {
  const gitPrefix = gitExecTrim(projectCwd, ["rev-parse", "--show-prefix"], true).replace(/\/$/, "")
  if (gitPrefix) {
    return gitPrefix
  }

  const relativePath = toGitPath(relative(repoRoot, projectCwd))
  if (!relativePath || relativePath === ".") return ""
  if (relativePath === ".." || relativePath.startsWith("../")) return null
  return relativePath
}

function pathInsideProject(repoPath: string, projectPath: string | null): boolean {
  if (projectPath === null || projectPath === "") return true
  return repoPath === projectPath || repoPath.startsWith(`${projectPath}/`)
}

function toProjectPath(repoPath: string, projectPath: string | null): string {
  if (projectPath === null || projectPath === "") return repoPath
  if (repoPath === projectPath) return "."
  return repoPath.startsWith(`${projectPath}/`) ? repoPath.slice(projectPath.length + 1) : repoPath
}

function parsePorcelainPath(rawPath: string): string {
  const renameArrow = " -> "
  const arrowIndex = rawPath.lastIndexOf(renameArrow)
  const value = arrowIndex >= 0 ? rawPath.slice(arrowIndex + renameArrow.length) : rawPath
  return value.trim()
}

function parseStatusLine(line: string, projectPath: string | null): GitSummaryFile | null {
  if (line.length < 3) return null

  const status = line.slice(0, 2)
  const repoPath = parsePorcelainPath(line.slice(3))
  if (!repoPath || !pathInsideProject(repoPath, projectPath)) return null

  const untracked = status === "??"
  const conflict = CONFLICT_STATUS_CODES.has(status)
  const staged = !untracked && !conflict && status[0] !== " "
  const dirty = !untracked && !conflict && status[1] !== " "

  return {
    path: toProjectPath(repoPath, projectPath),
    repoPath,
    status,
    staged,
    dirty,
    untracked,
    conflict,
  }
}

function summarizeChangedFiles(changedFiles: GitSummaryFile[]): GitSummaryCounts {
  return changedFiles.reduce<GitSummaryCounts>(
    (counts, file) => ({
      changed: counts.changed + 1,
      staged: counts.staged + Number(file.staged),
      dirty: counts.dirty + Number(file.dirty),
      untracked: counts.untracked + Number(file.untracked),
      conflicts: counts.conflicts + Number(file.conflict),
    }),
    {
      changed: 0,
      staged: 0,
      dirty: 0,
      untracked: 0,
      conflicts: 0,
    },
  )
}

function collectChangedFiles(repoRoot: string, projectPath: string | null): GitSummaryFile[] {
  const porcelain = readGitStatusPorcelain(repoRoot)
  if (!porcelain.trim()) return []

  return porcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => parseStatusLine(line, projectPath))
    .filter((file): file is GitSummaryFile => file !== null)
}

export async function collectCurrentProjectGitSummary(): Promise<GitSummaryResponse> {
  const config = resolveBridgeRuntimeConfig()
  const projectCwd = resolve(config.projectCwd)

  const repoRoot = gitExecTrim(projectCwd, ["rev-parse", "--show-toplevel"], true)
  if (!repoRoot) {
    return {
      kind: "not_repo",
      project: {
        scope: GIT_SUMMARY_SCOPE,
        cwd: projectCwd,
        repoRoot: null,
        repoRelativePath: null,
      },
      message: "Current project is not inside a Git repository.",
    }
  }

  try {
    const resolvedRepoRoot = resolve(repoRoot)
    const projectPath = repoRelativeProjectPath(projectCwd, resolvedRepoRoot)
    const allChangedFiles = collectChangedFiles(resolvedRepoRoot, projectPath)
    const counts = summarizeChangedFiles(allChangedFiles)
    const branch = nativeGetCurrentBranch(resolvedRepoRoot) || null
    const mainBranch = nativeDetectMainBranch(resolvedRepoRoot) || null
    const hasChanges = projectPath === "" ? nativeHasChanges(resolvedRepoRoot) : counts.changed > 0
    const hasConflicts = projectPath === "" ? nativeHasMergeConflicts(resolvedRepoRoot) : counts.conflicts > 0

    return {
      kind: "repo",
      project: {
        scope: GIT_SUMMARY_SCOPE,
        cwd: projectCwd,
        repoRoot: resolvedRepoRoot,
        repoRelativePath: projectPath,
      },
      branch,
      mainBranch,
      hasChanges,
      hasConflicts,
      counts,
      changedFiles: allChangedFiles.slice(0, MAX_CHANGED_FILES),
      truncatedFileCount: Math.max(0, allChangedFiles.length - MAX_CHANGED_FILES),
    }
  } catch (error) {
    throw new Error(`Current-project git summary failed: ${sanitizeGitError(error)}`)
  }
}
