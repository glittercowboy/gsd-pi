import {
  _getAdapter,
  transaction,
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
  db.exec("BEGIN DEFERRED");

  try {
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

  db.exec("COMMIT");
  return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback failure */ }
    throw err;
  }
}

// ─── restore ─────────────────────────────────────────────────────────────

/**
 * Atomically replace all workflow state from a manifest.
 * Runs inside a transaction — if any insert fails, no tables are modified.
 * Only touches engine tables + decisions. Does NOT modify artifacts or memories.
 */
function restore(manifest: StateManifest): void {
  const db = requireDb();

  transaction(() => {
    // Clear engine tables (order matters for foreign-key-like consistency)
    db.exec("DELETE FROM verification_evidence");
    db.exec("DELETE FROM tasks");
    db.exec("DELETE FROM slices");
    db.exec("DELETE FROM milestones");
    db.exec("DELETE FROM decisions WHERE 1=1");

    // Restore milestones
    const msStmt = db.prepare(
      `INSERT INTO milestones (id, title, status, depends_on, created_at, completed_at,
        vision, success_criteria, key_risks, proof_strategy,
        verification_contract, verification_integration, verification_operational, verification_uat,
        definition_of_done, requirement_coverage, boundary_map_markdown)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of manifest.milestones) {
      msStmt.run(
        m.id, m.title, m.status,
        JSON.stringify(m.depends_on), m.created_at, m.completed_at,
        m.vision, JSON.stringify(m.success_criteria), JSON.stringify(m.key_risks),
        JSON.stringify(m.proof_strategy),
        m.verification_contract, m.verification_integration, m.verification_operational, m.verification_uat,
        JSON.stringify(m.definition_of_done), m.requirement_coverage, m.boundary_map_markdown,
      );
    }

    // Restore slices
    const slStmt = db.prepare(
      `INSERT INTO slices (milestone_id, id, title, status, risk, depends, demo,
        created_at, completed_at, full_summary_md, full_uat_md,
        goal, success_criteria, proof_level, integration_closure, observability_impact,
        sequence, replan_triggered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of manifest.slices) {
      slStmt.run(
        s.milestone_id, s.id, s.title, s.status, s.risk,
        JSON.stringify(s.depends), s.demo,
        s.created_at, s.completed_at, s.full_summary_md, s.full_uat_md,
        s.goal, s.success_criteria, s.proof_level, s.integration_closure, s.observability_impact,
        s.sequence, s.replan_triggered_at,
      );
    }

    // Restore tasks
    const tkStmt = db.prepare(
      `INSERT INTO tasks (milestone_id, slice_id, id, title, status,
        one_liner, narrative, verification_result, duration, completed_at,
        blocker_discovered, deviations, known_issues, key_files, key_decisions,
        full_summary_md, description, estimate, files, verify,
        inputs, expected_output, observability_impact, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of manifest.tasks) {
      tkStmt.run(
        t.milestone_id, t.slice_id, t.id, t.title, t.status,
        t.one_liner, t.narrative, t.verification_result, t.duration, t.completed_at,
        t.blocker_discovered ? 1 : 0, t.deviations, t.known_issues,
        JSON.stringify(t.key_files), JSON.stringify(t.key_decisions),
        t.full_summary_md, t.description, t.estimate, JSON.stringify(t.files), t.verify,
        JSON.stringify(t.inputs), JSON.stringify(t.expected_output),
        t.observability_impact, t.sequence,
      );
    }

    // Restore decisions
    const dcStmt = db.prepare(
      `INSERT INTO decisions (seq, id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of manifest.decisions) {
      dcStmt.run(d.seq, d.id, d.when_context, d.scope, d.decision, d.choice, d.rationale, d.revisable, d.made_by, d.superseded_by);
    }

    // Restore verification evidence
    const evStmt = db.prepare(
      `INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of manifest.verification_evidence) {
      evStmt.run(e.task_id, e.slice_id, e.milestone_id, e.command, e.exit_code, e.verdict, e.duration_ms, e.created_at);
    }
  });
}

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

  restore(manifest);
  return true;
}
