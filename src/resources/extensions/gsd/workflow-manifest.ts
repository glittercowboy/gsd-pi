import {
  _getAdapter,
  readTransaction,
  restoreManifest,
  type MilestoneRow,
  type SliceRow,
  type TaskRow,
} from "./gsd-db.js";
import type { Decision } from "./types.js";
import { atomicWriteSync } from "./atomic-write.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── Manifest Types ──────────────────────────────────────────────────────

export interface VerificationEvidenceRow {
  id: number;
  task_id: string;
  slice_id: string;
  milestone_id: string;
  command: string;
  exit_code: number | null;
  verdict: string;
  duration_ms: number | null;
  created_at: string;
}

export interface StateManifest {
  version: 1;
  exported_at: string; // ISO 8601
  milestones: MilestoneRow[];
  slices: SliceRow[];
  tasks: TaskRow[];
  decisions: Decision[];
  verification_evidence: VerificationEvidenceRow[];
}

// ─── helpers ─────────────────────────────────────────────────────────────

function requireDb() {
  const db = _getAdapter();
  if (!db) throw new Error("workflow-manifest: No database open");
  return db;
}

/**
 * Coerce a raw DB value to a number, returning `fallback` for
 * null/undefined/non-numeric strings (e.g. "-", "N/A", "").
 * SQLite can store TEXT in INTEGER columns after migrations or manual inserts.
 */
export function toNumeric(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "-" || trimmed === "N/A") return fallback;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

// ─── snapshotState ───────────────────────────────────────────────────────

/**
 * Capture complete DB state as a StateManifest.
 * Reads all rows from milestones, slices, tasks, decisions, verification_evidence.
 *
 * Note: rows returned from raw queries are plain objects with TEXT columns for
 * JSON arrays. We parse them into typed Row objects using the same logic as
 * gsd-db helper functions.
 */
export function snapshotState(): StateManifest {
  const db = requireDb();

  // Wrap all reads in a deferred transaction so the snapshot is consistent
  // (all SELECTs see the same DB state even if a concurrent write lands between them).
  return readTransaction(() => {
  const rawMilestones = db.prepare("SELECT * FROM milestones ORDER BY id").all() as Record<string, unknown>[];
  const milestones: MilestoneRow[] = rawMilestones.map((r) => ({
    id: r["id"] as string,
    title: r["title"] as string,
    status: r["status"] as string,
    depends_on: JSON.parse((r["depends_on"] as string) || "[]"),
    created_at: r["created_at"] as string,
    completed_at: (r["completed_at"] as string) ?? null,
    vision: (r["vision"] as string) ?? "",
    success_criteria: JSON.parse((r["success_criteria"] as string) || "[]"),
    key_risks: JSON.parse((r["key_risks"] as string) || "[]"),
    proof_strategy: JSON.parse((r["proof_strategy"] as string) || "[]"),
    verification_contract: (r["verification_contract"] as string) ?? "",
    verification_integration: (r["verification_integration"] as string) ?? "",
    verification_operational: (r["verification_operational"] as string) ?? "",
    verification_uat: (r["verification_uat"] as string) ?? "",
    definition_of_done: JSON.parse((r["definition_of_done"] as string) || "[]"),
    requirement_coverage: (r["requirement_coverage"] as string) ?? "",
    boundary_map_markdown: (r["boundary_map_markdown"] as string) ?? "",
  }));

  const rawSlices = db.prepare("SELECT * FROM slices ORDER BY milestone_id, sequence, id").all() as Record<string, unknown>[];
  const slices: SliceRow[] = rawSlices.map((r) => ({
    milestone_id: r["milestone_id"] as string,
    id: r["id"] as string,
    title: r["title"] as string,
    status: r["status"] as string,
    risk: r["risk"] as string,
    depends: JSON.parse((r["depends"] as string) || "[]"),
    demo: (r["demo"] as string) ?? "",
    created_at: r["created_at"] as string,
    completed_at: (r["completed_at"] as string) ?? null,
    full_summary_md: (r["full_summary_md"] as string) ?? "",
    full_uat_md: (r["full_uat_md"] as string) ?? "",
    goal: (r["goal"] as string) ?? "",
    success_criteria: (r["success_criteria"] as string) ?? "",
    proof_level: (r["proof_level"] as string) ?? "",
    integration_closure: (r["integration_closure"] as string) ?? "",
    observability_impact: (r["observability_impact"] as string) ?? "",
    sequence: toNumeric(r["sequence"], 0) as number,
    replan_triggered_at: (r["replan_triggered_at"] as string) ?? null,
    is_sketch: toNumeric(r["is_sketch"], 0) as number,
    sketch_scope: (r["sketch_scope"] as string) ?? "",
  }));

  const rawTasks = db.prepare("SELECT * FROM tasks ORDER BY milestone_id, slice_id, sequence, id").all() as Record<string, unknown>[];
  const tasks: TaskRow[] = rawTasks.map((r) => ({
    milestone_id: r["milestone_id"] as string,
    slice_id: r["slice_id"] as string,
    id: r["id"] as string,
    title: r["title"] as string,
    status: r["status"] as string,
    one_liner: (r["one_liner"] as string) ?? "",
    narrative: (r["narrative"] as string) ?? "",
    verification_result: (r["verification_result"] as string) ?? "",
    duration: (r["duration"] as string) ?? "",
    completed_at: (r["completed_at"] as string) ?? null,
    blocker_discovered: (r["blocker_discovered"] as number) === 1,
    deviations: (r["deviations"] as string) ?? "",
    known_issues: (r["known_issues"] as string) ?? "",
    key_files: JSON.parse((r["key_files"] as string) || "[]"),
    key_decisions: JSON.parse((r["key_decisions"] as string) || "[]"),
    full_summary_md: (r["full_summary_md"] as string) ?? "",
    description: (r["description"] as string) ?? "",
    estimate: (r["estimate"] as string) ?? "",
    files: JSON.parse((r["files"] as string) || "[]"),
    verify: (r["verify"] as string) ?? "",
    inputs: JSON.parse((r["inputs"] as string) || "[]"),
    expected_output: JSON.parse((r["expected_output"] as string) || "[]"),
    observability_impact: (r["observability_impact"] as string) ?? "",
    full_plan_md: (r["full_plan_md"] as string) ?? "",
    sequence: toNumeric(r["sequence"], 0) as number,
    blocker_source: (r["blocker_source"] as string) ?? "",
    escalation_pending: toNumeric(r["escalation_pending"], 0) as number,
    escalation_awaiting_review: toNumeric(r["escalation_awaiting_review"], 0) as number,
    escalation_artifact_path: (r["escalation_artifact_path"] as string) ?? null,
    escalation_override_applied_at: (r["escalation_override_applied_at"] as string) ?? null,
  }));

  const rawDecisions = db.prepare("SELECT * FROM decisions ORDER BY seq").all() as Record<string, unknown>[];
  const decisions: Decision[] = rawDecisions.map((r) => ({
    seq: toNumeric(r["seq"], 0) as number,
    id: r["id"] as string,
    when_context: (r["when_context"] as string) ?? "",
    scope: (r["scope"] as string) ?? "",
    decision: (r["decision"] as string) ?? "",
    choice: (r["choice"] as string) ?? "",
    rationale: (r["rationale"] as string) ?? "",
    revisable: (r["revisable"] as string) ?? "",
    made_by: (r["made_by"] as string as Decision["made_by"]) ?? "agent",
    source: (r["source"] as string) ?? "discussion",
    superseded_by: (r["superseded_by"] as string) ?? null,
  }));

  const rawEvidence = db.prepare("SELECT * FROM verification_evidence ORDER BY id").all() as Record<string, unknown>[];
  const verification_evidence: VerificationEvidenceRow[] = rawEvidence.map((r) => ({
    id: r["id"] as number,
    task_id: r["task_id"] as string,
    slice_id: r["slice_id"] as string,
    milestone_id: r["milestone_id"] as string,
    command: r["command"] as string,
    exit_code: toNumeric(r["exit_code"]),
    verdict: (r["verdict"] as string) ?? "",
    duration_ms: toNumeric(r["duration_ms"]),
    created_at: r["created_at"] as string,
  }));

  const result: StateManifest = {
    version: 1,
    exported_at: new Date().toISOString(),
    milestones,
    slices,
    tasks,
    decisions,
    verification_evidence,
  };

  return result;
  });
}

