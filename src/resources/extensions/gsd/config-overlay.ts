/**
 * GSD Configuration Overlay
 *
 * Read-only TUI overlay showing the effective GSD configuration:
 * token profile, model assignments, dynamic routing, git settings,
 * budget, workflow toggles, and preference file sources.
 * Opened via `/gsd show-config` or `/gsd config`.
 */

import type { Theme } from "@gsd/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@gsd/pi-tui";

import {
  loadEffectiveGSDPreferences,
  loadGlobalGSDPreferences,
  loadProjectGSDPreferences,
  getGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  resolveDynamicRoutingConfig,
  resolveEffectiveProfile,
  resolveModelWithFallbacksForUnit,
  resolveAutoSupervisorConfig,
} from "./preferences.js";

// ─── Data Collection ──────────────────────────────────────────────────────

interface ConfigSection {
  title: string;
  rows: Array<{ label: string; value: string; accent?: boolean }>;
}

function collectConfigSections(): ConfigSection[] {
  const sections: ConfigSection[] = [];

  const globalPrefs = loadGlobalGSDPreferences();
  const projectPrefs = loadProjectGSDPreferences();
  const effective = loadEffectiveGSDPreferences();
  const prefs = effective?.preferences;

  // ─── Sources ─────────────────────────────────────────────────────────
  sections.push({
    title: "Sources",
    rows: [
      { label: "Global", value: globalPrefs ? globalPrefs.path : `(none) ${getGlobalGSDPreferencesPath()}` },
      { label: "Project", value: projectPrefs ? projectPrefs.path : `(none) ${getProjectGSDPreferencesPath()}` },
    ],
  });

  // ─── Profile ─────────────────────────────────────────────────────────
  const profile = resolveEffectiveProfile();
  const profileRows: ConfigSection["rows"] = [
    { label: "Token profile", value: `${profile}${!prefs?.token_profile ? " (default)" : ""}`, accent: true },
  ];
  if (prefs?.mode) profileRows.push({ label: "Workflow mode", value: prefs.mode });
  sections.push({ title: "Profile", rows: profileRows });

  // ─── Models ──────────────────────────────────────────────────────────
  const unitTypes: Array<[string, string]> = [
    ["research", "research-milestone"],
    ["planning", "plan-milestone"],
    ["discuss", "discuss-milestone"],
    ["execution", "execute-task"],
    ["completion", "complete-slice"],
    ["validation", "run-uat"],
  ];

  const modelRows: ConfigSection["rows"] = [];
  for (const [label, unitType] of unitTypes) {
    const resolved = resolveModelWithFallbacksForUnit(unitType);
    if (resolved) {
      let val = resolved.primary;
      if (resolved.fallbacks.length > 0) {
        val += ` \u2192 ${resolved.fallbacks.join(" \u2192 ")}`;
      }
      modelRows.push({ label, value: val });
    } else {
      modelRows.push({ label, value: "(inherit)" });
    }
  }

  // subagent is a direct config key
  const models = prefs?.models as Record<string, unknown> | undefined;
  const subVal = models?.subagent;
  if (subVal) {
    const model = typeof subVal === "string" ? subVal : (subVal as { model?: string })?.model ?? "?";
    modelRows.push({ label: "subagent", value: model });
  } else {
    modelRows.push({ label: "subagent", value: "(inherit)" });
  }

  sections.push({ title: "Models", rows: modelRows });

  // ─── Dynamic Routing ─────────────────────────────────────────────────
  const routing = resolveDynamicRoutingConfig();
  const routingRows: ConfigSection["rows"] = [
    { label: "Enabled", value: routing.enabled ? "yes" : "no", accent: routing.enabled },
  ];
  if (routing.enabled) {
    routingRows.push({ label: "Escalate on fail", value: routing.escalate_on_failure !== false ? "yes" : "no" });
    routingRows.push({ label: "Budget pressure", value: routing.budget_pressure !== false ? "yes" : "no" });
    routingRows.push({ label: "Cross-provider", value: routing.cross_provider !== false ? "yes" : "no" });
    if (routing.tier_models) {
      const tm = routing.tier_models;
      if (tm.light) routingRows.push({ label: "[L] light", value: tm.light });
      if (tm.standard) routingRows.push({ label: "[S] standard", value: tm.standard });
      if (tm.heavy) routingRows.push({ label: "[H] heavy", value: tm.heavy });
    }
  }
  sections.push({ title: "Dynamic Routing", rows: routingRows });

  // ─── Git ─────────────────────────────────────────────────────────────
  if (prefs?.git) {
    const g = prefs.git;
    const gitRows: ConfigSection["rows"] = [];
    if (g.isolation !== undefined) gitRows.push({ label: "Isolation", value: String(g.isolation) });
    if (g.auto_push !== undefined) gitRows.push({ label: "Auto push", value: String(g.auto_push) });
    if (g.push_branches !== undefined) gitRows.push({ label: "Push branches", value: String(g.push_branches) });
    if (g.merge_strategy) gitRows.push({ label: "Merge strategy", value: g.merge_strategy });
    if (g.main_branch) gitRows.push({ label: "Main branch", value: g.main_branch });
    if (g.remote) gitRows.push({ label: "Remote", value: g.remote });
    if (gitRows.length > 0) sections.push({ title: "Git", rows: gitRows });
  }

  // ─── Budget ──────────────────────────────────────────────────────────
  if (prefs?.budget_ceiling !== undefined || prefs?.budget_enforcement) {
    const budgetRows: ConfigSection["rows"] = [];
    if (prefs.budget_ceiling !== undefined) budgetRows.push({ label: "Ceiling", value: `$${prefs.budget_ceiling}` });
    if (prefs.budget_enforcement) budgetRows.push({ label: "Enforcement", value: String(prefs.budget_enforcement) });
    sections.push({ title: "Budget", rows: budgetRows });
  }

  // ─── Auto Supervisor ─────────────────────────────────────────────────
  if (prefs?.auto_supervisor) {
    const sup = resolveAutoSupervisorConfig();
    const supRows: ConfigSection["rows"] = [];
    if (sup.model) supRows.push({ label: "Model", value: sup.model });
    supRows.push({ label: "Soft timeout", value: `${sup.soft_timeout_minutes}m` });
    supRows.push({ label: "Idle timeout", value: `${sup.idle_timeout_minutes}m` });
    supRows.push({ label: "Hard timeout", value: `${sup.hard_timeout_minutes}m` });
    sections.push({ title: "Auto Supervisor", rows: supRows });
  }

  // ─── Toggles ─────────────────────────────────────────────────────────
  const toggleRows: ConfigSection["rows"] = [];
  if (prefs?.phases) {
    const p = prefs.phases;
    if (p.skip_research) toggleRows.push({ label: "skip_research", value: "on" });
    if (p.skip_reassess) toggleRows.push({ label: "skip_reassess", value: "on" });
    if (p.skip_slice_research) toggleRows.push({ label: "skip_slice_research", value: "on" });
    if (p.skip_milestone_validation) toggleRows.push({ label: "skip_milestone_validation", value: "on" });
    if (p.require_slice_discussion) toggleRows.push({ label: "require_slice_discussion", value: "on" });
  }
  if (prefs?.uat_dispatch) toggleRows.push({ label: "uat_dispatch", value: "on" });
  if (prefs?.auto_visualize) toggleRows.push({ label: "auto_visualize", value: "on" });
  if (prefs?.auto_report === false) toggleRows.push({ label: "auto_report", value: "off" });
  if (prefs?.show_token_cost) toggleRows.push({ label: "show_token_cost", value: "on" });
  if (prefs?.forensics_dedup) toggleRows.push({ label: "forensics_dedup", value: "on" });
  if (prefs?.unique_milestone_ids) toggleRows.push({ label: "unique_milestone_ids", value: "on" });
  if (prefs?.service_tier) toggleRows.push({ label: "service_tier", value: prefs.service_tier });
  if (prefs?.search_provider && prefs.search_provider !== "auto") toggleRows.push({ label: "search_provider", value: prefs.search_provider });
  if (prefs?.context_selection) toggleRows.push({ label: "context_selection", value: prefs.context_selection });
  if (prefs?.widget_mode && prefs.widget_mode !== "full") toggleRows.push({ label: "widget_mode", value: prefs.widget_mode });
  if (prefs?.experimental?.rtk) toggleRows.push({ label: "experimental.rtk", value: "on" });
  if (toggleRows.length > 0) sections.push({ title: "Toggles", rows: toggleRows });

  // ─── Parallel ────────────────────────────────────────────────────────
  if (prefs?.parallel) {
    const pc = prefs.parallel;
    const parallelRows: ConfigSection["rows"] = [];
    if (pc.max_workers !== undefined) parallelRows.push({ label: "Max workers", value: String(pc.max_workers) });
    if (pc.merge_strategy) parallelRows.push({ label: "Merge strategy", value: pc.merge_strategy });
    if (pc.auto_merge) parallelRows.push({ label: "Auto merge", value: pc.auto_merge });
    if (parallelRows.length > 0) sections.push({ title: "Parallel", rows: parallelRows });
  }

  // ─── Hooks ───────────────────────────────────────────────────────────
  const postHooks = prefs?.post_unit_hooks?.filter(h => h.enabled !== false) ?? [];
  const preHooks = prefs?.pre_dispatch_hooks?.filter(h => h.enabled !== false) ?? [];
  if (postHooks.length > 0 || preHooks.length > 0) {
    const hookRows: ConfigSection["rows"] = [];
    if (preHooks.length > 0) hookRows.push({ label: "Pre-dispatch", value: `${preHooks.length} active` });
    if (postHooks.length > 0) hookRows.push({ label: "Post-unit", value: `${postHooks.length} active` });
    sections.push({ title: "Hooks", rows: hookRows });
  }

  // ─── Warnings ────────────────────────────────────────────────────────
  const warnings = [
    ...(globalPrefs?.warnings ?? []),
    ...(projectPrefs?.warnings ?? []),
  ];
  if (warnings.length > 0) {
    sections.push({
      title: "Warnings",
      rows: warnings.map(w => ({ label: "\u26a0", value: w })),
    });
  }

  return sections;
}

