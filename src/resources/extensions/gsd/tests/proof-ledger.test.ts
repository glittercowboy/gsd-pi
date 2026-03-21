/**
 * Proof Ledger CRUD tests.
 *
 * Validates:
 * - readProofLedger returns empty ledger for missing/corrupt files
 * - appendProofEntry creates file on first write, appends on subsequent
 * - getRequirementProofStatus returns highest strength or null
 * - clearRegressions removes only targeted requirement entries
 * - atomicWriteSync produces valid JSON
 * - Optional taskId field handled correctly
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  readProofLedger,
  appendProofEntry,
  getRequirementProofStatus,
  clearRegressions,
  type ProofEntry,
  type ProofLedger,
  type ProofStrength,
} from "../proof-ledger.ts"

import { extractPlanRequirements } from "../files.ts"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-proof-ledger-"))
  mkdirSync(join(base, ".gsd"), { recursive: true })
  return base
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
}

function proofJsonPath(base: string): string {
  return join(base, ".gsd", "PROOF.json")
}

// ─── readProofLedger ──────────────────────────────────────────────────────────

describe("readProofLedger", () => {
  let base: string

  beforeEach(() => { base = makeTmpBase() })
  afterEach(() => { cleanup(base) })

  it("returns empty ledger when PROOF.json does not exist", () => {
    const ledger = readProofLedger(base)
    assert.deepStrictEqual(ledger, { entries: [], version: 1 })
  })

  it("returns empty ledger when PROOF.json is corrupt JSON", () => {
    writeFileSync(proofJsonPath(base), "NOT VALID JSON{{{")
    const ledger = readProofLedger(base)
    assert.deepStrictEqual(ledger, { entries: [], version: 1 })
  })

  it("returns empty ledger when PROOF.json has no entries array", () => {
    writeFileSync(proofJsonPath(base), JSON.stringify({ version: 1, bad: true }))
    const ledger = readProofLedger(base)
    assert.deepStrictEqual(ledger, { entries: [], version: 1 })
  })

  it("reads a valid ledger file", () => {
    const data: ProofLedger = {
      entries: [{
        requirementId: "R001",
        sliceId: "S01",
        strength: "supports",
        evidence: "test passed",
        timestamp: "2025-01-01T00:00:00.000Z",
      }],
      version: 1,
    }
    writeFileSync(proofJsonPath(base), JSON.stringify(data))
    const ledger = readProofLedger(base)
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.entries[0].requirementId, "R001")
  })
})

// ─── appendProofEntry ─────────────────────────────────────────────────────────

describe("appendProofEntry", () => {
  let base: string

  beforeEach(() => { base = makeTmpBase() })
  afterEach(() => { cleanup(base) })

  it("creates PROOF.json on first write", () => {
    assert.equal(existsSync(proofJsonPath(base)), false)

    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "initial test",
    })

    assert.equal(existsSync(proofJsonPath(base)), true)
    const ledger = readProofLedger(base)
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.entries[0].requirementId, "R001")
    assert.equal(ledger.entries[0].strength, "supports")
  })

  it("appends to existing entries on subsequent writes", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "first",
    })
    appendProofEntry(base, {
      requirementId: "R002",
      sliceId: "S02",
      strength: "partially_validates",
      evidence: "second",
    })

    const ledger = readProofLedger(base)
    assert.equal(ledger.entries.length, 2)
    assert.equal(ledger.entries[0].requirementId, "R001")
    assert.equal(ledger.entries[1].requirementId, "R002")
  })

  it("auto-generates ISO timestamp", () => {
    const before = new Date().toISOString()
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "timed",
    })
    const after = new Date().toISOString()

    const ledger = readProofLedger(base)
    const ts = ledger.entries[0].timestamp
    assert.ok(ts >= before, `timestamp ${ts} should be >= ${before}`)
    assert.ok(ts <= after, `timestamp ${ts} should be <= ${after}`)
  })

  it("stores entries for different requirements independently", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "r1",
    })
    appendProofEntry(base, {
      requirementId: "R002",
      sliceId: "S01",
      strength: "fully_validates",
      evidence: "r2",
    })
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S02",
      strength: "partially_validates",
      evidence: "r1 again",
    })

    const ledger = readProofLedger(base)
    const r1 = ledger.entries.filter(e => e.requirementId === "R001")
    const r2 = ledger.entries.filter(e => e.requirementId === "R002")
    assert.equal(r1.length, 2)
    assert.equal(r2.length, 1)
  })

  it("handles entry with taskId present", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      taskId: "T01",
      strength: "supports",
      evidence: "with task",
    })

    const ledger = readProofLedger(base)
    assert.equal(ledger.entries[0].taskId, "T01")
  })

  it("handles entry with taskId absent", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "no task",
    })

    const ledger = readProofLedger(base)
    assert.equal(ledger.entries[0].taskId, undefined)
  })

  it("produces valid JSON after write (atomicWriteSync correctness)", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "json check",
    })

    const raw = readFileSync(proofJsonPath(base), "utf-8")
    const parsed = JSON.parse(raw) // should not throw
    assert.ok(Array.isArray(parsed.entries))
    assert.equal(parsed.version, 1)
  })
})

// ─── getRequirementProofStatus ────────────────────────────────────────────────

describe("getRequirementProofStatus", () => {
  let base: string

  beforeEach(() => { base = makeTmpBase() })
  afterEach(() => { cleanup(base) })

  it("returns null strength when no entries exist for requirement", () => {
    const status = getRequirementProofStatus(base, "R999")
    assert.equal(status.strength, null)
    assert.deepStrictEqual(status.entries, [])
  })

  it("returns null strength when ledger exists but requirement has no entries", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "other req",
    })

    const status = getRequirementProofStatus(base, "R999")
    assert.equal(status.strength, null)
    assert.deepStrictEqual(status.entries, [])
  })

  it("returns the single entry strength when only one entry exists", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "partially_validates",
      evidence: "single",
    })

    const status = getRequirementProofStatus(base, "R001")
    assert.equal(status.strength, "partially_validates")
    assert.equal(status.entries.length, 1)
  })

  it("returns highest strength across multiple entries (supports < partially_validates < fully_validates)", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "low",
    })
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S02",
      strength: "fully_validates",
      evidence: "high",
    })
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S03",
      strength: "partially_validates",
      evidence: "mid",
    })

    const status = getRequirementProofStatus(base, "R001")
    assert.equal(status.strength, "fully_validates")
    assert.equal(status.entries.length, 3)
  })

  it("strength ordering: supports < partially_validates < fully_validates", () => {
    // Only supports entries → highest is supports
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "a",
    })
    assert.equal(getRequirementProofStatus(base, "R001").strength, "supports")

    // Add partially_validates → highest becomes partially_validates
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S02",
      strength: "partially_validates",
      evidence: "b",
    })
    assert.equal(getRequirementProofStatus(base, "R001").strength, "partially_validates")

    // Add fully_validates → highest becomes fully_validates
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S03",
      strength: "fully_validates",
      evidence: "c",
    })
    assert.equal(getRequirementProofStatus(base, "R001").strength, "fully_validates")
  })
})

// ─── clearRegressions ─────────────────────────────────────────────────────────

describe("clearRegressions", () => {
  let base: string

  beforeEach(() => { base = makeTmpBase() })
  afterEach(() => { cleanup(base) })

  it("returns 0 on non-existent requirement (no entries)", () => {
    const removed = clearRegressions(base, "R999")
    assert.equal(removed, 0)
  })

  it("returns 0 on non-existent requirement when ledger has other entries", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "keep",
    })

    const removed = clearRegressions(base, "R999")
    assert.equal(removed, 0)
    // Verify R001 entry still exists
    assert.equal(readProofLedger(base).entries.length, 1)
  })

  it("removes entries for target requirement only", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "r1-a",
    })
    appendProofEntry(base, {
      requirementId: "R002",
      sliceId: "S01",
      strength: "fully_validates",
      evidence: "r2",
    })
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S02",
      strength: "partially_validates",
      evidence: "r1-b",
    })

    const removed = clearRegressions(base, "R001")
    assert.equal(removed, 2)

    const ledger = readProofLedger(base)
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.entries[0].requirementId, "R002")
  })

  it("produces valid JSON after clearing", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "to clear",
    })

    clearRegressions(base, "R001")

    const raw = readFileSync(proofJsonPath(base), "utf-8")
    const parsed = JSON.parse(raw)
    assert.ok(Array.isArray(parsed.entries))
    assert.equal(parsed.entries.length, 0)
  })

  it("does not write file when nothing was removed", () => {
    // No PROOF.json exists, clearRegressions on missing req → no file created
    clearRegressions(base, "R999")
    assert.equal(existsSync(proofJsonPath(base)), false)
  })
})

// ─── Integration: multi-entry strength queries ────────────────────────────────

describe("integration: multi-entry strength queries", () => {
  let base: string

  beforeEach(() => { base = makeTmpBase() })
  afterEach(() => { cleanup(base) })

  it("two entries for same requirement (different tasks) — returns both and highest strength", () => {
    appendProofEntry(base, {
      requirementId: "R003",
      sliceId: "S04",
      taskId: "T01",
      strength: "supports",
      evidence: "proof-ledger CRUD tests pass",
    })
    appendProofEntry(base, {
      requirementId: "R003",
      sliceId: "S04",
      taskId: "T03",
      strength: "partially_validates",
      evidence: "wired into post-unit pipeline",
    })

    const status = getRequirementProofStatus(base, "R003")
    assert.equal(status.entries.length, 2)
    assert.equal(status.strength, "partially_validates")
    assert.equal(status.entries[0].taskId, "T01")
    assert.equal(status.entries[1].taskId, "T03")
  })

  it("three entries spanning all strengths — returns fully_validates as highest", () => {
    appendProofEntry(base, {
      requirementId: "R010",
      sliceId: "S04",
      taskId: "T01",
      strength: "supports",
      evidence: "module exists",
    })
    appendProofEntry(base, {
      requirementId: "R010",
      sliceId: "S04",
      taskId: "T02",
      strength: "partially_validates",
      evidence: "validation wired",
    })
    appendProofEntry(base, {
      requirementId: "R010",
      sliceId: "S04",
      strength: "fully_validates",
      evidence: "UAT passed",
    })

    const status = getRequirementProofStatus(base, "R010")
    assert.equal(status.entries.length, 3)
    assert.equal(status.strength, "fully_validates")
  })
})

// ─── Integration: simulated post-unit flow ────────────────────────────────────

describe("integration: simulated post-unit flow", () => {
  let base: string

  beforeEach(() => { base = makeTmpBase() })
  afterEach(() => { cleanup(base) })

  it("reads slice plan requirements, appends entries for each, verifies PROOF.json", () => {
    // Simulate a slice plan with requirements frontmatter
    const slicePlanContent = [
      "---",
      "requirements:",
      "  - R003",
      "  - R010",
      "---",
      "# S04: Proof Ledger",
      "",
      "Goal: wire proof ledger",
    ].join("\n")

    const requirements = extractPlanRequirements(slicePlanContent)

    assert.deepStrictEqual(requirements, ["R003", "R010"])

    // Simulate the post-unit proof append loop
    const verificationResult = "passed"
    for (const reqId of requirements) {
      appendProofEntry(base, {
        requirementId: reqId,
        sliceId: "S04",
        taskId: "T03",
        strength: "supports",
        evidence: verificationResult,
      })
    }

    // Verify PROOF.json contains entries for all requirements
    const ledger = readProofLedger(base)
    assert.equal(ledger.entries.length, 2)
    assert.equal(ledger.version, 1)

    const r003 = ledger.entries.find(e => e.requirementId === "R003")
    const r010 = ledger.entries.find(e => e.requirementId === "R010")
    assert.ok(r003, "R003 entry should exist")
    assert.ok(r010, "R010 entry should exist")
    assert.equal(r003!.sliceId, "S04")
    assert.equal(r003!.taskId, "T03")
    assert.equal(r003!.strength, "supports")
    assert.equal(r003!.evidence, "passed")
    assert.equal(r010!.evidence, "passed")
  })

  it("skips proof append when slice plan has no requirements frontmatter", () => {
    const slicePlanContent = [
      "# S03: Some Old Slice",
      "",
      "Goal: no frontmatter here",
    ].join("\n")

    const requirements = extractPlanRequirements(slicePlanContent)

    assert.deepStrictEqual(requirements, [])

    // No entries appended — PROOF.json should not exist
    assert.equal(existsSync(proofJsonPath(base)), false)
  })

  it("skips proof append when requirements are all placeholders", () => {
    const slicePlanContent = [
      "---",
      "requirements:",
      "  - {{requirementId}}",
      "---",
      "# S01: Placeholder Slice",
    ].join("\n")

    const requirements = extractPlanRequirements(slicePlanContent)

    assert.deepStrictEqual(requirements, [])
    assert.equal(existsSync(proofJsonPath(base)), false)
  })

  it("uses 'task completed' as default evidence when verification_result is absent", () => {
    const requirements = ["R001"]
    const verificationResult: string | undefined = undefined
    const evidence = verificationResult || "task completed"

    for (const reqId of requirements) {
      appendProofEntry(base, {
        requirementId: reqId,
        sliceId: "S01",
        taskId: "T01",
        strength: "supports",
        evidence,
      })
    }

    const ledger = readProofLedger(base)
    assert.equal(ledger.entries[0].evidence, "task completed")
  })
})

// ─── Integration: PROOF.json path correctness ─────────────────────────────────

describe("integration: PROOF.json path", () => {
  let base: string

  beforeEach(() => { base = makeTmpBase() })
  afterEach(() => { cleanup(base) })

  it("PROOF.json is written at basePath/.gsd/PROOF.json", () => {
    appendProofEntry(base, {
      requirementId: "R001",
      sliceId: "S01",
      strength: "supports",
      evidence: "path check",
    })

    const expectedPath = join(base, ".gsd", "PROOF.json")
    assert.equal(existsSync(expectedPath), true)

    // Also confirm it's valid JSON at that path
    const raw = readFileSync(expectedPath, "utf-8")
    const parsed = JSON.parse(raw)
    assert.ok(Array.isArray(parsed.entries))
    assert.equal(parsed.entries.length, 1)
  })
})
