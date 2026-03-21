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
  // Match "## Slices", "## Slice Overview", "## Slice Table", etc.
  const headingMatch = /^## Slice(?:s| Overview| Table| Summary| Status)\b.*$/m.exec(content);
  if (!headingMatch || headingMatch.index == null) return "";

  const start = headingMatch.index + headingMatch[0].length;
  const rest = content.slice(start).replace(/^\r?\n/, "");
  const nextHeading = /^##\s+/m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trimEnd();
}

/**
 * Parse markdown table format for slices.
 *
 * Handles LLM-generated table variants:
 *   | S01 | Title | High | [x] Done |
 *   | S01 | Title | High | Done | [x] |
 *   | S01 | Title | High | Complete |
 *   | S01 | Title | [x] | High | S01,S02 |
 *
 * Returns parsed slices if a table with slice IDs is found, otherwise empty array.
 */
function parseTableSlices(section: string): RoadmapSliceEntry[] {
  const lines = section.split("\n");
  const slices: RoadmapSliceEntry[] = [];

  for (const line of lines) {
    // Skip non-table lines, separator lines (|---|---|), and header rows
    if (!line.includes("|")) continue;
    if (/^\s*\|[\s:-]+\|/.test(line) && !/S\d+/.test(line)) continue;

    // Extract a slice ID from the row
    const idMatch = line.match(/\b(S\d+)\b/);
    if (!idMatch) continue;

    const id = idMatch[1]!;
    const cells = line.split("|").map(c => c.trim()).filter(Boolean);

    // Determine completion status from any cell containing [x], "Done", or "Complete"
    const fullRow = line.toLowerCase();
    const done =
      /\[x\]/i.test(line) ||
      /\bdone\b/.test(fullRow) ||
      /\bcomplete(?:d)?\b/.test(fullRow);

    // Extract risk from any cell containing risk keywords
    let risk: RiskLevel = "medium";
    for (const cell of cells) {
      const cellLower = cell.toLowerCase();
      if (/\bhigh\b/.test(cellLower)) { risk = "high"; break; }
      if (/\blow\b/.test(cellLower)) { risk = "low"; break; }
      if (/\bmedium\b/.test(cellLower) || /\bmed\b/.test(cellLower)) { risk = "medium"; break; }
    }

    // Extract dependencies from cells containing S-prefixed IDs (excluding the slice's own ID)
    let depends: string[] = [];
    for (const cell of cells) {
      if (/depends|deps/i.test(cell) || (cell.match(/S\d+/g)?.length ?? 0) > 0) {
        const depIds = (cell.match(/S\d+/g) ?? []).filter(d => d !== id);
        if (depIds.length > 0 || /none|—|-/i.test(cell)) {
          depends = expandDependencies(depIds);
          break;
        }
      }
    }

    // Extract title: use the cell after the ID cell, excluding cells that look like
    // status, risk, dependency, or checkbox fields
    let title = "";
    const idCellIndex = cells.findIndex(c => c.includes(id));
    for (let i = 0; i < cells.length; i++) {
      if (i === idCellIndex) continue;
      const cellLower = cells[i]!.toLowerCase();
      // Skip cells that are clearly metadata
      if (/^\[[ x]\]/.test(cells[i]!) || /\[x\]/i.test(cells[i]!)) continue;
      if (/^(high|medium|med|low)$/i.test(cells[i]!.trim())) continue;
      if (/^(done|complete[d]?|pending|in.?progress|not started|todo)$/i.test(cells[i]!.trim())) continue;
      if (/^(none|—|-)$/.test(cells[i]!.trim())) continue;
      if (/^S\d+/.test(cells[i]!.trim()) && i !== idCellIndex) continue;
      if (/depends|deps/i.test(cellLower)) continue;
      // First remaining cell is likely the title
      if (!title && cells[i]!.trim()) {
        title = cells[i]!.trim().replace(/^\*+|\*+$/g, "");
        break;
      }
    }

    if (!title) title = id;

    slices.push({ id, title, risk, depends, done, demo: "" });
  }

  return slices;
}

export function parseRoadmapSlices(content: string): RoadmapSliceEntry[] {
  const slicesSection = extractSlicesSection(content);
  if (!slicesSection) {
    // Fallback: detect prose-style slice headers (## Slice S01: Title)
    // when the LLM writes freeform prose instead of the ## Slices checklist.
    // This prevents a permanent "No slice eligible" block (#807).
    return parseProseSliceHeaders(content);
  }

  // Try table format first — if the section contains pipe-delimited rows with
  // slice IDs, parse them as a table (#1736).
  const tableSlices = parseTableSlices(slicesSection);
  if (tableSlices.length > 0) {
    return tableSlices;
  }

  // Standard checkbox format
  const slices: RoadmapSliceEntry[] = [];
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

  // When the ## Slices section exists but the checkbox parser found nothing
  // (e.g. the LLM used H3 prose headers instead of checkboxes), fall through
  // to the prose-header parser as a second-chance fallback.
  if (slices.length === 0) {
    return parseProseSliceHeaders(content);
  }

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
  // Match H1-H4 headers containing S<digits> with optional "Slice" prefix, bold markers,
  // and optional checkmark completion marker before the slice ID.
  // Separator after the ID is flexible: colon, dash, em/en dash, dot, or just whitespace.
  const headerPattern = /^#{1,4}\s+\*{0,2}(?:\u2713\s+)?(?:Slice\s+)?(S\d+)\*{0,2}[:\s.\u2014\u2013-]*\s*(.+)/gm;
  let match: RegExpExecArray | null;

  // Check for checkmark before the slice ID (e.g., "## checkmark S01: Title")
  const prefixCheckPattern = /^#{1,4}\s+\*{0,2}\u2713\s+/;

  while ((match = headerPattern.exec(content)) !== null) {
    const id = match[1]!;
    let title = match[2]!.trim().replace(/\*{1,2}$/g, "").trim(); // strip trailing bold markers
    if (!title) continue; // skip if we only matched the ID with no title

    // Detect completion markers:
    // 1. Checkmark before the slice ID: "## checkmark S01: Title"
    // 2. Checkmark after separator: "## S01: checkmark Title"
    // 3. (Complete) suffix: "## S01: Title (Complete)"
    const line = match[0];
    let done = prefixCheckPattern.test(line);

    if (!done && title.startsWith("\u2713")) {
      done = true;
      title = title.replace(/^\u2713\s*/, "");
    }

    if (!done && /\(Complete\)\s*$/i.test(title)) {
      done = true;
      title = title.replace(/\s*\(Complete\)\s*$/i, "");
    }

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

    slices.push({ id, title, risk: "medium" as RiskLevel, depends, done, demo: "" });
  }

  return slices;
}
