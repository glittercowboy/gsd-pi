"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  dispatchBrowserSlashCommand,
  getBrowserSlashCommandTerminalNotice,
  GSD_HELP_TEXT,
  type BrowserSlashCommandDispatchResult,
  type BrowserSlashCommandSurface,
} from "./browser-slash-command-dispatch"
import {
  applyCommandSurfaceActionResult,
  closeCommandSurfaceState,
  createInitialCommandSurfaceState,
  openCommandSurfaceState,
  selectCommandSurfaceStateTarget,
  setCommandSurfacePending,
  setCommandSurfaceSection,
  type CommandSurfaceCompactionResult,
  type CommandSurfaceDiagnosticsPhaseState,
  type CommandSurfaceDoctorState,
  type CommandSurfaceForkMessage,
  type CommandSurfaceGitSummaryState,
  type CommandSurfaceModelOption,
  type CommandSurfaceRecoveryState,
  type CommandSurfaceSection,
  type CommandSurfaceSessionBrowserState,
  type CommandSurfaceSessionStats,
  type CommandSurfaceTarget,
  type CommandSurfaceThinkingLevel,
  type CommandSurfaceKnowledgeCapturesState,
  type WorkspaceCommandSurfaceState,
  type WorkspaceRecoveryDiagnostics,
  type WorkspaceRecoverySummary,
} from "./command-surface-contract"
import type { DoctorFixResult, DoctorReport, ForensicReport, SkillHealthReport } from "./diagnostics-types"
import type { KnowledgeData, CapturesData, CaptureResolveRequest, CaptureResolveResult } from "./knowledge-captures-types"
import type { SettingsData } from "./settings-types"
import type {
  HistoryData,
  InspectData,
  HooksData,
  ExportResult,
  UndoInfo,
  UndoResult,
  CleanupData,
  CleanupResult,
  SteerData,
} from "./remaining-command-types"
import { isGitSummaryResponse, type GitSummaryResponse } from "./git-summary-contract"
import type { PendingImage } from "./image-utils"
import type { ChatMessage } from "./pty-chat-parser"
import type {
  SessionBrowserNameFilter,
  SessionBrowserResponse,
  SessionBrowserSession,
  SessionBrowserSortMode,
  SessionManageResponse,
} from "./session-browser-contract"
import { authFetch, appendAuthParam } from "./auth"

export type WorkspaceStatus = "idle" | "loading" | "ready" | "error" | "unauthenticated"
export type WorkspaceConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error"
export type TerminalLineType = "input" | "output" | "system" | "success" | "error"
export type BridgePhase = "idle" | "starting" | "ready" | "failed"
export type WorkspaceStatusTone = "muted" | "info" | "success" | "warning" | "danger"

export interface WorkspaceModelRef {
  id?: string
  provider?: string
  providerId?: string
}

export interface BridgeLastError {
  message: string
  at: string
  phase: BridgePhase
  afterSessionAttachment: boolean
  commandType?: string
}

export interface WorkspaceSessionState {
  model?: WorkspaceModelRef
  thinkingLevel: string
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: "all" | "one-at-a-time"
  followUpMode: "all" | "one-at-a-time"
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled: boolean
  autoRetryEnabled: boolean
  retryInProgress: boolean
  retryAttempt: number
  messageCount: number
  pendingMessageCount: number
}

export interface BridgeRuntimeSnapshot {
  phase: BridgePhase
  projectCwd: string
  projectSessionsDir: string
  packageRoot: string
  startedAt: string | null
  updatedAt: string
  connectionCount: number
  lastCommandType: string | null
  activeSessionId: string | null
  activeSessionFile: string | null
  sessionState: WorkspaceSessionState | null
  lastError: BridgeLastError | null
}

export type { WorkspaceTaskTarget, RiskLevel, WorkspaceSliceTarget, WorkspaceMilestoneTarget } from "./workspace-types.js"

export interface WorkspaceScopeTarget {
  scope: string
  label: string
  kind: "project" | "milestone" | "slice" | "task"
}

export interface WorkspaceValidationIssue {
  message?: string
  [key: string]: unknown
}

export interface WorkspaceIndex {
  milestones: WorkspaceMilestoneTarget[]
  active: {
    milestoneId?: string
    sliceId?: string
    taskId?: string
    phase: string
  }
  scopes: WorkspaceScopeTarget[]
  validationIssues: WorkspaceValidationIssue[]
}

export interface RtkSessionSavings {
  commands: number
  inputTokens: number
  outputTokens: number
  savedTokens: number
  savingsPct: number
  totalTimeMs: number
  avgTimeMs: number
  updatedAt: string
}

export interface AutoDashboardData {
  active: boolean
  paused: boolean
  stepMode: boolean
  startTime: number
  elapsed: number
  currentUnit: { type: string; id: string; startedAt: number } | null
  completedUnits: { type: string; id: string; startedAt: number; finishedAt: number }[]
  basePath: string
  totalCost: number
  totalTokens: number
  rtkSavings?: RtkSessionSavings | null
  /** Whether RTK is enabled via experimental.rtk preference. False when not opted in. */
  rtkEnabled?: boolean
}

export interface BootResumableSession {
  id: string
  path: string
  cwd: string
  name?: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  isActive: boolean
}

export interface WorkspaceOnboardingProviderState {
  id: string
  label: string
  required: true
  recommended: boolean
  configured: boolean
  configuredVia: "auth_file" | "environment" | "runtime" | null
  supports: {
    apiKey: boolean
    oauth: boolean
    oauthAvailable: boolean
    usesCallbackServer: boolean
  }
}

export interface WorkspaceOnboardingOptionalSectionState {
  id: string
  label: string
  blocking: false
  skippable: true
  configured: boolean
  configuredItems: string[]
}

export interface WorkspaceOnboardingValidationResult {
  status: "succeeded" | "failed"
  providerId: string
  method: "api_key" | "oauth"
  checkedAt: string
  message: string
  persisted: boolean
}

export interface WorkspaceOnboardingFlowState {
  flowId: string
  providerId: string
  providerLabel: string
  status: "idle" | "running" | "awaiting_browser_auth" | "awaiting_input" | "succeeded" | "failed" | "cancelled"
  updatedAt: string
  auth: {
    url: string
    instructions?: string
  } | null
  prompt: {
    kind: "text" | "manual_code"
    message: string
    placeholder?: string
    allowEmpty?: boolean
  } | null
  progress: string[]
  error: string | null
}

export interface WorkspaceOnboardingBridgeAuthRefreshState {
  phase: "idle" | "pending" | "succeeded" | "failed"
  strategy: "restart" | null
  startedAt: string | null
  completedAt: string | null
  error: string | null
}

export interface WorkspaceOnboardingState {
  status: "blocked" | "ready"
  locked: boolean
  lockReason: "required_setup" | "bridge_refresh_pending" | "bridge_refresh_failed" | null
  required: {
    blocking: true
    skippable: false
    satisfied: boolean
    satisfiedBy: { providerId: string; source: "auth_file" | "environment" | "runtime" } | null
    providers: WorkspaceOnboardingProviderState[]
  }
  optional: {
    blocking: false
    skippable: true
    sections: WorkspaceOnboardingOptionalSectionState[]
  }
  lastValidation: WorkspaceOnboardingValidationResult | null
  activeFlow: WorkspaceOnboardingFlowState | null
  bridgeAuthRefresh: WorkspaceOnboardingBridgeAuthRefreshState
}

// ─── Project Detection ──────────────────────────────────────────────────────

export type ProjectDetectionKind =
  | "active-gsd"
  | "empty-gsd"
  | "v1-legacy"
  | "brownfield"
  | "blank"

export interface ProjectDetectionSignals {
  hasGsdFolder: boolean
  hasPlanningFolder: boolean
  hasGitRepo: boolean
  hasPackageJson: boolean
  isMonorepo?: boolean
  fileCount: number
}

export interface ProjectDetection {
  kind: ProjectDetectionKind
  signals: ProjectDetectionSignals
}

// ─── Boot Payload ───────────────────────────────────────────────────────────

export interface WorkspaceBootPayload {
  project: {
    cwd: string
    sessionsDir: string
    packageRoot: string
  }
  workspace: WorkspaceIndex
  auto: AutoDashboardData
  onboarding: WorkspaceOnboardingState
  onboardingNeeded: boolean
  resumableSessions: BootResumableSession[]
  bridge: BridgeRuntimeSnapshot
  projectDetection?: ProjectDetection
}

export interface BridgeStatusEvent {
  type: "bridge_status"
  bridge: BridgeRuntimeSnapshot
}

export type LiveStateInvalidationDomain = "auto" | "workspace" | "recovery" | "resumable_sessions"
export type LiveStateInvalidationSource = "bridge_event" | "rpc_command" | "session_manage"
export type LiveStateInvalidationReason =
  | "agent_end"
  | "turn_end"
  | "auto_retry_start"
  | "auto_retry_end"
  | "auto_compaction_start"
  | "auto_compaction_end"
  | "new_session"
  | "switch_session"
  | "fork"
  | "set_session_name"

export interface LiveStateInvalidationEvent {
  type: "live_state_invalidation"
  at: string
  reason: LiveStateInvalidationReason
  source: LiveStateInvalidationSource
  domains: LiveStateInvalidationDomain[]
  workspaceIndexCacheInvalidated: boolean
}

export type WorkspaceFreshnessStatus = "idle" | "fresh" | "refreshing" | "stale" | "error"

export interface WorkspaceFreshnessBucket {
  status: WorkspaceFreshnessStatus
  stale: boolean
  reloadCount: number
  lastRequestedAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastFailure: string | null
  invalidatedAt: string | null
  invalidationReason: LiveStateInvalidationReason | null
  invalidationSource: LiveStateInvalidationSource | null
}

export interface WorkspaceLiveFreshnessState {
  auto: WorkspaceFreshnessBucket
  workspace: WorkspaceFreshnessBucket
  recovery: WorkspaceFreshnessBucket
  resumableSessions: WorkspaceFreshnessBucket
  gitSummary: WorkspaceFreshnessBucket
  sessionBrowser: WorkspaceFreshnessBucket
  sessionStats: WorkspaceFreshnessBucket
}

export interface WorkspaceLiveState {
  auto: AutoDashboardData | null
  workspace: WorkspaceIndex | null
  resumableSessions: BootResumableSession[]
  recoverySummary: WorkspaceRecoverySummary
  freshness: WorkspaceLiveFreshnessState
  softBootRefreshCount: number
  targetedRefreshCount: number
}

// Discriminated union for extension UI requests — matches the authoritative
// RpcExtensionUIRequest from rpc-types.ts. Blocking methods queue in pendingUiRequests;
// fire-and-forget methods update state maps directly.
export type ExtensionUiRequestEvent =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number; allowMultiple?: boolean }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }

export interface ExtensionErrorEvent {
  type: "extension_error"
  extensionPath?: string
  event?: string
  error: string
}

export interface MessageUpdateEvent {
  type: "message_update"
  assistantMessageEvent?: {
    type: string
    delta?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start"
  toolCallId: string
  toolName: string
  [key: string]: unknown
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end"
  toolCallId: string
  toolName: string
  isError?: boolean
  [key: string]: unknown
}

export interface AgentEndEvent {
  type: "agent_end"
  [key: string]: unknown
}

export interface TurnEndEvent {
  type: "turn_end"
  [key: string]: unknown
}

export type WorkspaceEvent =
  | BridgeStatusEvent
  | LiveStateInvalidationEvent
  | ExtensionUiRequestEvent
  | ExtensionErrorEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | AgentEndEvent
  | TurnEndEvent
  | ({ type: Exclude<string, "bridge_status" | "live_state_invalidation" | "extension_ui_request" | "extension_error" | "message_update" | "tool_execution_start" | "tool_execution_end" | "agent_end" | "turn_end">; [key: string]: unknown } & Record<string, unknown>)

export function isWorkspaceEvent(value: unknown): value is WorkspaceEvent {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string"
}

export interface WorkspaceCommandResponse {
  type: "response"
  command: string
  success: boolean
  error?: string
  data?: unknown
  id?: string
  code?: string
  details?: {
    reason?: "required_setup" | "bridge_refresh_pending" | "bridge_refresh_failed"
    onboarding?: Partial<WorkspaceOnboardingState>
  }
}

export interface WorkspaceBridgeCommand {
  type: string
  [key: string]: unknown
}

export interface WorkspaceTerminalLine {
  id: string
  type: TerminalLineType
  content: string
  timestamp: string
}

export type WorkspaceOnboardingRequestState =
  | "idle"
  | "refreshing"
  | "saving_api_key"
  | "starting_provider_flow"
  | "submitting_provider_flow_input"
  | "cancelling_provider_flow"
  | "logging_out_provider"

// A blocking UI request that needs user response before the agent can continue.
// The `method` field discriminates the payload shape.
export type PendingUiRequest = Extract<
  ExtensionUiRequestEvent,
  { method: "select" | "confirm" | "input" | "editor" }
>

export interface ActiveToolExecution {
  id: string
  name: string
  args?: Record<string, unknown>
}

/** Completed tool execution with result — kept for chat rendering */
export interface CompletedToolExecution {
  id: string
  name: string
  args: Record<string, unknown>
  result?: {
    content?: Array<{ type: string; text?: string }>
    details?: Record<string, unknown>
    isError?: boolean
  }
}

/**
 * A chronologically-ordered segment within a single assistant turn.
 * The sequence `thinking → text → tool → thinking → text → tool …`
 * is captured as separate segments so the chat UI can render them
 * in the correct interleaved order.
 */
export type TurnSegment =
  | { kind: "thinking"; content: string }
  | { kind: "text"; content: string }
  | { kind: "tool"; tool: CompletedToolExecution }

export interface WidgetContent {
  lines: string[] | undefined
  placement?: "aboveEditor" | "belowEditor"
}

export interface WorkspaceStoreState {
  bootStatus: WorkspaceStatus
  connectionState: WorkspaceConnectionState
  boot: WorkspaceBootPayload | null
  live: WorkspaceLiveState
  terminalLines: WorkspaceTerminalLine[]
  lastClientError: string | null
  lastBridgeError: BridgeLastError | null
  sessionAttached: boolean
  lastEventType: string | null
  commandInFlight: string | null
  lastSlashCommandOutcome: BrowserSlashCommandDispatchResult | null
  commandSurface: WorkspaceCommandSurfaceState
  onboardingRequestState: WorkspaceOnboardingRequestState
  onboardingRequestProviderId: string | null
  // Live interaction state
  pendingUiRequests: PendingUiRequest[]
  streamingAssistantText: string
  streamingThinkingText: string
  liveTranscript: string[]
  /** Thinking text for each liveTranscript block (parallel array — same length) */
  liveThinkingTranscript: string[]
  completedToolExecutions: CompletedToolExecution[]
  activeToolExecution: ActiveToolExecution | null
  /**
   * Ordered segments within the current streaming turn.
   * Captures the chronological sequence: thinking → text → tool → thinking → text → ...
   * Flushed to `completedTurnSegments` on turn boundary.
   */
  currentTurnSegments: TurnSegment[]
  /**
   * Segment history for completed turns. Each entry is a full turn's segments.
   * Parallel to `liveTranscript` (same index = same turn).
   */
  completedTurnSegments: TurnSegment[][]
  /** User messages in chat — persisted in store so they survive component unmount/remount */
  chatUserMessages: ChatMessage[]
  statusTexts: Record<string, string>
  widgetContents: Record<string, WidgetContent>
  titleOverride: string | null
  editorTextBuffer: string | null
}

const MAX_TERMINAL_LINES = 250
export const MAX_TRANSCRIPT_BLOCKS = 100
export const COMMAND_TIMEOUT_MS = 90_000
export const VISIBILITY_REFRESH_THRESHOLD_MS = 30_000
const IMPLEMENTED_BROWSER_COMMAND_SURFACES = new Set<BrowserSlashCommandSurface>([
  "settings",
  "model",
  "thinking",
  "git",
  "resume",
  "name",
  "fork",
  "compact",
  "login",
  "logout",
  "session",
  "export",
  // GSD subcommand surfaces (S02)
  "gsd-status",
  "gsd-visualize",
  "gsd-forensics",
  "gsd-doctor",
  "gsd-skill-health",
  "gsd-knowledge",
  "gsd-capture",
  "gsd-triage",
  "gsd-quick",
  "gsd-history",
  "gsd-undo",
  "gsd-inspect",
  "gsd-prefs",
  "gsd-config",
  "gsd-hooks",
  "gsd-mode",
  "gsd-steer",
  "gsd-export",
  "gsd-cleanup",
  "gsd-queue",
])

function timestampLabel(date = new Date()): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function createTerminalLine(type: TerminalLineType, content: string): WorkspaceTerminalLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    content,
    timestamp: timestampLabel(),
  }
}

function withTerminalLine(lines: WorkspaceTerminalLine[], line: WorkspaceTerminalLine): WorkspaceTerminalLine[] {
  return [...lines, line].slice(-MAX_TERMINAL_LINES)
}

function hasAttachedSession(bridge: BridgeRuntimeSnapshot | null | undefined): boolean {
  return Boolean(bridge?.activeSessionId || bridge?.sessionState?.sessionId)
}

function normalizeClientError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function getCommandInputLabel(command: WorkspaceBridgeCommand): string {
  return typeof command.message === "string" ? command.message : `/${command.type}`
}

function summarizeBridgeStatus(bridge: BridgeRuntimeSnapshot): { type: TerminalLineType; message: string } {
  if (bridge.phase === "failed") {
    return {
      type: "error",
      message: `Bridge failed${bridge.lastError?.message ? ` — ${bridge.lastError.message}` : ""}`,
    }
  }

  if (bridge.phase === "starting") {
    return {
      type: "system",
      message: "Bridge starting for the current project…",
    }
  }

  if (bridge.phase === "ready") {
    const sessionLabel = getSessionLabelFromBridge(bridge)
    return {
      type: "success",
      message: sessionLabel
        ? `Live bridge ready — attached to ${sessionLabel}`
        : "Live bridge ready — session attachment pending",
    }
  }

  return {
    type: "system",
    message: "Bridge idle",
  }
}

