/**
 * SettingsView — full settings panel with 5 sections, all open by default.
 *
 * Uses useSettings hook. Changes require explicit Apply button.
 * Two-tier config: global vs project with override indicators.
 * Discovers real GSD 2 config (skills, commands, agents, plugins).
 */
import { useState, useCallback } from "react";
import {
  Shield,
  Terminal,
  Users,
  GitBranch,
  Package,
  ChevronDown,
  ChevronRight,
  Search,
  Zap,
  Plug,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/hooks/useSettings";

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  badge?: number;
  children: React.ReactNode;
}

function Section({ title, icon, open, onToggle, badge, children }: SectionProps) {
  return (
    <div className="border-b border-navy-600">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 p-4 text-left text-sm font-medium text-slate-300 transition-colors hover:bg-navy-800"
      >
        {icon}
        <span className="flex-1">{title}</span>
        {badge !== undefined && badge > 0 && (
          <span className="text-[10px] font-mono bg-cyan-accent/15 text-cyan-accent px-1.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}
        {open ? (
          <ChevronDown className="h-4 w-4 text-slate-500" />
        ) : (
          <ChevronRight className="h-4 w-4 text-slate-500" />
        )}
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  checked: boolean;
  onChange: (val: boolean) => void;
  overridden?: boolean;
}

function ToggleRow({ label, checked, onChange, overridden }: ToggleRowProps) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 rounded-full transition-colors",
          checked ? "bg-cyan-accent" : "bg-navy-600",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
      <span>{label}</span>
      {overridden && (
        <span className="text-xs text-amber-400 ml-1">(project override)</span>
      )}
    </label>
  );
}

function TextAreaRow({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm text-slate-400">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md bg-navy-800 border border-navy-600 px-3 py-2 text-sm text-slate-300 font-mono resize-none h-20 focus:outline-none focus:border-cyan-accent"
      />
    </div>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
  overridden,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (val: string) => void;
  overridden?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm text-slate-400 flex-1">
        {label}
        {overridden && (
          <span className="text-xs text-amber-400 ml-1">(project override)</span>
        )}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md bg-navy-800 border border-navy-600 px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:border-cyan-accent"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Model options available in GSD 2 per-phase selects. */
const GSD2_MODEL_OPTIONS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
];

/** Pill badge for items like skills, commands. */
function ItemPill({ label, variant = "default" }: { label: string; variant?: "default" | "active" | "plugin" }) {
  const colors = {
    default: "bg-navy-800 text-slate-300 border-navy-600",
    active: "bg-cyan-accent/10 text-cyan-accent border-cyan-accent/30",
    plugin: "bg-emerald-900/30 text-emerald-400 border-emerald-700/30",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-mono", colors[variant])}>
      {label}
    </span>
  );
}

export function SettingsView() {
  const { settings, loading, error, dirty, update, save } = useSettings();
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    claude: true,
    skills: true,
    agents: true,
    worktree: true,
    marketplace: true,
  });
  const [marketplaceSearch, setMarketplaceSearch] = useState("");
  // Local overrides for immediate visual feedback before Apply
  const [localOverrides, setLocalOverrides] = useState<Record<string, unknown>>({});

  const toggleSection = useCallback((key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const getSetting = (key: string, fallback: unknown = "") => {
    // Local overrides take priority for immediate visual feedback
    if (key in localOverrides) return localOverrides[key];
    if (!settings) return fallback;
    return settings.merged[key] ?? fallback;
  };

  const isOverridden = (key: string): boolean => {
    if (key in localOverrides) return true;
    if (!settings) return false;
    return key in settings.project;
  };

  const handleUpdate = useCallback((key: string, value: unknown) => {
    setLocalOverrides((prev) => ({ ...prev, [key]: value }));
    update(key, value);
  }, [update]);

  const handleApply = useCallback(async () => {
    await save("project");
    setLocalOverrides({}); // Clear overrides after save — server state is truth
  }, [save]);

  const claude = settings?.claude;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-slate-500 text-sm font-mono">Loading settings...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-red-400 text-sm font-mono">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-navy-900">
      {/* Header */}
      <div className="border-b border-navy-600 p-4">
        <h1 className="text-lg font-display text-slate-200">Settings</h1>
        <p className="text-xs text-slate-500 mt-1">
          Configure Claude Code options, skills, and project preferences.
        </p>
      </div>

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto">
        {/* 1. AI Model Settings */}
        <Section
          title="AI Model Settings"
          icon={<Shield className="h-4 w-4 text-cyan-accent" />}
          open={openSections.claude ?? false}
          onToggle={() => toggleSection("claude")}
        >
          <SelectRow
            label="Research model"
            value={getSetting("research_model", "claude-sonnet-4-6") as string}
            options={GSD2_MODEL_OPTIONS}
            onChange={(val) => handleUpdate("research_model", val)}
            overridden={isOverridden("research_model")}
          />
          <SelectRow
            label="Planning model"
            value={getSetting("planning_model", "claude-sonnet-4-6") as string}
            options={GSD2_MODEL_OPTIONS}
            onChange={(val) => handleUpdate("planning_model", val)}
            overridden={isOverridden("planning_model")}
          />
          <SelectRow
            label="Execution model"
            value={getSetting("execution_model", "claude-sonnet-4-6") as string}
            options={GSD2_MODEL_OPTIONS}
            onChange={(val) => handleUpdate("execution_model", val)}
            overridden={isOverridden("execution_model")}
          />
          <SelectRow
            label="Completion model"
            value={getSetting("completion_model", "claude-sonnet-4-6") as string}
            options={GSD2_MODEL_OPTIONS}
            onChange={(val) => handleUpdate("completion_model", val)}
            overridden={isOverridden("completion_model")}
          />
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-400 flex-1">Budget ceiling ($)</label>
            <input
              type="number"
              value={getSetting("budget_ceiling", "") as string | number}
              onChange={(e) => handleUpdate("budget_ceiling", e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="e.g. 50"
              className="w-24 rounded-md bg-navy-800 border border-navy-600 px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:border-cyan-accent"
            />
          </div>
          <SelectRow
            label="Skill discovery"
            value={getSetting("skill_discovery", "auto") as string}
            options={["auto", "suggest", "off"]}
            onChange={(val) => handleUpdate("skill_discovery", val)}
            overridden={isOverridden("skill_discovery")}
          />
        </Section>

        {/* 2. Skills & Commands */}
        <Section
          title="Skills & Commands"
          icon={<Terminal className="h-4 w-4 text-cyan-accent" />}
          open={openSections.skills ?? false}
          onToggle={() => toggleSection("skills")}
          badge={(claude?.skills.length ?? 0) + (claude?.commands.length ?? 0)}
        >
          {/* Skills */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Installed Skills
              </span>
            </div>
            {claude?.skills && claude.skills.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {claude.skills.map((skill) => (
                  <ItemPill key={skill} label={skill} variant="active" />
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-600 italic">No skills installed</p>
            )}
          </div>

          {/* Commands */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-cyan-accent" />
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Custom Commands
              </span>
            </div>
            {claude?.commands && claude.commands.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {claude.commands.map((cmd) => (
                  <ItemPill key={cmd} label={`/${cmd}`} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-600 italic">No custom commands</p>
            )}
          </div>
        </Section>

        {/* 3. Sub-agents & Profiles */}
        <Section
          title="Sub-agents & Profiles"
          icon={<Users className="h-4 w-4 text-cyan-accent" />}
          open={openSections.agents ?? false}
          onToggle={() => toggleSection("agents")}
          badge={claude?.agents.length ?? 0}
        >
          {/* Discovered agents */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Bot className="h-3.5 w-3.5 text-violet-400" />
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Installed Agents
              </span>
            </div>
            {claude?.agents && claude.agents.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {claude.agents.map((agent) => (
                  <ItemPill key={agent} label={agent} variant="active" />
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-600 italic">No custom agents (GSD agents excluded)</p>
            )}
          </div>

          {/* Model profiles */}
          <div className="space-y-2 mt-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Model Profiles
            </span>
            {["quality", "balanced", "budget"].map((profile) => (
              <div
                key={profile}
                className="flex items-center justify-between rounded-md bg-navy-800 border border-navy-600 px-3 py-2"
              >
                <span className="text-sm text-slate-300 capitalize">
                  {profile}
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  {profile === "quality"
                    ? "claude-opus-4"
                    : profile === "balanced"
                      ? "claude-sonnet-4"
                      : "claude-haiku-3"}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* 4. Worktree Isolation */}
        <Section
          title="Worktree Isolation"
          icon={<GitBranch className="h-4 w-4 text-cyan-accent" />}
          open={openSections.worktree ?? false}
          onToggle={() => toggleSection("worktree")}
        >
          <ToggleRow
            label="Auto-create worktrees for new sessions"
            checked={getSetting("worktree_enabled", false) as boolean}
            onChange={(val) => handleUpdate("worktree_enabled", val)}
            overridden={isOverridden("worktree_enabled")}
          />
          <p className="text-xs text-slate-500">
            When enabled, each new chat session gets an isolated git worktree.
          </p>
        </Section>

        {/* 5. Plugins & Marketplace */}
        <Section
          title="Plugins & Marketplace"
          icon={<Package className="h-4 w-4 text-cyan-accent" />}
          open={openSections.marketplace ?? false}
          onToggle={() => toggleSection("marketplace")}
          badge={claude?.plugins.length ?? 0}
        >
          {/* Installed plugins */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Plug className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Installed Plugins
              </span>
            </div>
            {claude?.plugins && claude.plugins.length > 0 ? (
              <div className="space-y-1.5">
                {claude.plugins.map((plugin) => (
                  <div
                    key={plugin.name}
                    className="flex items-center justify-between rounded-md bg-navy-800 border border-navy-600 px-3 py-2"
                  >
                    <span className="text-xs text-slate-300 font-mono truncate flex-1">
                      {plugin.name}
                    </span>
                    <span className="text-[10px] text-slate-500 bg-navy-700 px-1.5 py-0.5 rounded ml-2">
                      {plugin.scope}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-600 italic">No plugins installed</p>
            )}
          </div>

          {/* npm search */}
          <div className="mt-2">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={marketplaceSearch}
                onChange={(e) => setMarketplaceSearch(e.target.value)}
                placeholder="Search npm packages..."
                className="w-full rounded-md bg-navy-800 border border-navy-600 pl-9 pr-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-cyan-accent"
              />
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Search and install plugins from the npm registry.
            </p>
          </div>
        </Section>
      </div>

      {/* Apply button */}
      <div className="border-t border-navy-600 p-4 flex justify-end gap-2">
        <button
          type="button"
          disabled={!dirty}
          onClick={handleApply}
          className={cn(
            "rounded-md px-4 py-2 text-sm font-medium transition-colors",
            dirty
              ? "bg-cyan-accent text-navy-900 hover:bg-cyan-accent/90"
              : "bg-navy-700 text-slate-500 cursor-not-allowed",
          )}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