// ─── restore ─────────────────────────────────────────────────────────────
//
// The actual restore() implementation lives in gsd-db.ts (single-writer
// invariant). This module only orchestrates reading the manifest file
// and handing it to the writer.

// ─── writeManifest ───────────────────────────────────────────────────────

/**
 * Write current DB state to .gsd/state-manifest.json via atomicWriteSync.
 * Uses JSON.stringify with 2-space indent for git three-way merge friendliness.
 */
export function writeManifest(basePath: string): void {
  const manifest = snapshotState();
  const json = JSON.stringify(manifest, null, 2);
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, "state-manifest.json"), json);
}

// ─── readManifest ────────────────────────────────────────────────────────

/**
 * Read state-manifest.json and return parsed manifest, or null if not found.
 */
export function readManifest(basePath: string): StateManifest | null {
  const manifestPath = join(basePath, ".gsd", "state-manifest.json");

  if (!existsSync(manifestPath)) {
    return null;
  }

  const raw = readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as StateManifest;

  if (parsed.version !== 1) {
    throw new Error(`Unsupported manifest version: ${parsed.version}`);
  }

  // Validate required fields to avoid cryptic errors during restore
  if (!Array.isArray(parsed.milestones) || !Array.isArray(parsed.slices) ||
      !Array.isArray(parsed.tasks) || !Array.isArray(parsed.decisions) ||
      !Array.isArray(parsed.verification_evidence)) {
    throw new Error("Malformed manifest: missing or invalid required arrays");
  }

  return parsed;
}

// ─── bootstrapFromManifest ──────────────────────────────────────────────

/**
 * Read state-manifest.json and restore DB state from it.
 * Returns true if bootstrap succeeded, false if manifest file doesn't exist.
 */
export function bootstrapFromManifest(basePath: string): boolean {
  const manifest = readManifest(basePath);

  if (!manifest) {
    return false;
  }

  restoreManifest(manifest);
  return true;
}