function summarizeEvent(event: WorkspaceEvent): { type: TerminalLineType; message: string } | null {
  switch (event.type) {
    case "bridge_status":
      return summarizeBridgeStatus((event as BridgeStatusEvent).bridge)
    case "live_state_invalidation":
      return {
        type: "system",
        message: `[Live] Refreshing ${Array.isArray(event.domains) ? event.domains.join(", ") : "state"} after ${String(event.reason).replaceAll("_", " ")}`,
      }
    case "agent_start":
      return { type: "system", message: "[Agent] Run started" }
    case "agent_end":
      return { type: "success", message: "[Agent] Run finished" }
    case "turn_start":
      return { type: "system", message: "[Agent] Turn started" }
    case "turn_end":
      return { type: "success", message: "[Agent] Turn complete" }
    case "tool_execution_start":
      return {
        type: "output",
        message: `[Tool] ${typeof event.toolName === "string" ? event.toolName : "tool"} started`,
      }
    case "tool_execution_end":
      return {
        type: event.isError ? "error" : "success",
        message: `[Tool] ${typeof event.toolName === "string" ? event.toolName : "tool"} ${event.isError ? "failed" : "completed"}`,
      }
    case "auto_compaction_start":
      return { type: "system", message: "[Auto] Compaction started" }
    case "auto_compaction_end":
      return {
        type: event.aborted ? "error" : "success",
        message: event.aborted ? "[Auto] Compaction aborted" : "[Auto] Compaction finished",
      }
    case "auto_retry_start":
      return {
        type: "system",
        message: `[Auto] Retry ${String(event.attempt)}/${String(event.maxAttempts)} scheduled`,
      }
    case "auto_retry_end":
      return {
        type: event.success ? "success" : "error",
        message: event.success ? "[Auto] Retry recovered the run" : "[Auto] Retry exhausted",
      }
    case "extension_ui_request": {
      const uiEvent = event as ExtensionUiRequestEvent
      const detail =
        "title" in uiEvent && typeof uiEvent.title === "string" && uiEvent.title.trim().length > 0
          ? uiEvent.title
          : "message" in uiEvent && typeof uiEvent.message === "string" && uiEvent.message.trim().length > 0
            ? uiEvent.message
            : uiEvent.method
      return {
        type: ("notifyType" in uiEvent && uiEvent.notifyType === "error") ? "error" : "system",
        message: `[UI] ${detail}`,
      }
    }
    case "extension_error":
      return { type: "error", message: `[Extension] ${event.error}` }
    default:
      return null
  }
}

type OnboardingApiPayload = {
  onboarding?: WorkspaceOnboardingState
  error?: string
}

const ACTIVE_ONBOARDING_FLOW_STATUSES = new Set<WorkspaceOnboardingFlowState["status"]>([
  "running",
  "awaiting_browser_auth",
  "awaiting_input",
])

const TERMINAL_ONBOARDING_FLOW_STATUSES = new Set<WorkspaceOnboardingFlowState["status"]>([
  "succeeded",
  "failed",
  "cancelled",
])

function findOnboardingProviderLabel(onboarding: WorkspaceOnboardingState, providerId: string): string {
  return onboarding.required.providers.find((provider) => provider.id === providerId)?.label ?? providerId
}

function mergeOnboardingState(
  current: WorkspaceOnboardingState,
  patch: Partial<WorkspaceOnboardingState>,
): WorkspaceOnboardingState {
  return {
    ...current,
    ...patch,
    required: {
      ...current.required,
      ...(patch.required ?? {}),
      providers: patch.required?.providers ?? current.required.providers,
    },
    optional: {
      ...current.optional,
      ...(patch.optional ?? {}),
      sections: patch.optional?.sections ?? current.optional.sections,
    },
    bridgeAuthRefresh: {
      ...current.bridgeAuthRefresh,
      ...(patch.bridgeAuthRefresh ?? {}),
    },
  }
}

function cloneBootWithBridge(
  boot: WorkspaceBootPayload | null,
  bridge: BridgeRuntimeSnapshot,
): WorkspaceBootPayload | null {
  if (!boot) return null
  const nextBoot = {
    ...boot,
    bridge,
  }

  return {
    ...nextBoot,
    resumableSessions: overlayLiveBridgeSessionState(nextBoot.resumableSessions, nextBoot),
  }
}

function patchBootSessionState(
  boot: WorkspaceBootPayload | null,
  patch: Partial<WorkspaceSessionState>,
): WorkspaceBootPayload | null {
  if (!boot?.bridge.sessionState) return boot

  return cloneBootWithBridge(boot, {
    ...boot.bridge,
    sessionState: {
      ...boot.bridge.sessionState,
      ...patch,
    },
  })
}

function patchBootSessionName(
  boot: WorkspaceBootPayload | null,
  sessionPath: string,
  name: string,
): WorkspaceBootPayload | null {
  if (!boot) return null

  const isActiveSession = getLiveActiveSessionPath(boot) === sessionPath
  const nextBridge =
    isActiveSession && boot.bridge.sessionState
      ? {
          ...boot.bridge,
          sessionState: {
            ...boot.bridge.sessionState,
            sessionName: name,
          },
        }
      : boot.bridge

  const nextBoot = {
    ...boot,
    bridge: nextBridge,
  }

  return {
    ...nextBoot,
    resumableSessions: overlayLiveBridgeSessionState(
      nextBoot.resumableSessions.map((session) =>
        session.path === sessionPath
          ? {
              ...session,
              name,
            }
          : session,
      ),
      nextBoot,
    ),
  }
}

function patchBootActiveSession(
  boot: WorkspaceBootPayload | null,
  sessionPath: string,
  sessionName?: string,
): WorkspaceBootPayload | null {
  if (!boot) return null

  const selectedSession = boot.resumableSessions.find((session) => session.path === sessionPath)
  const nextBridge = {
    ...boot.bridge,
    activeSessionFile: sessionPath,
    activeSessionId: selectedSession?.id ?? boot.bridge.activeSessionId,
    sessionState: boot.bridge.sessionState
      ? {
          ...boot.bridge.sessionState,
          sessionFile: sessionPath,
          sessionId: selectedSession?.id ?? boot.bridge.sessionState.sessionId,
          sessionName: sessionName ?? selectedSession?.name ?? boot.bridge.sessionState.sessionName,
        }
      : boot.bridge.sessionState,
  }

  const nextBoot = {
    ...boot,
    bridge: nextBridge,
  }

  return {
    ...nextBoot,
    resumableSessions: overlayLiveBridgeSessionState(
      nextBoot.resumableSessions.map((session) => ({
        ...session,
        isActive: session.path === sessionPath,
      })),
      nextBoot,
    ),
  }
}

function cloneBootWithOnboarding(
  boot: WorkspaceBootPayload | null,
  onboarding: WorkspaceOnboardingState,
): WorkspaceBootPayload | null {
  if (!boot) return null
  return {
    ...boot,
    onboarding,
    onboardingNeeded: onboarding.locked,
  }
}

function cloneBootWithPartialOnboarding(
  boot: WorkspaceBootPayload | null,
  onboarding: Partial<WorkspaceOnboardingState>,
): WorkspaceBootPayload | null {
  if (!boot) return null
  return cloneBootWithOnboarding(boot, mergeOnboardingState(boot.onboarding, onboarding))
}

function summarizeOnboardingState(onboarding: WorkspaceOnboardingState): { type: TerminalLineType; message: string } | null {
  if (onboarding.bridgeAuthRefresh.phase === "failed") {
    return {
      type: "error",
      message: onboarding.bridgeAuthRefresh.error
        ? `Bridge auth refresh failed — ${onboarding.bridgeAuthRefresh.error}`
        : "Bridge auth refresh failed after setup",
    }
  }

  if (onboarding.bridgeAuthRefresh.phase === "pending") {
    return {
      type: "system",
      message: "Credentials saved — refreshing bridge auth before the workspace unlocks…",
    }
  }

  if (onboarding.lastValidation?.status === "failed") {
    return {
      type: "error",
      message: `Credential validation failed — ${onboarding.lastValidation.message}`,
    }
  }

  if (!onboarding.locked && onboarding.lastValidation?.status === "succeeded") {
    return {
      type: "success",
      message: `${findOnboardingProviderLabel(onboarding, onboarding.lastValidation.providerId)} is ready — workspace unlocked`,
    }
  }

  if (onboarding.activeFlow?.status === "awaiting_browser_auth") {
    return {
      type: "system",
      message: `${onboarding.activeFlow.providerLabel} sign-in is waiting for browser confirmation`,
    }
  }

  if (onboarding.activeFlow?.status === "awaiting_input") {
    return {
      type: "system",
      message: `${onboarding.activeFlow.providerLabel} sign-in needs one more input step`,
    }
  }

  if (onboarding.activeFlow?.status === "cancelled") {
    return {
      type: "system",
      message: `${onboarding.activeFlow.providerLabel} sign-in was cancelled`,
    }
  }

  if (onboarding.activeFlow?.status === "failed") {
    return {
      type: "error",
      message: onboarding.activeFlow.error
        ? `${onboarding.activeFlow.providerLabel} sign-in failed — ${onboarding.activeFlow.error}`
        : `${onboarding.activeFlow.providerLabel} sign-in failed`,
    }
  }

  if (onboarding.lockReason === "required_setup") {
    return {
      type: "system",
      message: "Onboarding is still required before model-backed prompts will run",
    }
  }

  return null
}

function bootSeedLines(boot: WorkspaceBootPayload): WorkspaceTerminalLine[] {
  const lines = [
    createTerminalLine("system", `GSD web workspace attached to ${boot.project.cwd}`),
    createTerminalLine("system", `Workspace scope: ${getCurrentScopeLabel(boot.workspace)}`),
  ]

  const bridgeSummary = summarizeBridgeStatus(boot.bridge)
  lines.push(createTerminalLine(bridgeSummary.type, bridgeSummary.message))

  if (boot.bridge.lastError) {
    lines.push(createTerminalLine("error", `Bridge error: ${boot.bridge.lastError.message}`))
  }

  const onboardingSummary = summarizeOnboardingState(boot.onboarding)
  if (onboardingSummary) {
    lines.push(createTerminalLine(onboardingSummary.type, onboardingSummary.message))
  }

  return lines
}

function responseToLine(response: WorkspaceCommandResponse): WorkspaceTerminalLine {
  if (!response.success) {
    return createTerminalLine("error", `Command failed (${response.command}) — ${response.error ?? "unknown error"}`)
  }

  switch (response.command) {
    case "get_state":
      return createTerminalLine("success", "Session state refreshed")
    case "new_session":
      return createTerminalLine("success", "Started a new session")
    case "prompt":
      return createTerminalLine("success", "Prompt accepted by the live bridge")
    case "follow_up":
      return createTerminalLine("success", "Follow-up queued on the live bridge")
    default:
      return createTerminalLine("success", `Command accepted (${response.command})`)
  }
}

export function shortenPath(path: string | undefined, segmentCount = 3): string {
  if (!path) return "—"
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segmentCount) {
    return path.startsWith("/") ? `/${parts.join("/")}` : parts.join("/")
  }
  const tail = parts.slice(-segmentCount).join("/")
  return `…/${tail}`
}

export function getProjectDisplayName(path: string | undefined): string {
  if (!path) return "Current project"
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || path
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return "0m"
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(Math.round(tokens))
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00"
  return `$${cost.toFixed(2)}`
}

export function getCurrentScopeLabel(workspace: WorkspaceIndex | null | undefined): string {
  if (!workspace) return "Project scope pending"
  const scope = [workspace.active.milestoneId, workspace.active.sliceId, workspace.active.taskId]
    .filter(Boolean)
    .join("/")
  return scope ? `${scope} — ${workspace.active.phase}` : `project — ${workspace.active.phase}`
}

export function getCurrentBranch(workspace: WorkspaceIndex | null | undefined): string | null {
  if (!workspace?.active.milestoneId || !workspace.active.sliceId) {
    return null
  }

  const milestone = workspace.milestones.find((entry) => entry.id === workspace.active.milestoneId)
  const slice = milestone?.slices.find((entry) => entry.id === workspace.active.sliceId)
  return slice?.branch ?? null
}

export function getCurrentSlice(workspace: WorkspaceIndex | null | undefined): WorkspaceSliceTarget | null {
  if (!workspace?.active.milestoneId || !workspace.active.sliceId) return null
  const milestone = workspace.milestones.find((entry) => entry.id === workspace.active.milestoneId)
  return milestone?.slices.find((entry) => entry.id === workspace.active.sliceId) ?? null
}

export function getSessionLabelFromBridge(bridge: BridgeRuntimeSnapshot | null | undefined): string | null {
  if (!bridge?.sessionState && !bridge?.activeSessionId) return null
  const sessionName = bridge.sessionState?.sessionName?.trim()
  if (sessionName) return sessionName
  if (bridge.activeSessionId) return `session ${bridge.activeSessionId}`
  return bridge.sessionState?.sessionId ?? null
}

export function getModelLabel(bridge: BridgeRuntimeSnapshot | null | undefined): string {
  const model = bridge?.sessionState?.model
  if (!model) return "model pending"
  return model.id || model.providerId || model.provider || "model pending"
}

function getCurrentModelSelection(
  bridge: BridgeRuntimeSnapshot | null | undefined,
): { provider?: string; modelId?: string } | null {
  const model = bridge?.sessionState?.model
  if (!model) return null
  return {
    provider: model.provider ?? model.providerId,
    modelId: model.id,
  }
}

function getPreferredOnboardingProviderId(onboarding: WorkspaceOnboardingState | null | undefined): string | null {
  if (!onboarding) return null
  if (onboarding.required.satisfiedBy?.providerId) {
    return onboarding.required.satisfiedBy.providerId
  }

  const recommended = onboarding.required.providers.find((provider) => !provider.configured && provider.recommended)
  if (recommended) return recommended.id

  const firstUnconfigured = onboarding.required.providers.find((provider) => !provider.configured)
  if (firstUnconfigured) return firstUnconfigured.id

  return onboarding.required.providers[0]?.id ?? null
}

function normalizeAvailableModels(
  payload: unknown,
  currentModel: { provider?: string; modelId?: string } | null,
): CommandSurfaceModelOption[] {
  const models =
    payload &&
    typeof payload === "object" &&
    "models" in payload &&
    Array.isArray((payload as { models?: unknown[] }).models)
      ? (payload as { models: Array<Record<string, unknown>> }).models
      : []

  const results: CommandSurfaceModelOption[] = []
  for (const model of models) {
    const provider =
      typeof model.provider === "string"
        ? model.provider
        : typeof model.providerId === "string"
          ? model.providerId
          : undefined
    const modelId = typeof model.id === "string" ? model.id : undefined
    if (!provider || !modelId) continue
    results.push({
      provider,
      modelId,
      name: typeof model.name === "string" ? model.name : undefined,
      reasoning: Boolean(model.reasoning),
      isCurrent: provider === currentModel?.provider && modelId === currentModel?.modelId,
    })
  }
  return results
    .sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent) || left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId))
}

function normalizeSessionStats(payload: unknown): CommandSurfaceSessionStats | null {
  if (!payload || typeof payload !== "object") return null
  const stats = payload as Partial<CommandSurfaceSessionStats>
  if (typeof stats.sessionId !== "string") return null

  return {
    sessionFile: typeof stats.sessionFile === "string" ? stats.sessionFile : undefined,
    sessionId: stats.sessionId,
    userMessages: Number(stats.userMessages ?? 0),
    assistantMessages: Number(stats.assistantMessages ?? 0),
    toolCalls: Number(stats.toolCalls ?? 0),
    toolResults: Number(stats.toolResults ?? 0),
    totalMessages: Number(stats.totalMessages ?? 0),
    tokens: {
      input: Number(stats.tokens?.input ?? 0),
      output: Number(stats.tokens?.output ?? 0),
      cacheRead: Number(stats.tokens?.cacheRead ?? 0),
      cacheWrite: Number(stats.tokens?.cacheWrite ?? 0),
      total: Number(stats.tokens?.total ?? 0),
    },
    cost: Number(stats.cost ?? 0),
  }
}

function normalizeForkMessages(payload: unknown): CommandSurfaceForkMessage[] {
  const messages =
    payload &&
    typeof payload === "object" &&
    "messages" in payload &&
    Array.isArray((payload as { messages?: unknown[] }).messages)
      ? (payload as { messages: Array<Record<string, unknown>> }).messages
      : []

  return messages
    .map((message) => {
      const entryId = typeof message.entryId === "string" ? message.entryId : undefined
      const text = typeof message.text === "string" ? message.text : undefined
      if (!entryId || !text) return null
      return { entryId, text } satisfies CommandSurfaceForkMessage
    })
    .filter((message): message is CommandSurfaceForkMessage => message !== null)
}

function normalizeCompactionResult(payload: unknown): CommandSurfaceCompactionResult | null {
  if (!payload || typeof payload !== "object") return null
  const result = payload as Partial<CommandSurfaceCompactionResult>
  if (typeof result.summary !== "string" || typeof result.firstKeptEntryId !== "string") return null

  return {
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: Number(result.tokensBefore ?? 0),
    details: result.details,
  }
}

function normalizeGitSummaryPayload(payload: unknown): GitSummaryResponse | null {
  return isGitSummaryResponse(payload) ? payload : null
}

function normalizeGitSummaryError(
  current: CommandSurfaceGitSummaryState,
  message: string,
): CommandSurfaceGitSummaryState {
  return {
    ...current,
    pending: false,
    loaded: false,
    error: message,
  }
}

function normalizeRecoveryDiagnosticsPayload(payload: unknown): WorkspaceRecoveryDiagnostics | null {
  if (!payload || typeof payload !== "object") return null

  const candidate = payload as Partial<WorkspaceRecoveryDiagnostics>
  if (candidate.status !== "ready" && candidate.status !== "unavailable") return null
  if (typeof candidate.loadedAt !== "string") return null
  if (!candidate.project || typeof candidate.project.cwd !== "string") return null
  if (!candidate.summary || typeof candidate.summary.label !== "string" || typeof candidate.summary.detail !== "string") return null
  if (!candidate.bridge || typeof candidate.bridge.phase !== "string") return null
  if (!candidate.validation || typeof candidate.validation.total !== "number") return null
  if (!candidate.doctor || typeof candidate.doctor.total !== "number") return null
  if (!candidate.interruptedRun || typeof candidate.interruptedRun.available !== "boolean") return null
  if (!candidate.actions || !Array.isArray(candidate.actions.browser) || !Array.isArray(candidate.actions.commands)) return null

  return candidate as WorkspaceRecoveryDiagnostics
}

