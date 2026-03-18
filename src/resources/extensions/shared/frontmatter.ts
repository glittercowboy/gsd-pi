// Shared frontmatter parsing utilities
// Canonical implementation for splitting and parsing YAML-like frontmatter.

/** Strip matching single or double quotes from a string value (standard YAML scalar behavior). */
function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Split markdown content into frontmatter (YAML-like) and body.
 * Returns [frontmatterLines, body] where frontmatterLines is null if no frontmatter.
 */
export function splitFrontmatter(content: string): [string[] | null, string] {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return [null, content];

  const afterFirst = trimmed.indexOf('\n');
  if (afterFirst === -1) return [null, content];

  const rest = trimmed.slice(afterFirst + 1);
  const endIdx = rest.indexOf('\n---');
  if (endIdx === -1) return [null, content];

  const fmLines = rest.slice(0, endIdx).split('\n');
  const body = rest.slice(endIdx + 4).replace(/^\n+/, '');
  return [fmLines, body];
}

/**
 * Parse YAML-like frontmatter lines into a flat key-value map.
 * Handles simple scalars and arrays (lines starting with "  - ").
 * Handles nested objects like requires (lines with "    key: value").
 * Supports hyphenated keys (e.g. `tech-stack:`).
 */
export function parseFrontmatterMap(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentObj: Record<string, string> | null = null;

  for (const line of lines) {
    // Nested object property (4-space indent with key: value)
    const nestedMatch = line.match(/^    ([\w][\w_-]*)\s*:\s*(.*)$/);
    if (nestedMatch && currentArray && currentObj) {
      currentObj[nestedMatch[1]] = nestedMatch[2].trim();
      continue;
    }

    // Array item (2-space indent)
    const arrayMatch = line.match(/^  - (.*)$/);
    if (arrayMatch && currentKey) {
      // If there's a pending nested object, push it
      if (currentObj && Object.keys(currentObj).length > 0) {
        currentArray!.push(currentObj);
      }
      currentObj = null;

      const val = arrayMatch[1].trim();
      if (!currentArray) currentArray = [];

      // Check if this array item starts a nested object (e.g. "- slice: S00")
      const nestedStart = val.match(/^([\w][\w_-]*)\s*:\s*(.*)$/);
      if (nestedStart) {
        currentObj = { [nestedStart[1]]: nestedStart[2].trim() };
      } else {
        currentArray.push(stripQuotes(val));
      }
      continue;
    }

    // Flush previous key
    if (currentKey) {
      if (currentObj && Object.keys(currentObj).length > 0 && currentArray) {
        currentArray.push(currentObj);
        currentObj = null;
      }
      if (currentArray) {
        result[currentKey] = currentArray;
      }
      currentArray = null;
    }

    // Top-level key: value (supports hyphens in key names)
    const kvMatch = line.match(/^([\w][\w_-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();

      if (val === '' || val === '[]') {
        currentArray = [];
      } else if (val.startsWith('[') && val.endsWith(']')) {
        const inner = val.slice(1, -1).trim();
        result[currentKey] = inner ? inner.split(',').map(s => s.trim()) : [];
        currentKey = null;
      } else {
        result[currentKey] = stripQuotes(val);
        currentKey = null;
      }
    }
  }

  // Flush final key
  if (currentKey) {
    if (currentObj && Object.keys(currentObj).length > 0 && currentArray) {
      currentArray.push(currentObj);
      currentObj = null;
    }
    if (currentArray) {
      result[currentKey] = currentArray;
    }
  }

  return result;
}
