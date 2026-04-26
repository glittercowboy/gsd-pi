/**
 * Repair malformed JSON in LLM tool-call arguments.
 *
 * LLMs sometimes copy YAML template formatting into JSON tool arguments,
 * producing patterns like:
 *
 *   "keyDecisions": - Used Web Notification API...,
 *   "keyFiles": - src-tauri/src/lib.rs — Extended...
 *
 * instead of valid JSON arrays:
 *
 *   "keyDecisions": ["Used Web Notification API..."],
 *   "keyFiles": ["src-tauri/src/lib.rs — Extended..."]
 *
 * This module detects and repairs such patterns before JSON.parse is called.
 *
 * @see https://github.com/gsd-build/gsd-2/issues/2660
 */

/**
 * Detect whether a JSON string contains YAML-style bullet-list values
 * (i.e. `"key": - item` instead of `"key": ["item"]`).
 */
export function hasYamlBulletLists(json: string): boolean {
	// Match: "key": followed by whitespace then a dash-space pattern (YAML bullet)
	// The negative lookahead excludes negative numbers (e.g. "key": -1)
	return /"\s*:\s*-\s+(?!\d)/.test(json);
}

/**
 * Detect whether a JSON string contains XML parameter tags
 * (i.e. `<parameter name="X">value</parameter>`).
 *
 * Some models mix XML tool-call syntax into JSON string values,
 * producing hybrid output that fails JSON.parse.
 *
 * @see https://github.com/gsd-build/gsd-2/issues/3403
 */
export function hasXmlParameterTags(json: string): boolean {
	return /<\/?parameter[\s>]/.test(json);
}

/**
 * Detect whether a JSON string contains truncated numeric values
 * (e.g. `"exitCode": -,` or `"durationMs": ,`).
 *
 * Smaller models sometimes emit incomplete numbers when the value
 * is cut off mid-generation.
 *
 * @see https://github.com/gsd-build/gsd-2/issues/3464
 */
export function hasTruncatedNumbers(json: string): boolean {
	// Match: colon, optional whitespace, then a comma or } without a value
	// Or: colon, optional whitespace, bare minus sign followed by comma/}
	return /:\s*,/.test(json) || /:\s*-\s*[,}]/.test(json);
}

type XmlParameterBlock = {
	name: string;
	value: unknown;
};

const xmlParameterBlockPattern = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
const xmlParameterOpenPattern = /<parameter\s+name="([^"]+)"\s*>/g;

function parseXmlParameterValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === "") return "";
	try {
		return JSON.parse(trimmed);
	} catch {
		return trimmed;
	}
}

function extractXmlParameterBlocks(text: string): XmlParameterBlock[] {
	const strictBlocks: XmlParameterBlock[] = [];
	let hasNestedParameterOpening = false;
	for (const match of text.matchAll(xmlParameterBlockPattern)) {
		const rawValue = match[2] ?? "";
		hasNestedParameterOpening ||= rawValue.includes("<parameter");
		strictBlocks.push({
			name: match[1],
			value: parseXmlParameterValue(rawValue),
		});
	}
	if (strictBlocks.length > 0 && !hasNestedParameterOpening) return strictBlocks;

	const blocks: XmlParameterBlock[] = [];
	const openings = [...text.matchAll(xmlParameterOpenPattern)];
	for (let i = 0; i < openings.length; i++) {
		const current = openings[i];
		const next = openings[i + 1];
		if (current.index === undefined) continue;

		const start = current.index + current[0].length;
		const end = next?.index ?? text.length;
		const rawValue = text.slice(start, end).replace(/\s*<\/parameter>\s*$/, "");
		blocks.push({
			name: current[1],
			value: parseXmlParameterValue(rawValue),
		});
	}
	return blocks;
}

function trimLeakedXmlTail(fieldName: string, value: string): string {
	let cut = value.length;
	const parameterIndex = value.indexOf("<parameter");
	if (parameterIndex >= 0) cut = Math.min(cut, parameterIndex);

	const closingTagIndex = value.indexOf(`</${fieldName}>`);
	if (closingTagIndex >= 0) cut = Math.min(cut, closingTagIndex);

	return value.slice(0, cut).trimEnd();
}

/**
 * Strip XML `<parameter>` tags from a JSON string, leaving only the
 * text content. This handles the case where the LLM mixes XML
 * tool-call format into JSON string values.
 */