function createRecoveryStateFromDiagnostics(diagnostics: WorkspaceRecoveryDiagnostics): CommandSurfaceRecoveryState {
  return {
    phase: diagnostics.status === "ready" ? "ready" : "unavailable",
    pending: false,
    loaded: true,
    stale: false,
    diagnostics,
    error: null,
    lastLoadedAt: diagnostics.loadedAt,
    lastInvalidatedAt: null,
    lastFailureAt: null,
  }
}

function markRecoveryStatePending(current: CommandSurfaceRecoveryState): CommandSurfaceRecoveryState {
  return {
    ...current,
    pending: true,
    error: null,
    phase: current.loaded ? current.phase : "loading",
  }
}

function markRecoveryStateInvalidated(current: CommandSurfaceRecoveryState): CommandSurfaceRecoveryState {
  if (!current.loaded && !current.error) return current
  return {
    ...current,
    stale: true,
    lastInvalidatedAt: new Date().toISOString(),
  }
}

function markRecoveryStateFailure(current: CommandSurfaceRecoveryState, message: string): CommandSurfaceRecoveryState {
  return {
    ...current,
    phase: "error",
    pending: false,
    stale: true,
    error: message,
    lastFailureAt: new Date().toISOString(),
  }
}

function normalizeSessionBrowserPayload(payload: unknown): CommandSurfaceSessionBrowserState | null {
  if (!payload || typeof payload !== "object") return null

  const response = payload as Partial<SessionBrowserResponse>
  const project = response.project
  const query = response.query
  if (!project || !query || !Array.isArray(response.sessions)) return null
  if (project.scope !== "current_project") return null
  if (typeof project.cwd !== "string" || typeof project.sessionsDir !== "string") return null
  if (typeof query.query !== "string" || typeof query.sortMode !== "string" || typeof query.nameFilter !== "string") return null

  const sessions = response.sessions.filter((session): session is SessionBrowserSession => {
    return (
      typeof session?.id === "string" &&
      typeof session?.path === "string" &&
      typeof session?.cwd === "string" &&
      typeof session?.createdAt === "string" &&
      typeof session?.modifiedAt === "string" &&
      typeof session?.messageCount === "number" &&
      typeof session?.firstMessage === "string" &&
      typeof session?.isActive === "boolean" &&
      typeof session?.depth === "number" &&
      typeof session?.isLastInThread === "boolean" &&
      Array.isArray(session?.ancestorHasNextSibling)
    )
  })

  return {
    scope: project.scope,
    projectCwd: project.cwd,
    projectSessionsDir: project.sessionsDir,
    activeSessionPath: typeof project.activeSessionPath === "string" ? project.activeSessionPath : null,
    query: query.query,
    sortMode: query.sortMode as SessionBrowserSortMode,
    nameFilter: query.nameFilter as SessionBrowserNameFilter,
    totalSessions: Number(response.totalSessions ?? sessions.length),
    returnedSessions: Number(response.returnedSessions ?? sessions.length),
    sessions,
    loaded: true,
    error: null,
  }
}

function getLiveActiveSessionPath(boot: WorkspaceBootPayload | null): string | null {
  return boot?.bridge.activeSessionFile ?? boot?.bridge.sessionState?.sessionFile ?? null
}

function getLiveActiveSessionName(boot: WorkspaceBootPayload | null): string | undefined {
  const value = boot?.bridge.sessionState?.sessionName?.trim()
  return value ? value : undefined
}

function overlayLiveBridgeSessionState<T extends { path: string; isActive: boolean; name?: string }>(
  sessions: T[],
  boot: WorkspaceBootPayload | null,
): T[] {
  const activeSessionPath = getLiveActiveSessionPath(boot)
  const activeSessionName = getLiveActiveSessionName(boot)

  return sessions.map((session) => {
    const isActive = activeSessionPath ? session.path === activeSessionPath : session.isActive
    return {
      ...session,
      isActive,
      ...(isActive && activeSessionName ? { name: activeSessionName } : {}),
    }
  })
}

function syncSessionBrowserStateWithBridge(
  sessionBrowser: CommandSurfaceSessionBrowserState,
  boot: WorkspaceBootPayload | null,
): CommandSurfaceSessionBrowserState {
  return {
    ...sessionBrowser,
    activeSessionPath: getLiveActiveSessionPath(boot),
    sessions: overlayLiveBridgeSessionState(sessionBrowser.sessions, boot),
  }
}

function patchSessionBrowserSession(
  sessionBrowser: CommandSurfaceSessionBrowserState,
  sessionPath: string,
  patch: Partial<Pick<SessionBrowserSession, "name" | "isActive">>,
): CommandSurfaceSessionBrowserState {
  return {
    ...sessionBrowser,
    activeSessionPath: patch.isActive ? sessionPath : sessionBrowser.activeSessionPath,
    sessions: sessionBrowser.sessions.map((session) =>
      session.path === sessionPath
        ? {
            ...session,
            ...patch,
          }
        : patch.isActive
          ? {
              ...session,
              isActive: false,
            }
          : session,
    ),
  }
}

function describeSessionPath(sessionPath: string, boot: WorkspaceBootPayload | null): string {
  const knownSession = boot?.resumableSessions.find((session) => session.path === sessionPath)
  if (knownSession?.name?.trim()) return knownSession.name.trim()
  if (knownSession?.id) return knownSession.id
  return shortenPath(sessionPath)
}

export interface WorkspaceOnboardingPresentation {
  phase:
    | "loading"
    | "locked"
    | "validating"
    | "running_flow"
    | "awaiting_browser_auth"
    | "awaiting_input"
    | "refreshing"
    | "failure"
    | "ready"
  label: string
  detail: string
  tone: WorkspaceStatusTone
}

export function getOnboardingPresentation(
  state: Pick<WorkspaceStoreState, "bootStatus" | "boot" | "onboardingRequestState">,
): WorkspaceOnboardingPresentation {
  if (state.bootStatus === "loading" || !state.boot) {
    return {
      phase: "loading",
      label: "Loading setup state",
      detail: "Resolving the current project, bridge, and onboarding contract…",
      tone: "info",
    }
  }

  const onboarding = state.boot.onboarding
  if (onboarding.activeFlow?.status === "awaiting_browser_auth") {
    return {
      phase: "awaiting_browser_auth",
      label: "Continue sign-in in your browser",
      detail: `${onboarding.activeFlow.providerLabel} is waiting for browser confirmation before the workspace can unlock.`,
      tone: "info",
    }
  }

  if (onboarding.activeFlow?.status === "awaiting_input") {
    return {
      phase: "awaiting_input",
      label: "One more sign-in step is required",
      detail: onboarding.activeFlow.prompt?.message ?? `${onboarding.activeFlow.providerLabel} needs one more input step.`,
      tone: "info",
    }
  }

  if (onboarding.lockReason === "bridge_refresh_pending") {
    return {
      phase: "refreshing",
      label: "Refreshing bridge auth",
      detail: "Credentials validated. The live bridge is restarting onto the new auth view before the shell unlocks.",
      tone: "info",
    }
  }

  if (onboarding.lockReason === "bridge_refresh_failed") {
    return {
      phase: "failure",
      label: "Setup completed, but the shell is still locked",
      detail: onboarding.bridgeAuthRefresh.error ?? "The bridge could not reload auth after setup.",
      tone: "danger",
    }
  }

  if (onboarding.lastValidation?.status === "failed") {
    return {
      phase: "failure",
      label: "Credential validation failed",
      detail: onboarding.lastValidation.message,
      tone: "danger",
    }
  }

  if (state.onboardingRequestState === "saving_api_key") {
    return {
      phase: "validating",
      label: "Validating credentials",
      detail: "Checking the provider key and saving it only if validation succeeds.",
      tone: "info",
    }
  }

  if (state.onboardingRequestState === "starting_provider_flow" || state.onboardingRequestState === "submitting_provider_flow_input") {
    return {
      phase: "running_flow",
      label: "Advancing provider sign-in",
      detail: "The onboarding flow is running and will update here as soon as the next step is ready.",
      tone: "info",
    }
  }

  if (onboarding.locked) {
    return {
      phase: "locked",
      label: "Required setup needed",
      detail: "Choose a required provider, validate it here, and the workspace will unlock without restarting the host.",
      tone: "warning",
    }
  }

  return {
    phase: "ready",
    label: "Workspace unlocked",
    detail:
      onboarding.lastValidation?.status === "succeeded"
        ? `${findOnboardingProviderLabel(onboarding, onboarding.lastValidation.providerId)} is ready and the workspace is live.`
        : "Required setup is satisfied and the shell is ready for live commands.",
    tone: "success",
  }
}

export function getVisibleWorkspaceError(
  state: Pick<WorkspaceStoreState, "boot" | "lastBridgeError" | "lastClientError">,
): string | null {
  const onboarding = state.boot?.onboarding
  if (onboarding?.bridgeAuthRefresh.phase === "failed" && onboarding.bridgeAuthRefresh.error) {
    return onboarding.bridgeAuthRefresh.error
  }
  if (onboarding?.lastValidation?.status === "failed") {
    return onboarding.lastValidation.message
  }
  return state.lastBridgeError?.message ?? state.lastClientError
}

export function getStatusPresentation(
  state: Pick<WorkspaceStoreState, "bootStatus" | "connectionState" | "boot" | "onboardingRequestState">,
): {
  label: string
  tone: WorkspaceStatusTone
} {
  if (state.bootStatus === "loading") {
    return { label: "Loading workspace", tone: "info" }
  }

  if (state.bootStatus === "error") {
    return { label: "Boot failed", tone: "danger" }
  }

  const onboardingPresentation = getOnboardingPresentation(state)
  if (onboardingPresentation.phase !== "ready") {
    return {
      label: onboardingPresentation.label,
      tone: onboardingPresentation.tone,
    }
  }

  if (state.boot?.bridge.phase === "failed") {
    return { label: "Bridge failed", tone: "danger" }
  }

  switch (state.connectionState) {
    case "connected":
      return { label: "Bridge connected", tone: "success" }
    case "connecting":
      return { label: "Connecting stream", tone: "info" }
    case "reconnecting":
      return { label: "Reconnecting stream", tone: "warning" }
    case "disconnected":
      return { label: "Stream disconnected", tone: "warning" }
    case "error":
      return { label: "Stream error", tone: "danger" }
    default:
      return { label: "Workspace idle", tone: "muted" }
  }
}

function createFreshnessBucket(): WorkspaceFreshnessBucket {
  return {
    status: "idle",
    stale: false,
    reloadCount: 0,
    lastRequestedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailure: null,
    invalidatedAt: null,
    invalidationReason: null,
    invalidationSource: null,
  }
}

function createInitialRecoverySummary(): WorkspaceRecoverySummary {
  return {
    visible: false,
    tone: "healthy",
    label: "Recovery summary pending",
    detail: "Waiting for the first live workspace snapshot.",
    validationCount: 0,
    retryInProgress: false,
    retryAttempt: 0,
    autoRetryEnabled: false,
    isCompacting: false,
    currentUnitId: null,
    freshness: "idle",
    entrypointLabel: "Inspect recovery",
    lastError: null,
  }
}

function createInitialWorkspaceLiveFreshnessState(): WorkspaceLiveFreshnessState {
  return {
    auto: createFreshnessBucket(),
    workspace: createFreshnessBucket(),
    recovery: createFreshnessBucket(),
    resumableSessions: createFreshnessBucket(),
    gitSummary: createFreshnessBucket(),
    sessionBrowser: createFreshnessBucket(),
    sessionStats: createFreshnessBucket(),
  }
}

function createInitialWorkspaceLiveState(): WorkspaceLiveState {
  return {
    auto: null,
    workspace: null,
    resumableSessions: [],
    recoverySummary: createInitialRecoverySummary(),
    freshness: createInitialWorkspaceLiveFreshnessState(),
    softBootRefreshCount: 0,
    targetedRefreshCount: 0,
  }
}

function withFreshnessRequested(bucket: WorkspaceFreshnessBucket): WorkspaceFreshnessBucket {
  return {
    ...bucket,
    status: "refreshing",
    lastRequestedAt: new Date().toISOString(),
    lastFailure: null,
  }
}

function withFreshnessInvalidated(
  bucket: WorkspaceFreshnessBucket,
  reason: LiveStateInvalidationReason,
  source: LiveStateInvalidationSource,
): WorkspaceFreshnessBucket {
  return {
    ...bucket,
    status: bucket.lastSuccessAt ? "stale" : bucket.status,
    stale: true,
    invalidatedAt: new Date().toISOString(),
    invalidationReason: reason,
    invalidationSource: source,
  }
}

function withFreshnessSucceeded(bucket: WorkspaceFreshnessBucket): WorkspaceFreshnessBucket {
  return {
    ...bucket,
    status: "fresh",
    stale: false,
    reloadCount: bucket.reloadCount + 1,
    lastSuccessAt: new Date().toISOString(),
    lastFailureAt: null,
    lastFailure: null,
  }
}

function withFreshnessFailed(bucket: WorkspaceFreshnessBucket, error: string): WorkspaceFreshnessBucket {
  return {
    ...bucket,
    status: "error",
    stale: true,
    lastFailureAt: new Date().toISOString(),
    lastFailure: error,
  }
}

export function getLiveWorkspaceIndex(
  state: Pick<WorkspaceStoreState, "boot" | "live">,
): WorkspaceIndex | null {
  return state.live.workspace ?? state.boot?.workspace ?? null
}

export function getLiveAutoDashboard(
  state: Pick<WorkspaceStoreState, "boot" | "live">,
): AutoDashboardData | null {
  return state.live.auto ?? state.boot?.auto ?? null
}

export function getLiveResumableSessions(
  state: Pick<WorkspaceStoreState, "boot" | "live">,
): BootResumableSession[] {
  return state.live.resumableSessions.length > 0 ? state.live.resumableSessions : state.boot?.resumableSessions ?? []
}

export function createWorkspaceRecoverySummary(state: Pick<WorkspaceStoreState, "boot" | "live">): WorkspaceRecoverySummary {
  const bridge = state.boot?.bridge ?? null
  const workspace = getLiveWorkspaceIndex(state)
  const auto = getLiveAutoDashboard(state)
  const validationCount = workspace?.validationIssues.length ?? 0
  const retryInProgress = Boolean(bridge?.sessionState?.retryInProgress)
  const retryAttempt = bridge?.sessionState?.retryAttempt ?? 0
  const autoRetryEnabled = Boolean(bridge?.sessionState?.autoRetryEnabled)
  const isCompacting = Boolean(bridge?.sessionState?.isCompacting)
  const freshnessBucket = state.live.freshness.recovery
  const freshness =
    freshnessBucket.status === "error"
      ? "error"
      : freshnessBucket.stale
        ? "stale"
        : freshnessBucket.lastSuccessAt
          ? "fresh"
          : "idle"
  const lastError = bridge?.lastError
    ? {
        message: bridge.lastError.message,
        phase: bridge.lastError.phase,
        at: bridge.lastError.at,
      }
    : null

  let tone: WorkspaceRecoverySummary["tone"] = "healthy"
  let label = "Recovery summary healthy"
  let detail = "No retry, compaction, bridge, or validation recovery signals are active."

  if (!workspace && !auto && !bridge) {
    return createInitialRecoverySummary()
  }

  if (lastError || freshness === "error") {
    tone = "danger"
    label = "Recovery attention required"
    detail = lastError?.message ?? freshnessBucket.lastFailure ?? "A targeted live refresh failed."
  } else if (validationCount > 0) {
    tone = "warning"
    label = `Recovery summary: ${validationCount} validation issue${validationCount === 1 ? "" : "s"}`
    detail = "Workspace validation surfaced issues that may need doctor or audit follow-up."
  } else if (retryInProgress) {
    tone = "warning"
    label = `Recovery retry active (attempt ${Math.max(1, retryAttempt)})`
    detail = "The live bridge is retrying the current unit after a transient failure."
  } else if (isCompacting) {
    tone = "warning"
    label = "Recovery compaction active"
    detail = "The live session is compacting context before continuing."
  } else if (freshness === "stale") {
    tone = "warning"
    label = "Recovery summary stale"
    detail = freshnessBucket.invalidationReason
      ? `Waiting for a targeted refresh after ${freshnessBucket.invalidationReason.replaceAll("_", " ")}.`
      : "Waiting for the next targeted refresh."
  }

  return {
    visible: true,
    tone,
    label,
    detail,
    validationCount,
    retryInProgress,
    retryAttempt,
    autoRetryEnabled,
    isCompacting,
    currentUnitId: auto?.currentUnit?.id ?? null,
    freshness,
    entrypointLabel: tone === "danger" || tone === "warning" ? "Inspect recovery" : "Review recovery",
    lastError,
  }
}

function applyBootToLiveState(
  current: WorkspaceLiveState,
  boot: WorkspaceBootPayload,
  options: { soft?: boolean } = {},
): WorkspaceLiveState {
  const next: WorkspaceLiveState = {
    ...current,
    auto: boot.auto,
    workspace: boot.workspace,
    resumableSessions: boot.resumableSessions,
    freshness: {
      ...current.freshness,
      auto: withFreshnessSucceeded(current.freshness.auto),
      workspace: withFreshnessSucceeded(current.freshness.workspace),
      recovery: withFreshnessSucceeded(current.freshness.recovery),
      resumableSessions: withFreshnessSucceeded(current.freshness.resumableSessions),
    },
    softBootRefreshCount: current.softBootRefreshCount + (options.soft ? 1 : 0),
  }

  next.recoverySummary = createWorkspaceRecoverySummary({ boot, live: next })
  return next
}

