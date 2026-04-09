// GSD Web — Notifications Service
// Loads notification data via a child process that imports the notification store.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag, resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"

export interface NotificationsData {
  entries: Array<{
    id: string
    ts: string
    severity: string
    message: string
    source: string
    read: boolean
  }>
  unreadCount: number
  totalCount: number
}

const NOTIFICATIONS_MAX_BUFFER = 2 * 1024 * 1024
const NOTIFICATIONS_MODULE_ENV = "GSD_NOTIFICATIONS_MODULE"

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

export async function collectNotificationsData(projectCwdOverride?: string): Promise<NotificationsData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/notification-store.ts")
  const modulePath = moduleResolution.modulePath

  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(modulePath))) {
    throw new Error(
      `notifications data provider not found; checked=${resolveTsLoader},${modulePath}`,
    )
  }
  if (moduleResolution.useCompiledJs && !existsSync(modulePath)) {
    throw new Error(`notifications data provider not found; checked=${modulePath}`)
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${NOTIFICATIONS_MODULE_ENV}).href);`,
    'const basePath = process.env.GSD_NOTIFICATIONS_BASE;',
    'const entries = mod.readNotifications(basePath);',
    'const unread = entries.filter(e => !e.read).length;',
    'const result = { entries, unreadCount: unread, totalCount: entries.length };',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<NotificationsData>((resolveResult, reject) => {
    execFile(
      process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          [NOTIFICATIONS_MODULE_ENV]: modulePath,
          GSD_NOTIFICATIONS_BASE: projectCwd,
        },
        maxBuffer: NOTIFICATIONS_MAX_BUFFER,
        timeout: 10_000,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`notifications subprocess failed: ${err.message}${stderr ? `\nstderr: ${stderr}` : ""}`))
          return
        }
        try {
          const parsed = JSON.parse(stdout) as NotificationsData
          resolveResult(parsed)
        } catch (parseErr) {
          reject(new Error(`Failed to parse notifications output: ${(parseErr as Error).message}`))
        }
      },
    )
  })
}

export async function clearNotificationsData(projectCwdOverride?: string): Promise<void> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/notification-store.ts")
  const modulePath = moduleResolution.modulePath

  if (moduleResolution.useCompiledJs && !existsSync(modulePath)) {
    throw new Error(`notifications data provider not found; checked=${modulePath}`)
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${NOTIFICATIONS_MODULE_ENV}).href);`,
    'mod.clearNotifications(process.env.GSD_NOTIFICATIONS_BASE);',
    'process.stdout.write("ok");',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<void>((resolveResult, reject) => {
    execFile(
      process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          [NOTIFICATIONS_MODULE_ENV]: modulePath,
          GSD_NOTIFICATIONS_BASE: projectCwd,
        },
        maxBuffer: NOTIFICATIONS_MAX_BUFFER,
        timeout: 10_000,
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`clear notifications subprocess failed: ${err.message}${stderr ? `\nstderr: ${stderr}` : ""}`))
          return
        }
        resolveResult()
      },
    )
  })
}
