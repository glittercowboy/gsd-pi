// gsd-2 / Phase 11 — Artifact validator entry point.
//
// Validates PROJECT.md, REQUIREMENTS.md, and per-milestone ROADMAP.md
// against the contract spec in .planning/phases/11-deep-planning-mode/11-CONTRACTS.md.
// Used by deep-mode dispatch rules to gate stage completion and by light mode
// auto-start to catch malformed artifacts early.

import { existsSync, readFileSync } from "node:fs";
import { parseProject, parseRequirements, parseRoadmap } from "./parsers.js";
import type { ParsedRequirement } from "./parsers.js";

export type ArtifactKind = "project" | "requirements" | "roadmap";

export interface ValidationError {
  code: string;
  message: string;
  location?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface ValidateOptions {
  crossRefs?: {
    projectPath?: string;
    requirementsPath?: string;
  };
}

const REQUIRED_PROJECT_SECTIONS = [
  "What This Is",
  "Core Value",
  "Current State",
  "Architecture / Key Patterns",
  "Capability Contract",
  "Milestone Sequence",
];

const REQUIRED_REQUIREMENTS_SECTIONS = [
  "Active",
  "Validated",
  "Deferred",
  "Out of Scope",
  "Traceability",
  "Coverage Summary",
];

const REQUIRED_ROADMAP_SECTIONS = ["Slices", "Definition of Done"];

const ALLOWED_REQUIREMENT_CLASSES = new Set([
  "core-capability",
  "primary-user-loop",
  "launchability",
  "continuity",
  "failure-visibility",
  "integration",
  "quality-attribute",
  "operability",
  "admin/support",
  "compliance/security",
  "differentiator",
  "constraint",
  "anti-feature",
]);

const STATUS_TO_SECTION: Record<string, string> = {
  active: "Active",
  validated: "Validated",
  deferred: "Deferred",
  "out-of-scope": "Out of Scope",
};

function loadFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function err(code: string, message: string, location?: string): ValidationError {
  return location ? { code, message, location } : { code, message };
}

// ─── PROJECT.md ─────────────────────────────────────────────────────────

function validateProjectContent(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const parsed = parseProject(content);

  for (const required of REQUIRED_PROJECT_SECTIONS) {
    if (!(required in parsed.sections)) {
      errors.push(err("missing-section", `Missing required section "## ${required}"`, required));
    }
  }

  for (const sectionName of parsed.sectionsWithTokens) {
    errors.push(err("template-token", `Section "${sectionName}" contains unsubstituted {{...}} template tokens`, sectionName));
  }

  for (const required of REQUIRED_PROJECT_SECTIONS) {
    const body = parsed.sections[required];
    if (body !== undefined && body.trim() === "") {
      errors.push(err("empty-section", `Section "## ${required}" is empty`, required));
    }
  }

  if (parsed.milestones.length === 0 && "Milestone Sequence" in parsed.sections) {
    errors.push(err("no-milestones", "Milestone Sequence has no entries", "Milestone Sequence"));
  }

  const seen = new Set<string>();
  let prevNum = 0;
  for (const m of parsed.milestones) {
    if (seen.has(m.id)) {
      errors.push(err("duplicate-milestone", `Duplicate milestone ID ${m.id}`, "Milestone Sequence"));
    }
    seen.add(m.id);
    const num = parseInt(m.id.slice(1), 10);
    if (num !== prevNum + 1) {
      warnings.push(err("non-monotonic-milestone", `Milestone ${m.id} is not monotonically numbered (expected M${String(prevNum + 1).padStart(3, "0")})`, "Milestone Sequence"));
    }
    prevNum = num;
    if (!m.title || !m.oneLiner) {
      errors.push(err("incomplete-milestone", `Milestone ${m.id} is missing title or one-liner`, "Milestone Sequence"));
    }
  }

  const capabilityBody = parsed.sections["Capability Contract"] ?? "";
  if (capabilityBody && !capabilityBody.includes("REQUIREMENTS.md")) {
    warnings.push(err("missing-requirements-ref", "Capability Contract section should reference .gsd/REQUIREMENTS.md", "Capability Contract"));
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─── REQUIREMENTS.md ────────────────────────────────────────────────────

function validateRequirementsContent(content: string, projectContent: string | null): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const parsed = parseRequirements(content);

  for (const required of REQUIRED_REQUIREMENTS_SECTIONS) {
    if (!(required in parsed.sections)) {
      errors.push(err("missing-section", `Missing required section "## ${required}"`, required));
    }
  }

  for (const sectionName of Object.keys(parsed.sections)) {
    const body = parsed.sections[sectionName];
    if (/\{\{[^}]+\}\}/.test(body)) {
      errors.push(err("template-token", `Section "${sectionName}" contains unsubstituted {{...}} template tokens`, sectionName));
    }
  }

  const seenIds = new Set<string>();
  let prevNum = 0;
  for (const r of parsed.requirements) {
    if (seenIds.has(r.id)) {
      errors.push(err("duplicate-requirement", `Duplicate requirement ID ${r.id}`, r.id));
    }
    seenIds.add(r.id);
    const num = parseInt(r.id.slice(1), 10);
    if (num <= prevNum) {
      warnings.push(err("non-monotonic-requirement", `Requirement ${r.id} is not monotonically numbered`, r.id));
    }
    prevNum = num;
    validateRequirementShape(r, errors, warnings);
  }

  if (projectContent) {
    const project = parseProject(projectContent);
    const milestoneIds = new Set(project.milestones.map(m => m.id));
    for (const r of parsed.requirements) {
      const ownerMatch = r.primaryOwner.match(/^(M\d{3})\//);
      if (ownerMatch && !milestoneIds.has(ownerMatch[1])) {
        errors.push(err("dangling-owner", `Requirement ${r.id} references non-existent milestone ${ownerMatch[1]}`, r.id));
      }
    }
  }

  const sectionCounts: Record<string, number> = { Active: 0, Validated: 0, Deferred: 0, "Out of Scope": 0 };
  for (const r of parsed.requirements) sectionCounts[r.parentSection] = (sectionCounts[r.parentSection] ?? 0) + 1;

  const expectedActive = sectionCounts.Active;
  const reportedActive = parsed.coverageSummary["Active requirements"];
  if (reportedActive !== undefined && parseInt(reportedActive, 10) !== expectedActive) {
    warnings.push(err("coverage-mismatch", `Coverage Summary says Active=${reportedActive} but ${expectedActive} entries found in ## Active`, "Coverage Summary"));
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateRequirementShape(r: ParsedRequirement, errors: ValidationError[], warnings: ValidationError[]): void {
  const required: Array<keyof ParsedRequirement> = [
    "class", "status", "description", "whyItMatters", "source", "primaryOwner", "validation",
  ];
  for (const field of required) {
    if (!r[field] || (r[field] as string).trim() === "") {
      errors.push(err("missing-field", `Requirement ${r.id} is missing field "${field}"`, r.id));
    }
  }

  if (r.class && !ALLOWED_REQUIREMENT_CLASSES.has(r.class)) {
    errors.push(err("invalid-class", `Requirement ${r.id} has invalid class "${r.class}"`, r.id));
  }

  const expectedSection = STATUS_TO_SECTION[r.status];
  if (expectedSection && expectedSection !== r.parentSection) {
    errors.push(err("status-section-mismatch", `Requirement ${r.id} has Status "${r.status}" but lives under "## ${r.parentSection}" (expected "## ${expectedSection}")`, r.id));
  }

  if (r.primaryOwner && !/^(M\d{3}\/(S\d{2}|none yet)|none yet|none)$/.test(r.primaryOwner)) {
    warnings.push(err("malformed-owner", `Requirement ${r.id} owner "${r.primaryOwner}" does not match expected formats (M###/S## | M###/none yet | none yet | none)`, r.id));
  }
}

// ─── ROADMAP.md ─────────────────────────────────────────────────────────

function validateRoadmapContent(content: string, requirementsContent: string | null): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const parsed = parseRoadmap(content);

  for (const required of REQUIRED_ROADMAP_SECTIONS) {
    if (!(required in parsed.sections)) {
      errors.push(err("missing-section", `Missing required section "## ${required}"`, required));
    }
  }

  for (const sectionName of Object.keys(parsed.sections)) {
    const body = parsed.sections[sectionName];
    if (/\{\{[^}]+\}\}/.test(body)) {
      errors.push(err("template-token", `Section "${sectionName}" contains unsubstituted {{...}} template tokens`, sectionName));
    }
  }

  if (parsed.slices.length === 0 && "Slices" in parsed.sections) {
    errors.push(err("no-slices", "Slices section has no entries", "Slices"));
  }

  if (parsed.definitionOfDone.length === 0 && "Definition of Done" in parsed.sections) {
    errors.push(err("no-definition-of-done", "Definition of Done has no items", "Definition of Done"));
  }

  const seenIds = new Set<string>();
  let prevNum = 0;
  for (const s of parsed.slices) {
    if (seenIds.has(s.id)) {
      errors.push(err("duplicate-slice", `Duplicate slice ID ${s.id}`, s.id));
    }
    seenIds.add(s.id);
    const num = parseInt(s.id.slice(1), 10);
    if (num !== prevNum + 1) {
      warnings.push(err("non-monotonic-slice", `Slice ${s.id} is not monotonically numbered (expected S${String(prevNum + 1).padStart(2, "0")})`, s.id));
    }
    prevNum = num;
    if (!s.risk || !s.demo) {
      errors.push(err("missing-slice-field", `Slice ${s.id} is missing required field (risk and demo are required)`, s.id));
    }
  }

  // Depends graph: dangling refs + cycle detection
  const sliceIds = new Set(parsed.slices.map(s => s.id));
  for (const s of parsed.slices) {
    for (const dep of s.depends) {
      if (!sliceIds.has(dep)) {
        errors.push(err("dangling-dependency", `Slice ${s.id} depends on non-existent slice ${dep}`, s.id));
      }
    }
  }
  if (hasCycle(parsed.slices)) {
    errors.push(err("circular-dependency", "Slice depends graph contains a cycle"));
  }

  if (requirementsContent) {
    const reqs = parseRequirements(requirementsContent);
    for (const s of parsed.slices) {
      const ownsAnyRequirement = reqs.requirements.some(r => {
        if (r.parentSection !== "Active") return false;
        const m = r.primaryOwner.match(/^M\d{3}\/(S\d{2})$/);
        return m && m[1] === s.id;
      });
      if (!ownsAnyRequirement) {
        warnings.push(err("orphan-slice", `Slice ${s.id} owns no Active requirements`, s.id));
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function hasCycle(slices: Array<{ id: string; depends: string[] }>): boolean {
  const map = new Map(slices.map(s => [s.id, s.depends]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of map.get(id) ?? []) {
      if (dfs(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const s of slices) {
    if (dfs(s.id)) return true;
  }
  return false;
}

// ─── Entry point ────────────────────────────────────────────────────────

export function validateArtifact(
  filePath: string,
  kind: ArtifactKind,
  opts: ValidateOptions = {},
): ValidationResult {
  const content = loadFile(filePath);
  if (content === null) {
    return {
      ok: false,
      errors: [err("file-missing", `Artifact file not found: ${filePath}`, filePath)],
      warnings: [],
    };
  }

  switch (kind) {
    case "project":
      return validateProjectContent(content);
    case "requirements":
      return validateRequirementsContent(content, opts.crossRefs?.projectPath ? loadFile(opts.crossRefs.projectPath) : null);
    case "roadmap":
      return validateRoadmapContent(content, opts.crossRefs?.requirementsPath ? loadFile(opts.crossRefs.requirementsPath) : null);
  }
}
