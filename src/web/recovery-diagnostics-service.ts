import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  collectCurrentProjectOnboardingState,
  collectSelectiveLiveStatePayload,
  resolveBridgeRuntimeConfig,
} from "./bridge-service.ts"
import { resolveTypeStrippingFlag, resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"
import type {
  WorkspaceRecoveryBrowserAction,
  WorkspaceRecoveryCodeSummary,
  WorkspaceRecoveryCommandSuggestion,
  WorkspaceRecoveryDiagnostics,
  WorkspaceRecoveryIssueDigest,
  WorkspaceRecoverySummaryTone,
} from "../../web/lib/command-surface-contract.ts"

const RECOVERY_DIAGNOSTICS_MAX_BUFFER = 1024 * 1024

type RecoveryDiagnosticsSeverity = "info" | "warning" | "error"

interface RecoveryDiagnosticsServiceOptions {
  execPath?: string
  env?: NodeJS.ProcessEnv
  existsSync?: (path: string) => boolean
}

interface RecoveryDiagnosticsChildIssue {
  code: string
  severity: RecoveryDiagnosticsSeverity
  scope: string
  message: string
  file?: string
  suggestion?: string
  unitId?: string
}

interface RecoveryDiagnosticsChildPayload {
  doctor: {
    scope: string | null
    total: number
    errors: number
    warnings: number
    infos: number
    fixable: number
    codes: Array<{ code: string; count: number }>
    topIssues: RecoveryDiagnosticsChildIssue[]
  }
  interruptedRun: {
    available: boolean
    detected: boolean
    label: string
    detail: string
    unit: {
      type: string
      id: string
    } | null
    counts: {
      toolCalls: number
      filesWritten: number
      commandsRun: number
      errors: number
    }
    gitChangesDetected: boolean
    lastError: string | null
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)["'=:\s]+)([^\s,;"']+)/gi, "$1[redacted]")
}

function sanitizeText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "")
  return redactSensitiveText(raw).replace(/\s+/g, " ").trim()
}

