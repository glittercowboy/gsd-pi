// GSD Community Hooks — Extension Entry Point
//
// A curated collection of production-ready hooks that showcase the Pi SDK
// hooks system. Each hook is independently toggleable via settings.json.
//
// Enable/disable individual hooks in your settings.json:
//   {
//     "communityHooks": {
//       "secretScanner": true,        // Block writes containing secrets
//       "fileGuardrails": true,       // Protect critical files from modification
//       "dependencyAuditor": true,    // Audit packages after install
//       "autoTestRunner": true,       // Run tests after code changes
//       "diffSummarizer": true,       // Summarize file changes after each run
//       "undoCheckpoint": true,       // Git stash checkpoint before agent runs
//       "costTracker": true,          // Track token usage and costs
//       "contextLoader": true,        // Auto-inject relevant docs
//       "styleEnforcer": true,        // Run linters on written files
//       "sessionLogger": true         // Log session activity for teams
//     }
//   }

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

import { registerSecretScanner } from "./secret-scanner.js";
import { registerFileGuardrails } from "./file-guardrails.js";
import { registerDependencyAuditor } from "./dependency-auditor.js";
import { registerAutoTestRunner } from "./auto-test-runner.js";
import { registerDiffSummarizer } from "./diff-summarizer.js";
import { registerUndoCheckpoint } from "./undo-checkpoint.js";
import { registerCostTracker } from "./cost-tracker.js";
import { registerContextLoader } from "./context-loader.js";
import { registerStyleEnforcer } from "./style-enforcer.js";
import { registerSessionLogger } from "./session-logger.js";
import { registerHooksCommand } from "./manage.js";
import { resetStats } from "./stats.js";

interface CommunityHookConfig {
  secretScanner?: boolean;
  fileGuardrails?: boolean;
  dependencyAuditor?: boolean;
  autoTestRunner?: boolean;
  diffSummarizer?: boolean;
  undoCheckpoint?: boolean;
  costTracker?: boolean;
  contextLoader?: boolean;
  styleEnforcer?: boolean;
  sessionLogger?: boolean;
}

/** All hooks enabled by default. */
const DEFAULTS: Required<CommunityHookConfig> = {
  secretScanner: true,
  fileGuardrails: true,
  dependencyAuditor: true,
  autoTestRunner: true,
  diffSummarizer: true,
  undoCheckpoint: true,
  costTracker: true,
  contextLoader: true,
  styleEnforcer: true,
  sessionLogger: true,
};

function loadConfig(): CommunityHookConfig {
  const configDir = process.env.PI_CONFIG_DIR || ".gsd";
  const paths = [
    join(process.cwd(), configDir, "settings.json"),
    join(homedir(), configDir, "agent", "settings.json"),
  ];

  for (const settingsPath of paths) {
    if (!existsSync(settingsPath)) continue;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.communityHooks) return settings.communityHooks;
    } catch { /* skip malformed */ }
  }

  return {};
}

const HOOK_REGISTRY: Array<{
  key: keyof CommunityHookConfig;
  name: string;
  register: (pi: ExtensionAPI) => void;
}> = [
  { key: "secretScanner", name: "Secret Scanner", register: registerSecretScanner },
  { key: "fileGuardrails", name: "File Guardrails", register: registerFileGuardrails },
  { key: "dependencyAuditor", name: "Dependency Auditor", register: registerDependencyAuditor },
  { key: "autoTestRunner", name: "Auto Test Runner", register: registerAutoTestRunner },
  { key: "diffSummarizer", name: "Diff Summarizer", register: registerDiffSummarizer },
  { key: "undoCheckpoint", name: "Undo Checkpoint", register: registerUndoCheckpoint },
  { key: "costTracker", name: "Cost Tracker", register: registerCostTracker },
  { key: "contextLoader", name: "Context Loader", register: registerContextLoader },
  { key: "styleEnforcer", name: "Style Enforcer", register: registerStyleEnforcer },
  { key: "sessionLogger", name: "Session Logger", register: registerSessionLogger },
];

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const enabled: string[] = [];

  for (const hook of HOOK_REGISTRY) {
    const isEnabled = config[hook.key] ?? DEFAULTS[hook.key];
    if (isEnabled) {
      hook.register(pi);
      enabled.push(hook.name);
    }
  }

  // Register the /community-hooks management command
  registerHooksCommand(pi);

  // Reset stats and show status on session start
  pi.on("session_start", async (_event, ctx) => {
    resetStats();
    if (enabled.length > 0) {
      ctx.ui.setStatus("community-hooks", `Hooks: ${enabled.length} active`);
    }
  });
}

// Re-export the route function for integration with /gsd hooks
export { routeCommand as routeCommunityHooksCommand } from "./manage.js";
