// gsd-2 / Phase 11 — Markdown → structured object parsers for artifact validation.
//
// Each parser converts a markdown artifact into a typed object suitable for
// JSON Schema validation. The parsers are intentionally minimal — they only
// extract the structure the validators care about, not full semantic content.

export interface ParsedProject {
  sections: Record<string, string>;
  /** Names of H2 sections in the order they appear */
  sectionOrder: string[];
  milestones: Array<{ id: string; title: string; oneLiner: string; done: boolean }>;
  /** True if any section body contains an unsubstituted {{...}} template token */
  hasTemplateTokens: boolean;
  /** Section names whose bodies contain template tokens */
  sectionsWithTokens: string[];
}

export interface ParsedRequirement {
  id: string;
  title: string;
  class: string;
  status: string;
  description: string;
  whyItMatters: string;
  source: string;
  primaryOwner: string;
  supportingSlices: string;
  validation: string;
  notes: string;
  /** The H2 section this entry was found under */
  parentSection: string;
}

export interface ParsedRequirements {
  sections: Record<string, string>;
  sectionOrder: string[];
  requirements: ParsedRequirement[];
  /** Parsed traceability table rows */
  traceabilityRows: Array<Record<string, string>>;
  /** Parsed coverage summary key/value lines */
  coverageSummary: Record<string, string>;
  hasTemplateTokens: boolean;
}

export interface ParsedRoadmapSlice {
  id: string;
  title: string;
  risk: string;
  depends: string[];
  demo: string;
}

export interface ParsedRoadmap {
  sections: Record<string, string>;
  sectionOrder: string[];
  slices: ParsedRoadmapSlice[];
  definitionOfDone: string[];
  hasTemplateTokens: boolean;
}

const TEMPLATE_TOKEN_RE = /\{\{[^}]+\}\}/;
const H2_RE = /^##\s+(.+)$/gm;
const H3_RE = /^###\s+(.+)$/gm;
const MILESTONE_LINE_RE = /^-\s+\[([ x])\]\s+(M\d{3}):\s+(.+?)\s+(?:—|--|-)\s+(.+)$/gm;
const SLICE_HEADER_RE = /^###\s+(S\d{2})\s*(?:—|--|-)\s+(.+)$/m;
const REQUIREMENT_HEADER_RE = /^###\s+(R\d{3})\s*(?:—|--|-)\s+(.+)$/m;

function splitH2Sections(content: string): { sections: Record<string, string>; order: string[] } {
  const sections: Record<string, string> = {};
  const order: string[] = [];
  const headerMatches: Array<{ name: string; index: number; lineEnd: number }> = [];

  for (const m of content.matchAll(H2_RE)) {
    if (m.index === undefined) continue;
    headerMatches.push({
      name: m[1].trim(),
      index: m.index,
      lineEnd: m.index + m[0].length,
    });
  }

  for (let i = 0; i < headerMatches.length; i++) {
    const start = headerMatches[i].lineEnd;
    const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index : content.length;
    const body = content.slice(start, end).trim();
    sections[headerMatches[i].name] = body;
    order.push(headerMatches[i].name);
  }

  return { sections, order };
}

function detectTemplateTokens(sections: Record<string, string>): { has: boolean; flagged: string[] } {
  const flagged: string[] = [];
  for (const [name, body] of Object.entries(sections)) {
    if (TEMPLATE_TOKEN_RE.test(body)) flagged.push(name);
  }
  return { has: flagged.length > 0, flagged };
}

export function parseProject(content: string): ParsedProject {
  const { sections, order } = splitH2Sections(content);
  const tokens = detectTemplateTokens(sections);

  const milestones: ParsedProject["milestones"] = [];
  const sequenceBody = sections["Milestone Sequence"] ?? "";
  for (const m of sequenceBody.matchAll(MILESTONE_LINE_RE)) {
    milestones.push({
      done: m[1] === "x",
      id: m[2],
      title: m[3].trim(),
      oneLiner: m[4].trim(),
    });
  }

  return {
    sections,
    sectionOrder: order,
    milestones,
    hasTemplateTokens: tokens.has,
    sectionsWithTokens: tokens.flagged,
  };
}