function createInitialState(): WorkspaceStoreState {
  return {
    bootStatus: "idle",
    connectionState: "idle",
    boot: null,
    live: createInitialWorkspaceLiveState(),
    terminalLines: [createTerminalLine("system", "Preparing the live GSD workspace…")],
    lastClientError: null,
    lastBridgeError: null,
    sessionAttached: false,
    lastEventType: null,
    commandInFlight: null,
    lastSlashCommandOutcome: null,
    commandSurface: createInitialCommandSurfaceState(),
    onboardingRequestState: "idle",
    onboardingRequestProviderId: null,
    // Live interaction state
    pendingUiRequests: [],
    streamingAssistantText: "",
    streamingThinkingText: "",
    liveTranscript: [],
    liveThinkingTranscript: [],
    completedToolExecutions: [],
    activeToolExecution: null,
    currentTurnSegments: [],
    completedTurnSegments: [],
    chatUserMessages: [],
    statusTexts: {},
    widgetContents: {},
    titleOverride: null,
    editorTextBuffer: null,
  }
}

export function buildProjectUrl(path: string, projectCwd?: string): string {
  if (!projectCwd) return path
  const url = new URL(path, "http://localhost")
  url.searchParams.set("project", projectCwd)
  return url.pathname + url.search
}

export class GSDWorkspaceStore {
  constructor(private readonly projectCwd?: string) {}

  private buildUrl(path: string): string {
    return buildProjectUrl(path, this.projectCwd)
  }

