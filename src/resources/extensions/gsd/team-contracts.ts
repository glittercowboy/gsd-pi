/**
 * GSD Team Contracts — Contract file format, parsing, sync, and consumed-version tracking.
 *
 * Workers produce CONTRACT.md files with YAML frontmatter (version, domain, interfaces)
 * and a markdown body. The coordinator syncs these between worktrees so each worker
 * has visibility into other workers' public interfaces.
 *
 * All contract mechanics live in this single module to minimize mock surface expansion
 * (K014 — adding exports to already-mocked modules forces updates to 5+ test files).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  splitFrontmatter,
  parseFrontmatterMap,
} from "../shared/frontmatter.js";
import { safeCopy } from "./safe-fs.js";
import { getWorkerStatuses } from "./parallel-orchestrator.js";
import { writeTeamSignal, type TeamSignal } from "./session-status-io.js";
import { truncateAtSectionBoundary } from "./context-budget.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Strip matching single or double quotes from a YAML scalar value. */
function stripYamlQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    // Unescape escaped quotes inside double-quoted strings
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"') : inner;
  }
  return s;
}

export interface ContractInterface {
  name: string;
  type: string;
  signature: string;
}

export interface Contract {
  version: number;
  domain: string;
  interfaces: ContractInterface[];
  body: string;
}

// ─── Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse a CONTRACT.md file's content into a structured Contract object.
 * Handles missing frontmatter, missing fields, and malformed interfaces gracefully.
 * Returns sensible defaults for any missing field.
 */
export function parseContract(content: string): Contract {
  const [fmLines, body] = splitFrontmatter(content);

  if (!fmLines) {
    return { version: 0, domain: "unclassified", interfaces: [], body: content };
  }

  const map = parseFrontmatterMap(fmLines);

  const version = typeof map.version === "string" ? parseInt(map.version, 10) : 0;
  const domain = typeof map.domain === "string" ? map.domain : "unclassified";

  let interfaces: ContractInterface[] = [];
  if (Array.isArray(map.interfaces)) {
    interfaces = (map.interfaces as unknown[])
      .filter((item): item is Record<string, string> =>
        typeof item === "object" && item !== null && "name" in item)
      .map((item) => ({
        name: stripYamlQuotes(String(item.name ?? "")),
        type: stripYamlQuotes(String(item.type ?? "")),
        signature: stripYamlQuotes(String(item.signature ?? "")),
      }));
  }

  return {
    version: Number.isNaN(version) ? 0 : version,
    domain,
    interfaces,
    body,
  };
}

// ─── Formatting ────────────────────────────────────────────────────────────

/**
 * Serialize a Contract back to CONTRACT.md format (YAML frontmatter + markdown body).
 * Output is round-trippable through parseContract().
 */
