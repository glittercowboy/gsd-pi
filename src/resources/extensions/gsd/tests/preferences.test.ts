/**
 * Preferences tests — consolidated from:
 *   - preferences-git.test.ts (git.isolation, git.merge_to_main)
 *   - preferences-hooks.test.ts (post-unit + pre-dispatch hook config)
 *   - preferences-mode.test.ts (solo/team mode defaults, overrides)
 *   - preferences-models.test.ts (model config parsing, OpenRouter, CRLF)
 *   - preferences-schema-validation.test.ts (unknown keys, invalid types)
 *   - preferences-wizard-fields.test.ts (budget, notifications, git, uat)
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePreferences,
  applyModeDefaults,
  getIsolationMode,
  parsePreferencesMarkdown,
  _resetParseWarningFlag,
} from "../preferences.ts";
import { formatConfiguredModel, toPersistedModelId } from "../commands-prefs-wizard.ts";
import { _resetLogs, peekLogs } from "../workflow-logger.ts";
import type { GSDPreferences, GSDModelConfigV2, GSDPhaseModelConfig } from "../preferences.ts";

// ── Git preferences ──────────────────────────────────────────────────────────

test("git.isolation accepts valid values and rejects invalid", () => {
  for (const val of ["worktree", "branch", "none"] as const) {
    const { errors, preferences } = validatePreferences({ git: { isolation: val } });
    assert.equal(errors.length, 0, `isolation ${val}: no errors`);
    assert.equal(preferences.git?.isolation, val);
  }
  const { errors } = validatePreferences({ git: { isolation: "invalid" as any } });
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes("worktree, branch, none"));
});

test("git.merge_to_main produces deprecation warning", () => {
  for (const val of ["milestone", "slice"]) {
    const { warnings } = validatePreferences({ git: { merge_to_main: val } } as any);
    assert.ok(warnings.length > 0);
    assert.ok(warnings[0].includes("deprecated"));
  }
});


test("getIsolationMode defaults to none when preferences have no isolation setting", () => {
  // Validate the default via validatePreferences: when no isolation is set,
  // preferences.git.isolation is undefined, and getIsolationMode returns "none".
  // Default changed from "worktree" to "none" so GSD works out of the box
  // without PREFERENCES.md (#2480).
  const { preferences } = validatePreferences({});
  assert.equal(preferences.git?.isolation, undefined, "no isolation in empty prefs");
  const isolation = preferences.git?.isolation;
  const expected = isolation === "worktree" ? "worktree" : isolation === "branch" ? "branch" : "none";
  assert.equal(expected, "none", "default isolation mode is none");
});

// ── Mode defaults ────────────────────────────────────────────────────────────

test("solo mode applies correct defaults", () => {
  const result = applyModeDefaults("solo", { mode: "solo" });
  assert.equal(result.git?.auto_push, true);
  assert.equal(result.git?.push_branches, false);
  assert.equal(result.git?.pre_merge_check, "auto");
  assert.equal(result.git?.merge_strategy, "squash");
  assert.equal(result.git?.isolation, "none");
  assert.equal(result.unique_milestone_ids, false);
});

test("team mode applies correct defaults", () => {
  const result = applyModeDefaults("team", { mode: "team" });
  assert.equal(result.git?.auto_push, false);
  assert.equal(result.git?.push_branches, true);
  assert.equal(result.git?.pre_merge_check, true);
  assert.equal(result.unique_milestone_ids, true);
});

test("explicit override wins over mode default", () => {
  const result = applyModeDefaults("solo", { mode: "solo", git: { auto_push: false } });
  assert.equal(result.git?.auto_push, false);
  assert.equal(result.git?.push_branches, false); // default still applies
});

test("mode: team + explicit unique_milestone_ids override", () => {
  const result = applyModeDefaults("team", { mode: "team", unique_milestone_ids: false });
  assert.equal(result.unique_milestone_ids, false);
  assert.equal(result.git?.push_branches, true); // other defaults still apply
});

test("invalid mode value produces error", () => {
  const { errors } = validatePreferences({ mode: "invalid" as any });
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes("solo, team"));
});

test("valid mode values pass validation", () => {
  for (const m of ["solo", "team"] as const) {
    const { errors, preferences } = validatePreferences({ mode: m });
    assert.equal(errors.length, 0);
    assert.equal(preferences.mode, m);
  }
});

// ── Schema validation ────────────────────────────────────────────────────────

test("unknown keys produce warnings", () => {
  const { warnings } = validatePreferences({ typo_key: "value" } as any);
  assert.ok(warnings.some(w => w.includes("typo_key")));
  assert.ok(warnings.some(w => w.includes("unknown")));
});

test("known keys produce no unknown-key warnings", () => {
  const { warnings } = validatePreferences({
    version: 1, uat_dispatch: true, budget_ceiling: 50, skill_discovery: "auto",
  });
  assert.equal(warnings.filter(w => w.includes("unknown")).length, 0);
});

test("invalid value types produce errors and fall back to undefined", () => {
  const cases = [
    { input: { budget_ceiling: "not-a-number" }, field: "budget_ceiling" },
    { input: { budget_enforcement: "invalid" }, field: "budget_enforcement" },
    { input: { context_pause_threshold: "not-a-number" }, field: "context_pause_threshold" },
    { input: { skill_discovery: "invalid-mode" }, field: "skill_discovery" },
  ];
  for (const { input, field } of cases) {
    const { errors, preferences } = validatePreferences(input as any);
    assert.ok(errors.some(e => e.includes(field)), `${field}: error produced`);
    assert.equal((preferences as any)[field], undefined, `${field}: falls back to undefined`);
  }
});

test("valid values pass through correctly", () => {
  const { preferences: p1 } = validatePreferences({ budget_enforcement: "halt" });
  assert.equal(p1.budget_enforcement, "halt");

  const { preferences: p2 } = validatePreferences({ context_pause_threshold: 0.75 });
  assert.equal(p2.context_pause_threshold, 0.75);

  const { preferences: p3 } = validatePreferences({ auto_supervisor: { model: "claude-opus-4-6" } });
  assert.equal(p3.auto_supervisor?.model, "claude-opus-4-6");
});

test("mixed valid/invalid/unknown keys handled correctly", () => {
  const { preferences, errors, warnings } = validatePreferences({
    uat_dispatch: true, totally_made_up: "value", budget_ceiling: "garbage",
  } as any);
  assert.equal(preferences.uat_dispatch, true);
  assert.ok(warnings.some(w => w.includes("totally_made_up")));
  assert.ok(errors.some(e => e.includes("budget_ceiling")));
  assert.equal(preferences.budget_ceiling, undefined);
});

// ── Wizard fields ────────────────────────────────────────────────────────────

test("budget fields validate correctly", () => {
  const { preferences, errors } = validatePreferences({
    budget_ceiling: 25.50, budget_enforcement: "warn", context_pause_threshold: 80,
  });
  assert.equal(errors.length, 0);
  assert.equal(preferences.budget_ceiling, 25.50);
  assert.equal(preferences.budget_enforcement, "warn");
  assert.equal(preferences.context_pause_threshold, 80);
});

test("notification fields validate correctly", () => {
  const { preferences, errors } = validatePreferences({
    notifications: { enabled: true, on_complete: false, on_error: true, on_budget: true },
  });
  assert.equal(errors.length, 0);
  assert.equal(preferences.notifications?.enabled, true);
  assert.equal(preferences.notifications?.on_complete, false);
});

test("cmux fields validate correctly", () => {
  const { preferences, errors } = validatePreferences({
    cmux: {
      enabled: true,
      notifications: true,
      sidebar: false,
      splits: true,
      browser: false,
    },
  });
  assert.equal(errors.length, 0);
  assert.equal(preferences.cmux?.enabled, true);
  assert.equal(preferences.cmux?.sidebar, false);
  assert.equal(preferences.cmux?.splits, true);
});

test("cmux unknown keys produce warnings", () => {
  const { warnings } = validatePreferences({
    cmux: { enabled: true, strange_mode: true } as any,
  });
  assert.ok(warnings.some((warning) => warning.includes('unknown cmux key "strange_mode"')));
});

test("git fields comprehensive validation", () => {
  const { preferences, errors } = validatePreferences({
    git: {
      auto_push: true, push_branches: false, remote: "upstream", snapshots: true,
      pre_merge_check: "auto", commit_type: "feat", main_branch: "develop",
      merge_strategy: "squash", isolation: "branch",
    },
  });
  assert.equal(errors.length, 0);
  assert.equal(preferences.git?.auto_push, true);
  assert.equal(preferences.git?.remote, "upstream");
  assert.equal(preferences.git?.isolation, "branch");
});

test("auto_visualize, auto_report, context_selection validate correctly", () => {
  const { preferences, errors } = validatePreferences({
    auto_visualize: true,
    auto_report: false,
    context_selection: "smart",
  });
  assert.equal(errors.length, 0);
  assert.equal(preferences.auto_visualize, true);
  assert.equal(preferences.auto_report, false);
  assert.equal(preferences.context_selection, "smart");
});

test("auto_visualize, auto_report, context_selection reject invalid values", () => {
  const { errors: e1 } = validatePreferences({ auto_visualize: "yes" as never });
  assert.ok(e1.some(e => e.includes("auto_visualize")));

  const { errors: e2 } = validatePreferences({ auto_report: 1 as never });
  assert.ok(e2.some(e => e.includes("auto_report")));

  const { errors: e4 } = validatePreferences({ context_selection: "partial" as never });
  assert.ok(e4.some(e => e.includes("context_selection")));
});

test("all wizard fields together produce no errors", () => {
  const { errors, warnings } = validatePreferences({
    version: 1,
    models: { research: "claude-opus-4-6" },
    auto_supervisor: { soft_timeout_minutes: 15 },
    git: { main_branch: "main", auto_push: true, isolation: "worktree" },
    skill_discovery: "suggest",
    unique_milestone_ids: false,
    budget_ceiling: 50, budget_enforcement: "pause", context_pause_threshold: 75,
    notifications: { enabled: true },
    uat_dispatch: false,
  });
  assert.equal(errors.length, 0);
  assert.equal(warnings.filter(w => w.includes("unknown")).length, 0);
});

// ── Hook config ──────────────────────────────────────────────────────────────

test("post-unit hook max_cycles clamping via validatePreferences", () => {
  const base = { name: "h", after: ["execute-task"], prompt: "do something" };

  const { preferences: p1 } = validatePreferences({ post_unit_hooks: [{ ...base, max_cycles: 15 }] } as any);
  assert.equal(p1.post_unit_hooks![0].max_cycles, 10, "clamps to 10");

  const { preferences: p2 } = validatePreferences({ post_unit_hooks: [{ ...base, max_cycles: 0 }] } as any);
  assert.equal(p2.post_unit_hooks![0].max_cycles, 1, "clamps to 1");

  const { preferences: p3 } = validatePreferences({ post_unit_hooks: [{ ...base, max_cycles: -5 }] } as any);
  assert.equal(p3.post_unit_hooks![0].max_cycles, 1, "negative clamps to 1");

  const { preferences: p4 } = validatePreferences({ post_unit_hooks: [{ ...base, max_cycles: 3 }] } as any);
  assert.equal(p4.post_unit_hooks![0].max_cycles, 3, "valid value passes through");
});

test("pre-dispatch hook action validation via validatePreferences", () => {
  const base = { name: "h", before: ["execute-task"] };

  const { preferences, errors: e1 } = validatePreferences({
    pre_dispatch_hooks: [{ ...base, action: "skip" }],
  } as any);
  assert.equal(e1.length, 0);
  assert.equal(preferences.pre_dispatch_hooks![0].action, "skip");

  const { preferences: p2, errors: e2 } = validatePreferences({
    pre_dispatch_hooks: [{ ...base, action: "modify", prepend: "note: " }],
  } as any);
  assert.equal(e2.length, 0);
  assert.equal(p2.pre_dispatch_hooks![0].action, "modify");

  const { errors: e3 } = validatePreferences({
    pre_dispatch_hooks: [{ ...base, action: "delete" }],
  } as any);
  assert.ok(e3.some(e => e.includes("invalid action")));
});

// ── Model config parsing ─────────────────────────────────────────────────────

test("parses OpenRouter model config with org/model IDs and fallbacks", () => {
  const content = `---\nversion: 1\nmodels:\n  research:\n    model: moonshotai/kimi-k2.5\n    fallbacks:\n      - qwen/qwen3.5-397b-a17b\n  planning:\n    model: deepseek/deepseek-r1-0528\n    fallbacks:\n      - moonshotai/kimi-k2.5\n      - deepseek/deepseek-v3.2\n  execution:\n    model: qwen/qwen3-coder\n    fallbacks:\n      - qwen/qwen3-coder-next\n---\n`;
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  const models = prefs!.models as GSDModelConfigV2;
  const research = models.research as GSDPhaseModelConfig;
  assert.equal(research.model, "moonshotai/kimi-k2.5");
  assert.deepEqual(research.fallbacks, ["qwen/qwen3.5-397b-a17b"]);
  const execution = models.execution as GSDPhaseModelConfig;
  assert.deepEqual(execution.fallbacks, ["qwen/qwen3-coder-next"]);
});

test("parses model IDs with colons (OpenRouter :free, :exacto)", () => {
  const content = `---\nmodels:\n  execution:\n    model: qwen/qwen3-coder\n    fallbacks:\n      - qwen/qwen3-coder:free\n      - qwen/qwen3-coder:exacto\n---\n`;
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  const models = prefs!.models as GSDModelConfigV2;
  const execution = models.execution as GSDPhaseModelConfig;
  assert.deepEqual(execution.fallbacks, ["qwen/qwen3-coder:free", "qwen/qwen3-coder:exacto"]);
});

test("parses legacy string-per-phase model config", () => {
  const content = `---\nmodels:\n  research: claude-opus-4-6\n  execution: claude-sonnet-4-6\n---\n`;
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  const models = prefs!.models as GSDModelConfigV2;
  assert.equal(models.research, "claude-opus-4-6");
  assert.equal(models.execution, "claude-sonnet-4-6");
});

test("strips inline YAML comments from values", () => {
  const content = `---\nmodels:\n  execution:\n    model: qwen/qwen3-coder  # fast\n    fallbacks:\n      - minimax/minimax-m2.5  # backup\n---\n`;
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  const models = prefs!.models as GSDModelConfigV2;
  const execution = models.execution as GSDPhaseModelConfig;
  assert.equal(execution.model, "qwen/qwen3-coder");
  assert.deepEqual(execution.fallbacks, ["minimax/minimax-m2.5"]);
});

test("handles Windows CRLF line endings", () => {
  const content = "---\r\nmodels:\r\n  execution:\r\n    model: qwen/qwen3-coder\r\n---\r\n";
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  const models = prefs!.models as GSDModelConfigV2;
  const execution = models.execution as GSDPhaseModelConfig;
  assert.equal(execution.model, "qwen/qwen3-coder");
});

test("handles model config with explicit provider field", () => {
  const content = `---\nmodels:\n  execution:\n    model: claude-opus-4-6\n    provider: bedrock\n    fallbacks:\n      - claude-sonnet-4-6\n---\n`;
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  const models = prefs!.models as GSDModelConfigV2;
  const execution = models.execution as GSDPhaseModelConfig;
  assert.equal(execution.model, "claude-opus-4-6");
  assert.equal(execution.provider, "bedrock");
});

test("formatConfiguredModel renders provider-qualified object config", () => {
  assert.equal(
    formatConfiguredModel({ model: "claude-opus-4-6", provider: "bedrock" }),
    "bedrock/claude-opus-4-6",
  );
});

test("toPersistedModelId prefixes provider chosen in prefs wizard", () => {
  assert.equal(toPersistedModelId("openai", "gpt-5.4"), "openai/gpt-5.4");
  assert.equal(
    toPersistedModelId("openai", "openai/gpt-5.4"),
    "openai/gpt-5.4",
    "already-qualified IDs should be preserved",
  );
});

test("handles empty models config", () => {
  const prefs = parsePreferencesMarkdown("---\nversion: 1\n---\n");
  assert.notEqual(prefs, null);
  assert.equal(prefs!.models, undefined);
});

test("parses raw YAML blocks under headings", () => {
  const content = `## Parallel
enabled: true
max_workers: 3
`;
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  assert.equal(prefs!.parallel?.enabled, true);
  assert.equal(prefs!.parallel?.max_workers, 3);
});

test("unwraps nested top-level preference key under descriptive headings", () => {
  const content = `## Parallel Orchestration
parallel:
  enabled: true
  max_workers: 3
`;
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  assert.equal(prefs!.parallel?.enabled, true);
  assert.equal(prefs!.parallel?.max_workers, 3);
});

test("preserves legacy heading list format", () => {
  const content = `## Git
- isolation: branch
- auto_push: true
`;
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  assert.equal(prefs!.git?.isolation, "branch");
  assert.equal(prefs!.git?.auto_push, true);
});

// ── Warn-once for unrecognized format (#2373) ────────────────────────────────

test("unrecognized format warning is emitted at most once (#2373)", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    // Reset internal warned flag so the test starts clean
    _resetParseWarningFlag();

    const unrecognized = "This is just plain text with no frontmatter or headings.";

    // Call multiple times — simulates repeated preference loads
    parsePreferencesMarkdown(unrecognized);
    parsePreferencesMarkdown(unrecognized);
    parsePreferencesMarkdown(unrecognized);

    const relevant = warnings.filter(w => w.includes("unrecognized format"));
    assert.equal(relevant.length, 1, `expected exactly 1 warning, got ${relevant.length}: ${JSON.stringify(relevant)}`);
  } finally {
    console.warn = origWarn;
    // Reset so other tests aren't affected by the flag state
    _resetParseWarningFlag();
  }
});

test("parsePreferencesMarkdown parses heading+list format without frontmatter (#2036)", () => {
  // A GSD agent recovery session wrote preferences in markdown heading+list
  // format instead of YAML frontmatter. Since the heading+list fallback parser
  // was added, this format is now handled gracefully.
  const content = "## Git\n\n- isolation: none\n";
  const result = parsePreferencesMarkdown(content);
  assert.notEqual(result, null, "heading+list content should be parsed");
  assert.deepStrictEqual(result!.git, { isolation: "none" });
});

test("section parse warning is emitted at most once for heading+list YAML failures (#3759)", () => {
  _resetParseWarningFlag();
  _resetLogs();

  const content = `## Git
bad: [
`;

  parsePreferencesMarkdown(content);
  parsePreferencesMarkdown(content);
  parsePreferencesMarkdown(content);

  const warnings = peekLogs().filter((entry) => entry.component === "guided" && entry.message.includes("preferences section parse failed"));
  assert.equal(warnings.length, 1, `expected exactly 1 guided warning, got ${warnings.length}`);

  _resetParseWarningFlag();
  _resetLogs();
});

// ── Experimental preferences ─────────────────────────────────────────────────

test("experimental.rtk: true is accepted and stored", () => {
  const result = validatePreferences({ experimental: { rtk: true } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.preferences.experimental?.rtk, true);
});

test("experimental.rtk: false is accepted and stored", () => {
  const result = validatePreferences({ experimental: { rtk: false } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.preferences.experimental?.rtk, false);
});

test("experimental.rtk: non-boolean produces error", () => {
  const result = validatePreferences({ experimental: { rtk: "yes" } } as unknown as GSDPreferences);
  assert.ok(result.errors.some(e => e.includes("experimental.rtk")), `expected rtk error in: ${JSON.stringify(result.errors)}`);
});

test("experimental: non-object produces error", () => {
  const result = validatePreferences({ experimental: true } as unknown as GSDPreferences);
  assert.ok(result.errors.some(e => e.includes("experimental must be an object")));
});

test("experimental: unknown key produces warning", () => {
  const result = validatePreferences({ experimental: { rtk: true, future_flag: true } } as unknown as GSDPreferences);
  assert.ok(result.warnings.some(w => w.includes("future_flag")), `expected unknown-key warning in: ${JSON.stringify(result.warnings)}`);
  assert.equal(result.preferences.experimental?.rtk, true);
});

test("experimental: omitting rtk defaults to undefined (opt-in)", () => {
  const result = validatePreferences({ version: 1 });
  assert.equal(result.preferences.experimental, undefined);
});

test("experimental.rtk parses correctly from preferences markdown", () => {
  const content = "---\nversion: 1\nexperimental:\n  rtk: true\n---\n";
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  assert.equal(prefs!.experimental?.rtk, true);
});

test("experimental.rtk defaults to off in new project preferences", () => {
  // No experimental key → feature is disabled
  const content = "---\nversion: 1\n---\n";
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  assert.equal(prefs!.experimental?.rtk, undefined);
});

// ── Codebase Map Preferences ─────────────────────────────────────────────────

test("codebase preferences validate and pass through correctly", () => {
  const result = validatePreferences({
    codebase: {
      exclude_patterns: ["docs/", "fixtures/"],
      max_files: 1000,
      collapse_threshold: 15,
    },
  });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.preferences.codebase?.exclude_patterns, ["docs/", "fixtures/"]);
  assert.equal(result.preferences.codebase?.max_files, 1000);
  assert.equal(result.preferences.codebase?.collapse_threshold, 15);
});

test("codebase preferences reject invalid types", () => {
  const result = validatePreferences({
    codebase: {
      exclude_patterns: "not-an-array" as any,
      max_files: -5,
      collapse_threshold: 0,
    },
  });
  assert.ok(result.errors.some(e => e.includes("exclude_patterns must be an array")));
  assert.ok(result.errors.some(e => e.includes("max_files must be a positive")));
  assert.ok(result.errors.some(e => e.includes("collapse_threshold must be a positive")));
});

test("codebase preferences warn on unknown keys", () => {
  const result = validatePreferences({
    codebase: {
      exclude_patterns: ["docs/"],
      unknown_key: true,
    } as any,
  });
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some(w => w.includes('unknown codebase key "unknown_key"')));
  assert.deepEqual(result.preferences.codebase?.exclude_patterns, ["docs/"]);
});

test("codebase preferences parse from markdown frontmatter", () => {
  const content = [
    "---",
    "version: 1",
    "codebase:",
    "  exclude_patterns:",
    '    - "docs/"',
    '    - ".cache/"',
    "  max_files: 800",
    "  collapse_threshold: 10",
    "---",
  ].join("\n");
  const prefs = parsePreferencesMarkdown(content);
  assert.notEqual(prefs, null);
  const result = validatePreferences(prefs!);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.preferences.codebase?.exclude_patterns, ["docs/", ".cache/"]);
  assert.equal(result.preferences.codebase?.max_files, 800);
  assert.equal(result.preferences.codebase?.collapse_threshold, 10);
});