  private state = createInitialState()
  private readonly listeners = new Set<() => void>()
  private bootPromise: Promise<void> | null = null
  private eventSource: EventSource | null = null
  private onboardingPollTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private disposed = false
  private lastBridgeDigest: string | null = null
  private lastStreamState: WorkspaceConnectionState = "idle"
  private commandTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private lastBootRefreshAt = 0
  private visibilityHandler: (() => void) | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): WorkspaceStoreState => this.state

  start = (): void => {
    if (this.started || this.disposed) return
    this.started = true

    if (typeof document !== "undefined") {
      this.visibilityHandler = () => {
        if (document.visibilityState === "visible" && Date.now() - this.lastBootRefreshAt >= VISIBILITY_REFRESH_THRESHOLD_MS) {
          void this.refreshBoot({ soft: true })
        }
      }
      document.addEventListener("visibilitychange", this.visibilityHandler)
    }

    void this.refreshBoot()
  }

  dispose = (): void => {
    this.disposed = true
    this.started = false
    this.stopOnboardingPoller()
    this.closeEventStream()
    this.clearCommandTimeout()
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler)
      this.visibilityHandler = null
    }
  }

  disconnectSSE = (): void => {
    this.closeEventStream()
  }

  reconnectSSE = (): void => {
    if (this.disposed) return
    this.ensureEventStream()
    void this.refreshBoot({ soft: true })
  }

  clearTerminalLines = (): void => {
    const replacement = this.state.boot ? bootSeedLines(this.state.boot) : [createTerminalLine("system", "Terminal cleared")]
    this.patchState({ terminalLines: replacement })
  }

  consumeEditorTextBuffer = (): string | null => {
    const next = this.state.editorTextBuffer
    if (next !== null) {
      this.patchState({ editorTextBuffer: null })
    }
    return next
  }

  openCommandSurface = (
    surface: BrowserSlashCommandSurface,
    options: { source?: "slash" | "sidebar" | "surface"; args?: string; selectedTarget?: CommandSurfaceTarget | null } = {},
  ): void => {
    const resumableSessions = getLiveResumableSessions(this.state)
    this.patchState({
      commandSurface: openCommandSurfaceState(this.state.commandSurface, {
        surface,
        source: options.source ?? "surface",
        args: options.args ?? "",
        selectedTarget: options.selectedTarget,
        onboardingLocked: this.state.boot?.onboarding.locked,
        currentModel: getCurrentModelSelection(this.state.boot?.bridge),
        currentThinkingLevel: this.state.boot?.bridge.sessionState?.thinkingLevel ?? null,
        preferredProviderId: getPreferredOnboardingProviderId(this.state.boot?.onboarding),
        resumableSessions: resumableSessions.map((session) => ({
          id: session.id,
          path: session.path,
          name: session.name,
          isActive: session.isActive,
        })),
        currentSessionPath: this.state.boot?.bridge.activeSessionFile ?? this.state.boot?.bridge.sessionState?.sessionFile ?? null,
        currentSessionName: this.state.boot?.bridge.sessionState?.sessionName ?? null,
        projectCwd: this.state.boot?.project.cwd ?? null,
        projectSessionsDir: this.state.boot?.project.sessionsDir ?? null,
      }),
    })
  }

  closeCommandSurface = (): void => {
    this.patchState({
      commandSurface: closeCommandSurfaceState(this.state.commandSurface),
    })
  }

  setCommandSurfaceSection = (section: CommandSurfaceSection): void => {
    const resumableSessions = getLiveResumableSessions(this.state)
    this.patchState({
      commandSurface: setCommandSurfaceSection(this.state.commandSurface, section, {
        onboardingLocked: this.state.boot?.onboarding.locked,
        currentModel: getCurrentModelSelection(this.state.boot?.bridge),
        currentThinkingLevel: this.state.boot?.bridge.sessionState?.thinkingLevel ?? null,
        preferredProviderId: getPreferredOnboardingProviderId(this.state.boot?.onboarding),
        resumableSessions: resumableSessions.map((session) => ({
          id: session.id,
          path: session.path,
          name: session.name,
          isActive: session.isActive,
        })),
        currentSessionPath: this.state.boot?.bridge.activeSessionFile ?? this.state.boot?.bridge.sessionState?.sessionFile ?? null,
        currentSessionName: this.state.boot?.bridge.sessionState?.sessionName ?? null,
        projectCwd: this.state.boot?.project.cwd ?? null,
        projectSessionsDir: this.state.boot?.project.sessionsDir ?? null,
      }),
    })
  }

  selectCommandSurfaceTarget = (target: CommandSurfaceTarget): void => {
    this.patchState({
      commandSurface: selectCommandSurfaceStateTarget(this.state.commandSurface, target),
    })
  }

  loadGitSummary = async (): Promise<GitSummaryResponse | null> => {
    const requestedGitSummary: CommandSurfaceGitSummaryState = {
      ...this.state.commandSurface.gitSummary,
      pending: true,
      error: null,
    }

    const requestedLive: WorkspaceLiveState = {
      ...this.state.live,
      freshness: {
        ...this.state.live.freshness,
        gitSummary: withFreshnessRequested(this.state.live.freshness.gitSummary),
      },
    }

    this.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: requestedLive }),
      },
      commandSurface: setCommandSurfacePending(
        {
          ...this.state.commandSurface,
          gitSummary: requestedGitSummary,
        },
        "load_git_summary",
      ),
    })

    try {
      const response = await authFetch(this.buildUrl("/api/git"), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })

      const payload = await response.json().catch(() => null)
      const normalizedGitSummary = normalizeGitSummaryPayload(payload)
      if (!response.ok || !normalizedGitSummary) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Current-project git summary failed with ${response.status}`
        const failedGitSummary = normalizeGitSummaryError(requestedGitSummary, message)
        const failedLive: WorkspaceLiveState = {
          ...this.state.live,
          freshness: {
            ...this.state.live.freshness,
            gitSummary: withFreshnessFailed(this.state.live.freshness.gitSummary, message),
          },
        }
        this.patchState({
          live: {
            ...failedLive,
            recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
          },
          commandSurface: applyCommandSurfaceActionResult(
            {
              ...this.state.commandSurface,
              gitSummary: failedGitSummary,
            },
            {
              action: "load_git_summary",
              success: false,
              message,
              gitSummary: failedGitSummary,
            },
          ),
        })
        return null
      }

      const gitSummary: CommandSurfaceGitSummaryState = {
        pending: false,
        loaded: true,
        result: normalizedGitSummary,
        error: null,
      }

      const nextLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          gitSummary: withFreshnessSucceeded(this.state.live.freshness.gitSummary),
        },
      }

      this.patchState({
        live: {
          ...nextLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: nextLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "load_git_summary",
          success: true,
          message: "",
          gitSummary,
        }),
      })

      return normalizedGitSummary
    } catch (error) {
      const message = normalizeClientError(error)
      const failedGitSummary = normalizeGitSummaryError(requestedGitSummary, message)
      const failedLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          gitSummary: withFreshnessFailed(this.state.live.freshness.gitSummary, message),
        },
      }
      this.patchState({
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.state.commandSurface,
            gitSummary: failedGitSummary,
          },
          {
            action: "load_git_summary",
            success: false,
            message,
            gitSummary: failedGitSummary,
          },
        ),
      })
      return null
    }
  }

  loadRecoveryDiagnostics = async (): Promise<WorkspaceRecoveryDiagnostics | null> => {
    const requestedRecovery = markRecoveryStatePending(this.state.commandSurface.recovery)
    const requestedLive: WorkspaceLiveState = {
      ...this.state.live,
      freshness: {
        ...this.state.live.freshness,
        recovery: withFreshnessRequested(this.state.live.freshness.recovery),
      },
    }

    this.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: requestedLive }),
      },
      commandSurface: setCommandSurfacePending(
        {
          ...this.state.commandSurface,
          recovery: requestedRecovery,
        },
        "load_recovery_diagnostics",
      ),
    })

    try {
      const response = await authFetch(this.buildUrl("/api/recovery"), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })

      const payload = await response.json().catch(() => null)
      const diagnostics = normalizeRecoveryDiagnosticsPayload(payload)
      if (!response.ok || !diagnostics) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Recovery diagnostics failed with ${response.status}`
        const failedRecovery = markRecoveryStateFailure(requestedRecovery, message)
        const failedLive: WorkspaceLiveState = {
          ...this.state.live,
          freshness: {
            ...this.state.live.freshness,
            recovery: withFreshnessFailed(this.state.live.freshness.recovery, message),
          },
        }
        this.patchState({
          lastClientError: message,
          live: {
            ...failedLive,
            recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
          },
          commandSurface: applyCommandSurfaceActionResult(
            {
              ...this.state.commandSurface,
              recovery: failedRecovery,
            },
            {
              action: "load_recovery_diagnostics",
              success: false,
              message,
              recovery: failedRecovery,
            },
          ),
        })
        return null
      }

      const recovery = {
        ...createRecoveryStateFromDiagnostics(diagnostics),
        lastInvalidatedAt: this.state.commandSurface.recovery.lastInvalidatedAt,
      }
      const nextLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          recovery: withFreshnessSucceeded(this.state.live.freshness.recovery),
        },
      }

      this.patchState({
        lastClientError: null,
        live: {
          ...nextLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: nextLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.state.commandSurface,
            recovery,
          },
          {
            action: "load_recovery_diagnostics",
            success: true,
            message:
              diagnostics.status === "ready"
                ? "Recovery diagnostics refreshed"
                : "Recovery diagnostics are currently unavailable",
            recovery,
          },
        ),
      })

      return diagnostics
    } catch (error) {
      const message = normalizeClientError(error)
      const failedRecovery = markRecoveryStateFailure(requestedRecovery, message)
      const failedLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          recovery: withFreshnessFailed(this.state.live.freshness.recovery, message),
        },
      }
      this.patchState({
        lastClientError: message,
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.state.commandSurface,
            recovery: failedRecovery,
          },
          {
            action: "load_recovery_diagnostics",
            success: false,
            message,
            recovery: failedRecovery,
          },
        ),
      })
      return null
    }
  }

  // ─── Diagnostics panel fetch methods ────────────────────────────────────────

  private patchDiagnosticsPhaseState<K extends "forensics" | "skillHealth">(
    key: K,
    patch: Partial<CommandSurfaceDiagnosticsPhaseState<K extends "forensics" ? ForensicReport : SkillHealthReport>>,
  ): void {
    this.patchState({
      commandSurface: {
        ...this.state.commandSurface,
        diagnostics: {
          ...this.state.commandSurface.diagnostics,
          [key]: { ...this.state.commandSurface.diagnostics[key], ...patch },
        },
      },
    })
  }

  private patchDoctorState(patch: Partial<CommandSurfaceDoctorState>): void {
    this.patchState({
      commandSurface: {
        ...this.state.commandSurface,
        diagnostics: {
          ...this.state.commandSurface.diagnostics,
          doctor: { ...this.state.commandSurface.diagnostics.doctor, ...patch },
        },
      },
    })
  }

  private patchKnowledgeCapturesState(patch: Partial<CommandSurfaceKnowledgeCapturesState>): void {
    this.patchState({
      commandSurface: {
        ...this.state.commandSurface,
        knowledgeCaptures: { ...this.state.commandSurface.knowledgeCaptures, ...patch },
      },
    })
  }

  private patchKnowledgeCapturesPhaseState<K extends "knowledge" | "captures">(
    key: K,
    patch: Partial<CommandSurfaceDiagnosticsPhaseState<K extends "knowledge" ? KnowledgeData : CapturesData>>,
  ): void {
    this.patchState({
      commandSurface: {
        ...this.state.commandSurface,
        knowledgeCaptures: {
          ...this.state.commandSurface.knowledgeCaptures,
          [key]: { ...this.state.commandSurface.knowledgeCaptures[key], ...patch },
        },
      },
    })
  }

  private patchSettingsPhaseState(patch: Partial<CommandSurfaceDiagnosticsPhaseState<SettingsData>>): void {
    this.patchState({
      commandSurface: {
        ...this.state.commandSurface,
        settingsData: { ...this.state.commandSurface.settingsData, ...patch },
      },
    })
  }

  private patchRemainingCommandsPhaseState<
    K extends keyof import("./command-surface-contract").CommandSurfaceRemainingState,
  >(
    key: K,
    patch: Partial<CommandSurfaceDiagnosticsPhaseState<import("./command-surface-contract").CommandSurfaceRemainingState[K] extends CommandSurfaceDiagnosticsPhaseState<infer T> ? T : never>>,
  ): void {
    this.patchState({
      commandSurface: {
        ...this.state.commandSurface,
        remainingCommands: {
          ...this.state.commandSurface.remainingCommands,
          [key]: { ...this.state.commandSurface.remainingCommands[key], ...patch },
        },
      },
    })
  }

  loadForensicsDiagnostics = async (): Promise<ForensicReport | null> => {
    this.patchDiagnosticsPhaseState("forensics", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/forensics"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Forensics request failed with ${response.status}`
        this.patchDiagnosticsPhaseState("forensics", { phase: "error", error: message })
        return null
      }
      this.patchDiagnosticsPhaseState("forensics", { phase: "loaded", data: payload as ForensicReport, lastLoadedAt: new Date().toISOString() })
      return payload as ForensicReport
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchDiagnosticsPhaseState("forensics", { phase: "error", error: message })
      return null
    }
  }

  loadDoctorDiagnostics = async (scope?: string): Promise<DoctorReport | null> => {
    this.patchDoctorState({ phase: "loading", error: null })
    try {
      const url = scope ? `/api/doctor?scope=${encodeURIComponent(scope)}` : "/api/doctor"
      const response = await authFetch(url, { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Doctor request failed with ${response.status}`
        this.patchDoctorState({ phase: "error", error: message })
        return null
      }
      this.patchDoctorState({ phase: "loaded", data: payload as DoctorReport, lastLoadedAt: new Date().toISOString() })
      return payload as DoctorReport
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchDoctorState({ phase: "error", error: message })
      return null
    }
  }

  applyDoctorFixes = async (scope?: string): Promise<DoctorFixResult | null> => {
    this.patchDoctorState({ fixPending: true, lastFixError: null, lastFixResult: null })
    try {
      const response = await authFetch(this.buildUrl("/api/doctor"), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(scope ? { scope } : {}),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Doctor fix request failed with ${response.status}`
        this.patchDoctorState({ fixPending: false, lastFixError: message })
        return null
      }
      const fixResult = payload as DoctorFixResult
      this.patchDoctorState({ fixPending: false, lastFixResult: fixResult })
      // Reload doctor data after applying fixes so the issue list refreshes
      void this.loadDoctorDiagnostics(scope)
      return fixResult
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchDoctorState({ fixPending: false, lastFixError: message })
      return null
    }
  }

  loadSkillHealthDiagnostics = async (): Promise<SkillHealthReport | null> => {
    this.patchDiagnosticsPhaseState("skillHealth", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/skill-health"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Skill health request failed with ${response.status}`
        this.patchDiagnosticsPhaseState("skillHealth", { phase: "error", error: message })
        return null
      }
      this.patchDiagnosticsPhaseState("skillHealth", { phase: "loaded", data: payload as SkillHealthReport, lastLoadedAt: new Date().toISOString() })
      return payload as SkillHealthReport
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchDiagnosticsPhaseState("skillHealth", { phase: "error", error: message })
      return null
    }
  }

  loadKnowledgeData = async (): Promise<KnowledgeData | null> => {
    this.patchKnowledgeCapturesPhaseState("knowledge", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/knowledge"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Knowledge request failed with ${response.status}`
        this.patchKnowledgeCapturesPhaseState("knowledge", { phase: "error", error: message })
        return null
      }
      this.patchKnowledgeCapturesPhaseState("knowledge", { phase: "loaded", data: payload as KnowledgeData, lastLoadedAt: new Date().toISOString() })
      return payload as KnowledgeData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchKnowledgeCapturesPhaseState("knowledge", { phase: "error", error: message })
      return null
    }
  }

  loadCapturesData = async (): Promise<CapturesData | null> => {
    this.patchKnowledgeCapturesPhaseState("captures", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/captures"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Captures request failed with ${response.status}`
        this.patchKnowledgeCapturesPhaseState("captures", { phase: "error", error: message })
        return null
      }
      this.patchKnowledgeCapturesPhaseState("captures", { phase: "loaded", data: payload as CapturesData, lastLoadedAt: new Date().toISOString() })
      return payload as CapturesData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchKnowledgeCapturesPhaseState("captures", { phase: "error", error: message })
      return null
    }
  }

  loadSettingsData = async (): Promise<SettingsData | null> => {
    this.patchSettingsPhaseState({ phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/settings-data"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Settings request failed with ${response.status}`
        this.patchSettingsPhaseState({ phase: "error", error: message })
        return null
      }
      this.patchSettingsPhaseState({ phase: "loaded", data: payload as SettingsData, lastLoadedAt: new Date().toISOString() })
      return payload as SettingsData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchSettingsPhaseState({ phase: "error", error: message })
      return null
    }
  }

  // ─── Remaining command surface load/mutation methods ──────────────────────────

  loadHistoryData = async (): Promise<HistoryData | null> => {
    this.patchRemainingCommandsPhaseState("history", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/history"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `History request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("history", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("history", { phase: "loaded", data: payload as HistoryData, lastLoadedAt: new Date().toISOString() })
      return payload as HistoryData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("history", { phase: "error", error: message })
      return null
    }
  }

  loadInspectData = async (): Promise<InspectData | null> => {
    this.patchRemainingCommandsPhaseState("inspect", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/inspect"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Inspect request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("inspect", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("inspect", { phase: "loaded", data: payload as InspectData, lastLoadedAt: new Date().toISOString() })
      return payload as InspectData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("inspect", { phase: "error", error: message })
      return null
    }
  }

  loadHooksData = async (): Promise<HooksData | null> => {
    this.patchRemainingCommandsPhaseState("hooks", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/hooks"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Hooks request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("hooks", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("hooks", { phase: "loaded", data: payload as HooksData, lastLoadedAt: new Date().toISOString() })
      return payload as HooksData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("hooks", { phase: "error", error: message })
      return null
    }
  }

  loadExportData = async (format?: "markdown" | "json"): Promise<ExportResult | null> => {
    this.patchRemainingCommandsPhaseState("exportData", { phase: "loading", error: null })
    try {
      const url = format ? `/api/export-data?format=${encodeURIComponent(format)}` : "/api/export-data"
      const response = await authFetch(url, { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Export request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("exportData", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("exportData", { phase: "loaded", data: payload as ExportResult, lastLoadedAt: new Date().toISOString() })
      return payload as ExportResult
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("exportData", { phase: "error", error: message })
      return null
    }
  }

  loadUndoInfo = async (): Promise<UndoInfo | null> => {
    this.patchRemainingCommandsPhaseState("undo", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/undo"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Undo info request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("undo", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("undo", { phase: "loaded", data: payload as UndoInfo, lastLoadedAt: new Date().toISOString() })
      return payload as UndoInfo
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("undo", { phase: "error", error: message })
      return null
    }
  }

  loadCleanupData = async (): Promise<CleanupData | null> => {
    this.patchRemainingCommandsPhaseState("cleanup", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/cleanup"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Cleanup data request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("cleanup", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("cleanup", { phase: "loaded", data: payload as CleanupData, lastLoadedAt: new Date().toISOString() })
      return payload as CleanupData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("cleanup", { phase: "error", error: message })
      return null
    }
  }

  loadSteerData = async (): Promise<SteerData | null> => {
    this.patchRemainingCommandsPhaseState("steer", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.buildUrl("/api/steer"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Steer data request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("steer", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("steer", { phase: "loaded", data: payload as SteerData, lastLoadedAt: new Date().toISOString() })
      return payload as SteerData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("steer", { phase: "error", error: message })
      return null
    }
  }

  executeUndoAction = async (): Promise<UndoResult | null> => {
    try {
      const response = await authFetch(this.buildUrl("/api/undo"), {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Undo action failed with ${response.status}`
        return { success: false, message }
      }
      // Reload undo info after executing
      void this.loadUndoInfo()
      return payload as UndoResult
    } catch (error) {
      const message = normalizeClientError(error)
      return { success: false, message }
    }
  }

  executeCleanupAction = async (branches: string[], snapshots: string[]): Promise<CleanupResult | null> => {
    try {
      const response = await authFetch(this.buildUrl("/api/cleanup"), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ branches, snapshots }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Cleanup action failed with ${response.status}`
        return { deletedBranches: 0, prunedSnapshots: 0, message }
      }
      // Reload cleanup data after executing
      void this.loadCleanupData()
      return payload as CleanupResult
    } catch (error) {
      const message = normalizeClientError(error)
      return { deletedBranches: 0, prunedSnapshots: 0, message }
    }
  }

  resolveCaptureAction = async (request: CaptureResolveRequest): Promise<CaptureResolveResult | null> => {
    this.patchKnowledgeCapturesState({ resolveRequest: { pending: true, lastError: null, lastResult: null } })
    try {
      const response = await authFetch(this.buildUrl("/api/captures"), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Capture resolve failed with ${response.status}`
        this.patchKnowledgeCapturesState({ resolveRequest: { pending: false, lastError: message, lastResult: null } })
        return null
      }
      const result = payload as CaptureResolveResult
      this.patchKnowledgeCapturesState({ resolveRequest: { pending: false, lastError: null, lastResult: result } })
      // Auto-reload captures after successful resolve
      void this.loadCapturesData()
      return result
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchKnowledgeCapturesState({ resolveRequest: { pending: false, lastError: message, lastResult: null } })
      return null
    }
  }

  updateSessionBrowserState = (
    patch: Partial<Pick<CommandSurfaceSessionBrowserState, "query" | "sortMode" | "nameFilter">>,
  ): void => {
    this.patchState({
      commandSurface: {
        ...this.state.commandSurface,
        sessionBrowser: {
          ...this.state.commandSurface.sessionBrowser,
          ...patch,
          error: null,
        },
        lastError: null,
        lastResult: null,
      },
    })
  }

  loadSessionBrowser = async (
    overrides: Partial<Pick<CommandSurfaceSessionBrowserState, "query" | "sortMode" | "nameFilter">> = {},
  ): Promise<CommandSurfaceSessionBrowserState | null> => {
    const requestedSessionBrowser = {
      ...this.state.commandSurface.sessionBrowser,
      ...overrides,
      error: null,
    }

    const requestedLive: WorkspaceLiveState = {
      ...this.state.live,
      freshness: {
        ...this.state.live.freshness,
        sessionBrowser: withFreshnessRequested(this.state.live.freshness.sessionBrowser),
      },
    }

    this.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: requestedLive }),
      },
      commandSurface: setCommandSurfacePending(
        {
          ...this.state.commandSurface,
          sessionBrowser: requestedSessionBrowser,
        },
        "load_session_browser",
      ),
    })

    const params = new URLSearchParams()
    if (requestedSessionBrowser.query.trim()) {
      params.set("query", requestedSessionBrowser.query.trim())
    }
    params.set("sortMode", requestedSessionBrowser.sortMode)
    params.set("nameFilter", requestedSessionBrowser.nameFilter)

    try {
      const response = await authFetch(this.buildUrl(`/api/session/browser?${params.toString()}`), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })

      const payload = await response.json().catch(() => null)
      const normalizedSessionBrowser = normalizeSessionBrowserPayload(payload)
      if (!response.ok || !normalizedSessionBrowser) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Current-project session browser failed with ${response.status}`
        const failedSessionBrowser = {
          ...requestedSessionBrowser,
          error: message,
        }
        const failedLive: WorkspaceLiveState = {
          ...this.state.live,
          freshness: {
            ...this.state.live.freshness,
            sessionBrowser: withFreshnessFailed(this.state.live.freshness.sessionBrowser, message),
          },
        }
        this.patchState({
          live: {
            ...failedLive,
            recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
          },
          commandSurface: applyCommandSurfaceActionResult(
            {
              ...this.state.commandSurface,
              sessionBrowser: failedSessionBrowser,
            },
            {
              action: "load_session_browser",
              success: false,
              message,
              sessionBrowser: failedSessionBrowser,
            },
          ),
        })
        return null
      }

      const sessionBrowser = syncSessionBrowserStateWithBridge(normalizedSessionBrowser, this.state.boot)
      const currentTarget = this.state.commandSurface.selectedTarget
      const defaultResumePath = sessionBrowser.sessions.find((session) => !session.isActive)?.path ?? sessionBrowser.sessions[0]?.path
      const defaultRenameSession =
        sessionBrowser.sessions.find((session) => session.path === sessionBrowser.activeSessionPath) ?? sessionBrowser.sessions[0]

      let selectedTarget = currentTarget
      if (currentTarget?.kind === "resume" || this.state.commandSurface.section === "resume") {
        const visiblePath =
          currentTarget?.kind === "resume" && currentTarget.sessionPath && sessionBrowser.sessions.some((session) => session.path === currentTarget.sessionPath)
            ? currentTarget.sessionPath
            : defaultResumePath
        selectedTarget = { kind: "resume", sessionPath: visiblePath }
      } else if (currentTarget?.kind === "name" || this.state.commandSurface.section === "name") {
        const visibleSession =
          currentTarget?.kind === "name" && currentTarget.sessionPath
            ? sessionBrowser.sessions.find((session) => session.path === currentTarget.sessionPath) ?? defaultRenameSession
            : defaultRenameSession
        selectedTarget = {
          kind: "name",
          sessionPath: visibleSession?.path,
          name:
            currentTarget?.kind === "name" && currentTarget.sessionPath === visibleSession?.path
              ? currentTarget.name
              : visibleSession?.name ?? "",
        }
      }

      const nextLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          sessionBrowser: withFreshnessSucceeded(this.state.live.freshness.sessionBrowser),
        },
      }

      this.patchState({
        live: {
          ...nextLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: nextLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.state.commandSurface,
            sessionBrowser,
          },
          {
            action: "load_session_browser",
            success: true,
            message: "",
            selectedTarget,
            sessionBrowser,
          },
        ),
      })

      return sessionBrowser
    } catch (error) {
      const message = normalizeClientError(error)
      const failedSessionBrowser = {
        ...requestedSessionBrowser,
        error: message,
      }
      const failedLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          sessionBrowser: withFreshnessFailed(this.state.live.freshness.sessionBrowser, message),
        },
      }
      this.patchState({
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.state.commandSurface,
            sessionBrowser: failedSessionBrowser,
          },
          {
            action: "load_session_browser",
            success: false,
            message,
            sessionBrowser: failedSessionBrowser,
          },
        ),
      })
      return null
    }
  }

  renameSessionFromSurface = async (sessionPath: string, name?: string): Promise<SessionManageResponse | null> => {
    const currentTarget = this.state.commandSurface.selectedTarget
    const requestedName = name ?? (currentTarget?.kind === "name" ? currentTarget.name : "")
    const trimmedName = requestedName.trim()
    const selectedTarget: CommandSurfaceTarget = { kind: "name", sessionPath, name: requestedName }

    if (!trimmedName) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "rename_session",
          success: false,
          message: "Session name cannot be empty",
          selectedTarget,
        }),
      })
      return null
    }

    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "rename_session", selectedTarget),
    })

    try {
      const response = await authFetch(this.buildUrl("/api/session/manage"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          action: "rename",
          sessionPath,
          name: trimmedName,
        }),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || typeof payload !== "object" || payload.success !== true) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Session rename failed with ${response.status}`
        this.patchState({
          commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
            action: "rename_session",
            success: false,
            message,
            selectedTarget,
          }),
        })
        return null
      }

      const result = payload as SessionManageResponse & { success: true }
      const nextBoot = patchBootSessionName(this.state.boot, result.sessionPath, result.name)
      const nextSessionBrowser = syncSessionBrowserStateWithBridge(
        patchSessionBrowserSession(this.state.commandSurface.sessionBrowser, result.sessionPath, {
          name: result.name,
          ...(result.isActiveSession ? { isActive: true } : {}),
        }),
        nextBoot,
      )
      const nextSelectedTarget: CommandSurfaceTarget = {
        kind: "name",
        sessionPath: result.sessionPath,
        name: result.name,
      }
      const nextLiveBase: WorkspaceLiveState = {
        ...this.state.live,
        resumableSessions: overlayLiveBridgeSessionState(
          getLiveResumableSessions(this.state).map((session) =>
            session.path === result.sessionPath
              ? {
                  ...session,
                  name: result.name,
                }
              : session,
          ),
          nextBoot,
        ),
      }

      this.patchState({
        ...(nextBoot ? { boot: nextBoot } : {}),
        live: {
          ...nextLiveBase,
          recoverySummary: createWorkspaceRecoverySummary({ boot: nextBoot, live: nextLiveBase }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.state.commandSurface,
            sessionBrowser: nextSessionBrowser,
          },
          {
            action: "rename_session",
            success: true,
            message: `Session name set: ${result.name}`,
            selectedTarget: nextSelectedTarget,
            sessionBrowser: nextSessionBrowser,
          },
        ),
      })

      return result
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "rename_session",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return null
    }
  }

  loadAvailableModels = async (): Promise<CommandSurfaceModelOption[]> => {
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "loading_models"),
    })

    const response = await this.sendCommand(
      { type: "get_available_models" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "loading_models",
          success: false,
          message: `Couldn't load models — ${message}`,
        }),
      })
      return []
    }

    const availableModels = normalizeAvailableModels(response.data, getCurrentModelSelection(this.state.boot?.bridge))
    const currentTarget = this.state.commandSurface.selectedTarget
    const selectedTarget =
      currentTarget?.kind === "model"
        ? currentTarget
        : availableModels[0]
          ? { kind: "model" as const, provider: availableModels[0].provider, modelId: availableModels[0].modelId }
          : currentTarget

    this.patchState({
      commandSurface: {
        ...this.state.commandSurface,
        pendingAction: null,
        lastError: null,
        availableModels,
        selectedTarget: selectedTarget ?? null,
      },
    })

    return availableModels
  }

  applyModelSelection = async (provider: string, modelId: string): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "model", provider, modelId }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "set_model", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "set_model", provider, modelId },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "set_model",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBridge = this.state.boot?.bridge.sessionState
      ? {
          ...this.state.boot.bridge,
          sessionState: {
            ...this.state.boot.bridge.sessionState,
            model: response.data as WorkspaceModelRef,
          },
        }
      : null

    const nextAvailableModels = this.state.commandSurface.availableModels.map((model) => ({
      ...model,
      isCurrent: model.provider === provider && model.modelId === modelId,
    }))

    this.patchState({
      ...(nextBridge && this.state.boot ? { boot: cloneBootWithBridge(this.state.boot, nextBridge) } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "set_model",
        success: true,
        message: `Model set to ${provider}/${modelId}`,
        selectedTarget,
        availableModels: nextAvailableModels,
      }),
    })

    return response
  }

  applyThinkingLevel = async (level: CommandSurfaceThinkingLevel): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "thinking", level }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "set_thinking_level", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "set_thinking_level", level },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "set_thinking_level",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBridge = this.state.boot?.bridge.sessionState
      ? {
          ...this.state.boot.bridge,
          sessionState: {
            ...this.state.boot.bridge.sessionState,
            thinkingLevel: level,
          },
        }
      : null

    this.patchState({
      ...(nextBridge && this.state.boot ? { boot: cloneBootWithBridge(this.state.boot, nextBridge) } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "set_thinking_level",
        success: true,
        message: `Thinking level set to ${level}`,
        selectedTarget,
      }),
    })

    return response
  }

  setSteeringModeFromSurface = async (
    mode: WorkspaceSessionState["steeringMode"],
  ): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.state.commandSurface.selectedTarget
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "set_steering_mode", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "set_steering_mode", mode },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "set_steering_mode",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBoot = patchBootSessionState(this.state.boot, { steeringMode: mode })
    this.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "set_steering_mode",
        success: true,
        message: `Steering mode set to ${mode}`,
        selectedTarget,
      }),
    })

    return response
  }

  setFollowUpModeFromSurface = async (
    mode: WorkspaceSessionState["followUpMode"],
  ): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.state.commandSurface.selectedTarget
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "set_follow_up_mode", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "set_follow_up_mode", mode },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "set_follow_up_mode",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBoot = patchBootSessionState(this.state.boot, { followUpMode: mode })
    this.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "set_follow_up_mode",
        success: true,
        message: `Follow-up mode set to ${mode}`,
        selectedTarget,
      }),
    })

    return response
  }

  setAutoCompactionFromSurface = async (enabled: boolean): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.state.commandSurface.selectedTarget
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "set_auto_compaction", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "set_auto_compaction", enabled },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "set_auto_compaction",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBoot = patchBootSessionState(this.state.boot, { autoCompactionEnabled: enabled })
    this.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "set_auto_compaction",
        success: true,
        message: `Auto-compaction ${enabled ? "enabled" : "disabled"}`,
        selectedTarget,
      }),
    })

    return response
  }

  setAutoRetryFromSurface = async (enabled: boolean): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.state.commandSurface.selectedTarget
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "set_auto_retry", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "set_auto_retry", enabled },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "set_auto_retry",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBoot = patchBootSessionState(this.state.boot, { autoRetryEnabled: enabled })
    this.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "set_auto_retry",
        success: true,
        message: `Auto-retry ${enabled ? "enabled" : "disabled"}`,
        selectedTarget,
      }),
    })

    return response
  }

  abortRetryFromSurface = async (): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.state.commandSurface.selectedTarget
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "abort_retry", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "abort_retry" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "abort_retry",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "abort_retry",
        success: true,
        message: "Retry cancellation requested. Live retry state will update when the bridge confirms the abort.",
        selectedTarget,
      }),
    })

    return response
  }

  switchSessionFromSurface = async (sessionPath: string): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "resume", sessionPath }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "switch_session", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "switch_session", sessionPath },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "switch_session",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    if (response.data && typeof response.data === "object" && "cancelled" in response.data && response.data.cancelled) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "switch_session",
          success: false,
          message: "Session switch was cancelled before the browser changed sessions.",
          selectedTarget,
        }),
      })
      return response
    }

    const nextSessionName =
      this.state.commandSurface.sessionBrowser.sessions.find((session) => session.path === sessionPath)?.name ??
      this.state.boot?.resumableSessions.find((session) => session.path === sessionPath)?.name
    const nextBoot = patchBootActiveSession(this.state.boot, sessionPath, nextSessionName)
    const nextSessionBrowser = syncSessionBrowserStateWithBridge(
      patchSessionBrowserSession(this.state.commandSurface.sessionBrowser, sessionPath, {
        isActive: true,
        ...(nextSessionName ? { name: nextSessionName } : {}),
      }),
      nextBoot,
    )

    const nextLiveBase: WorkspaceLiveState = {
      ...this.state.live,
      resumableSessions: overlayLiveBridgeSessionState(
        getLiveResumableSessions(this.state).map((session) => ({
          ...session,
          isActive: session.path === sessionPath,
          ...(session.path === sessionPath && nextSessionName ? { name: nextSessionName } : {}),
        })),
        nextBoot,
      ),
    }

    this.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      live: {
        ...nextLiveBase,
        recoverySummary: createWorkspaceRecoverySummary({ boot: nextBoot, live: nextLiveBase }),
      },
      commandSurface: applyCommandSurfaceActionResult(
        {
          ...this.state.commandSurface,
          sessionBrowser: nextSessionBrowser,
        },
        {
          action: "switch_session",
          success: true,
          message: `Switched to ${describeSessionPath(sessionPath, nextBoot ?? this.state.boot)}`,
          selectedTarget,
          sessionBrowser: nextSessionBrowser,
        },
      ),
    })

    return response
  }

  loadSessionStats = async (): Promise<CommandSurfaceSessionStats | null> => {
    const requestedLive: WorkspaceLiveState = {
      ...this.state.live,
      freshness: {
        ...this.state.live.freshness,
        sessionStats: withFreshnessRequested(this.state.live.freshness.sessionStats),
      },
    }

    this.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: requestedLive }),
      },
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "load_session_stats"),
    })

    const response = await this.sendCommand(
      { type: "get_session_stats" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      const failedLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          sessionStats: withFreshnessFailed(this.state.live.freshness.sessionStats, message),
        },
      }
      this.patchState({
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "load_session_stats",
          success: false,
          message: `Couldn't load session details — ${message}`,
          sessionStats: null,
        }),
      })
      return null
    }

    const sessionStats = normalizeSessionStats(response.data)
    if (!sessionStats) {
      const message = "Session details response was missing the expected fields."
      const failedLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          sessionStats: withFreshnessFailed(this.state.live.freshness.sessionStats, message),
        },
      }
      this.patchState({
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "load_session_stats",
          success: false,
          message,
          sessionStats: null,
        }),
      })
      return null
    }

    const nextLive: WorkspaceLiveState = {
      ...this.state.live,
      freshness: {
        ...this.state.live.freshness,
        sessionStats: withFreshnessSucceeded(this.state.live.freshness.sessionStats),
      },
    }

    this.patchState({
      live: {
        ...nextLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: nextLive }),
      },
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "load_session_stats",
        success: true,
        message: `Loaded session details for ${sessionStats.sessionId}`,
        sessionStats,
      }),
    })

    return sessionStats
  }

  exportSessionFromSurface = async (outputPath?: string): Promise<WorkspaceCommandResponse | null> => {
    const normalizedOutputPath = outputPath?.trim() || undefined
    const selectedTarget: CommandSurfaceTarget = { kind: "session", outputPath: normalizedOutputPath }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "export_html", selectedTarget),
    })

    const response = await this.sendCommand(
      normalizedOutputPath ? { type: "export_html", outputPath: normalizedOutputPath } : { type: "export_html" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "export_html",
          success: false,
          message: `Couldn't export this session — ${message}`,
          selectedTarget,
        }),
      })
      return response
    }

    const exportedPath =
      response.data && typeof response.data === "object" && "path" in response.data && typeof response.data.path === "string"
        ? response.data.path
        : "the generated file"

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "export_html",
        success: true,
        message: `Session exported to ${exportedPath}`,
        selectedTarget,
      }),
    })

    return response
  }

  loadForkMessages = async (): Promise<CommandSurfaceForkMessage[]> => {
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "load_fork_messages"),
    })

    const response = await this.sendCommand(
      { type: "get_fork_messages" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "load_fork_messages",
          success: false,
          message: `Couldn't load fork points — ${message}`,
          forkMessages: [],
        }),
      })
      return []
    }

    const forkMessages = normalizeForkMessages(response.data)
    const currentTarget = this.state.commandSurface.selectedTarget
    const selectedTarget =
      currentTarget?.kind === "fork" && currentTarget.entryId
        ? currentTarget
        : forkMessages[0]
          ? { kind: "fork" as const, entryId: forkMessages[0].entryId }
          : currentTarget

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "load_fork_messages",
        success: true,
        message: forkMessages.length > 0 ? `Loaded ${forkMessages.length} fork points.` : "No fork points are available yet.",
        selectedTarget: selectedTarget ?? null,
        forkMessages,
      }),
    })

    return forkMessages
  }

  forkSessionFromSurface = async (entryId: string): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "fork", entryId }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "fork_session", selectedTarget),
    })

    const response = await this.sendCommand(
      { type: "fork", entryId },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "fork_session",
          success: false,
          message: `Couldn't create a fork — ${message}`,
          selectedTarget,
        }),
      })
      return response
    }

    if (response.data && typeof response.data === "object" && "cancelled" in response.data && response.data.cancelled) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "fork_session",
          success: false,
          message: "Fork creation was cancelled before a new session was created.",
          selectedTarget,
        }),
      })
      return response
    }

    const sourceText =
      response.data && typeof response.data === "object" && "text" in response.data && typeof response.data.text === "string"
        ? response.data.text.trim()
        : ""

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "fork_session",
        success: true,
        message: sourceText ? `Forked from “${sourceText.slice(0, 120)}${sourceText.length > 120 ? "…" : ""}”` : "Created a forked session.",
        selectedTarget,
      }),
    })

    return response
  }

  compactSessionFromSurface = async (customInstructions?: string): Promise<WorkspaceCommandResponse | null> => {
    const normalizedInstructions = customInstructions?.trim() ?? ""
    const selectedTarget: CommandSurfaceTarget = { kind: "compact", customInstructions: normalizedInstructions }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "compact_session", selectedTarget),
    })

    const response = await this.sendCommand(
      normalizedInstructions ? { type: "compact", customInstructions: normalizedInstructions } : { type: "compact" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.state.lastClientError ?? "Unknown error"
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "compact_session",
          success: false,
          message: `Couldn't compact the session — ${message}`,
          selectedTarget,
          lastCompaction: null,
        }),
      })
      return response
    }

    const compactionResult = normalizeCompactionResult(response.data)
    if (!compactionResult) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "compact_session",
          success: false,
          message: "Compaction finished but the browser could not read the compaction result.",
          selectedTarget,
          lastCompaction: null,
        }),
      })
      return response
    }

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "compact_session",
        success: true,
        message: `Compacted ${compactionResult.tokensBefore.toLocaleString()} tokens into a fresh summary${normalizedInstructions ? " with custom instructions" : ""}.`,
        selectedTarget,
        lastCompaction: compactionResult,
      }),
    })

    return response
  }

  saveApiKeyFromSurface = async (providerId: string, apiKey: string): Promise<WorkspaceOnboardingState | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "manage" }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "save_api_key", selectedTarget),
    })

    const onboarding = await this.saveApiKey(providerId, apiKey)
    const providerLabel = onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId

    if (!onboarding) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "save_api_key",
          success: false,
          message: this.state.lastClientError ?? `${providerLabel} setup failed`,
          selectedTarget,
        }),
      })
      return null
    }

    if (onboarding.lastValidation?.status === "failed") {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "save_api_key",
          success: false,
          message: onboarding.lastValidation.message,
          selectedTarget,
        }),
      })
      return onboarding
    }

    if (onboarding.bridgeAuthRefresh.phase === "failed") {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "save_api_key",
          success: false,
          message: onboarding.bridgeAuthRefresh.error ?? `${providerLabel} credentials validated but bridge auth refresh failed`,
          selectedTarget,
        }),
      })
      return onboarding
    }

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "save_api_key",
        success: true,
        message: `${providerLabel} credentials validated and saved.`,
        selectedTarget,
      }),
    })

    return onboarding
  }

  startProviderFlowFromSurface = async (providerId: string): Promise<WorkspaceOnboardingState | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "login" }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "start_provider_flow", selectedTarget),
    })

    const onboarding = await this.startProviderFlow(providerId)
    const providerLabel = onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId

    if (!onboarding) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "start_provider_flow",
          success: false,
          message: this.state.lastClientError ?? `${providerLabel} sign-in failed to start`,
          selectedTarget,
        }),
      })
      return null
    }

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "start_provider_flow",
        success: true,
        message: `${providerLabel} sign-in started. Continue in the auth section.`,
        selectedTarget,
      }),
    })

    return onboarding
  }

  submitProviderFlowInputFromSurface = async (flowId: string, input: string): Promise<WorkspaceOnboardingState | null> => {
    const providerId = this.state.boot?.onboarding.activeFlow?.providerId ?? undefined
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "login" }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "submit_provider_flow_input", selectedTarget),
    })

    const onboarding = await this.submitProviderFlowInput(flowId, input)
    const providerLabel =
      onboarding?.activeFlow?.providerLabel ??
      (providerId && onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId) ??
      "Provider"

    if (!onboarding) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "submit_provider_flow_input",
          success: false,
          message: this.state.lastClientError ?? `${providerLabel} sign-in failed`,
          selectedTarget,
        }),
      })
      return null
    }

    if (onboarding.activeFlow?.status === "failed") {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "submit_provider_flow_input",
          success: false,
          message: onboarding.activeFlow.error ?? `${providerLabel} sign-in failed`,
          selectedTarget,
        }),
      })
      return onboarding
    }

    if (onboarding.bridgeAuthRefresh.phase === "failed") {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "submit_provider_flow_input",
          success: false,
          message: onboarding.bridgeAuthRefresh.error ?? `${providerLabel} sign-in completed but bridge auth refresh failed`,
          selectedTarget,
        }),
      })
      return onboarding
    }

    const successMessage =
      onboarding.activeFlow && ["running", "awaiting_browser_auth", "awaiting_input"].includes(onboarding.activeFlow.status)
        ? `${providerLabel} sign-in advanced. Complete the remaining step in this panel.`
        : `${providerLabel} sign-in complete.`

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "submit_provider_flow_input",
        success: true,
        message: successMessage,
        selectedTarget,
      }),
    })

    return onboarding
  }

  cancelProviderFlowFromSurface = async (flowId: string): Promise<WorkspaceOnboardingState | null> => {
    const providerId = this.state.boot?.onboarding.activeFlow?.providerId ?? undefined
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "login" }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "cancel_provider_flow", selectedTarget),
    })

    const onboarding = await this.cancelProviderFlow(flowId)
    const providerLabel =
      onboarding?.activeFlow?.providerLabel ??
      (providerId && onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId) ??
      "Provider"

    if (!onboarding) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "cancel_provider_flow",
          success: false,
          message: this.state.lastClientError ?? `${providerLabel} sign-in cancellation failed`,
          selectedTarget,
        }),
      })
      return null
    }

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "cancel_provider_flow",
        success: true,
        message: `${providerLabel} sign-in cancelled.`,
        selectedTarget,
      }),
    })

    return onboarding
  }

  logoutProviderFromSurface = async (providerId: string): Promise<WorkspaceOnboardingState | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "logout" }
    this.patchState({
      commandSurface: setCommandSurfacePending(this.state.commandSurface, "logout_provider", selectedTarget),
    })

    const onboarding = await this.logoutProvider(providerId)
    const providerLabel = onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId

    if (!onboarding) {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "logout_provider",
          success: false,
          message: this.state.lastClientError ?? `${providerLabel} logout failed`,
          selectedTarget,
        }),
      })
      return null
    }

    if (onboarding.bridgeAuthRefresh.phase === "failed") {
      this.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
          action: "logout_provider",
          success: false,
          message: onboarding.bridgeAuthRefresh.error ?? `${providerLabel} logout completed but bridge auth refresh failed`,
          selectedTarget,
        }),
      })
      return onboarding
    }

    const providerState = onboarding.required.providers.find((provider) => provider.id === providerId)
    const resultMessage = providerState?.configured
      ? `${providerLabel} saved credentials were removed, but ${providerState.configuredVia} auth still keeps the provider available.`
      : onboarding.locked
        ? `${providerLabel} logged out — required setup is needed again.`
        : `${providerLabel} logged out.`

    this.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.state.commandSurface, {
        action: "logout_provider",
        success: true,
        message: resultMessage,
        selectedTarget,
      }),
    })

    return onboarding
  }

  respondToUiRequest = async (id: string, response: Record<string, unknown>): Promise<void> => {
    this.patchState({ commandInFlight: "extension_ui_response" })
    try {
      const result = await authFetch(this.buildUrl("/api/session/command"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: "extension_ui_response", id, ...response }),
      })
      if (!result.ok) {
        const body = await result.json().catch(() => ({ error: `HTTP ${result.status}` })) as { error?: string }
        throw new Error(body.error ?? `extension_ui_response failed with ${result.status}`)
      }
      this.patchState({
        pendingUiRequests: this.state.pendingUiRequests.filter((r) => r.id !== id),
      })
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `UI response failed — ${message}`)),
      })
    } finally {
      this.patchState({ commandInFlight: null })
    }
  }

  dismissUiRequest = async (id: string): Promise<void> => {
    this.patchState({ commandInFlight: "extension_ui_response" })
    try {
      const result = await authFetch(this.buildUrl("/api/session/command"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: "extension_ui_response", id, cancelled: true }),
      })
      if (!result.ok) {
        const body = await result.json().catch(() => ({ error: `HTTP ${result.status}` })) as { error?: string }
        throw new Error(body.error ?? `extension_ui_response cancel failed with ${result.status}`)
      }
      this.patchState({
        pendingUiRequests: this.state.pendingUiRequests.filter((r) => r.id !== id),
      })
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `UI dismiss failed — ${message}`)),
      })
    } finally {
      this.patchState({ commandInFlight: null })
    }
  }

  sendSteer = async (message: string): Promise<void> => {
    await this.sendCommand({ type: "steer", message })
  }

  sendAbort = async (): Promise<void> => {
    await this.sendCommand({ type: "abort" })
  }

  pushChatUserMessage = (msg: ChatMessage) => {
    this.patchState({ chatUserMessages: [...this.state.chatUserMessages, msg] })
  }

  submitInput = async (input: string, images?: PendingImage[]): Promise<BrowserSlashCommandDispatchResult | null> => {
    const trimmed = input.trim()
    if (!trimmed) return null

    const outcome = dispatchBrowserSlashCommand(trimmed, {
      isStreaming: this.state.boot?.bridge.sessionState?.isStreaming,
    })

    this.patchState({
      lastSlashCommandOutcome: trimmed.startsWith("/") ? outcome : null,
    })

    switch (outcome.kind) {
      case "prompt":
      case "rpc": {
        const imagePayload = images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))
        const command = imagePayload && imagePayload.length > 0
          ? { ...outcome.command, images: imagePayload }
          : outcome.command
        await this.sendCommand(command, { displayInput: trimmed })
        return outcome
      }
      case "local":
        if (outcome.action === "clear_terminal") {
          this.clearTerminalLines()
          return outcome
        }
        if (outcome.action === "refresh_workspace") {
          await this.refreshBoot()
          return outcome
        }
        if (outcome.action === "gsd_help") {
          this.patchState({
            terminalLines: withTerminalLine(
              withTerminalLine(this.state.terminalLines, createTerminalLine("input", trimmed)),
              createTerminalLine("system", GSD_HELP_TEXT),
            ),
          })
          return outcome
        }
        return outcome
      case "surface": {
        if (IMPLEMENTED_BROWSER_COMMAND_SURFACES.has(outcome.surface)) {
          this.patchState({
            terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("input", trimmed)),
          })
          this.openCommandSurface(outcome.surface, { source: "slash", args: outcome.args })
          return outcome
        }

        const notice = getBrowserSlashCommandTerminalNotice(outcome)
        let nextLines = withTerminalLine(this.state.terminalLines, createTerminalLine("input", trimmed))
        if (notice) {
          nextLines = withTerminalLine(nextLines, createTerminalLine(notice.type, notice.message))
        }
        this.patchState({ terminalLines: nextLines })
        return outcome
      }
      case "reject": {
        const notice = getBrowserSlashCommandTerminalNotice(outcome)
        let nextLines = withTerminalLine(this.state.terminalLines, createTerminalLine("input", trimmed))
        if (notice) {
          nextLines = withTerminalLine(nextLines, createTerminalLine(notice.type, notice.message))
        }
        this.patchState({ terminalLines: nextLines })
        return outcome
      }
      case "view-navigate": {
        this.patchState({
          terminalLines: withTerminalLine(
            this.state.terminalLines,
            createTerminalLine("system", `Navigating to ${outcome.view} view`),
          ),
        })
        window.dispatchEvent(
          new CustomEvent("gsd:navigate-view", { detail: { view: outcome.view } }),
        )
        return outcome
      }
    }
  }

  refreshBoot = async (options: { soft?: boolean } = {}): Promise<void> => {
    if (this.bootPromise) return await this.bootPromise

    this.lastBootRefreshAt = Date.now()
    const softRefresh = Boolean(options.soft && this.state.boot)

    this.bootPromise = (async () => {
      if (!softRefresh) {
        this.patchState({
          bootStatus: "loading",
          connectionState: this.state.connectionState === "connected" ? "connected" : "connecting",
          lastClientError: null,
        })
      } else {
        this.patchState({
          lastClientError: null,
        })
      }

      try {
        const response = await authFetch(this.buildUrl("/api/boot"), {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept: "application/json",
          },
        })

        if (!response.ok) {
          if (response.status === 401) {
            this.patchState({
              bootStatus: "unauthenticated",
              connectionState: "error",
            })
            return
          }
          throw new Error(`Boot request failed with ${response.status}`)
        }

        const bootPayload = (await response.json()) as WorkspaceBootPayload
        const boot = cloneBootWithBridge(bootPayload, bootPayload.bridge) ?? bootPayload
        const live = applyBootToLiveState(this.state.live, boot, { soft: softRefresh })
        this.lastBridgeDigest = null
        this.lastBridgeDigest = [boot.bridge.phase, boot.bridge.activeSessionId, boot.bridge.lastError?.at, boot.bridge.lastError?.message].join("::")
        this.patchState({
          bootStatus: "ready",
          boot,
          live,
          connectionState: boot.onboarding.locked
            ? "idle"
            : this.eventSource
              ? this.state.connectionState
              : "connecting",
          lastBridgeError: boot.bridge.lastError,
          sessionAttached: hasAttachedSession(boot.bridge),
          lastClientError: null,
          ...(softRefresh ? {} : { terminalLines: bootSeedLines(boot) }),
        })
        if (boot.onboarding.locked) {
          this.closeEventStream()
        } else {
          this.ensureEventStream()
        }
      } catch (error) {
        const message = normalizeClientError(error)
        if (softRefresh) {
          this.patchState({
            lastClientError: message,
            terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Workspace refresh failed — ${message}`)),
          })
          return
        }

        this.patchState({
          bootStatus: "error",
          connectionState: "error",
          lastClientError: message,
          terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Boot failed — ${message}`)),
        })
      }
    })().finally(() => {
      this.bootPromise = null
    })

    await this.bootPromise
  }

  private async refreshBootAfterCurrentSettles(options: { soft?: boolean } = {}): Promise<void> {
    if (this.bootPromise) {
      try {
        await this.bootPromise
      } catch {
        // Preserve the original boot failure surface, then issue a fresh refresh.
      }
    }

    await this.refreshBoot(options)
  }

  private invalidateLiveFreshness(
    domains: LiveStateInvalidationDomain[],
    reason: LiveStateInvalidationReason,
    source: LiveStateInvalidationSource,
  ): WorkspaceLiveState {
    const nextFreshness = { ...this.state.live.freshness }

    if (domains.includes("auto")) {
      nextFreshness.auto = withFreshnessInvalidated(nextFreshness.auto, reason, source)
    }
    if (domains.includes("workspace")) {
      nextFreshness.workspace = withFreshnessInvalidated(nextFreshness.workspace, reason, source)
      nextFreshness.gitSummary = withFreshnessInvalidated(nextFreshness.gitSummary, reason, source)
    }
    if (domains.includes("recovery")) {
      nextFreshness.recovery = withFreshnessInvalidated(nextFreshness.recovery, reason, source)
      nextFreshness.sessionStats = withFreshnessInvalidated(nextFreshness.sessionStats, reason, source)
    }
    if (domains.includes("resumable_sessions")) {
      nextFreshness.resumableSessions = withFreshnessInvalidated(nextFreshness.resumableSessions, reason, source)
      nextFreshness.sessionBrowser = withFreshnessInvalidated(nextFreshness.sessionBrowser, reason, source)
      nextFreshness.sessionStats = withFreshnessInvalidated(nextFreshness.sessionStats, reason, source)
    }

    const nextLive = {
      ...this.state.live,
      freshness: nextFreshness,
    }
    return {
      ...nextLive,
      recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: nextLive }),
    }
  }

  private refreshOpenCommandSurfacesForInvalidation(event: LiveStateInvalidationEvent): void {
    if (event.domains.includes("workspace") && this.state.commandSurface.open && this.state.commandSurface.section === "git") {
      if (this.state.commandSurface.pendingAction !== "load_git_summary") {
        void this.loadGitSummary()
      }
    }

    if (event.domains.includes("recovery") && this.state.commandSurface.open && this.state.commandSurface.section === "recovery") {
      if (this.state.commandSurface.pendingAction !== "load_recovery_diagnostics") {
        void this.loadRecoveryDiagnostics()
      }
    }

    if (event.domains.includes("resumable_sessions")) {
      if (
        this.state.commandSurface.open &&
        (this.state.commandSurface.section === "resume" || this.state.commandSurface.section === "name") &&
        this.state.commandSurface.pendingAction !== "load_session_browser"
      ) {
        void this.loadSessionBrowser()
      }

      if (this.state.commandSurface.open && this.state.commandSurface.section === "session") {
        const activeSessionPath = this.state.boot?.bridge.activeSessionFile ?? this.state.boot?.bridge.sessionState?.sessionFile ?? null
        this.patchState({
          commandSurface: {
            ...this.state.commandSurface,
            sessionStats:
              this.state.commandSurface.sessionStats && this.state.commandSurface.sessionStats.sessionFile === activeSessionPath
                ? this.state.commandSurface.sessionStats
                : null,
          },
        })
        if (this.state.commandSurface.pendingAction !== "load_session_stats") {
          void this.loadSessionStats()
        }
      }
    }
  }

  private async reloadLiveState(
    domains: LiveStateInvalidationDomain[],
    reason: LiveStateInvalidationReason,
  ): Promise<void> {
    const requestedDomains = domains.filter((domain) => domain === "auto" || domain === "workspace" || domain === "resumable_sessions")

    if (requestedDomains.length === 0) {
      const nextLive = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          recovery: withFreshnessSucceeded(this.state.live.freshness.recovery),
        },
      }
      this.patchState({
        live: {
          ...nextLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: nextLive }),
        },
      })
      return
    }

    const nextFreshness = { ...this.state.live.freshness }
    if (requestedDomains.includes("auto")) {
      nextFreshness.auto = withFreshnessRequested(nextFreshness.auto)
    }
    if (requestedDomains.includes("workspace")) {
      nextFreshness.workspace = withFreshnessRequested(nextFreshness.workspace)
    }
    if (requestedDomains.includes("resumable_sessions")) {
      nextFreshness.resumableSessions = withFreshnessRequested(nextFreshness.resumableSessions)
    }
    nextFreshness.recovery = withFreshnessRequested(nextFreshness.recovery)

    const requestedLive = {
      ...this.state.live,
      freshness: nextFreshness,
      targetedRefreshCount: this.state.live.targetedRefreshCount + 1,
    }
    this.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: requestedLive }),
      },
    })

    const params = new URLSearchParams()
    for (const domain of requestedDomains) {
      params.append("domain", domain)
    }

    try {
      const response = await authFetch(this.buildUrl(`/api/live-state?${params.toString()}`), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })
      const payload = await response.json().catch(() => null) as {
        auto?: AutoDashboardData
        workspace?: WorkspaceIndex
        resumableSessions?: BootResumableSession[]
        error?: string
      } | null

      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? `Live state request failed with ${response.status}`)
      }

      let nextBoot = this.state.boot
      const nextLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: { ...this.state.live.freshness },
      }

      if (requestedDomains.includes("auto") && payload.auto) {
        nextLive.auto = payload.auto
        nextLive.freshness.auto = withFreshnessSucceeded(nextLive.freshness.auto)
        nextBoot = nextBoot
          ? {
              ...nextBoot,
              auto: payload.auto,
            }
          : nextBoot
      }

      if (requestedDomains.includes("workspace") && payload.workspace) {
        nextLive.workspace = payload.workspace
        nextLive.freshness.workspace = withFreshnessSucceeded(nextLive.freshness.workspace)
        nextBoot = nextBoot
          ? {
              ...nextBoot,
              workspace: payload.workspace,
            }
          : nextBoot
      }

      if (requestedDomains.includes("resumable_sessions") && payload.resumableSessions) {
        const nextSessions = overlayLiveBridgeSessionState(payload.resumableSessions, nextBoot)
        nextLive.resumableSessions = nextSessions
        nextLive.freshness.resumableSessions = withFreshnessSucceeded(nextLive.freshness.resumableSessions)
        nextBoot = nextBoot
          ? {
              ...nextBoot,
              resumableSessions: nextSessions,
            }
          : nextBoot
      }

      nextLive.freshness.recovery = withFreshnessSucceeded(nextLive.freshness.recovery)
      nextLive.recoverySummary = createWorkspaceRecoverySummary({ boot: nextBoot, live: nextLive })
      this.patchState({
        ...(nextBoot ? { boot: nextBoot } : {}),
        live: nextLive,
      })
    } catch (error) {
      const message = normalizeClientError(error)
      const failedLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          auto:
            requestedDomains.includes("auto")
              ? withFreshnessFailed(this.state.live.freshness.auto, message)
              : this.state.live.freshness.auto,
          workspace:
            requestedDomains.includes("workspace")
              ? withFreshnessFailed(this.state.live.freshness.workspace, message)
              : this.state.live.freshness.workspace,
          resumableSessions:
            requestedDomains.includes("resumable_sessions")
              ? withFreshnessFailed(this.state.live.freshness.resumableSessions, message)
              : this.state.live.freshness.resumableSessions,
          recovery: withFreshnessFailed(this.state.live.freshness.recovery, message),
        },
      }

      this.patchState({
        lastClientError: message,
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
        },
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Live refresh failed (${reason}) — ${message}`)),
      })
    }
  }

  private handleLiveStateInvalidation(event: LiveStateInvalidationEvent): void {
    this.patchState({
      live: this.invalidateLiveFreshness(event.domains, event.reason, event.source),
      commandSurface: event.domains.includes("recovery")
        ? {
            ...this.state.commandSurface,
            recovery: markRecoveryStateInvalidated(this.state.commandSurface.recovery),
          }
        : this.state.commandSurface,
    })
    this.refreshOpenCommandSurfacesForInvalidation(event)
    void this.reloadLiveState(event.domains, event.reason)
  }

  refreshOnboarding = async (): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "refreshing",
      onboardingRequestProviderId: null,
      lastClientError: null,
    })

    try {
      return await this.fetchOnboardingState()
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Onboarding refresh failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  saveApiKey = async (providerId: string, apiKey: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "saving_api_key",
      onboardingRequestProviderId: providerId,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "save_api_key",
        providerId,
        apiKey,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Credential setup failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  startProviderFlow = async (providerId: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "starting_provider_flow",
      onboardingRequestProviderId: providerId,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "start_provider_flow",
        providerId,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Provider sign-in failed to start — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  submitProviderFlowInput = async (flowId: string, input: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "submitting_provider_flow_input",
      onboardingRequestProviderId: this.state.boot?.onboarding.activeFlow?.providerId ?? null,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "continue_provider_flow",
        flowId,
        input,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Provider sign-in input failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  cancelProviderFlow = async (flowId: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "cancelling_provider_flow",
      onboardingRequestProviderId: this.state.boot?.onboarding.activeFlow?.providerId ?? null,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "cancel_provider_flow",
        flowId,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Provider sign-in cancellation failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  logoutProvider = async (providerId: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "logging_out_provider",
      onboardingRequestProviderId: providerId,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "logout_provider",
        providerId,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Provider logout failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  sendCommand = async (
    command: WorkspaceBridgeCommand,
    options: { displayInput?: string; appendInputLine?: boolean; appendResponseLine?: boolean } = {},
  ): Promise<WorkspaceCommandResponse | null> => {
    this.clearCommandTimeout()

    const nextPatch: Partial<WorkspaceStoreState> = {
      commandInFlight: command.type,
    }

    if (options.appendInputLine !== false) {
      nextPatch.terminalLines = withTerminalLine(
        this.state.terminalLines,
        createTerminalLine("input", options.displayInput ?? getCommandInputLabel(command)),
      )
    }

    this.patchState(nextPatch)

    this.commandTimeoutTimer = setTimeout(() => {
      if (this.state.commandInFlight) {
        this.patchState({
          commandInFlight: null,
          lastClientError: "Command timed out — controls re-enabled",
          terminalLines: withTerminalLine(
            this.state.terminalLines,
            createTerminalLine("error", "Command timed out — controls re-enabled"),
          ),
        })
      }
    }, COMMAND_TIMEOUT_MS)

    try {
      const response = await authFetch(this.buildUrl("/api/session/command"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(command),
      })

      const payload = (await response.json()) as WorkspaceCommandResponse | { ok: true }
      if ("ok" in payload) {
        return null
      }

      if (payload.command === "get_state" && payload.success && this.state.boot) {
        const nextBridge = {
          ...this.state.boot.bridge,
          sessionState: payload.data as WorkspaceSessionState,
          activeSessionId: (payload.data as WorkspaceSessionState).sessionId,
          activeSessionFile: (payload.data as WorkspaceSessionState).sessionFile ?? this.state.boot.bridge.activeSessionFile,
          lastCommandType: "get_state",
          updatedAt: new Date().toISOString(),
        }

        this.patchState({
          boot: cloneBootWithBridge(this.state.boot, nextBridge),
          lastBridgeError: nextBridge.lastError,
          sessionAttached: hasAttachedSession(nextBridge),
        })
      }

      if (payload.code === "onboarding_locked" && payload.details?.onboarding && this.state.boot) {
        this.patchState({
          boot: cloneBootWithPartialOnboarding(this.state.boot, payload.details.onboarding),
        })
      }

      this.patchState({
        ...(options.appendResponseLine === false
          ? {}
          : { terminalLines: withTerminalLine(this.state.terminalLines, responseToLine(payload)) }),
        lastBridgeError: payload.success ? this.state.lastBridgeError : this.state.boot?.bridge.lastError ?? this.state.lastBridgeError,
      })
      return payload
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(
          this.state.terminalLines,
          createTerminalLine("error", `Command failed (${command.type}) — ${message}`),
        ),
      })
      return {
        type: "response",
        command: command.type,
        success: false,
        error: message,
      }
    } finally {
      this.clearCommandTimeout()
      this.patchState({ commandInFlight: null })
    }
  }

  private clearCommandTimeout(): void {
    if (this.commandTimeoutTimer) {
      clearTimeout(this.commandTimeoutTimer)
      this.commandTimeoutTimer = null
    }
  }

  private async fetchOnboardingState(silent = false): Promise<WorkspaceOnboardingState> {
    const previousFlowStatus = this.state.boot?.onboarding.activeFlow?.status ?? null
    const response = await authFetch(this.buildUrl("/api/onboarding"), {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    })
    const payload = (await response.json()) as OnboardingApiPayload
    if (!response.ok || !payload.onboarding) {
      throw new Error(payload.error ?? `Onboarding request failed with ${response.status}`)
    }

    this.applyOnboardingState(payload.onboarding)

    if (
      previousFlowStatus &&
      ACTIVE_ONBOARDING_FLOW_STATUSES.has(previousFlowStatus) &&
      payload.onboarding.activeFlow &&
      TERMINAL_ONBOARDING_FLOW_STATUSES.has(payload.onboarding.activeFlow.status)
    ) {
      await this.syncAfterOnboardingMutation(payload.onboarding)
    } else if (!silent) {
      this.appendOnboardingSummaryLine(payload.onboarding)
    }

    return payload.onboarding
  }

  private async postOnboardingAction(body: Record<string, unknown>): Promise<WorkspaceOnboardingState> {
    const response = await authFetch(this.buildUrl("/api/onboarding"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    })

    const payload = (await response.json()) as OnboardingApiPayload
    if (!payload.onboarding) {
      throw new Error(payload.error ?? `Onboarding action failed with ${response.status}`)
    }

    this.applyOnboardingState(payload.onboarding)
    return payload.onboarding
  }

  private applyOnboardingState(onboarding: WorkspaceOnboardingState): void {
    if (!this.state.boot) return
    this.patchState({
      boot: cloneBootWithOnboarding(this.state.boot, onboarding),
    })
  }

  private async syncAfterOnboardingMutation(onboarding: WorkspaceOnboardingState): Promise<void> {
    this.applyOnboardingState(onboarding)
    this.appendOnboardingSummaryLine(onboarding)

    if (onboarding.lastValidation?.status === "succeeded" || onboarding.bridgeAuthRefresh.phase !== "idle") {
      void this.refreshBootAfterCurrentSettles({ soft: true })
    }
  }

  private appendOnboardingSummaryLine(onboarding: WorkspaceOnboardingState): void {
    const summary = summarizeOnboardingState(onboarding)
    if (!summary) return

    const lastLine = this.state.terminalLines.at(-1)
    if (lastLine?.type === summary.type && lastLine.content === summary.message) {
      return
    }

    this.patchState({
      terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine(summary.type, summary.message)),
    })
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private patchState(patch: Partial<WorkspaceStoreState>): void {
    this.state = { ...this.state, ...patch }
    this.syncOnboardingPoller()
    this.emit()
  }

  private syncOnboardingPoller(): void {
    if (this.disposed) {
      this.stopOnboardingPoller()
      return
    }

    const flowStatus = this.state.boot?.onboarding.activeFlow?.status
    const shouldPoll = Boolean(flowStatus && ACTIVE_ONBOARDING_FLOW_STATUSES.has(flowStatus))
    if (shouldPoll && !this.onboardingPollTimer) {
      this.onboardingPollTimer = setInterval(() => {
        if (this.state.onboardingRequestState !== "idle") return
        void this.fetchOnboardingState(true).catch((error) => {
          const message = normalizeClientError(error)
          this.patchState({
            lastClientError: message,
          })
        })
      }, 1500)
      return
    }

    if (!shouldPoll) {
      this.stopOnboardingPoller()
    }
  }

  private stopOnboardingPoller(): void {
    if (!this.onboardingPollTimer) return
    clearInterval(this.onboardingPollTimer)
    this.onboardingPollTimer = null
  }

  private ensureEventStream(): void {
    if (this.eventSource || this.disposed || this.state.boot?.onboarding.locked) return

    const stream = new EventSource(appendAuthParam(this.buildUrl("/api/session/events")))
    this.eventSource = stream

    stream.onopen = () => {
      const previousState = this.lastStreamState
      const wasDisconnected = previousState === "reconnecting" || previousState === "disconnected" || previousState === "error"
      if (wasDisconnected) {
        this.patchState({
          terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("success", "Live event stream reconnected")),
        })
      }
      this.lastStreamState = "connected"
      this.patchState({ connectionState: "connected", lastClientError: null })
      if (wasDisconnected) {
        void this.refreshBoot({ soft: true })
      }
    }

    stream.onmessage = (message) => {
      try {
        const parsed: unknown = JSON.parse(message.data)
        if (!isWorkspaceEvent(parsed)) {
          this.patchState({
            lastClientError: "Malformed event received from stream",
            terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", "Malformed event received from stream")),
          })
          return
        }
        this.handleEvent(parsed)
      } catch (error) {
        const text = normalizeClientError(error)
        this.patchState({
          lastClientError: text,
          terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Failed to parse stream event — ${text}`)),
        })
      }
    }

    stream.onerror = () => {
      const nextConnectionState = this.lastStreamState === "connected" ? "reconnecting" : "error"
      if (nextConnectionState !== this.lastStreamState) {
        this.patchState({
          connectionState: nextConnectionState,
          terminalLines: withTerminalLine(
            this.state.terminalLines,
            createTerminalLine(
              nextConnectionState === "reconnecting" ? "system" : "error",
              nextConnectionState === "reconnecting"
                ? "Live event stream disconnected — retrying…"
                : "Live event stream failed before connection was established",
            ),
          ),
        })
      } else {
        this.patchState({ connectionState: nextConnectionState })
      }
      this.lastStreamState = nextConnectionState
    }
  }

  private closeEventStream(): void {
    this.eventSource?.close()
    this.eventSource = null
  }

  private handleEvent(event: WorkspaceEvent): void {
    this.patchState({ lastEventType: event.type })

    if (event.type === "bridge_status") {
      this.recordBridgeStatus((event as BridgeStatusEvent).bridge)
      return
    }

    if (event.type === "live_state_invalidation") {
      this.handleLiveStateInvalidation(event as LiveStateInvalidationEvent)
    }

    // Route into structured live-interaction state (additive — summary lines still produced below)
    this.routeLiveInteractionEvent(event)

    const summary = summarizeEvent(event)
    if (!summary) return

    this.patchState({
      terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine(summary.type, summary.message)),
    })
  }

  private routeLiveInteractionEvent(event: WorkspaceEvent): void {
    switch (event.type) {
      case "extension_ui_request":
        this.handleExtensionUiRequest(event as ExtensionUiRequestEvent)
        break
      case "message_update":
        this.handleMessageUpdate(event as MessageUpdateEvent)
        break
      case "agent_end":
      case "turn_end":
        this.handleTurnBoundary()
        break
      case "tool_execution_start":
        this.handleToolExecutionStart(event as ToolExecutionStartEvent)
        break
      case "tool_execution_end":
        this.handleToolExecutionEnd(event as ToolExecutionEndEvent)
        break
      case "bridge_status":
        // Handled upstream in handleEvent with early return — never reaches here
        break
      case "live_state_invalidation":
        // Handled upstream in handleEvent via handleLiveStateInvalidation — no live interaction state update needed
        break
      case "extension_error":
        // Terminal line produced by summarizeEvent — no live interaction state update needed
        break
    }
  }

  private handleExtensionUiRequest(event: ExtensionUiRequestEvent): void {
    const method = event.method
    switch (method) {
      // Blocking methods → queue in pendingUiRequests
      case "select":
      case "confirm":
      case "input":
      case "editor":
        this.patchState({
          pendingUiRequests: [...this.state.pendingUiRequests, event as PendingUiRequest],
        })
        break
      // Fire-and-forget methods → update state maps
      case "notify":
        // notify still produces a terminal line (via summarizeEvent), but we don't store it in pendingUiRequests
        break
      case "setStatus":
        if (event.method === "setStatus") {
          const next = { ...this.state.statusTexts }
          if (event.statusText === undefined) {
            delete next[event.statusKey]
          } else {
            next[event.statusKey] = event.statusText
          }
          this.patchState({ statusTexts: next })
        }
        break
      case "setWidget":
        if (event.method === "setWidget") {
          const next = { ...this.state.widgetContents }
          if (event.widgetLines === undefined) {
            delete next[event.widgetKey]
          } else {
            next[event.widgetKey] = { lines: event.widgetLines, placement: event.widgetPlacement }
          }
          this.patchState({ widgetContents: next })
        }
        break
      case "setTitle":
        if (event.method === "setTitle") {
          const nextTitle = event.title.trim()
          this.patchState({ titleOverride: nextTitle ? nextTitle : null })
        }
        break
      case "set_editor_text":
        if (event.method === "set_editor_text") {
          this.patchState({ editorTextBuffer: event.text })
        }
        break
    }
  }

  private handleMessageUpdate(event: MessageUpdateEvent): void {
    const assistantEvent = event.assistantMessageEvent
    if (!assistantEvent) return
    if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
      // If we were accumulating thinking and now text arrives, finalize the thinking segment
      if (this.state.streamingThinkingText.length > 0) {
        this.patchState({
          currentTurnSegments: [...this.state.currentTurnSegments, { kind: "thinking", content: this.state.streamingThinkingText }],
          streamingThinkingText: "",
        })
      }
      this.patchState({
        streamingAssistantText: this.state.streamingAssistantText + assistantEvent.delta,
      })
    } else if (assistantEvent.type === "thinking_delta" && typeof assistantEvent.delta === "string") {
      // If we were accumulating text and now thinking arrives, finalize the text segment
      if (this.state.streamingAssistantText.length > 0) {
        this.patchState({
          currentTurnSegments: [...this.state.currentTurnSegments, { kind: "text", content: this.state.streamingAssistantText }],
          streamingAssistantText: "",
        })
      }
      this.patchState({
        streamingThinkingText: this.state.streamingThinkingText + assistantEvent.delta,
      })
    } else if (assistantEvent.type === "thinking_end") {
      // Finalize thinking segment
      if (this.state.streamingThinkingText.length > 0) {
        this.patchState({
          currentTurnSegments: [...this.state.currentTurnSegments, { kind: "thinking", content: this.state.streamingThinkingText }],
          streamingThinkingText: "",
        })
      }
    }
  }

  private handleTurnBoundary(): void {
    // Finalize any remaining streaming content into segments
    const pendingSegments: TurnSegment[] = []
    if (this.state.streamingThinkingText.length > 0) {
      pendingSegments.push({ kind: "thinking", content: this.state.streamingThinkingText })
    }
    if (this.state.streamingAssistantText.length > 0) {
      pendingSegments.push({ kind: "text", content: this.state.streamingAssistantText })
    }

    const finalSegments = pendingSegments.length > 0
      ? [...this.state.currentTurnSegments, ...pendingSegments]
      : this.state.currentTurnSegments

    // Build the flat transcript text (backward-compat for terminal.tsx / files-view.tsx)
    const fullText = finalSegments
      .filter((s): s is TurnSegment & { kind: "text" } => s.kind === "text")
      .map((s) => s.content)
      .join("")

    if (fullText.length > 0 || finalSegments.length > 0) {
      const nextTranscript = [...this.state.liveTranscript, fullText]
      const nextThinking = [...this.state.liveThinkingTranscript, ""]
      const nextSegments = [...this.state.completedTurnSegments, finalSegments]
      const overflow = nextTranscript.length > MAX_TRANSCRIPT_BLOCKS ? nextTranscript.length - MAX_TRANSCRIPT_BLOCKS : 0
      // When overflow trims the front of parallel arrays, also trim
      // chatUserMessages to keep index-based interleaving aligned (#2707).
      const trimmedUserMsgs = overflow > 0
        ? this.state.chatUserMessages.slice(overflow)
        : undefined
      this.patchState({
        liveTranscript: overflow > 0 ? nextTranscript.slice(overflow) : nextTranscript,
        liveThinkingTranscript: overflow > 0 ? nextThinking.slice(overflow) : nextThinking,
        completedTurnSegments: overflow > 0 ? nextSegments.slice(overflow) : nextSegments,
        ...(trimmedUserMsgs !== undefined ? { chatUserMessages: trimmedUserMsgs } : {}),
        streamingAssistantText: "",
        streamingThinkingText: "",
        currentTurnSegments: [],
        completedToolExecutions: [],
      })
    } else if (this.state.streamingThinkingText.length > 0) {
      // Turn ended with only thinking, no visible text — clear
      this.patchState({
        streamingThinkingText: "",
        currentTurnSegments: [],
        completedToolExecutions: [],
      })
    } else {
      // Empty turn — just reset
      this.patchState({
        currentTurnSegments: [],
        completedToolExecutions: [],
      })
    }
  }

  private handleToolExecutionStart(event: ToolExecutionStartEvent): void {
    // Finalize any in-flight streaming content into segments before the tool runs
    const pendingSegments: TurnSegment[] = []
    if (this.state.streamingThinkingText.length > 0) {
      pendingSegments.push({ kind: "thinking", content: this.state.streamingThinkingText })
    }
    if (this.state.streamingAssistantText.length > 0) {
      pendingSegments.push({ kind: "text", content: this.state.streamingAssistantText })
    }
    this.patchState({
      activeToolExecution: {
        id: event.toolCallId,
        name: event.toolName,
        args: (event as Record<string, unknown>).args as Record<string, unknown> | undefined,
      },
      ...(pendingSegments.length > 0 ? {
        currentTurnSegments: [...this.state.currentTurnSegments, ...pendingSegments],
        streamingAssistantText: "",
        streamingThinkingText: "",
      } : {}),
    })
  }

  private handleToolExecutionEnd(event: ToolExecutionEndEvent): void {
    const active = this.state.activeToolExecution
    if (active) {
      const completed: CompletedToolExecution = {
        id: active.id,
        name: active.name,
        args: active.args ?? {},
        result: {
          content: ((event as Record<string, unknown>).result as NonNullable<CompletedToolExecution["result"]> | undefined)?.content,
          details: ((event as Record<string, unknown>).result as NonNullable<CompletedToolExecution["result"]> | undefined)?.details,
          isError: event.isError,
        },
      }
      const next = [...this.state.completedToolExecutions, completed]
      this.patchState({
        activeToolExecution: null,
        completedToolExecutions: next.length > 50 ? next.slice(next.length - 50) : next,
        // Also push tool segment into chronological order
        currentTurnSegments: [...this.state.currentTurnSegments, { kind: "tool", tool: completed }],
      })
    } else {
      this.patchState({ activeToolExecution: null })
    }
  }

  private recordBridgeStatus(bridge: BridgeRuntimeSnapshot): void {
    const digest = [bridge.phase, bridge.activeSessionId, bridge.lastError?.at, bridge.lastError?.message].join("::")
    const shouldEmitLine = digest !== this.lastBridgeDigest
    this.lastBridgeDigest = digest

    const nextBoot = cloneBootWithBridge(this.state.boot, bridge)
    const nextLiveBase: WorkspaceLiveState = {
      ...this.state.live,
      resumableSessions: overlayLiveBridgeSessionState(this.state.live.resumableSessions, nextBoot),
    }
    const nextLive = {
      ...nextLiveBase,
      recoverySummary: createWorkspaceRecoverySummary({ boot: nextBoot, live: nextLiveBase }),
    }

    const nextPatch: Partial<WorkspaceStoreState> = {
      boot: nextBoot,
      live: nextLive,
      lastBridgeError: bridge.lastError,
      sessionAttached: hasAttachedSession(bridge),
      commandSurface: {
        ...this.state.commandSurface,
        sessionBrowser: syncSessionBrowserStateWithBridge(this.state.commandSurface.sessionBrowser, nextBoot),
      },
    }

    if (shouldEmitLine) {
      const summary = summarizeBridgeStatus(bridge)
      nextPatch.terminalLines = withTerminalLine(this.state.terminalLines, createTerminalLine(summary.type, summary.message))
    }

    this.patchState(nextPatch)
  }
}

