import {
  buildPromptCommand,
  type BridgeRuntimeSnapshot,
  type WorkspaceBridgeCommand,
  type WorkspaceTerminalLine,
} from "./gsd-workspace-store"

export type GSDViewName = "dashboard" | "power" | "chat" | "roadmap" | "files" | "activity" | "visualize" | "projects"

export function navigateToGSDView(view: GSDViewName): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("gsd:navigate-view", { detail: { view } }))
}

export function executeWorkflowActionInPowerMode({
  command,
  bridge,
  sendCommand,
}: {
  command: string
  bridge: BridgeRuntimeSnapshot | null | undefined
  sendCommand: (command: WorkspaceBridgeCommand) => Promise<unknown>
}): Promise<unknown> {
  const payload = buildPromptCommand(command, bridge)
  const request = sendCommand(payload)
  navigateToGSDView("power")
  return request
}

export function derivePendingWorkflowCommandLabel({
  commandInFlight,
  terminalLines,
}: {
  commandInFlight: string | null
  terminalLines: WorkspaceTerminalLine[]
}): string | null {
  if (!commandInFlight) return null

  for (let index = terminalLines.length - 1; index >= 0; index -= 1) {
    const line = terminalLines[index]
    if (line.type !== "input") continue
    const text = line.content.trim()
    if (text) return text
  }

  if (commandInFlight === "prompt") return "Sending command"
  return `/${commandInFlight}`
}