function stripXmlParameterTags(json: string): string {
	// Remove opening tags: <parameter name="X">
	let cleaned = json.replace(/<parameter\s+name="[^"]*"\s*>/g, "");
	// Remove closing tags: </parameter>
	cleaned = cleaned.replace(/<\/parameter>/g, "");
	return cleaned;
}

function promoteXmlParametersToTopLevel(json: string): string {
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return stripXmlParameterTags(json);
		}

		let changed = false;
		for (const [fieldName, value] of Object.entries(parsed)) {
			if (typeof value !== "string" || !hasXmlParameterTags(value)) continue;

			const blocks = extractXmlParameterBlocks(value);
			if (blocks.length === 0) continue;

			parsed[fieldName] = trimLeakedXmlTail(fieldName, value);
			for (const block of blocks) {
				if (!(block.name in parsed)) {
					parsed[block.name] = block.value;
				}
			}
			changed = true;
		}

		return changed ? JSON.stringify(parsed) : stripXmlParameterTags(json);
	} catch {
		return stripXmlParameterTags(json);
	}
}

/**
 * Replace truncated numeric values with 0.
 * Handles: `"key": ,` → `"key": 0,` and `"key": -,` → `"key": 0,`
 */
function repairTruncatedNumbers(json: string): string {
	// Bare comma after colon (missing value entirely)
	let repaired = json.replace(/:\s*,/g, ": 0,");
	// Bare minus sign followed by comma or closing brace
	repaired = repaired.replace(/:\s*-\s*([,}])/g, ": 0$1");
	return repaired;
}

/**
 * Attempt to repair malformed JSON in LLM tool-call arguments.
 *
 * Handles three categories of malformation:
 *
 * 1. **YAML bullet lists** (#2660): `"key": - item1\n  - item2` → `"key": ["item1", "item2"]`
 * 2. **XML parameter tags** (#3403): `<parameter name="X">value</parameter>` → stripped to content
 * 3. **Truncated numbers** (#3464): `"exitCode": -,` → `"exitCode": 0,`
 *
 * Returns the original string unchanged if no patterns are detected
 * or if the repair itself would produce invalid JSON.
 */
export function repairToolJson(json: string): string {
	let repaired = json;

	// Phase 1: Strip XML parameter tags
	if (hasXmlParameterTags(repaired)) {
		repaired = promoteXmlParametersToTopLevel(repaired);
	}

	// Phase 2: Repair truncated numbers
	if (hasTruncatedNumbers(repaired)) {
		repaired = repairTruncatedNumbers(repaired);
	}

	// Phase 3: Repair YAML bullet lists
	if (!hasYamlBulletLists(repaired)) {
		return repaired;
	}

	// Strategy: find each `"key": - item1\n  - item2\n  - item3` region and
	// wrap items in a JSON array.
	//
	// We work on the raw string because the JSON is not parseable yet.
	// The pattern we target:
	//   "someKey":\s*- item text (possibly multiline)
	//   optionally followed by more `- item` lines
	//   terminated by the next `"key":` or `}` or end of string.

	// Match a key followed by YAML-style bullet list.
	// Capture: (1) the key portion including colon, (2) the bullet-list body,
	// (3) the separator (comma or empty) before the next key/bracket.
	// The bullet list body ends at the next `"key":` or `}` or `]` or end of string.
	const keyBulletPattern =
		/("(?:[^"\\]|\\.)*"\s*:\s*)(- .+?)(,?\s*)(?="(?:[^"\\]|\\.)*"\s*:|[}\]]|$)/gs;

	repaired = repaired.replace(
		keyBulletPattern,
		(_match, keyPart: string, bulletBody: string, separator: string) => {
			// Split the bullet body into individual items on `- ` boundaries.
			// Items may contain embedded newlines for multi-line values.
			const items = bulletBody
				.split(/\n?\s*- /)
				.filter((s) => s.trim().length > 0)
				.map((s) => s.replace(/,\s*$/, "").trim());

			// JSON-encode each item as a string, then wrap in an array.
			const jsonArray = "[" + items.map((item) => JSON.stringify(item)).join(", ") + "]";

			// Re-emit the separator (comma) so the next key is properly delimited
			const sep = separator.trim() ? separator : (/^\s*"/.test(separator + "x") ? ", " : "");
			return keyPart + jsonArray + sep;
		},
	);

	// Strip trailing commas before } or ] (common in repaired JSON)
	repaired = repaired.replace(/,(\s*[}\]])/g, "$1");

	return repaired;
}