function parseRequirementEntry(block: string, parentSection: string): ParsedRequirement | null {
  const headerMatch = block.match(REQUIREMENT_HEADER_RE);
  if (!headerMatch) return null;

  const id = headerMatch[1];
  const title = headerMatch[2].trim();

  const fieldOf = (key: string): string => {
    const re = new RegExp(`^-\\s+${key}:\\s*(.*)$`, "m");
    const matched = block.match(re);
    return matched ? matched[1].trim() : "";
  };

  return {
    id,
    title,
    class: fieldOf("Class"),
    status: fieldOf("Status"),
    description: fieldOf("Description"),
    whyItMatters: fieldOf("Why it matters"),
    source: fieldOf("Source"),
    primaryOwner: fieldOf("Primary owning slice"),
    supportingSlices: fieldOf("Supporting slices"),
    validation: fieldOf("Validation"),
    notes: fieldOf("Notes"),
    parentSection,
  };
}

function splitH3Blocks(sectionBody: string): string[] {
  if (!sectionBody) return [];
  const indices: number[] = [];
  for (const m of sectionBody.matchAll(H3_RE)) {
    if (m.index !== undefined) indices.push(m.index);
  }
  if (indices.length === 0) return [];
  const blocks: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const end = i + 1 < indices.length ? indices[i + 1] : sectionBody.length;
    blocks.push(sectionBody.slice(indices[i], end));
  }
  return blocks;
}

export function parseRequirements(content: string): ParsedRequirements {
  const { sections, order } = splitH2Sections(content);
  const tokens = detectTemplateTokens(sections);

  const requirements: ParsedRequirement[] = [];
  for (const sectionName of ["Active", "Validated", "Deferred", "Out of Scope"]) {
    const body = sections[sectionName] ?? "";
    for (const block of splitH3Blocks(body)) {
      const parsed = parseRequirementEntry(block, sectionName);
      if (parsed) requirements.push(parsed);
    }
  }

  const traceBody = sections["Traceability"] ?? "";
  const traceabilityRows: Array<Record<string, string>> = [];
  const lines = traceBody.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines[0].startsWith("|") && lines[1].startsWith("|")) {
    const headers = lines[0].replace(/^\|/, "").replace(/\|$/, "").split("|").map(s => s.trim());
    for (let i = 2; i < lines.length; i++) {
      if (!lines[i].startsWith("|")) continue;
      const cells = lines[i].replace(/^\|/, "").replace(/\|$/, "").split("|").map(s => s.trim());
      if (cells.length === headers.length) {
        const row: Record<string, string> = {};
        headers.forEach((h, idx) => { row[h] = cells[idx]; });
        traceabilityRows.push(row);
      }
    }
  }

  const coverageBody = sections["Coverage Summary"] ?? "";
  const coverageSummary: Record<string, string> = {};
  for (const line of coverageBody.split("\n")) {
    const m2 = line.match(/^-\s+(.+?):\s*(.+)$/);
    if (m2) coverageSummary[m2[1].trim()] = m2[2].trim();
  }

  return {
    sections,
    sectionOrder: order,
    requirements,
    traceabilityRows,
    coverageSummary,
    hasTemplateTokens: tokens.has,
  };
}

export function parseRoadmap(content: string): ParsedRoadmap {
  const { sections, order } = splitH2Sections(content);
  const tokens = detectTemplateTokens(sections);

  const slices: ParsedRoadmapSlice[] = [];
  const slicesBody = sections["Slices"] ?? "";
  for (const block of splitH3Blocks(slicesBody)) {
    const headerMatch = block.match(SLICE_HEADER_RE);
    if (!headerMatch) continue;
    const id = headerMatch[1];
    const title = headerMatch[2].trim();
    const fieldOf = (key: string): string => {
      const re = new RegExp(`^-\\s+${key}:\\s*(.*)$`, "m");
      const matched = block.match(re);
      return matched ? matched[1].trim() : "";
    };
    const dependsRaw = fieldOf("Depends");
    const depends = dependsRaw && dependsRaw.toLowerCase() !== "none"
      ? dependsRaw.split(/[,\s]+/).filter(s => /^S\d{2}$/.test(s))
      : [];
    slices.push({
      id,
      title,
      risk: fieldOf("Risk"),
      depends,
      demo: fieldOf("Demo"),
    });
  }

  const dodBody = sections["Definition of Done"] ?? "";
  const definitionOfDone: string[] = [];
  for (const line of dodBody.split("\n")) {
    const m3 = line.match(/^-\s+(.+)$/);
    if (m3) definitionOfDone.push(m3[1].trim());
  }

  return {
    sections,
    sectionOrder: order,
    slices,
    definitionOfDone,
    hasTemplateTokens: tokens.has,
  };
}
