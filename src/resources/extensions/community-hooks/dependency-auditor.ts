// GSD Community Hooks — Dependency Auditor
//
// Detects package install commands and runs a quick vulnerability audit after
// installation completes. Supports npm, yarn, pnpm, pip, cargo, and go.

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

/** Maps package manager install patterns to their audit commands. */
interface PackageManager {
  name: string;
  /** Regex matching install commands. */
  installPattern: RegExp;
  /** Binary and args for vulnerability audit. */
  auditBin: string;
  auditArgs: string[];
  /** Binary to check availability. */
  checkBin: string;
  checkArgs: string[];
}

const PACKAGE_MANAGERS: PackageManager[] = [
  {
    name: "npm",
    installPattern: /\bnpm\s+(?:install|i|add)\b/,
    auditBin: "npm",
    auditArgs: ["audit", "--json"],
    checkBin: "npm",
    checkArgs: ["--version"],
  },
  {
    name: "yarn",
    installPattern: /\byarn\s+(?:add|install)\b/,
    auditBin: "yarn",
    auditArgs: ["audit", "--json"],
    checkBin: "yarn",
    checkArgs: ["--version"],
  },
  {
    name: "pnpm",
    installPattern: /\bpnpm\s+(?:add|install|i)\b/,
    auditBin: "pnpm",
    auditArgs: ["audit", "--json"],
    checkBin: "pnpm",
    checkArgs: ["--version"],
  },
  {
    name: "pip",
    installPattern: /\bpip3?\s+install\b/,
    auditBin: "pip-audit",
    auditArgs: ["--format=json"],
    checkBin: "pip-audit",
    checkArgs: ["--version"],
  },
  {
    name: "cargo",
    installPattern: /\bcargo\s+(?:add|install)\b/,
    auditBin: "cargo",
    auditArgs: ["audit", "--json"],
    checkBin: "cargo",
    checkArgs: ["audit", "--version"],
  },
  {
    name: "go",
    installPattern: /\bgo\s+(?:get|install)\b/,
    auditBin: "govulncheck",
    auditArgs: ["./..."],
    checkBin: "govulncheck",
    checkArgs: ["-version"],
  },
];

function runExecFile(bin: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, cwd: process.cwd(), maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

function isCommandAvailable(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5_000 }, (error) => {
      resolve(!error);
    });
  });
}

function extractPackageName(command: string): string | null {
  const match = command.match(/(?:install|add|get|i)\s+(?:--save(?:-dev)?\s+)?([a-zA-Z0-9@/._-]+)/);
  return match?.[1] ?? null;
}

interface AuditSummary {
  vulnerabilities: number;
  critical: number;
  high: number;
  details: string;
}

function parseNpmAudit(stdout: string): AuditSummary | null {
  try {
    const data = JSON.parse(stdout);
    const meta = data.metadata?.vulnerabilities ?? {};
    const total = (meta.critical ?? 0) + (meta.high ?? 0) + (meta.moderate ?? 0) + (meta.low ?? 0);
    return {
      vulnerabilities: total,
      critical: meta.critical ?? 0,
      high: meta.high ?? 0,
      details: total > 0
        ? `Found ${total} vulnerabilities (${meta.critical ?? 0} critical, ${meta.high ?? 0} high)`
        : "No known vulnerabilities",
    };
  } catch {
    return null;
  }
}

export function registerDependencyAuditor(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;

    const command = (event.input as Record<string, unknown>).command;
    if (typeof command !== "string") return;

    // Find matching package manager
    const pm = PACKAGE_MANAGERS.find((p) => p.installPattern.test(command));
    if (!pm) return;

    recordFire("dependencyAuditor");
    const pkgName = extractPackageName(command);
    const label = pkgName ? `${pm.name} package "${pkgName}"` : `${pm.name} packages`;

    // Check if audit tool is available
    const available = await isCommandAvailable(pm.checkBin, pm.checkArgs);
    if (!available) {
      ctx.ui.notify(`Installed ${label} — audit tool not available, skipping vulnerability check`, "info");
      return;
    }

    ctx.ui.notify(`Auditing ${label} for vulnerabilities...`, "info");

    const result = await runExecFile(pm.auditBin, pm.auditArgs);

    // Try to parse structured output (npm-style)
    if (pm.name === "npm" || pm.name === "pnpm") {
      const summary = parseNpmAudit(result.stdout);
      if (summary) {
        recordAction("dependencyAuditor", summary.details);
        if (summary.vulnerabilities === 0) {
          ctx.ui.notify(`${label}: No known vulnerabilities`, "info");
        } else if (summary.critical > 0 || summary.high > 0) {
          ctx.ui.notify(`${label}: ${summary.details}`, "error");
        } else {
          ctx.ui.notify(`${label}: ${summary.details}`, "warning");
        }
        return;
      }
    }

    // Fallback: report raw output presence
    if (result.exitCode !== 0 && result.stdout.trim()) {
      ctx.ui.notify(`${label}: Audit found potential issues — review output`, "warning");
    } else {
      ctx.ui.notify(`${label}: Audit passed`, "info");
    }
  });
}
