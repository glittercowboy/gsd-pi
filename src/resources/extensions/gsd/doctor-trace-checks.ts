/**
 * Doctor trace checks (#3732) — trace-powered diagnostics.
 *
 * Queries the `spans` table to detect operational issues that are only
 * visible through execution history (model downgrades, stuck loops,
 * guard blocking, fallback exhaustion).
 */

import type { DoctorIssue } from "./doctor-types.js";
import type { DbAdapter } from "./gsd-db.js";

/**
 * Run all trace-based diagnostic checks.
 * Returns issues found; empty array if everything looks normal.
 */
export function runTraceChecks(
  db: DbAdapter,
  options?: { traceWindowMs?: number },
): DoctorIssue[] {
  const since = Date.now() - (options?.traceWindowMs ?? 3_600_000);
  const issues: DoctorIssue[] = [];

  issues.push(...checkModelPreferenceMismatch(db, since));
  issues.push(...checkRepeatedDispatch(db, since));
  issues.push(...checkGuardBlocking(db, since));
  issues.push(...checkFallbackChainExhausted(db, since));
  issues.push(...checkContextUndersized(db, since));
  issues.push(...checkCwdMismatch(db, since));

  return issues;
}

/**
 * Detect model downgrades — user configured one model but routing picked another.
 */
function checkModelPreferenceMismatch(db: DbAdapter, since: number): DoctorIssue[] {
  const rows = db.prepare(`
    SELECT unit_type, unit_id,
           json_extract(attributes, '$.gsd.model.configured') AS configured,
           json_extract(attributes, '$.gsd.model.resolved')   AS resolved,
           json_extract(attributes, '$.gsd.complexity.tier')   AS tier,
           json_extract(attributes, '$.gsd.complexity.reason') AS reason
    FROM spans
    WHERE name = 'gsd.unit.model_selection'
      AND json_extract(attributes, '$.gsd.model.downgraded') = 1
      AND start_time > ?
    ORDER BY start_time DESC
    LIMIT 20
  `).all(since);

  if (rows.length === 0) return [];

  const first = rows[0];
  return [{
    severity: rows.length > 5 ? "warning" : "info",
    code: "trace_model_downgrade",
    scope: "project",
    unitId: "",
    message:
      `Model was downgraded ${rows.length} time(s) in the last hour. ` +
      `Example: ${first["unit_type"]} configured=${first["configured"]} ` +
      `resolved=${first["resolved"]} (tier=${first["tier"]}, reason: ${first["reason"]}). ` +
      `Set dynamic_routing.enabled: false in preferences.md to prevent downgrades.`,
    fixable: false,
  }];
}

/**
 * Detect repeated dispatch of the same unit — possible stuck loop.
 */
function checkRepeatedDispatch(db: DbAdapter, since: number): DoctorIssue[] {
  const rows = db.prepare(`
    SELECT unit_type, unit_id, COUNT(*) as cnt
    FROM spans
    WHERE name = 'gsd.auto.iteration'
      AND unit_type IS NOT NULL
      AND start_time > ?
    GROUP BY unit_type, unit_id
    HAVING COUNT(*) > 3
    ORDER BY cnt DESC
    LIMIT 5
  `).all(since);

  return rows.map(r => ({
    severity: ((r["cnt"] as number) > 6 ? "error" : "warning") as DoctorIssue["severity"],
    code: "trace_repeated_dispatch",
    scope: "project" as const,
    unitId: r["unit_id"] as string,
    message: `Unit ${r["unit_type"]}/${r["unit_id"]} was dispatched ${r["cnt"]} times. Possible stuck loop.`,
    fixable: false,
  }));
}

/**
 * Detect guards that keep blocking execution.
 */
