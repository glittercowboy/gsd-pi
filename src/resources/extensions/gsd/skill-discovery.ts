/**
 * GSD Skill Discovery
 *
 * Detects skills installed during auto-mode by comparing the current
 * skills directory against a snapshot taken at auto-mode start.
 *
 * New skills are injected into the system prompt via before_agent_start,
 * making them visible to all subsequent units without requiring a reload.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Skills directories — skills.sh ecosystem + Claude Code official */
const SKILLS_DIR = join(homedir(), ".agents", "skills");
const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");

export interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
}

/** Snapshot of skill names at auto-mode start */
let baselineSkills: Set<string> | null = null;

/**
 * Snapshot the current skills directory. Call at auto-mode start.
 */
export function snapshotSkills(): void {
  baselineSkills = new Set(listSkillDirs());
}

/**
 * Clear the snapshot. Call when auto-mode stops.
 */
export function clearSkillSnapshot(): void {
  baselineSkills = null;
}

/**
 * Check if a snapshot is active (auto-mode is running with discovery).
 */
export function hasSkillSnapshot(): boolean {
  return baselineSkills !== null;
}

/**
 * Detect skills installed since the snapshot was taken.
 * Returns skill metadata for any new skills found.
 */
export function detectNewSkills(): DiscoveredSkill[] {
  if (!baselineSkills) return [];

  const current = listSkillDirs();
  const newSkills: DiscoveredSkill[] = [];

  for (const dir of current) {
    if (baselineSkills.has(dir)) continue;

    // Check both skill directories for the SKILL.md file
    const skillMdPath = resolveSkillMdPath(dir);
    if (!skillMdPath) continue;

    const meta = parseSkillFrontmatter(skillMdPath);
    if (meta) {
      newSkills.push({
        name: meta.name || dir,
        description: meta.description || `Skill: ${dir}`,
        location: skillMdPath,
      });
    }
  }

  return newSkills;
}

/**
 * Format discovered skills as an XML block matching pi's <available_skills> format.
 * This can be appended to the system prompt so the LLM sees them naturally.
 */
export function formatSkillsXml(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) return "";

  const entries = skills.map(s => `  <skill>
    <name>${escapeXml(s.name)}</name>
    <description>${escapeXml(s.description)}</description>
    <location>${escapeXml(s.location)}</location>
  </skill>`).join("\n");

  return `\n<newly_discovered_skills>
The following skills were installed during this auto-mode session.
Use the read tool to load a skill's file when the task matches its description.

${entries}
</newly_discovered_skills>`;
}

// ─── Internals ────────────────────────────────────────────────────────────────

function listSkillDirsFrom(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

function listSkillDirs(): string[] {
  const names = new Set<string>();
  for (const name of listSkillDirsFrom(SKILLS_DIR)) names.add(name);
  for (const name of listSkillDirsFrom(CLAUDE_SKILLS_DIR)) names.add(name);
  return [...names];
}

function parseSkillFrontmatter(path: string): { name?: string; description?: string } | null {
  try {
    const content = readFileSync(path, "utf-8");
    // Use indexOf instead of [\s\S]*? regex to avoid backtracking (#468)
    if (!content.startsWith('---\n')) return null;
    const endIdx = content.indexOf('\n---', 4);
    if (endIdx === -1) return null;

    const fm = content.slice(4, endIdx);
    const result: { name?: string; description?: string } = {};

    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    if (nameMatch) result.name = nameMatch[1].trim();

    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (descMatch) result.description = descMatch[1].trim();

    return result;
  } catch {
    return null;
  }
}

function resolveSkillMdPath(skillName: string): string | null {
  for (const dir of [SKILLS_DIR, CLAUDE_SKILLS_DIR]) {
    const candidate = join(dir, skillName, "SKILL.md");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
