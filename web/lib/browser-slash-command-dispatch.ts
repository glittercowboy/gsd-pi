import { BUILTIN_SLASH_COMMANDS } from "../../packages/pi-coding-agent/src/core/slash-commands.ts"

export type BrowserSlashCommandSurface =
  | "settings"
  | "model"
  | "thinking"
  | "git"
  | "resume"
  | "name"
  | "fork"
  | "compact"
  | "login"
  | "logout"
  | "session"
  | "export"

export type BrowserSlashCommandLocalAction = "clear_terminal" | "refresh_workspace"

export type BrowserSlashPromptCommandType = "prompt" | "follow_up"

export interface BrowserSlashCommandDispatchOptions {
  isStreaming?: boolean
}

export type BrowserSlashCommandDispatchResult =
  | {
      kind: "prompt"
      input: string
      slashCommandName: string | null
      command: {
        type: BrowserSlashPromptCommandType
        message: string
      }
    }
  | {
      kind: "rpc"
      input: string
      commandName: string
      command:
        | { type: "get_state" }
        | { type: "new_session" }
    }
  | {
      kind: "surface"
      input: string
      commandName: string
      surface: BrowserSlashCommandSurface
      args: string
    }
  | {
      kind: "local"
      input: string
      commandName: string
      action: BrowserSlashCommandLocalAction
    }
  | {
      kind: "reject"
      input: string
      commandName: string
      reason: string
      guidance: string
    }

export interface BrowserSlashCommandTerminalNotice {
  type: "system" | "error"
  message: string
}

const BUILTIN_COMMAND_DESCRIPTIONS = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command.description]))
const BUILTIN_COMMAND_NAMES = new Set(BUILTIN_COMMAND_DESCRIPTIONS.keys())

const SURFACE_COMMANDS = new Map<string, BrowserSlashCommandSurface>([
  ["settings", "settings"],
  ["model", "model"],
  ["thinking", "thinking"],
  ["git", "git"],
  ["resume", "resume"],
  ["name", "name"],
  ["fork", "fork"],
  ["compact", "compact"],
  ["login", "login"],
  ["logout", "logout"],
  ["session", "session"],
  ["export", "export"],
])

function parseSlashCommand(input: string): { name: string; args: string } | null {
  if (!input.startsWith("/")) return null
  const body = input.slice(1).trim()
  if (!body) return null

  const firstSpaceIndex = body.search(/\s/)
  if (firstSpaceIndex === -1) {
    return { name: body, args: "" }
  }

  return {
    name: body.slice(0, firstSpaceIndex),
    args: body.slice(firstSpaceIndex + 1).trim(),
  }
}

function getPromptCommandType(options: BrowserSlashCommandDispatchOptions): BrowserSlashPromptCommandType {
  return options.isStreaming ? "follow_up" : "prompt"
}

function formatBuiltinDescription(commandName: string): string {
  return BUILTIN_COMMAND_DESCRIPTIONS.get(commandName) ?? "Browser handling is reserved for this built-in command."
}

function buildDeferredBuiltinReject(input: string, commandName: string): BrowserSlashCommandDispatchResult {
  const description = formatBuiltinDescription(commandName)
  return {
    kind: "reject",
    input,
    commandName,
    reason: `/${commandName} is a built-in pi command (${description}) that is not available in the browser yet.`,
    guidance: "It was blocked instead of falling through to the model.",
  }
}

export function isAuthoritativeBuiltinSlashCommand(commandName: string): boolean {
  return BUILTIN_COMMAND_NAMES.has(commandName)
}

export function dispatchBrowserSlashCommand(
  input: string,
  options: BrowserSlashCommandDispatchOptions = {},
): BrowserSlashCommandDispatchResult {
  const trimmed = input.trim()
  const parsed = parseSlashCommand(trimmed)

  if (trimmed === "/clear") {
    return {
      kind: "local",
      input: trimmed,
      commandName: "clear",
      action: "clear_terminal",
    }
  }

  if (trimmed === "/refresh") {
    return {
      kind: "local",
      input: trimmed,
      commandName: "refresh",
      action: "refresh_workspace",
    }
  }

  if (trimmed === "/state") {
    return {
      kind: "rpc",
      input: trimmed,
      commandName: "state",
      command: { type: "get_state" },
    }
  }

  if (trimmed === "/new-session") {
    return {
      kind: "rpc",
      input: trimmed,
      commandName: "new",
      command: { type: "new_session" },
    }
  }

  if (!parsed) {
    return {
      kind: "prompt",
      input: trimmed,
      slashCommandName: null,
      command: {
        type: getPromptCommandType(options),
        message: trimmed,
      },
    }
  }

  if (parsed.name === "new") {
    return {
      kind: "rpc",
      input: trimmed,
      commandName: "new",
      command: { type: "new_session" },
    }
  }

  const browserSurface = SURFACE_COMMANDS.get(parsed.name)
  if (browserSurface) {
    return {
      kind: "surface",
      input: trimmed,
      commandName: parsed.name,
      surface: browserSurface,
      args: parsed.args,
    }
  }

  if (BUILTIN_COMMAND_NAMES.has(parsed.name)) {
    return buildDeferredBuiltinReject(trimmed, parsed.name)
  }

  return {
    kind: "prompt",
    input: trimmed,
    slashCommandName: parsed.name,
    command: {
      type: getPromptCommandType(options),
      message: trimmed,
    },
  }
}

export function getBrowserSlashCommandTerminalNotice(
  outcome: BrowserSlashCommandDispatchResult,
): BrowserSlashCommandTerminalNotice | null {
  switch (outcome.kind) {
    case "surface":
      return {
        type: "system",
        message: `/${outcome.commandName} is reserved for browser-native handling and was not sent to the model.`,
      }
    case "reject":
      return {
        type: "error",
        message: `${outcome.reason} ${outcome.guidance}`.trim(),
      }
    default:
      return null
  }
}
