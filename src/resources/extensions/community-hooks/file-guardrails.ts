// GSD Community Hooks — File Guardrails
//
// Protects critical files from accidental modification by blocking write/edit
// tool calls to specified paths. Configurable via settings.json or defaults to
// a sensible set of protected files.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { isToolCallEventType } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

/** Default files/patterns that should be protected from agent modification. */
const DEFAULT_PROTECTED: string[] = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Gemfile.lock",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
];

/** Default directory patterns that should be protected. */
const DEFAULT_PROTECTED_DIRS: string[] = [
  ".github/workflows",
  ".gitlab-ci",
  ".circleci",
];

interface GuardrailConfig {
  protectedFiles?: string[];
  protectedDirs?: string[];
  /** If true, completely block writes. If false (default), warn but allow. */
  strict?: boolean;
}

function loadGuardrailConfig(): GuardrailConfig {
  const configDir = process.env.PI_CONFIG_DIR || ".gsd";
  const paths = [
    join(process.cwd(), configDir, "settings.json"),
    join(homedir(), configDir, "agent", "settings.json"),
  ];

  for (const settingsPath of paths) {
    if (!existsSync(settingsPath)) continue;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.fileGuardrails) return settings.fileGuardrails;
    } catch { /* skip malformed config */ }
  }

  return {};
}

function isProtected(filePath: string, config: GuardrailConfig): string | null {
  const resolved = resolve(filePath);
  const name = basename(resolved);
  const relPath = filePath.startsWith("/")
    ? filePath.replace(process.cwd() + "/", "")
    : filePath;

  const protectedFiles = config.protectedFiles ?? DEFAULT_PROTECTED;
  const protectedDirs = config.protectedDirs ?? DEFAULT_PROTECTED_DIRS;

  // Check exact file names
  for (const pf of protectedFiles) {
    if (name === pf || relPath === pf || relPath.endsWith(`/${pf}`)) {
      return pf;
    }
  }

  // Check directory patterns
  for (const pd of protectedDirs) {
    if (relPath.startsWith(pd) || relPath.includes(`/${pd}/`) || relPath.includes(`/${pd}`)) {
      return pd;
    }
  }

  return null;
}

export function registerFileGuardrails(pi: ExtensionAPI): void {
  const config = loadGuardrailConfig();

  pi.on("tool_call", async (event, ctx) => {
    let filePath = "";

    if (isToolCallEventType("write", event)) {
      filePath = event.input.path;
    } else if (isToolCallEventType("edit", event)) {
      filePath = event.input.path;
    } else if (isToolCallEventType("bash", event)) {
      // Check for common destructive patterns against protected files
      const cmd = event.input.command;
      const allProtected = [...(config.protectedFiles ?? DEFAULT_PROTECTED)];
      for (const pf of allProtected) {
        if (cmd.includes(pf) && /(?:rm|mv|cp|>|>>|tee|sed\s+-i|chmod|chown)\b/.test(cmd)) {
          if (config.strict) {
            return {
              block: true,
              reason: `🛡️ File Guardrails: Blocked command targeting protected file "${pf}". This file is protected from modification.`,
            };
          }
          ctx.ui.notify(`⚠️ Command targets protected file: ${pf}`, "warning");
          return;
        }
      }
      return;
    } else {
      return;
    }

    recordFire("fileGuardrails");
    const match = isProtected(filePath, config);
    if (!match) return;

    recordAction("fileGuardrails", `Protected file: ${match}`);
    if (config.strict) {
      return {
        block: true,
        reason: `File Guardrails: Blocked write to protected file/directory "${match}". Configure fileGuardrails in settings.json to adjust protection rules.`,
      };
    }

    // Warn-only mode (default)
    ctx.ui.notify(`Writing to protected file: ${match}`, "warning");
  });
}
