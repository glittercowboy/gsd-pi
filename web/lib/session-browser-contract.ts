export const SESSION_BROWSER_SCOPE = "current_project" as const

export const SESSION_BROWSER_SORT_MODES = ["threaded", "recent", "relevance"] as const
export type SessionBrowserSortMode = (typeof SESSION_BROWSER_SORT_MODES)[number]

export const SESSION_BROWSER_NAME_FILTERS = ["all", "named"] as const
export type SessionBrowserNameFilter = (typeof SESSION_BROWSER_NAME_FILTERS)[number]

export const SESSION_MANAGE_ACTIONS = ["rename"] as const
export type SessionManageAction = (typeof SESSION_MANAGE_ACTIONS)[number]

export interface SessionBrowserQuery {
  query?: string
  sortMode?: SessionBrowserSortMode
  nameFilter?: SessionBrowserNameFilter
}

export interface ResolvedSessionBrowserQuery {
  query: string
  sortMode: SessionBrowserSortMode
  nameFilter: SessionBrowserNameFilter
}

export interface SessionBrowserProjectScope {
  scope: typeof SESSION_BROWSER_SCOPE
  cwd: string
  sessionsDir: string
  activeSessionPath: string | null
}

export interface SessionBrowserSession {
  id: string
  path: string
  cwd: string
  name?: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  parentSessionPath?: string
  firstMessage: string
  isActive: boolean
  depth: number
  isLastInThread: boolean
  ancestorHasNextSibling: boolean[]
}

export interface SessionBrowserResponse {
  project: SessionBrowserProjectScope
  query: ResolvedSessionBrowserQuery
  totalSessions: number
  returnedSessions: number
  sessions: SessionBrowserSession[]
}

export interface RenameSessionRequest {
  action: "rename"
  sessionPath: string
  name: string
}

export type SessionManageRequest = RenameSessionRequest
export type SessionManageErrorCode = "invalid_request" | "not_found" | "rename_failed" | "onboarding_locked"

export interface SessionManageSuccessResponse {
  success: true
  action: "rename"
  scope: typeof SESSION_BROWSER_SCOPE
  sessionPath: string
  name: string
  isActiveSession: boolean
  mutation: "rpc" | "session_file"
}

export interface SessionManageErrorResponse {
  success: false
  action: "rename"
  scope: typeof SESSION_BROWSER_SCOPE
  sessionPath?: string
  name?: string
  isActiveSession?: boolean
  mutation?: "rpc" | "session_file"
  code: SessionManageErrorCode
  error: string
}

export type SessionManageResponse = SessionManageSuccessResponse | SessionManageErrorResponse

export function isSessionBrowserSortMode(value: string | null | undefined): value is SessionBrowserSortMode {
  return SESSION_BROWSER_SORT_MODES.includes((value ?? "") as SessionBrowserSortMode)
}

export function isSessionBrowserNameFilter(value: string | null | undefined): value is SessionBrowserNameFilter {
  return SESSION_BROWSER_NAME_FILTERS.includes((value ?? "") as SessionBrowserNameFilter)
}

export function isSessionManageAction(value: string | null | undefined): value is SessionManageAction {
  return SESSION_MANAGE_ACTIONS.includes((value ?? "") as SessionManageAction)
}

export function normalizeSessionBrowserQuery(query?: SessionBrowserQuery): ResolvedSessionBrowserQuery {
  return {
    query: query?.query?.trim() ?? "",
    sortMode: query?.sortMode ?? "threaded",
    nameFilter: query?.nameFilter ?? "all",
  }
}
