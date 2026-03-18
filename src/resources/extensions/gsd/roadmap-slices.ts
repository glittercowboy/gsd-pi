import type { RoadmapSliceEntry, RiskLevel } from "./types.js";

/**
 * Expand dependency shorthand into individual slice IDs.
 *
 * Handles two common LLM-generated patterns that the roadmap parser
 * previously treated as single literal IDs (silently blocking slices):
 *
 *   "S01-S04"  → ["S01", "S02", "S03", "S04"]  (range syntax)
 *   "S01..S04" → ["S01", "S02", "S03", "S04"]  (dot-range syntax)
 *
 * Plain IDs ("S01", "S02") and empty strings pass through unchanged.
 */
export function expandDependencies(deps: string[]): string[] {
  const result: string[] = [];
  for (const dep of deps) {
    const trimmed = dep.trim();
    if (!trimmed) continue;

    // Match range syntax: S01-S04 or S01..S04 (case-insensitive prefix)
    const rangeMatch = trimmed.match(/^([A-Za-z]+)(\d+)(?:-|\.\.)+([A-Za-z]+)(\d+)$/);
    if (rangeMatch) {
      const prefixA = rangeMatch[1]!.toUpperCase();
      const startNum = parseInt(rangeMatch[2]!, 10);
      const prefixB = rangeMatch[3]!.toUpperCase();
      const endNum = parseInt(rangeMatch[4]!, 10);

      // Only expand when both prefixes match and range is valid
      if (prefixA === prefixB && startNum <= endNum) {
        const width = rangeMatch[2]!.length; // preserve zero-padding (S01 not S1)
        for (let i = startNum; i <= endNum; i++) {
          result.push(`${prefixA}${String(i).padStart(width, "0")}`);
        }
        continue;
      }
    }

    result.push(trimmed);
  }
  return result;
}

function extractSlicesSection(content: string): string {
  const headingMatch = /^## Slices\b.*$/m.exec(content);
  if (!headingMatch || headingMatch.index == null) return "";

  const start = headingMatch.index + headingMatch[0].length;
  const rest = content.slice(start).replace(/^\r?\n/, "");
  const nextHeading = /^##\s+/m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trimEnd();
}

export function parseRoadmapSlices(content: string): RoadmapSliceEntry[] {
  const slicesSection = extractSlicesSection(content);
  const slices: RoadmapSliceEntry[] = [];
  if (!slicesSection) {
    // Fallback: detect prose-style slice headers (## Slice S01: Title)
    // when the LLM writes freeform prose instead of the ## Slices checklist.
    // This prevents a permanent "No slice eligible" block (#807).
    return parseProseSliceHeaders(content);
  }

  const checkboxItems = slicesSection.split("\n");
  let currentSlice: RoadmapSliceEntry | null = null;

  for (const line of checkboxItems) {
    const cbMatch = line.match(/^\s*-\s+\[([ xX])\]\s+\*\*([\w.]+):\s+(.+?)\*\*\s*(.*)/);
    if (cbMatch) {
      if (currentSlice) slices.push(currentSlice);

      const done = cbMatch[1].toLowerCase() === "x";
      const id = cbMatch[2]!;
      const title = cbMatch[3]!;
      const rest = cbMatch[4] ?? "";

      const riskMatch = rest.match(/`risk:(\w+)`/);
      const risk = (riskMatch ? riskMatch[1] : "low") as RiskLevel;

      const depsMatch = rest.match(/`depends:\[([^\]]*)\]`/);
      const depends = depsMatch && depsMatch[1]!.trim()
        ? expandDependencies(depsMatch[1]!.split(",").map(s => s.trim()))
        : [];

      currentSlice = { id, title, risk, depends, done, demo: "" };
      continue;
    }

    if (currentSlice && line.trim().startsWith(">")) {
      currentSlice.demo = line.trim().replace(/^>\s*/, "").replace(/^After this:\s*/i, "");
    }
  }

  if (currentSlice) slices.push(currentSlice);
  return slices;
}

/**
 * Fallback parser for prose-style roadmaps where the LLM wrote
 * slice headers instead of the machine-readable `## Slices` checklist.
 * Extracts slice IDs and titles so auto-mode can at least identify
 * slices and plan them.
 *
 * Handles these LLM-generated variants:
 *   ## S01: Title           (H2, colon separator)
 *   ### S01: Title          (H3)
 *   #### S01: Title         (H4)
 *   ## Slice S01: Title     (with "Slice" prefix)
 *   ## S01 — Title          (em dash)
 *   ## S01 – Title          (en dash)
 *   ## S01 - Title          (hyphen)
 *   ## S01. Title           (dot separator)
 *   ## S01 Title            (space only, no separator)
 *   ## **S01: Title**       (bold-wrapped)
 *   ## **S01**: Title       (bold ID only)
 *   ## S1: Title            (non-zero-padded ID)
 */
function parseProseSliceHeaders(content: string): RoadmapSliceEntry[] {
  const slices: RoadmapSliceEntry[] = [];
  // Match H1–H4 headers containing S<digits> with optional "Slice" prefix and bold markers.
  // Separator after the ID is flexible: colon, dash, em/en dash, dot, or just whitespace.
  const headerPattern = /^#{1,4}\s+\*{0,2}(?:Slice\s+)?(S\d+)\*{0,2}[:\s.—–-]*\s*(.+)/gm;
  let match: RegExpExecArray | null;

  while ((match = headerPattern.exec(content)) !== null) {
    const id = match[1]!;
    let title = match[2]!.trim().replace(/\*{1,2}$/g, "").trim(); // strip trailing bold markers
    if (!title) continue; // skip if we only matched the ID with no title

    // Try to extract depends from prose: "Depends on: S01" or "**Depends on:** S01, S02"
    const afterHeader = content.slice(match.index + match[0].length);
    const nextHeader = afterHeader.search(/^#{1,4}\s/m);
    const section = nextHeader !== -1 ? afterHeader.slice(0, nextHeader) : afterHeader.slice(0, 500);

    const depsMatch = section.match(/\*{0,2}Depends\s+on:?\*{0,2}\s*(.+)/i);
    let depends: string[] = [];
    if (depsMatch) {
      const rawDeps = depsMatch[1]!.replace(/none/i, "").trim();
      if (rawDeps) {
        depends = expandDependencies(
          rawDeps.split(/[,;]/).map(s => s.trim().replace(/[^A-Za-z0-9]/g, "")).filter(Boolean)
        );
      }
    }

    slices.push({ id, title, risk: "medium" as RiskLevel, depends, done: false, demo: "" });
  }

  return slices;
}