function humanizeCode(code: string): string {
  return code.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

function activeScopeFromWorkspace(workspace: Awaited<ReturnType<typeof collectSelectiveLiveStatePayload>>["workspace"]): string | null {
  if (!workspace?.active.milestoneId) return null
  if (workspace.active.taskId && workspace.active.sliceId) {
    return `${workspace.active.milestoneId}/${workspace.active.sliceId}/${workspace.active.taskId}`
  }
  if (workspace.active.sliceId) {
    return `${workspace.active.milestoneId}/${workspace.active.sliceId}`
  }
  return workspace.active.milestoneId
}

function recoveryUnitFromWorkspace(workspace: Awaited<ReturnType<typeof collectSelectiveLiveStatePayload>>["workspace"]): { type: string; id: string } | null {
  const scope = activeScopeFromWorkspace(workspace)
  if (!scope) return null

  if (workspace?.active.taskId) {
    return { type: "execute-task", id: scope }
  }
  if (workspace?.active.sliceId) {
    return { type: "execute-slice", id: scope }
  }
  return { type: "execute-milestone", id: scope }
}

function selectRecoverySessionFile(
  activeSessionFile: string | null | undefined,
  resumableSessions: Array<{ id: string; path: string }>,
): string | null {
  if (!activeSessionFile) {
    return resumableSessions[0]?.path ?? null
  }

  const normalizedActiveSessionFile = resolve(activeSessionFile)
  const matchingCurrentProjectSession = resumableSessions.find((session) => resolve(session.path) === normalizedActiveSessionFile)
  if (matchingCurrentProjectSession) {
    return matchingCurrentProjectSession.path
  }

  return resumableSessions[0]?.path ?? activeSessionFile
}

function selectRecoverySessionId(
  activeSessionId: string | null | undefined,
  sessionFile: string | null,
  resumableSessions: Array<{ id: string; path: string }>,
): string | null {
  if (!sessionFile) return activeSessionId ?? null

  const normalizedSessionFile = resolve(sessionFile)
  return resumableSessions.find((session) => resolve(session.path) === normalizedSessionFile)?.id ?? activeSessionId ?? null
}

function summarizeSeverityCounts(issues: Array<{ severity: RecoveryDiagnosticsSeverity }>): {
  errors: number
  warnings: number
  infos: number
} {
  return issues.reduce(
    (counts, issue) => ({
      errors: counts.errors + Number(issue.severity === "error"),
      warnings: counts.warnings + Number(issue.severity === "warning"),
      infos: counts.infos + Number(issue.severity === "info"),
    }),
    { errors: 0, warnings: 0, infos: 0 },
  )
}

function summarizeCodes(
  issues: Array<{ code: string; severity: RecoveryDiagnosticsSeverity }>,
): WorkspaceRecoveryCodeSummary[] {
  const map = new Map<string, { count: number; severity: RecoveryDiagnosticsSeverity }>()
  const severityRank: Record<RecoveryDiagnosticsSeverity, number> = { info: 0, warning: 1, error: 2 }

  for (const issue of issues) {
    const current = map.get(issue.code)
    if (!current) {
      map.set(issue.code, { count: 1, severity: issue.severity })
      continue
    }

    map.set(issue.code, {
      count: current.count + 1,
      severity: severityRank[issue.severity] > severityRank[current.severity] ? issue.severity : current.severity,
    })
  }

  return [...map.entries()]
    .map(([code, data]) => ({
      code,
      count: data.count,
      label: humanizeCode(code),
      severity: data.severity,
    }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
}

function sanitizeIssueDigest(issue: RecoveryDiagnosticsChildIssue): WorkspaceRecoveryIssueDigest {
  return {
    code: issue.code,
    severity: issue.severity,
    scope: issue.scope,
    message: sanitizeText(issue.message),
    file: issue.file,
    suggestion: issue.suggestion ? sanitizeText(issue.suggestion) : undefined,
    unitId: issue.unitId,
  }
}

function buildCommandSuggestions(
  activeScope: string | null,
  phase: string | undefined,
  validationCount: number,
): WorkspaceRecoveryCommandSuggestion[] {
  const suggestions = new Map<string, WorkspaceRecoveryCommandSuggestion>()
  const add = (command: string, label: string) => {
    if (!suggestions.has(command)) {
      suggestions.set(command, { command, label })
    }
  }

  if (phase === "planning") add("/gsd", "Open GSD planning")
  if (phase === "executing" || phase === "summarizing") add("/gsd auto", "Resume GSD auto mode")
  if (activeScope) add(`/gsd doctor ${activeScope}`, "Inspect scoped doctor report")
  if (activeScope) add(`/gsd doctor fix ${activeScope}`, "Apply scoped doctor fixes")
  if (validationCount > 0 && activeScope) add(`/gsd doctor audit ${activeScope}`, "Audit validation diagnostics")
  add("/gsd status", "Check current-project status")

  return [...suggestions.values()]
}

function buildBrowserActions(options: {
  hasSessions: boolean
  retryActive: boolean
  autoRetryEnabled: boolean
  bridgeFailure: boolean
  compactionActive: boolean
  authAttentionNeeded: boolean
}): WorkspaceRecoveryBrowserAction[] {
  const actions = new Map<WorkspaceRecoveryBrowserAction["id"], WorkspaceRecoveryBrowserAction>()
  const add = (action: WorkspaceRecoveryBrowserAction) => {
    actions.set(action.id, action)
  }

  add({
    id: "refresh_diagnostics",
    label: "Refresh diagnostics",
    detail: "Reload the on-demand recovery route without refreshing the entire workspace.",
    emphasis: "primary",
  })
  add({
    id: "refresh_workspace",
    label: "Refresh workspace",
    detail: "Run one soft workspace refresh so the browser re-syncs boot, bridge, and onboarding state.",
  })

  if (options.retryActive || options.autoRetryEnabled || options.bridgeFailure || options.compactionActive) {
    add({
      id: "open_retry_controls",
      label: "Open retry controls",
      detail: "Inspect or change live retry and compaction controls on the authoritative browser surface.",
    })
  }

  if (options.hasSessions) {
    add({
      id: "open_resume_controls",
      label: "Open resume controls",
      detail: "Switch to another current-project session if recovery should continue elsewhere.",
    })
  }

  if (options.authAttentionNeeded) {
    add({
      id: "open_auth_controls",
      label: "Open auth controls",
      detail: "Inspect provider setup and bridge auth refresh failures from the shared browser surface.",
      emphasis: "danger",
    })
  }

  return [...actions.values()]
}

function resolveSummary(options: {
  status: WorkspaceRecoveryDiagnostics["status"]
  validationCount: number
  validationErrors: number
  doctorTotal: number
  doctorErrors: number
  retryAttempt: number
  retryInProgress: boolean
  compactionActive: boolean
  currentUnitId: string | null
  lastFailurePhase: string | null
  bridgeFailureMessage: string | null
  authFailureMessage: string | null
  interruptedRunDetected: boolean
  interruptedRunDetail: string
}): { tone: WorkspaceRecoverySummaryTone; label: string; detail: string } {
  if (options.authFailureMessage) {
    return {
      tone: "danger",
      label: "Bridge auth refresh failed",
      detail: options.authFailureMessage,
    }
  }

  if (options.bridgeFailureMessage) {
    return {
      tone: "danger",
      label: options.lastFailurePhase ? `Bridge recovery failed during ${options.lastFailurePhase}` : "Bridge recovery failed",
      detail: options.bridgeFailureMessage,
    }
  }

  if (options.doctorErrors > 0 || options.validationErrors > 0) {
    return {
      tone: "danger",
      label: `Recovery blockers detected (${options.doctorErrors + options.validationErrors})`,
      detail: `Doctor and validation surfaced blocking issues for ${options.currentUnitId ?? "the current project"}.`,
    }
  }

  if (options.retryInProgress) {
    return {
      tone: "warning",
      label: `Retry attempt ${Math.max(1, options.retryAttempt)} is active`,
      detail: "The bridge is retrying work right now; inspect retry controls before issuing more recovery actions.",
    }
  }

  if (options.compactionActive) {
    return {
      tone: "warning",
      label: "Compaction is active",
      detail: "The live session is compacting context before work continues.",
    }
  }

  if (options.validationCount > 0 || options.doctorTotal > 0) {
    return {
      tone: "warning",
      label: `Recovery diagnostics found ${options.validationCount + options.doctorTotal} actionable issue${options.validationCount + options.doctorTotal === 1 ? "" : "s"}`,
      detail: `Review the doctor and validation sections below before resuming work on ${options.currentUnitId ?? "the current project"}.`,
    }
  }

  if (options.interruptedRunDetected) {
    return {
      tone: "warning",
      label: "Interrupted-run evidence is available",
      detail: options.interruptedRunDetail,
    }
  }

  if (options.status === "unavailable") {
    return {
      tone: "healthy",
      label: "Recovery diagnostics unavailable",
      detail: "No current-project recovery evidence has been captured yet. Start or resume a session to populate diagnostics.",
    }
  }

  return {
    tone: "healthy",
    label: "Recovery diagnostics healthy",
    detail: "No bridge, validation, doctor, or interrupted-run recovery issues are currently active.",
  }
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

async function collectRecoveryDiagnosticsChildPayload(
  packageRoot: string,
  basePath: string,
  scope: string | null,
  unit: { type: string; id: string } | null,
  sessionFile: string | null,
  options: RecoveryDiagnosticsServiceOptions,
): Promise<RecoveryDiagnosticsChildPayload> {
  const env = options.env ?? process.env
  const checkExists = options.existsSync ?? existsSync
  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const doctorResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/doctor.ts", checkExists)
  const forensicsResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/session-forensics.ts", checkExists)
  const doctorModulePath = doctorResolution.modulePath
  const sessionForensicsModulePath = forensicsResolution.modulePath

  if (!doctorResolution.useCompiledJs && (!checkExists(resolveTsLoader) || !checkExists(doctorModulePath) || !checkExists(sessionForensicsModulePath))) {
    throw new Error(
      `recovery diagnostics providers not found; checked=${resolveTsLoader},${doctorModulePath},${sessionForensicsModulePath}`,
    )
  }
  if (doctorResolution.useCompiledJs && (!checkExists(doctorModulePath) || !checkExists(sessionForensicsModulePath))) {
    throw new Error(
      `recovery diagnostics providers not found; checked=${doctorModulePath},${sessionForensicsModulePath}`,
    )
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    'const doctor = await import(pathToFileURL(process.env.GSD_RECOVERY_DOCTOR_MODULE).href);',
    'const forensics = await import(pathToFileURL(process.env.GSD_RECOVERY_FORENSICS_MODULE).href);',
    'const basePath = process.env.GSD_RECOVERY_BASE;',
    'const scope = process.env.GSD_RECOVERY_SCOPE || undefined;',
    'const unitType = process.env.GSD_RECOVERY_UNIT_TYPE || "execute-project";',
    'const unitId = process.env.GSD_RECOVERY_UNIT_ID || "project";',
    'const sessionFile = process.env.GSD_RECOVERY_SESSION_FILE || undefined;',
    'const activityDir = process.env.GSD_RECOVERY_ACTIVITY_DIR || undefined;',
    'const report = await doctor.runGSDDoctor(basePath, { fix: false, scope, fixLevel: "task" });',
    'const summary = doctor.summarizeDoctorIssues(report.issues);',
    'const briefing = forensics.synthesizeCrashRecovery(basePath, unitType, unitId, sessionFile, activityDir);',
    'const trace = briefing?.trace;',
    'const available = Boolean(sessionFile || trace?.toolCallCount || briefing?.gitChanges);',
    'const detected = Boolean((trace?.toolCallCount ?? 0) > 0 || (trace?.errors?.length ?? 0) > 0 || (trace?.commandsRun?.length ?? 0) > 0 || (trace?.filesWritten?.length ?? 0) > 0 || briefing?.gitChanges);',
    'const interruptedRun = available',
    '  ? detected',
    '    ? {',
    '        available: true,',
    '        detected: true,',
    '        label: "Interrupted-run recovery available",',
    '        detail: "Recent session forensics captured unfinished work or errors that may need resume or retry follow-up.",',
    '        unit: { type: briefing?.unitType ?? unitType, id: briefing?.unitId ?? unitId },',
    '        counts: {',
    '          toolCalls: trace?.toolCallCount ?? 0,',
    '          filesWritten: trace?.filesWritten?.length ?? 0,',
    '          commandsRun: trace?.commandsRun?.length ?? 0,',
    '          errors: trace?.errors?.length ?? 0,',
    '        },',
    '        gitChangesDetected: Boolean(briefing?.gitChanges),',
    '        lastError: trace?.errors?.at(-1) ?? null,',
    '      }',
    '    : {',
    '        available: true,',
    '        detected: false,',
    '        label: "Session forensics available",',
    '        detail: "A current-project session was inspected, but it did not show unfinished tool or error activity.",',
    '        unit: { type: briefing?.unitType ?? unitType, id: briefing?.unitId ?? unitId },',
    '        counts: {',
    '          toolCalls: trace?.toolCallCount ?? 0,',
    '          filesWritten: trace?.filesWritten?.length ?? 0,',
    '          commandsRun: trace?.commandsRun?.length ?? 0,',
    '          errors: trace?.errors?.length ?? 0,',
    '        },',
    '        gitChangesDetected: Boolean(briefing?.gitChanges),',
    '        lastError: trace?.errors?.at(-1) ?? null,',
    '      }',
    '  : {',
    '      available: false,',
    '      detected: false,',
    '      label: "No interrupted-run evidence",',
    '      detail: "No current-project session or activity log is available for interrupted-run forensics yet.",',
    '      unit: null,',
    '      counts: { toolCalls: 0, filesWritten: 0, commandsRun: 0, errors: 0 },',
    '      gitChangesDetected: false,',
    '      lastError: null,',
    '    };',
    'process.stdout.write(JSON.stringify({',
    '  doctor: {',
    '    scope: scope ?? null,',
    '    total: summary.total,',
    '    errors: summary.errors,',
    '    warnings: summary.warnings,',
    '    infos: summary.infos,',
    '    fixable: summary.fixable,',
    '    codes: summary.byCode,',
    '    topIssues: report.issues.slice(0, 6).map((issue) => ({',
    '      code: issue.code,',
    '      severity: issue.severity,',
    '      scope: issue.scope,',
    '      message: issue.message,',
    '      file: issue.file,',
    '      unitId: issue.unitId,',
    '    })),',
    '  },',
    '  interruptedRun,',
    '}));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, doctorResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<RecoveryDiagnosticsChildPayload>((resolveResult, reject) => {
    execFile(
      options.execPath ?? process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script,
      ],
      {
        cwd: packageRoot,
        env: {
          ...env,
          GSD_RECOVERY_BASE: basePath,
          GSD_RECOVERY_SCOPE: scope ?? "",
          GSD_RECOVERY_UNIT_TYPE: unit?.type ?? "execute-project",
          GSD_RECOVERY_UNIT_ID: unit?.id ?? "project",
          GSD_RECOVERY_SESSION_FILE: sessionFile ?? "",
          GSD_RECOVERY_ACTIVITY_DIR: join(basePath, ".gsd", "activity"),
          GSD_RECOVERY_DOCTOR_MODULE: doctorModulePath,
          GSD_RECOVERY_FORENSICS_MODULE: sessionForensicsModulePath,
        },
        maxBuffer: RECOVERY_DIAGNOSTICS_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`recovery diagnostics subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as RecoveryDiagnosticsChildPayload)
        } catch (parseError) {
          reject(
            new Error(
              `recovery diagnostics subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}

export async function collectCurrentProjectRecoveryDiagnostics(
  options: RecoveryDiagnosticsServiceOptions = {},
  projectCwdOverride?: string,
): Promise<WorkspaceRecoveryDiagnostics> {
  const env = options.env ?? process.env
  const config = resolveBridgeRuntimeConfig(options.env, projectCwdOverride)
  const [{ bridge: bridgeSnapshot, workspace, resumableSessions: resumableSessionsRaw }, onboarding] = await Promise.all([
    collectSelectiveLiveStatePayload(["workspace", "resumable_sessions"], projectCwdOverride),
    collectCurrentProjectOnboardingState(projectCwdOverride),
  ])
  const resumableSessions = resumableSessionsRaw ?? []

  const activeScope = activeScopeFromWorkspace(workspace)
  const unit = recoveryUnitFromWorkspace(workspace)
  const sessionFile = selectRecoverySessionFile(bridgeSnapshot.activeSessionFile, resumableSessions)
  const recoverySessionId = selectRecoverySessionId(bridgeSnapshot.activeSessionId, sessionFile, resumableSessions)
  const recoveryChild = await collectRecoveryDiagnosticsChildPayload(
    config.packageRoot,
    config.projectCwd,
    activeScope,
    unit,
    sessionFile,
    options,
  )

  const validationIssues = (workspace?.validationIssues ?? []).map((issue) => {
    const typedIssue = issue as {
      ruleId?: string
      severity?: RecoveryDiagnosticsSeverity
      scope?: string
      message?: string
      file?: string
      suggestion?: string
    }
    return {
      code: typedIssue.ruleId ?? "unknown_validation_issue",
      severity: (typedIssue.severity ?? "warning") as RecoveryDiagnosticsSeverity,
      scope: typedIssue.scope ?? "workspace",
      message: sanitizeText(typedIssue.message ?? "Validation issue"),
      file: typedIssue.file,
      suggestion: typedIssue.suggestion ? sanitizeText(typedIssue.suggestion) : undefined,
    } satisfies WorkspaceRecoveryIssueDigest
  })
  const validationCounts = summarizeSeverityCounts(validationIssues)
  const validationCodes = summarizeCodes(validationIssues)

  const doctorTopIssues = recoveryChild.doctor.topIssues.map(sanitizeIssueDigest)
  const interruptedRun = {
    ...recoveryChild.interruptedRun,
    label: sanitizeText(recoveryChild.interruptedRun.label),
    detail: sanitizeText(recoveryChild.interruptedRun.detail),
    lastError: recoveryChild.interruptedRun.lastError ? sanitizeText(recoveryChild.interruptedRun.lastError) : null,
  }

  const bridgeFailure = bridgeSnapshot.lastError
    ? {
        message: sanitizeText(bridgeSnapshot.lastError.message),
        phase: bridgeSnapshot.lastError.phase,
        at: bridgeSnapshot.lastError.at,
        commandType: bridgeSnapshot.lastError.commandType ?? null,
        afterSessionAttachment: bridgeSnapshot.lastError.afterSessionAttachment,
      }
    : null

  const authRefreshPhase = onboarding.bridgeAuthRefresh.phase
  const authRefreshError = onboarding.bridgeAuthRefresh.error ? sanitizeText(onboarding.bridgeAuthRefresh.error) : null
  const authRefreshLabel =
    authRefreshPhase === "failed"
      ? "Bridge auth refresh failed"
      : authRefreshPhase === "pending"
        ? "Bridge auth refresh pending"
        : authRefreshPhase === "succeeded"
          ? "Bridge auth refresh succeeded"
          : "Bridge auth refresh idle"

  const status: WorkspaceRecoveryDiagnostics["status"] =
    bridgeFailure ||
    authRefreshPhase === "failed" ||
    validationIssues.length > 0 ||
    recoveryChild.doctor.total > 0 ||
    interruptedRun.available ||
    resumableSessions.length > 0 ||
    Boolean(bridgeSnapshot.sessionState?.retryInProgress) ||
    Boolean(bridgeSnapshot.sessionState?.isCompacting)
      ? "ready"
      : "unavailable"

  const currentUnitId = unit?.id ?? activeScope
  const summary = resolveSummary({
    status,
    validationCount: validationIssues.length,
    validationErrors: validationCounts.errors,
    doctorTotal: recoveryChild.doctor.total,
    doctorErrors: recoveryChild.doctor.errors,
    retryAttempt: bridgeSnapshot.sessionState?.retryAttempt ?? 0,
    retryInProgress: Boolean(bridgeSnapshot.sessionState?.retryInProgress),
    compactionActive: Boolean(bridgeSnapshot.sessionState?.isCompacting),
    currentUnitId: currentUnitId ?? null,
    lastFailurePhase: authRefreshPhase === "failed" ? "bridge_auth_refresh" : bridgeFailure?.phase ?? null,
    bridgeFailureMessage: bridgeFailure?.message ?? null,
    authFailureMessage: authRefreshPhase === "failed" ? authRefreshError : null,
    interruptedRunDetected: interruptedRun.detected,
    interruptedRunDetail: interruptedRun.detail,
  })

  return {
    status,
    loadedAt: new Date().toISOString(),
    project: {
      cwd: config.projectCwd,
      activeScope,
      activeSessionPath: sessionFile,
      activeSessionId: recoverySessionId,
    },
    summary: {
      tone: summary.tone,
      label: summary.label,
      detail: summary.detail,
      validationCount: validationIssues.length,
      doctorIssueCount: recoveryChild.doctor.total,
      lastFailurePhase: authRefreshPhase === "failed" ? "bridge_auth_refresh" : bridgeFailure?.phase ?? null,
      currentUnitId: currentUnitId ?? null,
      retryAttempt: bridgeSnapshot.sessionState?.retryAttempt ?? 0,
      retryInProgress: Boolean(bridgeSnapshot.sessionState?.retryInProgress),
      compactionActive: Boolean(bridgeSnapshot.sessionState?.isCompacting),
    },
    bridge: {
      phase: bridgeSnapshot.phase,
      retry: {
        enabled: Boolean(bridgeSnapshot.sessionState?.autoRetryEnabled),
        inProgress: Boolean(bridgeSnapshot.sessionState?.retryInProgress),
        attempt: bridgeSnapshot.sessionState?.retryAttempt ?? 0,
        label: bridgeSnapshot.sessionState?.retryInProgress
          ? `Attempt ${Math.max(1, bridgeSnapshot.sessionState?.retryAttempt ?? 0)}`
          : bridgeSnapshot.sessionState?.autoRetryEnabled
            ? "Enabled"
            : "Disabled",
      },
      compaction: {
        active: Boolean(bridgeSnapshot.sessionState?.isCompacting),
        label: bridgeSnapshot.sessionState?.isCompacting ? "Compaction active" : "Compaction idle",
      },
      lastFailure: bridgeFailure,
      authRefresh: {
        phase: authRefreshPhase,
        error: authRefreshError,
        label: authRefreshLabel,
      },
    },
    validation: {
      total: validationIssues.length,
      bySeverity: validationCounts,
      codes: validationCodes,
      topIssues: validationIssues.slice(0, 6),
    },
    doctor: {
      scope: recoveryChild.doctor.scope,
      total: recoveryChild.doctor.total,
      errors: recoveryChild.doctor.errors,
      warnings: recoveryChild.doctor.warnings,
      infos: recoveryChild.doctor.infos,
      fixable: recoveryChild.doctor.fixable,
      codes: recoveryChild.doctor.codes,
      topIssues: doctorTopIssues,
    },
    interruptedRun,
    actions: {
      browser: buildBrowserActions({
        hasSessions: resumableSessions.length > 0,
        retryActive: Boolean(bridgeSnapshot.sessionState?.retryInProgress),
        autoRetryEnabled: Boolean(bridgeSnapshot.sessionState?.autoRetryEnabled),
        bridgeFailure: Boolean(bridgeFailure),
        compactionActive: Boolean(bridgeSnapshot.sessionState?.isCompacting),
        authAttentionNeeded:
          onboarding.locked || authRefreshPhase === "failed" || onboarding.lastValidation?.status === "failed",
      }),
      commands: buildCommandSuggestions(activeScope, workspace?.active.phase, validationIssues.length),
    },
  }
}
