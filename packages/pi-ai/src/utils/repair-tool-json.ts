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
 * Attempt to repair YAML-style bullet lists embedded in a JSON string.
 *
 * Converts patterns like:
 *   "keyDecisions": - Used Web Notification API..., "keyFiles": - file1
 *
 * Into:
 *   "keyDecisions": ["Used Web Notification API..."], "keyFiles": ["file1"]
 *
 * Returns the original string unchanged if no YAML patterns are detected
 * or if the repair itself would produce invalid JSON.
 */
export function repairToolJson(json: string): string {
	if (!hasYamlBulletLists(json)) {
		return json;
	}

	// Strategy: find each `"key": - item1\n  - item2\n  - item3` region and
	// wrap items in a JSON array.
	//
	// We work on the raw string because the JSON is not parseable yet.
	// The pattern we target:
	//   "someKey":\s*- item text (possibly multiline)
	//   optionally followed by more `- item` lines
	//   terminated by the next `"key":` or `}` or end of string.

	let repaired = json;

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