function checkGuardBlocking(db: DbAdapter, since: number): DoctorIssue[] {
  const rows = db.prepare(`
    SELECT name,
           json_extract(attributes, '$.gsd.guard.name') AS guard,
           COUNT(*) AS cnt
    FROM spans
    WHERE name = 'gsd.guards'
      AND status = 'error'
      AND start_time > ?
    GROUP BY name
    HAVING COUNT(*) > 2
  `).all(since);

  return rows.map(r => ({
    severity: "warning" as const,
    code: "trace_guard_blocking",
    scope: "project" as const,
    unitId: "",
    message:
      `Guard "${r["guard"] ?? r["name"]}" blocked execution ${r["cnt"]} times. ` +
      `Check budget ceiling, context threshold, or pending stop captures.`,
    fixable: false,
  }));
}

/**
 * Detect cases where all models in a fallback chain failed.
 */
function checkFallbackChainExhausted(db: DbAdapter, since: number): DoctorIssue[] {
  const rows = db.prepare(`
    SELECT unit_type,
           json_extract(attributes, '$.gsd.model.configured') AS configured
    FROM spans
    WHERE name = 'gsd.unit.model_selection'
      AND json_extract(attributes, '$.gsd.model.resolved') = 'none'
      AND start_time > ?
  `).all(since);

  if (rows.length === 0) return [];
  return [{
    severity: "error",
    code: "trace_fallback_chain_exhausted",
    scope: "project",
    unitId: "",
    message:
      `${rows.length} model selection(s) failed — no model could be resolved. ` +
      `Configured model(s): ${[...new Set(rows.map(r => r["configured"]))].join(", ")}. ` +
      `Check provider auth and model availability.`,
    fixable: false,
  }];
}

/**
 * Detect cases where context assembly produced very small prompts,
 * suggesting that knowledge or codebase content is missing.
 */
function checkContextUndersized(db: DbAdapter, since: number): DoctorIssue[] {
  const rows = db.prepare(`
    SELECT unit_type, unit_id,
           json_extract(attributes, '$.gsd.context.prompt_chars') AS chars,
           json_extract(attributes, '$.gsd.context.knowledge_bytes') AS kb,
           json_extract(attributes, '$.gsd.context.codebase_bytes') AS cb
    FROM spans
    WHERE name = 'gsd.unit.context_assembly'
      AND json_extract(attributes, '$.gsd.context.prompt_chars') < 500
      AND start_time > ?
    LIMIT 5
  `).all(since);

  if (rows.length === 0) return [];
  return [{
    severity: "info",
    code: "trace_context_undersized",
    scope: "project",
    unitId: "",
    message:
      `${rows.length} unit(s) received very small context prompts (<500 chars). ` +
      `This may indicate missing KNOWLEDGE.md, CODEBASE.md, or preferences.`,
    fixable: false,
  }];
}

/**
 * Detect CWD / worktree path mismatch — GSD executing in the wrong directory.
 *
 * When a worktree is active, process.cwd() should match the worktree path.
 * If cwd points at the project root instead, GSD is writing files to the
 * wrong location.
 */
function checkCwdMismatch(db: DbAdapter, since: number): DoctorIssue[] {
  const rows = db.prepare(`
    SELECT trace_id,
           json_extract(attributes, '$.gsd.loop.iteration') AS iteration,
           json_extract(attributes, '$.gsd.cwd')            AS cwd,
           json_extract(attributes, '$.gsd.worktree.path')   AS wt_path
    FROM spans
    WHERE name = 'gsd.auto.iteration'
      AND json_extract(attributes, '$.gsd.worktree.path') IS NOT NULL
      AND json_extract(attributes, '$.gsd.worktree.path') != ''
      AND json_extract(attributes, '$.gsd.cwd') != json_extract(attributes, '$.gsd.worktree.path')
      AND start_time > ?
    ORDER BY start_time DESC
    LIMIT 20
  `).all(since);

  if (rows.length === 0) return [];

  const first = rows[0];
  return [{
    severity: rows.length > 3 ? "error" : "warning",
    code: "trace_cwd_mismatch",
    scope: "project",
    unitId: "",
    message:
      `CWD did not match worktree path in ${rows.length} iteration(s). ` +
      `Example: iteration #${first["iteration"]}: cwd=${first["cwd"]} ` +
      `but worktree=${first["wt_path"]}. ` +
      `GSD may be executing in the wrong directory.`,
    fixable: false,
  }];
}
