/**
 * Summary distiller — extracts essential structured data from SUMMARY.md files,
 * dropping verbose prose to save context budget.
 */

export interface DistillationResult {
  content: string;
  summaryCount: number;
  savingsPercent: number;
  originalChars: number;
  distilledChars: number;
}

interface ParsedFrontmatter {
  id: string;
  provides: string[];
  requires: string[];
  key_files: string[];
  key_decisions: string[];
  patterns_established: string[];
}

interface DistilledEntry {
  id: string;
  oneLiner: string;
  provides: string[];
  requires: string[];
  key_files: string[];
  key_decisions: string[];
  patterns: string[];
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {
    id: "",
    provides: [],
    requires: [],
    key_files: [],
    key_decisions: [],
    patterns_established: [],
  };

  // Extract frontmatter block between --- markers
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return result;

  const fmBlock = fmMatch[1];
  const lines = fmBlock.split(/\r?\n/);

  let currentKey: string | null = null;

  for (const line of lines) {
    // Scalar value: key: value
    const scalarMatch = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (scalarMatch) {
      const [, key, value] = scalarMatch;
      currentKey = key;
      setScalar(result, key, value.trim());
      continue;
    }

    // Array-start key with empty value: key:\n  or key: []\n
    const arrayStartMatch = line.match(/^(\w[\w_]*):\s*(\[\])?\s*$/);
    if (arrayStartMatch) {
      currentKey = arrayStartMatch[1];
      continue;
    }

    // Array item:   - value
    const itemMatch = line.match(/^\s+-\s+(.+)$/);
    if (itemMatch && currentKey) {
      pushItem(result, currentKey, itemMatch[1].trim());
      continue;
    }
  }

  return result;
}

function setScalar(fm: ParsedFrontmatter, key: string, value: string): void {
  if (key === "id") fm.id = value;
}

function pushItem(fm: ParsedFrontmatter, key: string, value: string): void {
  switch (key) {
    case "provides": fm.provides.push(value); break;
    case "requires": fm.requires.push(value); break;
    case "key_files": fm.key_files.push(value); break;
    case "key_decisions": fm.key_decisions.push(value); break;
    case "patterns_established": fm.patterns_established.push(value); break;
  }
}

// ─── Body parsing ────────────────────────────────────────────────────────────

function extractTitleAndOneLiner(body: string): { id: string; oneLiner: string } {
  const lines = body.split(/\r?\n/);
  let titleId = "";
  let oneLiner = "";
  let foundTitle = false;

  for (const line of lines) {
    const titleMatch = line.match(/^#\s+(\S+):\s*(.*)$/);
    if (titleMatch && !foundTitle) {
      titleId = titleMatch[1];
      // If the title line itself has text after "S01: ", use that as a fallback
      if (titleMatch[2].trim()) {
        oneLiner = titleMatch[2].trim();
      }
      foundTitle = true;
      continue;
    }

    // First non-empty line after the title is the one-liner
    if (foundTitle && !oneLiner && line.trim() && !line.startsWith("#")) {
      oneLiner = line.trim();
      break;
    }
  }

  return { id: titleId, oneLiner };
}

function getBodyAfterFrontmatter(raw: string): string {
  const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fmMatch) {
    return raw.slice(fmMatch[0].length);
  }
  return raw;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Distill a single SUMMARY.md content string into a compact structured block.
 */
export function distillSingle(summary: string): string {
  const fm = parseFrontmatter(summary);
  const body = getBodyAfterFrontmatter(summary);
  const { id: titleId, oneLiner } = extractTitleAndOneLiner(body);

  const id = fm.id || titleId || "???";

  return formatEntry({
    id,
    oneLiner,
    provides: fm.provides,
    requires: fm.requires,
    key_files: fm.key_files,
    key_decisions: fm.key_decisions,
    patterns: fm.patterns_established,
  });
}

function formatEntry(entry: DistilledEntry): string {
  return formatEntryWithDropLevel(entry, 0);
}

/**
 * Format an entry, progressively dropping fields based on dropLevel:
 *   0 = full output
 *   1 = drop patterns
 *   2 = drop patterns + key_decisions
 *   3 = drop patterns + key_decisions + key_files
 */
function formatEntryWithDropLevel(entry: DistilledEntry, dropLevel: number): string {
  const lines: string[] = [];
  lines.push(`## ${entry.id}: ${entry.oneLiner}`);

  if (entry.provides.length > 0) {
    lines.push(`provides: ${entry.provides.join(", ")}`);
  }
  if (entry.requires.length > 0) {
    lines.push(`requires: ${entry.requires.join(", ")}`);
  }
  if (dropLevel < 3 && entry.key_files.length > 0) {
    lines.push(`key_files: ${entry.key_files.join(", ")}`);
  }
  if (dropLevel < 2 && entry.key_decisions.length > 0) {
    lines.push(`key_decisions: ${entry.key_decisions.join(", ")}`);
  }
  if (dropLevel < 1 && entry.patterns.length > 0) {
    lines.push(`patterns: ${entry.patterns.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Distill multiple SUMMARY.md contents into a budget-constrained output.
 */
export function distillSummaries(summaries: string[], budgetChars: number): DistillationResult {
  const originalChars = summaries.reduce((sum, s) => sum + s.length, 0);

  if (summaries.length === 0) {
    return {
      content: "",
      summaryCount: 0,
      savingsPercent: 0,
      originalChars: 0,
      distilledChars: 0,
    };
  }

  // Parse all entries up front
  const entries: DistilledEntry[] = summaries.map((summary) => {
    const fm = parseFrontmatter(summary);
    const body = getBodyAfterFrontmatter(summary);
    const { id: titleId, oneLiner } = extractTitleAndOneLiner(body);
    return {
      id: fm.id || titleId || "???",
      oneLiner,
      provides: fm.provides,
      requires: fm.requires,
      key_files: fm.key_files,
      key_decisions: fm.key_decisions,
      patterns: fm.patterns_established,
    };
  });

  // Try progressively more aggressive dropping until it fits
  for (let dropLevel = 0; dropLevel <= 3; dropLevel++) {
    const blocks = entries.map((e) => formatEntryWithDropLevel(e, dropLevel));
    const content = blocks.join("\n\n");
    if (content.length <= budgetChars) {
      const distilledChars = content.length;
      return {
        content,
        summaryCount: summaries.length,
        savingsPercent: originalChars > 0
          ? Math.round((1 - distilledChars / originalChars) * 100)
          : 0,
        originalChars,
        distilledChars,
      };
    }
  }

  // Even at max drop level it doesn't fit — truncate
  const blocks = entries.map((e) => formatEntryWithDropLevel(e, 3));
  let content = blocks.join("\n\n");
  if (content.length > budgetChars) {
    content = content.slice(0, Math.max(0, budgetChars - 15)) + "\n[...truncated]";
  }

  const distilledChars = content.length;
  return {
    content,
    summaryCount: summaries.length,
    savingsPercent: originalChars > 0
      ? Math.round((1 - distilledChars / originalChars) * 100)
      : 0,
    originalChars,
    distilledChars,
  };
}
