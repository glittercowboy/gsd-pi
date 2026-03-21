/**
 * Proof Ledger — CRUD operations for `.gsd/PROOF.json`.
 *
 * Tracks requirement evidence at three strength levels. Pure module with
 * no runtime dependencies beyond Node built-ins and `atomicWriteSync`.
 *
 * The ledger backs R003: making "which requirements are unproven?"
 * a deterministic, queryable surface.
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { atomicWriteSync } from "./atomic-write.ts"

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProofStrength = "supports" | "partially_validates" | "fully_validates"

export interface ProofEntry {
  requirementId: string
  sliceId: string
  taskId?: string
  strength: ProofStrength
  evidence: string
  timestamp: string
}

export interface ProofLedger {
  entries: ProofEntry[]
  version: 1
}

// ─── Strength Ordering ────────────────────────────────────────────────────────

const STRENGTH_RANK: Record<ProofStrength, number> = {
  supports: 1,
  partially_validates: 2,
  fully_validates: 3,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ledgerPath(basePath: string): string {
  return join(basePath, ".gsd", "PROOF.json")
}

function emptyLedger(): ProofLedger {
  return { entries: [], version: 1 }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Read the proof ledger from `.gsd/PROOF.json`.
 * Returns an empty ledger if the file does not exist or is unreadable.
 */
export function readProofLedger(basePath: string): ProofLedger {
  const fp = ledgerPath(basePath)
  if (!existsSync(fp)) return emptyLedger()
  try {
    const raw = readFileSync(fp, "utf-8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.entries)) return emptyLedger()
    return parsed as ProofLedger
  } catch {
    return emptyLedger()
  }
}

/**
 * Append a proof entry to the ledger with an auto-generated ISO timestamp.
 * Uses `atomicWriteSync` for crash-safe writes.
 */
export function appendProofEntry(
  basePath: string,
  entry: Omit<ProofEntry, "timestamp">,
): void {
  const ledger = readProofLedger(basePath)
  const full: ProofEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  }
  ledger.entries.push(full)
  atomicWriteSync(ledgerPath(basePath), JSON.stringify(ledger, null, 2) + "\n")
}

/**
 * Get the proof status for a specific requirement.
 * Returns the highest strength across all entries and the full list of entries.
 * Returns `{ strength: null, entries: [] }` if no entries exist for the requirement.
 */
export function getRequirementProofStatus(
  basePath: string,
  requirementId: string,
): { strength: ProofStrength | null; entries: ProofEntry[] } {
  const ledger = readProofLedger(basePath)
  const entries = ledger.entries.filter(e => e.requirementId === requirementId)
  if (entries.length === 0) return { strength: null, entries: [] }

  let highest: ProofStrength = entries[0].strength
  for (const e of entries) {
    if (STRENGTH_RANK[e.strength] > STRENGTH_RANK[highest]) {
      highest = e.strength
    }
  }
  return { strength: highest, entries }
}

/**
 * Remove all proof entries for the given requirement.
 * Returns the number of entries removed.
 */
export function clearRegressions(basePath: string, requirementId: string): number {
  const ledger = readProofLedger(basePath)
  const before = ledger.entries.length
  ledger.entries = ledger.entries.filter(e => e.requirementId !== requirementId)
  const removed = before - ledger.entries.length
  if (removed > 0) {
    atomicWriteSync(ledgerPath(basePath), JSON.stringify(ledger, null, 2) + "\n")
  }
  return removed
}
