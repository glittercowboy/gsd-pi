/**
 * GSD Pre-Merge Impact Analysis
 *
 * Before merging a completed worker's code back to the base branch,
 * the system diffs the worker's contract against consumed versions
 * to detect breaking changes and generate adaptation signals for
 * affected workers.
 *
 * This module provides:
 * - Core types: ContractBreak, ImpactAnalysis
 * - Pure diff function: diffContracts(before, after) → ContractBreak[]
 * - Orchestrator: analyzePreMergeImpact(basePath, mid) → ImpactAnalysis
 * - Signal emitter: emitAdaptationSignals(basePath, analysis) → void
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseContract } from "./team-contracts.js";
import type { Contract, ContractInterface } from "./team-contracts.js";
import { writeTeamSignal } from "./session-status-io.js";
import type { TeamSignal } from "./session-status-io.js";
import { getWorkerStatuses } from "./parallel-orchestrator.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * A single breaking change detected between two versions of a contract.
 *
 * - "removed": interface existed before but is gone after
 * - "signature-changed": interface exists in both but signature differs
 * - "type-changed": interface exists in both, signature is same, but type differs
 */
export interface ContractBreak {
  interfaceName: string;
  changeType: "removed" | "signature-changed" | "type-changed";
  before: ContractInterface;
  after?: ContractInterface;
}

/**
 * Complete impact analysis result for a pre-merge check.
 *
 * Produced by analyzePreMergeImpact() (T02) which orchestrates
 * disk reads, diffing, and signal generation.
 */
export interface ImpactAnalysis {
  breakingChanges: ContractBreak[];
  affectedWorkers: string[];
  adaptationSignals: TeamSignal[];
  mergingMid: string;
}

// ─── Pure Contract Diffing ─────────────────────────────────────────────────

/**
 * Compare two Contract objects and return all breaking changes.
 *
 * Matches interfaces by `name` field (not array position), so
 * reordered interfaces with identical content produce zero breaks.
 *
 * Change detection priority per interface:
 * 1. Removed (in before, not in after) → "removed"
 * 2. Signature differs → "signature-changed"
 * 3. Type differs (signature same) → "type-changed"
 *
 * Added interfaces (in after, not in before) are NOT breaking.
 */
export function diffContracts(
  before: Contract,
  after: Contract,
): ContractBreak[] {
  const breaks: ContractBreak[] = [];

  // Build lookup maps keyed by interface name
  const beforeMap = new Map<string, ContractInterface>();
  for (const iface of before.interfaces) {
    beforeMap.set(iface.name, iface);
  }

  const afterMap = new Map<string, ContractInterface>();
  for (const iface of after.interfaces) {
    afterMap.set(iface.name, iface);
  }

  // Check each interface that existed before
  for (const [name, beforeIface] of beforeMap) {
    const afterIface = afterMap.get(name);

    if (!afterIface) {
      // Interface was removed
      breaks.push({
        interfaceName: name,
        changeType: "removed",
        before: beforeIface,
      });
      continue;
    }

    if (beforeIface.signature !== afterIface.signature) {
      // Signature changed — takes priority over type change
      breaks.push({
        interfaceName: name,
        changeType: "signature-changed",
        before: beforeIface,
        after: afterIface,
      });
      continue;
    }

    if (beforeIface.type !== afterIface.type) {
      // Type changed (signature is the same)
      breaks.push({
        interfaceName: name,
        changeType: "type-changed",
        before: beforeIface,
        after: afterIface,
      });
    }
  }

  // Interfaces in after but not in before are additions — not breaking, skip them

  return breaks;
}

// ─── Orchestration ─────────────────────────────────────────────────────────

/**
 * Read contracts from disk and diff the merging worker's current contract
 * against consumed copies in other workers' worktrees.
 *
 * Returns an ImpactAnalysis describing all breaking changes and which
 * workers are affected. Builds adaptation signals but does NOT emit them —
 * call emitAdaptationSignals() separately for that.
 */
export function analyzePreMergeImpact(
  basePath: string,
  mergingMid: string,
): ImpactAnalysis {
  const emptyResult: ImpactAnalysis = {
    breakingChanges: [],
    affectedWorkers: [],
    adaptationSignals: [],
    mergingMid,
  };

  const workers = getWorkerStatuses();
  if (workers.length === 0) return emptyResult;

  // Find the merging worker to get its worktree path
  const mergingWorker = workers.find(w => w.milestoneId === mergingMid);
  if (!mergingWorker) return emptyResult;

  // Read the merging worker's current contract
  const mergingContractPath = join(mergingWorker.worktreePath, ".gsd", "CONTRACT.md");
  if (!existsSync(mergingContractPath)) return emptyResult;

  let currentContract: Contract;
  try {
    const content = readFileSync(mergingContractPath, "utf-8");
    currentContract = parseContract(content);
  } catch {
    return emptyResult;
  }

  const allBreaks: ContractBreak[] = [];
  const affectedWorkers: string[] = [];
  const adaptationSignals: TeamSignal[] = [];

  // Check each other worker for consumed copies of the merging worker's contract
  for (const worker of workers) {
    if (worker.milestoneId === mergingMid) continue;

    const consumedPath = join(
      worker.worktreePath,
      ".gsd",
      "team-contracts",
      mergingMid,
      "CONTRACT.md",
    );
    if (!existsSync(consumedPath)) continue;

    let consumedContract: Contract;
    try {
      const content = readFileSync(consumedPath, "utf-8");
      consumedContract = parseContract(content);
    } catch {
      continue;
    }

    const breaks = diffContracts(consumedContract, currentContract);
    if (breaks.length > 0) {
      allBreaks.push(...breaks);
      affectedWorkers.push(worker.milestoneId);

      adaptationSignals.push({
        type: "contract-change",
        source: mergingMid,
        workerMid: worker.milestoneId,
        payload: {
          breaking: true,
          breakingChanges: breaks.map(b => ({
            interfaceName: b.interfaceName,
            changeType: b.changeType,
          })),
        },
        timestamp: Date.now(),
      });
    }
  }

  return {
    breakingChanges: allBreaks,
    affectedWorkers,
    adaptationSignals,
    mergingMid,
  };
}

/**
 * Emit adaptation signals for each affected worker in an ImpactAnalysis.
 *
 * Writes `contract-change` team signals with `breaking: true` to each
 * affected worker's NDJSON signal file. Non-fatal: each emission is
 * independently try/caught so a single failure doesn't block others.
 */
export function emitAdaptationSignals(
  basePath: string,
  analysis: ImpactAnalysis,
): void {
  for (const signal of analysis.adaptationSignals) {
    try {
      writeTeamSignal(basePath, signal.workerMid, signal);
    } catch {
      // Non-fatal — individual signal emission failure must not propagate
    }
  }
}