const WorkspaceStoreContext = createContext<GSDWorkspaceStore | null>(null)

export function GSDWorkspaceProvider({ children, store: externalStore }: { children: ReactNode; store?: GSDWorkspaceStore }) {
  const [internalStore] = useState(() => new GSDWorkspaceStore())
  const store = externalStore ?? internalStore

  useEffect(() => {
    // Only start/dispose if using internal store (not externally managed)
    if (!externalStore) {
      store.start()
      return () => store.dispose()
    }
  }, [store, externalStore])

  return <WorkspaceStoreContext.Provider value={store}>{children}</WorkspaceStoreContext.Provider>
}

function useWorkspaceStore(): GSDWorkspaceStore {
  const store = useContext(WorkspaceStoreContext)
  if (!store) {
    throw new Error("useWorkspaceStore must be used within GSDWorkspaceProvider")
  }
  return store
}

export function useGSDWorkspaceState(): WorkspaceStoreState {
  const store = useWorkspaceStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useGSDWorkspaceActions(): Pick<
  GSDWorkspaceStore,
  | "sendCommand"
  | "submitInput"
  | "clearTerminalLines"
  | "consumeEditorTextBuffer"
  | "refreshBoot"
  | "refreshOnboarding"
  | "openCommandSurface"
  | "closeCommandSurface"
  | "setCommandSurfaceSection"
  | "selectCommandSurfaceTarget"
  | "loadGitSummary"
  | "loadRecoveryDiagnostics"
  | "loadForensicsDiagnostics"
  | "loadDoctorDiagnostics"
  | "applyDoctorFixes"
  | "loadSkillHealthDiagnostics"
  | "loadKnowledgeData"
  | "loadCapturesData"
  | "loadSettingsData"
  | "loadHistoryData"
  | "loadInspectData"
  | "loadHooksData"
  | "loadExportData"
  | "loadUndoInfo"
  | "loadCleanupData"
  | "loadSteerData"
  | "executeUndoAction"
  | "executeCleanupAction"
  | "resolveCaptureAction"
  | "updateSessionBrowserState"
  | "loadSessionBrowser"
  | "renameSessionFromSurface"
  | "loadAvailableModels"
  | "applyModelSelection"
  | "applyThinkingLevel"
  | "setSteeringModeFromSurface"
  | "setFollowUpModeFromSurface"
  | "setAutoCompactionFromSurface"
  | "setAutoRetryFromSurface"
  | "abortRetryFromSurface"
  | "switchSessionFromSurface"
  | "loadSessionStats"
  | "exportSessionFromSurface"
  | "loadForkMessages"
  | "forkSessionFromSurface"
  | "compactSessionFromSurface"
  | "saveApiKey"
  | "saveApiKeyFromSurface"
  | "startProviderFlow"
  | "startProviderFlowFromSurface"
  | "submitProviderFlowInput"
  | "submitProviderFlowInputFromSurface"
  | "cancelProviderFlow"
  | "cancelProviderFlowFromSurface"
  | "logoutProvider"
  | "logoutProviderFromSurface"
  | "respondToUiRequest"
  | "dismissUiRequest"
  | "sendSteer"
  | "sendAbort"
  | "pushChatUserMessage"
> {
  const store = useWorkspaceStore()
  return {
    sendCommand: store.sendCommand,
    submitInput: store.submitInput,
    clearTerminalLines: store.clearTerminalLines,
    consumeEditorTextBuffer: store.consumeEditorTextBuffer,
    refreshBoot: store.refreshBoot,
    refreshOnboarding: store.refreshOnboarding,
    openCommandSurface: store.openCommandSurface,
    closeCommandSurface: store.closeCommandSurface,
    setCommandSurfaceSection: store.setCommandSurfaceSection,
    selectCommandSurfaceTarget: store.selectCommandSurfaceTarget,
    loadGitSummary: store.loadGitSummary,
    loadRecoveryDiagnostics: store.loadRecoveryDiagnostics,
    loadForensicsDiagnostics: store.loadForensicsDiagnostics,
    loadDoctorDiagnostics: store.loadDoctorDiagnostics,
    applyDoctorFixes: store.applyDoctorFixes,
    loadSkillHealthDiagnostics: store.loadSkillHealthDiagnostics,
    loadKnowledgeData: store.loadKnowledgeData,
    loadCapturesData: store.loadCapturesData,
    loadSettingsData: store.loadSettingsData,
    loadHistoryData: store.loadHistoryData,
    loadInspectData: store.loadInspectData,
    loadHooksData: store.loadHooksData,
    loadExportData: store.loadExportData,
    loadUndoInfo: store.loadUndoInfo,
    loadCleanupData: store.loadCleanupData,
    loadSteerData: store.loadSteerData,
    executeUndoAction: store.executeUndoAction,
    executeCleanupAction: store.executeCleanupAction,
    resolveCaptureAction: store.resolveCaptureAction,
    updateSessionBrowserState: store.updateSessionBrowserState,
    loadSessionBrowser: store.loadSessionBrowser,
    renameSessionFromSurface: store.renameSessionFromSurface,
    loadAvailableModels: store.loadAvailableModels,
    applyModelSelection: store.applyModelSelection,
    applyThinkingLevel: store.applyThinkingLevel,
    setSteeringModeFromSurface: store.setSteeringModeFromSurface,
    setFollowUpModeFromSurface: store.setFollowUpModeFromSurface,
    setAutoCompactionFromSurface: store.setAutoCompactionFromSurface,
    setAutoRetryFromSurface: store.setAutoRetryFromSurface,
    abortRetryFromSurface: store.abortRetryFromSurface,
    switchSessionFromSurface: store.switchSessionFromSurface,
    loadSessionStats: store.loadSessionStats,
    exportSessionFromSurface: store.exportSessionFromSurface,
    loadForkMessages: store.loadForkMessages,
    forkSessionFromSurface: store.forkSessionFromSurface,
    compactSessionFromSurface: store.compactSessionFromSurface,
    saveApiKey: store.saveApiKey,
    saveApiKeyFromSurface: store.saveApiKeyFromSurface,
    startProviderFlow: store.startProviderFlow,
    startProviderFlowFromSurface: store.startProviderFlowFromSurface,
    submitProviderFlowInput: store.submitProviderFlowInput,
    submitProviderFlowInputFromSurface: store.submitProviderFlowInputFromSurface,
    cancelProviderFlow: store.cancelProviderFlow,
    cancelProviderFlowFromSurface: store.cancelProviderFlowFromSurface,
    logoutProvider: store.logoutProvider,
    logoutProviderFromSurface: store.logoutProviderFromSurface,
    respondToUiRequest: store.respondToUiRequest,
    dismissUiRequest: store.dismissUiRequest,
    sendSteer: store.sendSteer,
    sendAbort: store.sendAbort,
    pushChatUserMessage: store.pushChatUserMessage,
  }
}

export function buildPromptCommand(
  input: string,
  bridge: BridgeRuntimeSnapshot | null | undefined,
): WorkspaceBridgeCommand {
  const outcome = dispatchBrowserSlashCommand(input, {
    isStreaming: bridge?.sessionState?.isStreaming,
  })

  if (outcome.kind === "prompt" || outcome.kind === "rpc") {
    return outcome.command
  }

  throw new Error(
    `buildPromptCommand cannot serialize ${outcome.input || input} because browser dispatch resolved it to ${outcome.kind}; use submitInput() instead.`,
  )
}