// ─── Plain Text Formatter (headless/RPC fallback) ─────────────────────────

export function formatConfigText(): string {
  const sections = collectConfigSections();
  const lines: string[] = ["GSD Configuration\n"];

  let maxLabel = 0;
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.label.length > maxLabel) maxLabel = row.label.length;
    }
  }
  const pad = Math.min(maxLabel + 2, 24);

  for (const section of sections) {
    lines.push("");
    lines.push(section.title.toUpperCase());
    for (const row of section.rows) {
      lines.push(`  ${row.label.padEnd(pad)}${row.value}`);
    }
  }

  return lines.join("\n");
}

// ─── Overlay Class ────────────────────────────────────────────────────────

export class GSDConfigOverlay {
  private tui: { requestRender: () => void };
  private theme: Theme;
  private onClose: () => void;
  private sections: ConfigSection[];
  private cachedLines?: string[];
  private scrollOffset = 0;
  private disposed = false;

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.sections = collectConfigSections();
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.disposed = true;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") {
      this.dispose();
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.scrollOffset++;
      this.cachedLines = undefined;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.cachedLines = undefined;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += 10;
      this.cachedLines = undefined;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.cachedLines = undefined;
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;

    const t = this.theme;
    const w = Math.max(width, 50);
    const allLines: string[] = [];

