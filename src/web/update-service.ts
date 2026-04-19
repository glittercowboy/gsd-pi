import { spawn } from "node:child_process"
import { compareSemver } from "../update-check.ts"

const NPM_PACKAGE_NAME = "gsd-pi"
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`
const FETCH_TIMEOUT_MS = 5000
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm"

// --- Version check ---

interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = process.env.GSD_VERSION || "0.0.0"

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) {
      return { currentVersion, latestVersion: currentVersion, updateAvailable: false }
    }

    const data = (await res.json()) as { version?: string }
    const latestVersion = data.version || currentVersion

    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    }
  } catch {
    // Network error or timeout — report no update available
    return { currentVersion, latestVersion: currentVersion, updateAvailable: false }
  } finally {
    clearTimeout(timeout)
  }
}

// --- Update state singleton ---

interface UpdateState {
  status: "idle" | "running" | "success" | "error"
  error?: string
  targetVersion?: string
}

let updateState: UpdateState = { status: "idle" }

export function getUpdateStatus(): UpdateState {
  return { ...updateState }
}

/**
 * Triggers an async global npm install of gsd-pi@latest.
 * Returns `true` if the update was started, `false` if one is already running.
 * The child process runs in the background; poll `getUpdateStatus()` for progress.
 */
export function triggerUpdate(targetVersion?: string): boolean {
  if (updateState.status === "running") {
    return false
  }

  updateState = { status: "running", targetVersion }

  const child = spawn(NPM_COMMAND, ["install", "-g", "gsd-pi@latest"], {
    stdio: ["ignore", "ignore", "pipe"],
    // Detach so the child process is not killed if the parent exits
    detached: false,
    windowsHide: true,
    // Avoid shell: true — npm.cmd is directly executable on Windows via spawn.
    // Using shell expands the command injection surface unnecessarily.
  })

  let stderr = ""

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  child.on("close", (code) => {
    if (code === 0) {
      updateState = { status: "success", targetVersion }
    } else {
      updateState = {
        status: "error",
        error: stderr.trim() || `npm install exited with code ${code}`,
        targetVersion,
      }
    }
  })

  child.on("error", (err) => {
    updateState = {
      status: "error",
      error: err.message,
      targetVersion,
    }
  })

  return true
}
