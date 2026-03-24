// tool-naming — Verifies canonical + alias tool registration for GSD DB tools.
//
// Each DB tool must register under its canonical gsd_concept_action name
// AND under a backward-compatible alias name.
// The alias must share the exact same execute function reference as the canonical tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDbTools } from '../bootstrap/db-tools.ts';


// ─── Mock PI ──────────────────────────────────────────────────────────────────

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

// ─── Rename map ───────────────────────────────────────────────────────────────

const RENAME_MAP: Array<{ canonical: string; alias: string }> = [
  { canonical: "gsd_decision_save", alias: "gsd_save_decision" },
  { canonical: "gsd_requirement_update", alias: "gsd_update_requirement" },
  { canonical: "gsd_summary_save", alias: "gsd_save_summary" },
  { canonical: "gsd_milestone_generate_id", alias: "gsd_generate_milestone_id" },
  { canonical: "gsd_task_complete", alias: "gsd_complete_task" },
  { canonical: "gsd_slice_complete", alias: "gsd_complete_slice" },
  { canonical: "gsd_plan_milestone", alias: "gsd_milestone_plan" },
  { canonical: "gsd_plan_slice", alias: "gsd_slice_plan" },
  { canonical: "gsd_plan_task", alias: "gsd_task_plan" },
  { canonical: "gsd_replan_slice", alias: "gsd_slice_replan" },
  { canonical: "gsd_reassess_roadmap", alias: "gsd_roadmap_reassess" },
  { canonical: "gsd_complete_milestone", alias: "gsd_milestone_complete" },
];

// ─── Registration count ──────────────────────────────────────────────────────

console.log('\n── Tool naming: registration count ──');

const pi = makeMockPi();
registerDbTools(pi);

assert.deepStrictEqual(pi.tools.length, 24, 'Should register exactly 24 tools (12 canonical + 12 aliases)');

// ─── Both names exist for each pair ──────────────────────────────────────────

console.log('\n── Tool naming: canonical and alias names exist ──');

for (const { canonical, alias } of RENAME_MAP) {
  const canonicalTool = pi.tools.find((t: any) => t.name === canonical);
  const aliasTool = pi.tools.find((t: any) => t.name === alias);

  assert.ok(canonicalTool !== undefined, `Canonical tool "${canonical}" should be registered`);
  assert.ok(aliasTool !== undefined, `Alias tool "${alias}" should be registered`);
}

// ─── Execute function identity ───────────────────────────────────────────────

console.log('\n── Tool naming: execute function identity (===) ──');

for (const { canonical, alias } of RENAME_MAP) {
  const canonicalTool = pi.tools.find((t: any) => t.name === canonical);
  const aliasTool = pi.tools.find((t: any) => t.name === alias);

  if (canonicalTool && aliasTool) {
    assert.ok(
      canonicalTool.execute === aliasTool.execute,
      `"${canonical}" and "${alias}" should share the same execute function reference`,
    );
  }
}

// ─── Alias descriptions include "(alias for ...)" ───────────────────────────

console.log('\n── Tool naming: alias descriptions ──');

for (const { canonical, alias } of RENAME_MAP) {
  const aliasTool = pi.tools.find((t: any) => t.name === alias);

  if (aliasTool) {
    assert.ok(
      aliasTool.description.includes(`alias for ${canonical}`),
      `Alias "${alias}" description should include "alias for ${canonical}"`,
    );
  }
}

// ─── Canonical tools have proper promptGuidelines ────────────────────────────

console.log('\n── Tool naming: canonical promptGuidelines use canonical name ──');

for (const { canonical } of RENAME_MAP) {
  const canonicalTool = pi.tools.find((t: any) => t.name === canonical);

  if (canonicalTool) {
    const guidelinesText = canonicalTool.promptGuidelines.join(' ');
    assert.ok(
      guidelinesText.includes(canonical),
      `Canonical tool "${canonical}" promptGuidelines should reference its own name`,
    );
  }
}

// ─── Alias promptGuidelines direct to canonical ──────────────────────────────

console.log('\n── Tool naming: alias promptGuidelines redirect to canonical ──');

for (const { canonical, alias } of RENAME_MAP) {
  const aliasTool = pi.tools.find((t: any) => t.name === alias);

  if (aliasTool) {
    const guidelinesText = aliasTool.promptGuidelines.join(' ');
    assert.ok(
      guidelinesText.includes(`Alias for ${canonical}`),
      `Alias "${alias}" promptGuidelines should say "Alias for ${canonical}"`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