    // Header
    allLines.push(t.bold(t.fg("accent", " GSD Configuration ")));
    allLines.push(t.fg("muted", "\u2500".repeat(w)));

    // Find max label width for alignment
    let maxLabel = 0;
    for (const section of this.sections) {
      for (const row of section.rows) {
        if (row.label.length > maxLabel) maxLabel = row.label.length;
      }
    }
    const labelPad = Math.min(maxLabel + 2, 24);

    for (const section of this.sections) {
      allLines.push("");
      allLines.push(t.bold(t.fg("accent", `  ${section.title}`)));

      for (const row of section.rows) {
        const label = t.fg("muted", `    ${row.label.padEnd(labelPad)}`);
        const value = row.accent ? t.bold(row.value) : row.value;
        allLines.push(truncateToWidth(`${label}${value}`, w));
      }
    }

    allLines.push("");
    allLines.push(t.fg("muted", `  ${"\u2500".repeat(w - 4)}`));
    allLines.push(t.fg("muted", "  esc/q close  \u2502  \u2191\u2193/jk scroll  \u2502  /gsd prefs to edit"));

    // Apply scroll
    const maxScroll = Math.max(0, allLines.length - 20);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visible = allLines.slice(this.scrollOffset);

    this.cachedLines = visible;
    return visible;
  }
}