export function formatContract(contract: Contract): string {
  const lines: string[] = ["---"];
  lines.push(`version: ${contract.version}`);
  lines.push(`domain: ${contract.domain}`);

  if (contract.interfaces.length === 0) {
    lines.push("interfaces: []");
  } else {
    lines.push("interfaces:");
    for (const iface of contract.interfaces) {
      lines.push(`  - name: ${iface.name}`);
      lines.push(`    type: ${iface.type}`);
      // Quote signatures containing special YAML characters
      const sig = iface.signature;
      if (sig.includes(":") || sig.includes("{") || sig.includes("}") || sig.includes("[") || sig.includes("]") || sig.includes('"')) {
        lines.push(`    signature: "${sig.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`    signature: ${sig}`);
      }
    }
  }

  lines.push("---");

  if (contract.body) {
    return lines.join("\n") + "\n\n" + contract.body;
  }
  return lines.join("\n") + "\n";
}

// ─── Consumed Version Tracking ─────────────────────────────────────────────

/**
 * Read the consumed-versions.json for a given source milestone from a worker's worktree.
 * Returns { version: N } or { version: 0 } if no tracking file exists.
 */
export function getConsumedVersion(
  worktreePath: string,
  sourceMid: string,
): number {
  try {
    const filePath = join(worktreePath, ".gsd", "team-contracts", sourceMid, ".consumed-versions.json");
    if (!existsSync(filePath)) return 0;
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.version === "number" ? data.version : 0;
  } catch {
    return 0;
  }
}

/**
 * Write the consumed version for a given source milestone in a worker's worktree.
 * Creates the directory structure if needed.
 */
export function setConsumedVersion(
  worktreePath: string,
  sourceMid: string,
  version: number,
): void {
  const dir = join(worktreePath, ".gsd", "team-contracts", sourceMid);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, ".consumed-versions.json");
  writeFileSync(filePath, JSON.stringify({ version }), "utf-8");
}

// ─── Contract Sync ─────────────────────────────────────────────────────────

/**
 * Sync CONTRACT.md files between all active worker worktrees.
 *
 * For each worker that has a CONTRACT.md, copies it to every other worker's
 * `.gsd/team-contracts/<sourceMid>/CONTRACT.md` directory — but only when
 * the source version exceeds the target's consumed version. Emits a
 * `contract-change` team signal on each update.
 *
 * Non-fatal: individual copy/parse failures are silently swallowed.
 */
export function syncContracts(basePath: string): void {
  const workers = getWorkerStatuses();
  if (workers.length < 2) return;

  // Read source contracts from each worker
  const sourceContracts = new Map<string, { contract: Contract; path: string }>();
  for (const worker of workers) {
    const contractPath = join(worker.worktreePath, ".gsd", "CONTRACT.md");
    if (!existsSync(contractPath)) continue;
    try {
      const content = readFileSync(contractPath, "utf-8");
      const contract = parseContract(content);
      sourceContracts.set(worker.milestoneId, { contract, path: contractPath });
    } catch { /* skip unreadable contracts */ }
  }

  // Sync each source to every other worker
  for (const [sourceMid, { contract: sourceContract, path: sourcePath }] of sourceContracts) {
    for (const targetWorker of workers) {
      if (targetWorker.milestoneId === sourceMid) continue;

      const consumedVersion = getConsumedVersion(targetWorker.worktreePath, sourceMid);
      if (sourceContract.version <= consumedVersion) continue;

      // Copy contract to target worker's team-contracts directory
      const targetDir = join(targetWorker.worktreePath, ".gsd", "team-contracts", sourceMid);
      mkdirSync(targetDir, { recursive: true });
      const targetPath = join(targetDir, "CONTRACT.md");

      if (!safeCopy(sourcePath, targetPath)) continue;

      // Update consumed version
      setConsumedVersion(targetWorker.worktreePath, sourceMid, sourceContract.version);

      // Emit contract-change signal
      const signal: TeamSignal = {
        type: "contract-change",
        source: sourceMid,
        workerMid: targetWorker.milestoneId,
        payload: {
          domain: sourceContract.domain,
          version: sourceContract.version,
          interfaceCount: sourceContract.interfaces.length,
        },
        timestamp: Date.now(),
      };
      writeTeamSignal(basePath, targetWorker.milestoneId, signal);
    }
  }
}

// ─── Cross-Context Prompt Injection ────────────────────────────────────────

/**
 * Build a budget-respecting markdown section summarizing other workers' contracts
 * and recent team signals for injection into the execute-task prompt.
 *
 * Returns empty string when: no contract files exist, no pending signals, or the
 * worker's worktree has no `.gsd/team-contracts/` directory (non-parallel mode).
 *
 * @param basePath - The worker's own worktree path (workers operate in their worktree)
 * @param workerMid - The current worker's milestone ID (for filtering self-references)
 * @param budgetChars - Maximum character budget for the output section
 * @param signals - Team signals to include (caller should splice(0) to clear atomically)
 */
export function buildCrossContextSection(basePath: string, workerMid: string, budgetChars: number, signals: TeamSignal[] = []): string {
  // Read synced contracts from .gsd/team-contracts/*/CONTRACT.md
  const teamContractsDir = join(basePath, ".gsd", "team-contracts");
  const contracts: Array<{ mid: string; contract: Contract }> = [];

  if (existsSync(teamContractsDir)) {
    try {
      const entries = readdirSync(teamContractsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const contractPath = join(teamContractsDir, entry.name, "CONTRACT.md");
        if (!existsSync(contractPath)) continue;
        try {
          const content = readFileSync(contractPath, "utf-8");
          const contract = parseContract(content);
          contracts.push({ mid: entry.name, contract });
        } catch { /* skip unreadable contracts */ }
      }
    } catch { /* directory read failure — non-fatal */ }
  }

  // Return empty string when no cross-context data
  if (contracts.length === 0 && signals.length === 0) return "";

  // Assemble the markdown section
  const lines: string[] = [
    "## Team Context (awareness only — do not act on this unless relevant to your current task)",
    "",
  ];

  for (const { mid, contract } of contracts) {
    lines.push(`### Worker ${mid} (${contract.domain})`);
    lines.push(`**Contract v${contract.version}:**`);
    if (contract.interfaces.length === 0) {
      lines.push("- (no public interfaces declared)");
    } else {
      for (const iface of contract.interfaces) {
        lines.push(`- ${iface.name}: ${iface.type} — \`${iface.signature}\``);
      }
    }
    lines.push("");
  }

  if (signals.length > 0) {
    lines.push("### Recent Team Signals");
    for (const signal of signals) {
      const payloadSummary = Object.entries(signal.payload)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ");
      lines.push(`- [${signal.type}] from ${signal.source}: ${payloadSummary}`);
    }
    lines.push("");
  }

  const assembled = lines.join("\n");

  // Truncate to budget if needed
  if (assembled.length <= budgetChars) return assembled;
  return truncateAtSectionBoundary(assembled, budgetChars).content;
}
