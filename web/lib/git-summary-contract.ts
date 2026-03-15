export const GIT_SUMMARY_SCOPE = "current_project" as const

export interface GitSummaryCounts {
  changed: number
  staged: number
  dirty: number
  untracked: number
  conflicts: number
}

export interface GitSummaryFile {
  path: string
  repoPath: string
  status: string
  staged: boolean
  dirty: boolean
  untracked: boolean
  conflict: boolean
}

export interface GitSummaryProjectScope {
  scope: typeof GIT_SUMMARY_SCOPE
  cwd: string
  repoRoot: string | null
  repoRelativePath: string | null
}

export interface GitSummaryRepoResponse {
  kind: "repo"
  project: GitSummaryProjectScope & {
    repoRoot: string
  }
  branch: string | null
  mainBranch: string | null
  hasChanges: boolean
  hasConflicts: boolean
  counts: GitSummaryCounts
  changedFiles: GitSummaryFile[]
  truncatedFileCount: number
}

export interface GitSummaryNotRepoResponse {
  kind: "not_repo"
  project: GitSummaryProjectScope
  message: string
}

export type GitSummaryResponse = GitSummaryRepoResponse | GitSummaryNotRepoResponse

export function isGitSummaryResponse(value: unknown): value is GitSummaryResponse {
  if (!value || typeof value !== "object") return false

  const response = value as Partial<GitSummaryResponse>
  if (response.kind !== "repo" && response.kind !== "not_repo") return false
  if (!response.project || typeof response.project !== "object") return false
  if (response.project.scope !== GIT_SUMMARY_SCOPE) return false
  if (typeof response.project.cwd !== "string") return false

  if (response.kind === "not_repo") {
    return typeof (response as GitSummaryNotRepoResponse).message === "string"
  }

  const repo = response as Partial<GitSummaryRepoResponse>
  if (typeof repo.project?.repoRoot !== "string") return false
  if (typeof repo.hasChanges !== "boolean" || typeof repo.hasConflicts !== "boolean") return false
  if (!repo.counts || typeof repo.counts !== "object") return false
  if (!Array.isArray(repo.changedFiles)) return false
  if (typeof repo.truncatedFileCount !== "number") return false

  return (
    typeof repo.counts.changed === "number" &&
    typeof repo.counts.staged === "number" &&
    typeof repo.counts.dirty === "number" &&
    typeof repo.counts.untracked === "number" &&
    typeof repo.counts.conflicts === "number"
  )
}
